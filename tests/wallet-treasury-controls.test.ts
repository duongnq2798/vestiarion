import { getAddress, maxUint256, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { PauseError } from "@/lib/platform/pause";
import type { TreasuryChain, TreasuryReceipt } from "@/lib/treasury/chain";
import { OWNER_STOPPED, recordWalletControl, type WalletControlKind } from "@/lib/treasury/wallet-treasury";
import {
  ACTOR,
  agentRow,
  APPROVE_TX,
  approvalLog,
  chain,
  CONTRACT,
  database,
  limitsSetLog,
  ORG,
  sealLedgerKeysPerTest,
  userOperationLog,
  WALLET,
  world,
  type World,
} from "./support/wallet-treasury-world";

/**
 * A live treasury's own wallet changes its contract's figures, or stops and resumes the agent's payments
 * (docs/superpowers/specs/2026-10-07-treasury-wallet-controls-design.md C4; review I2, I3): recorded from the chain only,
 * once per transaction, and only for a transaction whose own logs show that change. The state it acts on is read at a
 * block at or after the change's. The fake chain's contract holds 20 USDC a day and 60 in 7 days; its head is block 1000.
 */

sealLedgerKeysPerTest();

const CONTROL_TX = `0x${"c7".repeat(32)}` as Hex;
const OTHER = getAddress("0x5af3107a4000000000000000000000000000beef");
const NOT_THIS_CHANGE = "That transaction is not this change on the contract; nothing was recorded.";
const chosen = { org: { wallet_host: "external", mode: "live" }, operating: { address: WALLET } };
const live = (signer: "passkey" | "wallet") => agentRow({ treasury_signer: signer, address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true });
const ENTRY_POINT = getAddress("0x0000000071727de22e5e9d8baf0edac6f37da032");

type Log = NonNullable<TreasuryReceipt["logs"]>[number];
/** A passkey's change: a bundler's transaction, whose logs carry the user operation and what it did. */
const byPasskey = (...logs: Log[]): TreasuryReceipt => ({ status: "success", from: OTHER, to: ENTRY_POINT, contractAddress: null, blockNumber: 900n, logs: [userOperationLog(WALLET), ...logs] });
/** A browser wallet's change: its own transaction. */
const byWallet = (...logs: Log[]): TreasuryReceipt => ({ status: "success", from: WALLET, to: CONTRACT, contractAddress: null, blockNumber: 900n, logs });
const figuresSet = limitsSetLog(CONTRACT, 20_000_000n, 60_000_000n);
const stopped = approvalLog(WALLET, CONTRACT, 0n);
const resumed = approvalLog(WALLET, CONTRACT, maxUint256);

function pauses(state: { reason: string | null } | null = null) {
  return { state: vi.fn(async () => state), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
}

const control = (state: World, kind: WalletControlKind, onChain: TreasuryChain, agentPause = pauses(), hash: Hex = CONTROL_TX) =>
  database(state).inScope(() => recordWalletControl({ orgId: ORG, actorId: ACTOR, txHash: hash, kind }, { chain: onChain, agentPause }));

describe("recordWalletControl: figures", () => {
  it("makes the contract's figures the agent's spending limit once the change is mined, once", async () => {
    const state = world({ ...chosen, contract: live("passkey") });
    expect(await control(state, "figures", chain())).toEqual({ state: "pending" });
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byPasskey(figuresSet) } }))).toEqual({ state: "verified", loosened: false });
    expect(state.budget).toMatchObject({ daily_usdc: 20, weekly_usdc: 60 });
    expect(state.ledger).toEqual([
      {
        action: "agent_budget_changed",
        detail: { by: ACTOR, from: { dailyUsdc: 50, weeklyUsdc: 150 }, to: { dailyUsdc: 20, weeklyUsdc: 60 }, txHash: CONTROL_TX, onChain: { contract: CONTRACT, txHash: CONTROL_TX, signer: "passkey" } },
      },
    ]);
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byPasskey(figuresSet) } }))).toEqual({ state: "verified" });
    expect(state.ledger).toHaveLength(1);
  });

  it("says when a figure rose, so a payment held under the old one is decided again", async () => {
    const state = world({ ...chosen, contract: live("wallet"), budget: { daily_usdc: "10", weekly_usdc: "30" } });
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byWallet(figuresSet) } }))).toEqual({ state: "verified", loosened: true });
  });

  it("refuses a change that failed, or that this workspace's wallet did not send", async () => {
    const refused: TreasuryReceipt[] = [
      { ...byPasskey(figuresSet), status: "reverted" },
      { ...byPasskey(figuresSet), logs: [figuresSet] },
      { ...byPasskey(figuresSet), logs: [userOperationLog(OTHER), figuresSet] },
      { ...byPasskey(figuresSet), logs: [userOperationLog(WALLET, false), figuresSet] },
    ];
    for (const receipt of refused) {
      const state = world({ ...chosen, contract: live("passkey") });
      await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: receipt } }))).rejects.toMatchObject({ code: "chain_refused" });
      expect(state.ledger).toEqual([]);
    }
    const state = world({ ...chosen, contract: live("wallet") });
    await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: { ...byWallet(figuresSet), from: OTHER } } }))).rejects.toMatchObject({ code: "chain_refused" });
  });

  it("refuses a transaction of the wallet's that did not set this contract's figures", async () => {
    for (const receipt of [byWallet(), byWallet(stopped), byWallet(limitsSetLog(OTHER, 20_000_000n, 60_000_000n))]) {
      const state = world({ ...chosen, contract: live("wallet") });
      await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: receipt } }))).rejects.toMatchObject({ code: "chain_refused", message: NOT_THIS_CHANGE });
      expect(state.ledger).toEqual([]);
      expect(state.budget).toMatchObject({ daily_usdc: "50", weekly_usdc: "150" });
    }
  });

  it("waits for a node that has not reached the change's block, rather than reading the old figures", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byWallet(figuresSet) }, head: 899n }))).toEqual({ state: "pending" });
    expect(state.ledger).toEqual([]);
    const onChain = chain({ receipts: { [CONTROL_TX]: byWallet(figuresSet) }, head: 905n });
    expect(await control(state, "figures", onChain)).toMatchObject({ state: "verified" });
    expect(onChain.blocks.every((block) => block === 905n)).toBe(true);
  });

  it("records what this change set, and mirrors what the contract holds now", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const later = chain({ receipts: { [CONTROL_TX]: byWallet(limitsSetLog(CONTRACT, 10_000_000n, 30_000_000n)) }, figures: { daily: 25_000_000n, weekly: 75_000_000n } });
    await control(state, "figures", later);
    expect(state.ledger[0]?.detail).toMatchObject({ to: { dailyUsdc: 10, weeklyUsdc: 30 } });
    expect(state.budget).toMatchObject({ daily_usdc: 25, weekly_usdc: 75 });
  });

  it("is only for a treasury whose contract carries its payments", async () => {
    const state = world({ ...chosen, contract: agentRow({ treasury_signer: "passkey", address: CONTRACT }) });
    await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: byPasskey(figuresSet) } }))).rejects.toMatchObject({ code: "wrong_step" });
  });
});

