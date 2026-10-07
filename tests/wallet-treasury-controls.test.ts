import { getAddress, maxUint256, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { TreasuryChain, TreasuryReceipt } from "@/lib/treasury/chain";
import { OWNER_STOPPED, recordWalletControl, type WalletControlKind } from "@/lib/treasury/wallet-treasury";
import { ACTOR, agentRow, APPROVE_TX, chain, CONTRACT, database, ORG, sealLedgerKeysPerTest, USDC, userOperationLog, WALLET, world, type World } from "./support/wallet-treasury-world";

/**
 * A live treasury's own wallet changes its contract's figures, or stops and resumes the agent's payments
 * (docs/superpowers/specs/2026-10-07-treasury-wallet-controls-design.md C4): recorded from the chain only, once per
 * transaction. The fake chain's contract reads 20 USDC a day and 60 USDC in 7 days.
 */

sealLedgerKeysPerTest();

const CONTROL_TX = `0x${"c7".repeat(32)}` as Hex;
const OTHER = getAddress("0x5af3107a4000000000000000000000000000beef");
const chosen = { org: { wallet_host: "external", mode: "live" }, operating: { address: WALLET } };
const live = (signer: "passkey" | "wallet") => agentRow({ treasury_signer: signer, address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true });
const byPasskey: TreasuryReceipt = { status: "success", from: OTHER, to: getAddress("0x0000000071727de22e5e9d8baf0edac6f37da032"), contractAddress: null, logs: [userOperationLog(WALLET)] };
const byWallet: TreasuryReceipt = { status: "success", from: WALLET, to: CONTRACT, contractAddress: null };

function pauses(state: { reason: string | null } | null = null) {
  return { state: vi.fn(async () => state), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
}

const control = (state: World, kind: WalletControlKind, onChain: TreasuryChain, agentPause = pauses()) =>
  database(state).inScope(() => recordWalletControl({ orgId: ORG, actorId: ACTOR, txHash: CONTROL_TX, kind }, { chain: onChain, agentPause }));

describe("recordWalletControl: figures", () => {
  it("makes the contract's figures the agent's spending limit once the change is mined, once", async () => {
    const state = world({ ...chosen, contract: live("passkey") });
    expect(await control(state, "figures", chain())).toEqual({ state: "pending" });
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byPasskey } }))).toEqual({ state: "verified", loosened: false });
    expect(state.budget).toMatchObject({ daily_usdc: 20, weekly_usdc: 60 });
    expect(state.ledger).toEqual([
      {
        action: "agent_budget_changed",
        detail: { by: ACTOR, from: { dailyUsdc: 50, weeklyUsdc: 150 }, to: { dailyUsdc: 20, weeklyUsdc: 60 }, txHash: CONTROL_TX, onChain: { contract: CONTRACT, txHash: CONTROL_TX, signer: "passkey" } },
      },
    ]);
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byPasskey } }))).toEqual({ state: "verified" });
    expect(state.ledger).toHaveLength(1);
  });

  it("says when a figure rose, so a payment held under the old one is decided again", async () => {
    const state = world({ ...chosen, contract: live("wallet"), budget: { daily_usdc: "10", weekly_usdc: "30" } });
    expect(await control(state, "figures", chain({ receipts: { [CONTROL_TX]: byWallet } }))).toEqual({ state: "verified", loosened: true });
  });

  it("refuses a change that failed, or that this workspace's wallet did not send", async () => {
    const refused: TreasuryReceipt[] = [
      { ...byPasskey, status: "reverted" },
      { ...byPasskey, logs: [] },
      { ...byPasskey, logs: [userOperationLog(OTHER)] },
      { ...byPasskey, logs: [userOperationLog(WALLET, false)] },
    ];
    for (const receipt of refused) {
      const state = world({ ...chosen, contract: live("passkey") });
      await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: receipt } }))).rejects.toMatchObject({ code: "chain_refused" });
      expect(state.ledger).toEqual([]);
    }
    const state = world({ ...chosen, contract: live("wallet") });
    await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: { ...byWallet, from: OTHER } } }))).rejects.toMatchObject({ code: "chain_refused" });
  });

  it("is only for a treasury whose contract carries its payments", async () => {
    const state = world({ ...chosen, contract: agentRow({ treasury_signer: "passkey", address: CONTRACT }) });
    await expect(control(state, "figures", chain({ receipts: { [CONTROL_TX]: byPasskey } }))).rejects.toMatchObject({ code: "wrong_step" });
  });
});

describe("recordWalletControl: stop and resume", () => {
  it("records a stop once the contract may move nothing, and pauses the agent with the reason", async () => {
    const state = world({ ...chosen, contract: live("passkey") });
    const agentPause = pauses();
    expect(await control(state, "stop", chain({ receipts: { [CONTROL_TX]: byPasskey }, allowance: 0n }), agentPause)).toEqual({ state: "verified" });
    expect(state.ledger).toEqual([{ action: "spending_limit_stopped", detail: { by: ACTOR, contract: CONTRACT, txHash: CONTROL_TX, signer: "passkey" } }]);
    expect(agentPause.pause).toHaveBeenCalledWith({ orgId: ORG, actorId: ACTOR, reason: OWNER_STOPPED });
  });

  it("does not pause an agent paused already", async () => {
    const agentPause = pauses({ reason: "Holiday" });
    await control(world({ ...chosen, contract: live("passkey") }), "stop", chain({ receipts: { [CONTROL_TX]: byPasskey }, allowance: 0n }), agentPause);
    expect(agentPause.pause).not.toHaveBeenCalled();
  });

  it("refuses a stop while the contract may still move the wallet's USDC", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    await expect(control(state, "stop", chain({ receipts: { [CONTROL_TX]: byWallet }, allowance: 5_000_000n }))).rejects.toMatchObject({ code: "chain_refused" });
    expect(state.ledger).toEqual([]);
  });

  it("records a resume once the contract may move USDC again, and lifts only the pause a stop set", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    const stoppedHere = pauses({ reason: OWNER_STOPPED });
    expect(await control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet }, allowance: maxUint256 }), stoppedHere)).toEqual({ state: "verified", resumed: true });
    expect(state.ledger).toEqual([{ action: "spending_limit_resumed", detail: { by: ACTOR, contract: CONTRACT, txHash: CONTROL_TX, signer: "wallet", allowanceUsdc: null } }]);
    expect(stoppedHere.resume).toHaveBeenCalledWith({ orgId: ORG, actorId: ACTOR });

    const pausedForAnotherReason = pauses({ reason: "Holiday" });
    await control(world({ ...chosen, contract: live("wallet") }), "resume", chain({ receipts: { [CONTROL_TX]: byWallet }, allowance: 250_000_000n }), pausedForAnotherReason);
    expect(pausedForAnotherReason.resume).not.toHaveBeenCalled();
  });

  it("records a capped resume's cap, and refuses one that left nothing approved", async () => {
    const state = world({ ...chosen, contract: live("wallet") });
    await control(state, "resume", chain({ receipts: { [CONTROL_TX]: byWallet }, allowance: 250_000_000n }));
    expect(state.ledger[0]?.detail).toMatchObject({ allowanceUsdc: 250 });
    await expect(control(world({ ...chosen, contract: live("wallet") }), "resume", chain({ receipts: { [CONTROL_TX]: byWallet }, allowance: 0n }))).rejects.toMatchObject({
      code: "chain_refused",
    });
  });
});

void USDC;
