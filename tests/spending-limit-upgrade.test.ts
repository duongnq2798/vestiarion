import { describe, expect, it } from "vitest";
import { getAddress, maxUint256, encodeFunctionData, erc20Abi, type Hex } from "viem";
import { ARC_MAINNET } from "@/lib/network";
import { passkeyUpgradeCalls, spendingLimitSalt } from "@/lib/passkey-treasury";
import { deploymentData, spendingLimitTerms, type SpendingLimitTerms } from "@/lib/spending-limit/deployment";
import {
  preparePasskeyUpgrade,
  prepareRevokePrevious,
  prepareUpgradeApproval,
  prepareUpgradeDeployment,
  recordPasskeyUpgrade,
  recordRevokePrevious,
  recordUpgradeApproval,
  recordUpgradeDeployment,
} from "@/lib/treasury/contract-upgrade";
import { walletTreasuryStatus } from "@/lib/treasury/wallet-treasury";
import {
  ACTOR,
  AGENT,
  agentRow,
  APPROVE_TX,
  approvalLog,
  approvedOnUsdc,
  chain,
  chosen,
  CONTRACT,
  database,
  deployedAt,
  ORG,
  ourCode,
  ourCodeV2,
  sealLedgerKeysPerTest,
  SECOND_CONTRACT,
  USDC,
  userOperationLog,
  WALLET,
  world,
  type World,
} from "./support/wallet-treasury-world";

/**
 * The upgrade of a live workspace's spending limit contract to version 2 (docs/superpowers/specs/2026-10-19-spending-
 * limit-v2-cross-chain-design.md V9, V10): offered while version 1 carries the payments; a browser wallet deploys
 * version 2 with version 1's figures, approves it (the switch, never while a payment is in flight) and takes version 1's
 * approval back; a passkey does all of it in one user operation. Every step is read back from the chain first.
 */

sealLedgerKeysPerTest();

const TERMS = spendingLimitTerms(ARC_MAINNET) as SpendingLimitTerms;
const V2 = SECOND_CONTRACT;
const UPGRADE_TX = `0x${"e2".repeat(32)}` as Hex;
const REVOKE_TX = `0x${"0e".repeat(32)}` as Hex;
const live = { ...chosen, org: { wallet_host: "external", mode: "live" } };
const v1Row = (extra: Record<string, unknown> = {}) =>
  agentRow({ address: CONTRACT, deploy_tx_hash: `0x${"d1".repeat(32)}`, approve_tx_hash: APPROVE_TX, enforced: true, version: 1, ...extra });
const inScope = <T>(state: World, fn: () => Promise<T>) => database(state).inScope(fn);

describe("the upgrade's place in the status", () => {
  it("is offered for version 1, asks for the approval once version 2 is deployed, and for the revocation until version 1 reads 0", async () => {
    const status = (state: World, allowances: Record<string, bigint> = {}) =>
      inScope(state, () => walletTreasuryStatus(ORG, { chain: chain({ allowance: 1n, allowances, gas: 500_000_000_000_000_000n }) }));
    expect((await status(world({ ...live, contract: v1Row() }))).upgrade).toEqual({ state: "offer", next: null, previous: null });
    expect((await status(world({ ...live, contract: v1Row({ next_address: V2 }) }))).upgrade).toEqual({ state: "approve", next: V2, previous: null });
    const switched = () => world({ ...live, contract: v1Row({ address: V2, version: 2, previous_address: CONTRACT }) });
    expect(await status(switched(), { [CONTRACT.toLowerCase()]: 5n })).toMatchObject({ version: 2, upgrade: { state: "revoke", previous: CONTRACT } });
    expect(await status(switched(), { [CONTRACT.toLowerCase()]: 0n })).toMatchObject({ version: 2, upgrade: null });
    // A row from before migration 0132, with no version at all, reads as version 1.
    expect(await status(world({ ...live, contract: v1Row({ version: undefined }) }))).toMatchObject({ version: 1, upgrade: { state: "offer" } });
  });
});