describe("recordWalletControl: stop and resume", () => {
  it("pauses the agent with the stop's reason before it records the stop", async () => {
    const state = world({ ...chosen, contract: live("passkey") });
    const agentPause = pauses();
    agentPause.pause.mockImplementation(async () => {
      expect(state.ledger).toEqual([]);
    });
    expect(await control(state, "stop", chain({ receipts: { [CONTROL_TX]: byPasskey(stopped) }, allowance: 0n }), agentPause)).toEqual({ state: "verified" });
    expect(agentPause.pause).toHaveBeenCalledWith({ orgId: ORG, actorId: ACTOR, reason: OWNER_STOPPED });
    expect(state.ledger).toEqual([{ action: "spending_limit_stopped", detail: { by: ACTOR, contract: CONTRACT, txHash: CONTROL_TX, signer: "passkey" } }]);
  });

  it("records nothing when the pause fails, so the next try pauses and records", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const onChain = () => chain({ receipts: { [CONTROL_TX]: byWallet(stopped) }, allowance: 0n });
    const failing = pauses();
    failing.pause.mockRejectedValueOnce(new Error("the database did not answer"));
    await expect(control(state, "stop", onChain(), failing)).rejects.toThrow("the database did not answer");
    expect(state.ledger).toEqual([]);
    const agentPause = pauses();
    expect(await control(state, "stop", onChain(), agentPause)).toEqual({ state: "verified" });
    expect(agentPause.pause).toHaveBeenCalledTimes(1);
    expect(state.ledger).toHaveLength(1);
  });

  it("takes a pause that landed while it read as done", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const agentPause = pauses();
    agentPause.pause.mockRejectedValueOnce(new PauseError("already_paused"));
    expect(await control(state, "stop", chain({ receipts: { [CONTROL_TX]: byWallet(stopped) }, allowance: 0n }), agentPause)).toEqual({ state: "verified" });
    expect(state.ledger).toHaveLength(1);
  });

  it("does not pause an agent paused already", async () => {
    const agentPause = pauses({ reason: "Holiday" });
    await control(world({ ...chosen, contract: live("passkey") }), "stop", chain({ receipts: { [CONTROL_TX]: byPasskey(stopped) }, allowance: 0n }), agentPause);
    expect(agentPause.pause).not.toHaveBeenCalled();
  });

  it("refuses a transaction that did not approve nothing for this contract from this wallet", async () => {
    const notAStop = [byWallet(), byWallet(approvalLog(WALLET, CONTRACT, 5_000_000n)), byWallet(approvalLog(OTHER, CONTRACT, 0n)), byWallet(approvalLog(WALLET, OTHER, 0n)), byWallet(approvalLog(WALLET, CONTRACT, 0n, OTHER))];
    for (const receipt of notAStop) {
      const state = world({ ...chosen, contract: live("wallet") });
      await expect(control(state, "stop", chain({ receipts: { [CONTROL_TX]: receipt }, allowance: 0n }))).rejects.toMatchObject({ code: "chain_refused", message: NOT_THIS_CHANGE });
      expect(state.ledger).toEqual([]);
    }
  });

  it("records a stop a later approval undid, and leaves the agent running", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const agentPause = pauses();
    expect(await control(state, "stop", chain({ receipts: { [CONTROL_TX]: byWallet(stopped) }, allowance: maxUint256 }), agentPause)).toEqual({ state: "verified" });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["spending_limit_stopped"]);
    expect(agentPause.pause).not.toHaveBeenCalled();
  });

  it("lifts only the pause a stop set, before it records the resume", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const stoppedHere = pauses({ reason: OWNER_STOPPED });
    stoppedHere.resume.mockImplementation(async () => {
      expect(state.ledger).toEqual([]);
    });
    expect(await control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet(resumed) }, allowance: maxUint256 }), stoppedHere)).toEqual({ state: "verified", resumed: true });
    expect(state.ledger).toEqual([{ action: "spending_limit_resumed", detail: { by: ACTOR, contract: CONTRACT, txHash: CONTROL_TX, signer: "wallet", allowanceUsdc: null } }]);
    expect(stoppedHere.resume).toHaveBeenCalledWith({ orgId: ORG, actorId: ACTOR });

    const pausedForAnotherReason = pauses({ reason: "Holiday" });
    await control(world({ ...chosen, contract: live("wallet") }), "resume", chain({ receipts: { [CONTROL_TX]: byWallet(resumed) }, allowance: maxUint256 }), pausedForAnotherReason);
    expect(pausedForAnotherReason.resume).not.toHaveBeenCalled();
  });

  it("takes a resume that landed while it read as done", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const agentPause = pauses({ reason: OWNER_STOPPED });
    agentPause.resume.mockRejectedValueOnce(new PauseError("not_paused"));
    expect(await control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet(resumed) }, allowance: maxUint256 }), agentPause)).toMatchObject({ state: "verified" });
    expect(state.ledger).toHaveLength(1);
  });

  it("records a capped resume's cap from the transaction itself", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    await control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet(approvalLog(WALLET, CONTRACT, 250_000_000n)) }, allowance: 180_000_000n }));
    expect(state.ledger[0]?.detail).toMatchObject({ allowanceUsdc: 250 });
  });

  it("refuses a resume that approved nothing", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    await expect(control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet(stopped) }, allowance: 0n }))).rejects.toMatchObject({ code: "chain_refused", message: NOT_THIS_CHANGE });
  });

  it("records a resume a later stop undid, and keeps the agent paused", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const agentPause = pauses({ reason: OWNER_STOPPED });
    expect(await control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet(resumed) }, allowance: 0n }), agentPause)).toEqual({ state: "verified" });
    expect(agentPause.resume).not.toHaveBeenCalled();
    expect(state.ledger.map((entry) => entry.action)).toEqual(["spending_limit_resumed"]);
  });
});

describe("recordWalletControl: once per transaction", () => {
  it("refuses a transaction recorded already as another change", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const both = chain({ receipts: { [CONTROL_TX]: byWallet(stopped, figuresSet) }, allowance: 0n });
    await control(state, "stop", both);
    await expect(control(state, "figures", both)).rejects.toMatchObject({ code: "chain_refused", message: "That transaction is recorded already as another change; nothing was recorded." });
    expect(state.ledger).toHaveLength(1);
  });

  it("refuses the setup's own transaction", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const setup = chain({ receipts: { [APPROVE_TX.toLowerCase()]: byWallet(resumed) }, allowance: maxUint256 });
    await expect(control(state, "resume", setup, pauses(), APPROVE_TX as Hex)).rejects.toMatchObject({
      code: "chain_refused",
      message: "That transaction is recorded already as another change; nothing was recorded.",
    });
    expect(state.ledger).toEqual([]);
  });
});