describe("a browser wallet's upgrade", () => {
  it("deploys version 2 with the figures version 1 holds now, for this wallet and agent", async () => {
    const state = world({ ...live, contract: v1Row() });
    const prepared = await inScope(state, () => prepareUpgradeDeployment({ orgId: ORG }, { chain: chain({ figures: { daily: 20_000_000n, weekly: 60_000_000n } }) }));
    expect(prepared).toEqual({
      to: null,
      data: deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 20_000_000n, weeklyUnits: 60_000_000n, terms: TERMS }),
      value: "0",
      chainId: 5042,
    });
  });

  it("records version 2 as the contract to come, refusing a deployment of version 1", async () => {
    const state = world({ ...live, contract: v1Row() });
    const deployed = (code: Hex) => chain({ receipts: { [UPGRADE_TX]: deployedAt(V2) }, code: { [V2.toLowerCase()]: code } });
    await expect(inScope(state, () => recordUpgradeDeployment({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX }, { chain: deployed(ourCode) }))).rejects.toMatchObject({
      code: "chain_refused",
    });
    expect(await inScope(state, () => recordUpgradeDeployment({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX }, { chain: deployed(ourCodeV2) }))).toBe("verified");
    expect(state.contract).toMatchObject({ address: CONTRACT, version: 1, next_address: V2, next_deploy_tx_hash: UPGRADE_TX });
    expect(state.ledger.at(-1)).toMatchObject({ action: "spending_limit_deployed", detail: { contract: V2, version: 2, replaces: CONTRACT } });
    // Asked again, answered, not recorded twice.
    const entries = state.ledger.length;
    expect(await inScope(state, () => recordUpgradeDeployment({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX }, { chain: deployed(ourCodeV2) }))).toBe("verified");
    expect(state.ledger).toHaveLength(entries);
  });

  it("approves version 2 and switches to it, keeping version 1 to revoke", async () => {
    const state = world({ ...live, contract: v1Row({ next_address: V2, next_deploy_tx_hash: UPGRADE_TX }) });
    const approval = await inScope(state, () => prepareUpgradeApproval({ orgId: ORG, capUsdc: null }));
    expect(approval).toEqual({ to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [V2, maxUint256] }), value: "0", chainId: 5042 });
    const NEW_APPROVE = `0x${"a2".repeat(32)}` as Hex;
    const onChain = chain({ receipts: { [NEW_APPROVE]: approvedOnUsdc }, allowances: { [V2.toLowerCase()]: 2n ** 256n - 1n } });
    expect(await inScope(state, () => recordUpgradeApproval({ orgId: ORG, actorId: ACTOR, txHash: NEW_APPROVE }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({
      address: V2,
      version: 2,
      previous_address: CONTRACT,
      deploy_tx_hash: UPGRADE_TX,
      approve_tx_hash: NEW_APPROVE,
      next_address: null,
      next_deploy_tx_hash: null,
      enforced: true,
    });
    expect(state.ledger.at(-1)).toMatchObject({
      action: "spending_limit_upgraded",
      detail: { from: CONTRACT, to: V2, version: 2, signer: "wallet", approveTxHash: NEW_APPROVE, deployTxHash: UPGRADE_TX, revokeTxHash: null, allowanceUsdc: null },
    });
  });

  it("never switches while a payment is in flight: version 2's paid refs start empty", async () => {
    for (const status of ["submitting", "pending"]) {
      const state = world({ ...live, contract: v1Row({ next_address: V2, next_deploy_tx_hash: UPGRADE_TX }), intents: [{ id: "pi-1", status }] });
      const approved = `0x${"a3".repeat(32)}` as Hex;
      const onChain = chain({ receipts: { [approved]: approvedOnUsdc }, allowance: 1n });
      await expect(inScope(state, () => recordUpgradeApproval({ orgId: ORG, actorId: ACTOR, txHash: approved }, { chain: onChain }))).rejects.toMatchObject({ code: "in_flight" });
      expect(state.contract).toMatchObject({ address: CONTRACT, next_address: V2 });
    }
    const settled = world({ ...live, contract: v1Row(), intents: [{ id: "pi-1", status: "confirmed" }] });
    await expect(inScope(settled, () => prepareUpgradeDeployment({ orgId: ORG }, { chain: chain() }))).resolves.toMatchObject({ to: null });
  });

  it("records version 1's revocation only from USDC's own Approval of 0 and an allowance that reads 0", async () => {
    const state = world({ ...live, contract: v1Row({ address: V2, version: 2, previous_address: CONTRACT }) });
    expect(await inScope(state, () => prepareRevokePrevious({ orgId: ORG }))).toEqual({
      to: USDC,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACT, 0n] }),
      value: "0",
      chainId: 5042,
    });
    const revoked = (logs: ReturnType<typeof approvalLog>[], left: bigint) =>
      chain({ receipts: { [REVOKE_TX]: { status: "success", from: WALLET, to: USDC, contractAddress: null, blockNumber: 900n, logs } }, allowances: { [CONTRACT.toLowerCase()]: left } });
    // The approval of the new contract is not a revocation of the old one.
    await expect(inScope(state, () => recordRevokePrevious({ orgId: ORG, actorId: ACTOR, txHash: REVOKE_TX }, { chain: revoked([approvalLog(WALLET, V2, 0n)], 0n) }))).rejects.toMatchObject({
      code: "chain_refused",
    });
    await expect(inScope(state, () => recordRevokePrevious({ orgId: ORG, actorId: ACTOR, txHash: REVOKE_TX }, { chain: revoked([approvalLog(WALLET, CONTRACT, 0n)], 3n) }))).rejects.toMatchObject({
      code: "chain_refused",
    });
    expect(await inScope(state, () => recordRevokePrevious({ orgId: ORG, actorId: ACTOR, txHash: REVOKE_TX }, { chain: revoked([approvalLog(WALLET, CONTRACT, 0n)], 0n) }))).toBe("verified");
    expect(state.contract).toMatchObject({ previous_revoke_tx_hash: REVOKE_TX });
    expect(state.ledger.at(-1)).toEqual({ action: "spending_limit_revoked", detail: { by: ACTOR, contract: CONTRACT, replacedBy: V2, txHash: REVOKE_TX } });
  });

  it("is refused before the contract is enforced, once switched, and for a passkey wallet", async () => {
    await expect(inScope(world({ ...live, contract: v1Row({ enforced: false }) }), () => prepareUpgradeDeployment({ orgId: ORG }, { chain: chain() }))).rejects.toMatchObject({ code: "wrong_step" });
    await expect(inScope(world({ ...live, contract: v1Row({ version: 2 }) }), () => prepareUpgradeDeployment({ orgId: ORG }, { chain: chain() }))).rejects.toMatchObject({ code: "wrong_step" });
    await expect(inScope(world({ ...live, contract: v1Row({ treasury_signer: "passkey" }) }), () => prepareUpgradeDeployment({ orgId: ORG }, { chain: chain() }))).rejects.toMatchObject({
      code: "wrong_step",
    });
    await expect(inScope(world({ ...live, contract: v1Row() }), () => prepareUpgradeApproval({ orgId: ORG, capUsdc: null }))).rejects.toMatchObject({ code: "wrong_step" });
    await expect(inScope(world({ ...live, contract: v1Row() }), () => prepareRevokePrevious({ orgId: ORG }))).rejects.toMatchObject({ code: "wrong_step" });
  });
});

describe("a passkey wallet's upgrade, with one confirmation", () => {
  const passkeyLive = (extra: Record<string, unknown> = {}) => world({ ...live, contract: v1Row({ treasury_signer: "passkey", recovery_skipped_at: "2026-10-07T00:00:00Z", ...extra }) });
  const planned = (deployed: boolean, capUnits: bigint | null = null) =>
    passkeyUpgradeCalls({
      usdc: USDC,
      treasury: WALLET,
      agent: AGENT,
      dailyUnits: 20_000_000n,
      weeklyUnits: 60_000_000n,
      capUnits,
      salt: spendingLimitSalt(ORG),
      deployed,
      terms: TERMS,
      previous: CONTRACT,
    });

  it("deploys version 2, sets version 1's figures, approves it and takes version 1's approval back, in that order", async () => {
    const expected = planned(false, 100_000_000n);
    const prepared = await inScope(passkeyLive(), () => preparePasskeyUpgrade({ orgId: ORG, capUsdc: 100 }, { chain: chain() }));
    expect(prepared).toEqual({
      contract: expected.contract,
      previous: CONTRACT,
      salt: spendingLimitSalt(ORG),
      deployed: false,
      dailyUnits: "20000000",
      weeklyUnits: "60000000",
      capUnits: "100000000",
      calls: expected.calls.map((call) => ({ ...call, value: call.value.toString() })),
      chainId: 5042,
    });
    expect(expected.calls.map((call) => call.to)).toEqual([
      getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C"),
      expected.contract,
      USDC,
      USDC,
    ]);
    expect(expected.calls[3].data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACT, 0n] }));
    // Version 2 at its address already, from an upgrade whose recording was lost: not deployed twice.
    const again = await inScope(passkeyLive(), () => preparePasskeyUpgrade({ orgId: ORG, capUsdc: null }, { chain: chain({ code: { [expected.contract.toLowerCase()]: "0x6080" } }) }));
    expect(again.deployed).toBe(true);
    expect(again.calls).toHaveLength(3);
  });

  it("records it from the user operation, version 2's code, its approval and version 1's allowance of 0", async () => {
    const contract = planned(false).contract;
    const receipt = { status: "success" as const, from: getAddress("0x00000000000000000000000000000000000b0d1e"), to: null, contractAddress: null, blockNumber: 900n, logs: [userOperationLog(WALLET)] };
    const onChain = (left: bigint) =>
      chain({ receipts: { [UPGRADE_TX]: receipt }, code: { [contract.toLowerCase()]: ourCodeV2 }, allowances: { [contract.toLowerCase()]: 2n ** 256n - 1n, [CONTRACT.toLowerCase()]: left } });
    const state = passkeyLive();
    await expect(inScope(state, () => recordPasskeyUpgrade({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX, contract }, { chain: onChain(5n) }))).rejects.toMatchObject({ code: "chain_refused" });
    expect(state.ledger).toEqual([]);
    expect(await inScope(state, () => recordPasskeyUpgrade({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX, contract }, { chain: onChain(0n) }))).toBe("verified");
    expect(state.contract).toMatchObject({ address: contract, version: 2, previous_address: CONTRACT, previous_revoke_tx_hash: UPGRADE_TX, approve_tx_hash: UPGRADE_TX });
    // The workspace's limit (50 and 150) follows the figures version 2 holds, version 1's (20 and 60).
    expect(state.ledger.map((entry) => entry.action)).toEqual(["agent_budget_changed", "spending_limit_deployed", "spending_limit_upgraded"]);
    expect(state.budget).toMatchObject({ daily_usdc: 20, weekly_usdc: 60 });
    expect(state.ledger[2].detail).toMatchObject({ from: CONTRACT, to: contract, signer: "passkey", revokeTxHash: UPGRADE_TX });
    expect(await inScope(state, () => recordPasskeyUpgrade({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX, contract }, { chain: onChain(0n) }))).toBe("verified");
    expect(state.ledger).toHaveLength(3);
  });

  it("records nothing while a payment is in flight, so it is asked about again once it settles", async () => {
    const contract = planned(false).contract;
    const receipt = { status: "success" as const, from: WALLET, to: null, contractAddress: null, logs: [userOperationLog(WALLET)] };
    const state = passkeyLive();
    state.intents.push({ id: "pi-1", status: "pending" });
    const onChain = chain({ receipts: { [UPGRADE_TX]: receipt }, code: { [contract.toLowerCase()]: ourCodeV2 }, allowances: { [contract.toLowerCase()]: 1n, [CONTRACT.toLowerCase()]: 0n } });
    await expect(inScope(state, () => recordPasskeyUpgrade({ orgId: ORG, actorId: ACTOR, txHash: UPGRADE_TX, contract }, { chain: onChain }))).rejects.toMatchObject({ code: "in_flight" });
    expect(state.ledger).toEqual([]);
    expect(state.contract).toMatchObject({ address: CONTRACT });
  });
});
