import { decodeFunctionResult, encodeFunctionData, erc20Abi, maxUint256, type Hex } from "viem";
import { db, unwrap } from "../dal";
import { readOutflowBudget } from "../agent/outflow-budget";
import type { NetworkProfile } from "../network";
import { passkeyUpgradeCalls, spendingLimitSalt } from "../passkey-treasury";
import { deploymentData, spendingLimitTerms, type SpendingLimitTerms } from "../spending-limit/deployment";
import { SPENDING_LIMIT_ABI, usdcUnits } from "../spending-limit/onchain";
import { asAddress, treasuryChain, type TreasuryChain } from "./chain";
import { approvalIn, userOperationSucceeded, verifyApproval, verifyDeployedAt, verifyDeployment } from "./verify";
import {
  contractVersion,
  inScopeOf,
  readOrRefuse,
  record,
  recordDeployedContract,
  setup,
  txHash,
  UNLIMITED,
  WalletTreasuryError,
  type ContractRow,
  type PreparedTransaction,
  type WalletTreasuryDeps,
} from "./wallet-treasury";

/**
 * An owner upgrades their workspace's spending limit contract from version 1 to version 2, which also pays a payee on
 * another chain (docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md V10). A browser wallet sends
 * three transactions: version 2 deployed with the figures version 1 holds, version 2 approved on USDC (the switch), and
 * version 1's approval taken back. A passkey sends all of it as one user operation. As in the setup (W7), the server
 * builds every transaction and reads every result back from the chain before it records it. Live workspaces too: the
 * upgrade changes what the agent pays through, never whether the workspace is live.
 */

/** Where an upgrade starts and goes on: an enforced version 1 contract, its owner's wallet, and the network's terms. */
async function upgrading(): Promise<{ wallet: Hex; row: ContractRow; network: NetworkProfile; terms: SpendingLimitTerms; current: Hex }> {
  const { wallet, row, network } = await setup({ agent: true, contract: true });
  if (!row?.enforced || !row.address) throw new WalletTreasuryError("wrong_step", "Set up the wallet first.");
  const terms = spendingLimitTerms(network);
  if (!terms) throw new WalletTreasuryError("wrong_step", `${network.label} has no CCTP to pay other chains through.`);
  return { wallet, row, network, terms, current: asAddress(row.address) };
}

/** The figures a contract holds, in units, as the chain answers now. */
async function heldFigures(chain: TreasuryChain, contract: Hex): Promise<{ daily: bigint; weekly: bigint }> {
  const figure = async (functionName: "dailyLimit" | "weeklyLimit") =>
    readOrRefuse(async () => decodeFunctionResult({ abi: SPENDING_LIMIT_ABI, functionName, data: await chain.read(contract, encodeFunctionData({ abi: SPENDING_LIMIT_ABI, functionName })) }) as bigint);
  return { daily: await figure("dailyLimit"), weekly: await figure("weeklyLimit") };
}

/**
 * Refused while any payment is in flight (V10): version 2's `paid` starts empty, so a payment sent through version 1 and
 * sent again through version 2 under its key would be two payments. The switch waits until it settles.
 */
async function refuseWhilePaymentsInFlight(): Promise<void> {
  const found = unwrap(await db().from("payment_intents").select("id").in("status", ["submitting", "pending"]).limit(1)) as Array<{ id: string }>;
  if (found.length > 0) throw new WalletTreasuryError("in_flight");
}

const capUnitsOf = (capUsdc: number | null): bigint => {
  if (capUsdc !== null && !(Number.isFinite(capUsdc) && capUsdc > 0 && usdcUnits(capUsdc) > 0n)) throw new WalletTreasuryError("invalid_figures", "Set a cap above 0 USDC, or none.");
  return capUsdc === null ? maxUint256 : usdcUnits(capUsdc);
};

/** The browser wallet's deployment of version 2, with the figures version 1 holds now (V10, step 1). */
export async function prepareUpgradeDeployment(input: { orgId: string }, deps: WalletTreasuryDeps = {}): Promise<PreparedTransaction> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { wallet, row, network, terms, current } = await upgrading();
    if (contractVersion(row.version) !== 1) throw new WalletTreasuryError("wrong_step", "The contract is version 2 already.");
    if (row.treasury_signer === "passkey") throw new WalletTreasuryError("wrong_step", "A passkey wallet upgrades with one confirmation.");
    await refuseWhilePaymentsInFlight();
    const figures = await heldFigures(deps.chain ?? treasuryChain(network), current);
    return {
      to: null,
      data: deploymentData({ usdc: network.tokens.USDC, treasury: wallet, agent: row.agent_address as string, dailyUnits: figures.daily, weeklyUnits: figures.weekly, terms }),
      value: "0",
      chainId: network.chainId,
    };
  });
}

/**
 * Records the browser wallet's deployment of version 2 once the chain shows it (V10, step 1): version 2's code for this
 * wallet and agent, with the network's terms. Kept as the contract to come; a later one replaces it until it is approved.
 */
export async function recordUpgradeDeployment(input: { orgId: string; actorId: string; txHash: string }, deps: WalletTreasuryDeps = {}): Promise<"pending" | "verified"> {
  const hash = txHash(input.txHash);
  return inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network, terms, current } = await upgrading();
    if (row.next_deploy_tx_hash === hash || (contractVersion(row.version) === 2 && row.deploy_tx_hash === hash)) return "verified";
    if (contractVersion(row.version) !== 1) throw new WalletTreasuryError("wrong_step", "The contract is version 2 already.");
    const chain = deps.chain ?? treasuryChain(network);
    const check = await readOrRefuse(() =>
      verifyDeployment(chain, { txHash: hash, usdc: network.tokens.USDC, treasury: wallet, agent: row.agent_address as string, terms, versions: [2] })
    );
    if (check.state === "pending") return "pending";
    if (check.state === "refused") throw new WalletTreasuryError("chain_refused", check.reason);
    const written = unwrap(
      await db()
        .from("spending_limit_contracts")
        .update({ next_address: check.contract, next_deploy_tx_hash: hash })
        .eq("id", row.id)
        .eq("version", 1)
        .eq("address", row.address as string)
        .select("id")
    ) as Array<{ id: string }>;
    if (written.length === 0) throw new WalletTreasuryError("wrong_step", "The contract changed meanwhile; reload the page.");
    await recordDeployedContract({
      orgId: input.orgId,
      actorId: input.actorId,
      contract: check.contract,
      hash,
      dailyUnits: check.dailyUnits,
      weeklyUnits: check.weeklyUnits,
      version: 2,
      replaces: current,
    });
    return "verified";
  });
}

/** The browser wallet's approval of version 2 on USDC (V10, step 2): unlimited unless capped, as the setup's. */
export async function prepareUpgradeApproval(input: { orgId: string; capUsdc: number | null }): Promise<PreparedTransaction> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { row, network } = await upgrading();
    if (contractVersion(row.version) !== 1 || !row.next_address) throw new WalletTreasuryError("wrong_step", "Deploy the new contract first.");
    return {
      to: asAddress(network.tokens.USDC),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [asAddress(row.next_address), capUnitsOf(input.capUsdc)] }),
      value: "0",
      chainId: network.chainId,
    };
  });
}

/**
 * Makes version 2 the contract (V9, V10): it carries every payment from here on, version 1 is kept as the one it replaced,
 * and the ledger says so. Only while no payment is in flight, and only from the row as it was read.
 */
async function switchToVersion2(input: {
  orgId: string;
  actorId: string;
  row: ContractRow;
  wallet: Hex;
  next: Hex;
  deployTxHash: Hex | null;
  approveTxHash: Hex;
  revokeTxHash: Hex | null;
  allowanceUnits: bigint;
  signer: "wallet" | "passkey";
}): Promise<void> {
  await refuseWhilePaymentsInFlight();
  const previous = asAddress(input.row.address as string);
  const written = unwrap(
    await db()
      .from("spending_limit_contracts")
      .update({
        address: input.next,
        deploy_tx_hash: input.deployTxHash,
        approve_tx_hash: input.approveTxHash,
        version: 2,
        previous_address: previous,
        previous_revoke_tx_hash: input.revokeTxHash,
        next_address: null,
        next_deploy_tx_hash: null,
      })
      .eq("id", input.row.id)
      .eq("version", 1)
      .eq("address", input.row.address as string)
      .select("id")
  ) as Array<{ id: string }>;
  if (written.length === 0) throw new WalletTreasuryError("wrong_step", "The contract changed meanwhile; reload the page.");
  const figures = await readOutflowBudget(db());
  await record(input.orgId, input.actorId, {
    action: "spending_limit_upgraded",
    summary: `The owner's wallet moved the agent's payments to version 2 of its spending limit contract, ${input.next}, which also pays other chains`,
    detail: {
      by: input.actorId,
      from: previous,
      to: input.next,
      version: 2,
      agent: asAddress(input.row.agent_address as string),
      treasury: input.wallet,
      signer: input.signer,
      dailyUsdc: figures?.dailyUsdc ?? null,
      weeklyUsdc: figures?.weeklyUsdc ?? null,
      deployTxHash: input.deployTxHash,
      approveTxHash: input.approveTxHash,
      revokeTxHash: input.revokeTxHash,
      allowanceUsdc: input.allowanceUnits >= UNLIMITED ? null : Number(input.allowanceUnits) / 1_000_000,
    },
  });
}

/** Records the browser wallet's approval of version 2 once the chain shows it, and switches to it (V10, step 2). */
export async function recordUpgradeApproval(input: { orgId: string; actorId: string; txHash: string }, deps: WalletTreasuryDeps = {}): Promise<"pending" | "verified"> {
  const hash = txHash(input.txHash);
  return inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network } = await upgrading();
    if (contractVersion(row.version) === 2 && row.approve_tx_hash === hash) return "verified";
    if (contractVersion(row.version) !== 1 || !row.next_address) throw new WalletTreasuryError("wrong_step", "Deploy the new contract first.");
    const next = asAddress(row.next_address);
    const chain = deps.chain ?? treasuryChain(network);
    const check = await readOrRefuse(() => verifyApproval(chain, { txHash: hash, usdc: network.tokens.USDC, treasury: wallet, contract: next, minimumUnits: 1n }));
    if (check.state === "pending") return "pending";
    if (check.state === "refused") throw new WalletTreasuryError("chain_refused", check.reason);
    await switchToVersion2({
      orgId: input.orgId,
      actorId: input.actorId,
      row,
      wallet,
      next,
      deployTxHash: row.next_deploy_tx_hash ? txHash(row.next_deploy_tx_hash) : null,
      approveTxHash: hash,
      revokeTxHash: null,
      allowanceUnits: check.allowanceUnits,
      signer: "wallet",
    });
    return "verified";
  });
}

/** The version 2 contract that replaced version 1, and that version 1, once switched (V10, step 3). */
async function replaced(): Promise<{ wallet: Hex; row: ContractRow; network: NetworkProfile; previous: Hex }> {
  const { wallet, row, network } = await setup({ agent: true, contract: true });
  if (!row || contractVersion(row.version) !== 2 || !row.previous_address) throw new WalletTreasuryError("wrong_step", "There is no earlier contract to revoke.");
  return { wallet, row, network, previous: asAddress(row.previous_address) };
}

/** The browser wallet's revocation of version 1: its approval on USDC set to 0 (V10, step 3). */
export async function prepareRevokePrevious(input: { orgId: string }): Promise<PreparedTransaction> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { network, previous } = await replaced();
    return {
      to: asAddress(network.tokens.USDC),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [previous, 0n] }),
      value: "0",
      chainId: network.chainId,
    };
  });
}

/**
 * Records the revocation of version 1 once the chain shows it (V10, step 3): from this wallet, USDC's own `Approval` of
 * 0 to version 1 in its logs, and the allowance reading 0 at a block at or after it.
 */
export async function recordRevokePrevious(input: { orgId: string; actorId: string; txHash: string }, deps: WalletTreasuryDeps = {}): Promise<"pending" | "verified"> {
  const hash = txHash(input.txHash);
  return inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network, previous } = await replaced();
    if (row.previous_revoke_tx_hash === hash) return "verified";
    const chain = deps.chain ?? treasuryChain(network);
    const receipt = await readOrRefuse(() => chain.receipt(hash));
    if (!receipt) return "pending";
    const fromWallet = row.treasury_signer === "passkey" ? userOperationSucceeded(receipt, wallet) : receipt.from.toLowerCase() === wallet.toLowerCase();
    if (receipt.status !== "success" || !fromWallet) {
      throw new WalletTreasuryError("chain_refused", "That transaction failed, or this workspace's wallet did not send it; nothing was recorded.");
    }
    if (approvalIn(receipt, { token: asAddress(network.tokens.USDC), owner: wallet, spender: previous }) !== 0n) {
      throw new WalletTreasuryError("chain_refused", "That transaction does not take the earlier contract's approval back; nothing was recorded.");
    }
    const head = await readOrRefuse(() => chain.blockNumber());
    if (receipt.blockNumber !== undefined && head < receipt.blockNumber) return "pending";
    if ((await readOrRefuse(() => chain.allowance(wallet, previous, head))) !== 0n) {
      throw new WalletTreasuryError("chain_refused", "The earlier contract is still approved: a later approval undid this one. Revoke it again.");
    }
    const written = unwrap(
      await db().from("spending_limit_contracts").update({ previous_revoke_tx_hash: hash }).eq("id", row.id).eq("previous_address", previous).select("id")
    ) as Array<{ id: string }>;
    if (written.length === 0) throw new WalletTreasuryError("wrong_step", "The contract changed meanwhile; reload the page.");
    await record(input.orgId, input.actorId, {
      action: "spending_limit_revoked",
      summary: `The owner's wallet took back the approval of its earlier spending limit contract ${previous}, which can move none of its USDC now`,
      detail: { by: input.actorId, contract: previous, replacedBy: asAddress(row.address as string), txHash: hash },
    });
    return "verified";
  });
}

/** A passkey wallet's upgrade as the server built it (V10), with what the browser needs to build it again itself. */
export interface PreparedPasskeyUpgrade {
  contract: Hex;
  previous: Hex;
  salt: Hex;
  /** Version 2 is at its address already, from an upgrade whose recording was lost: the deploy call is left out. */
  deployed: boolean;
  /** The figures version 1 holds, in units, which version 2 is set to. */
  dailyUnits: string;
  weeklyUnits: string;
  capUnits: string | null;
  calls: Array<{ to: Hex; data: Hex; value: string }>;
  chainId: number;
}

/** The calls a passkey wallet's one confirmation makes to upgrade (V10): deploy, figures, approve, revoke. */
export async function preparePasskeyUpgrade(input: { orgId: string; capUsdc: number | null }, deps: WalletTreasuryDeps = {}): Promise<PreparedPasskeyUpgrade> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { wallet, row, network, terms, current } = await upgrading();
    if (row.treasury_signer !== "passkey") throw new WalletTreasuryError("wrong_step", "This workspace's wallet is not a passkey wallet.");
    if (contractVersion(row.version) !== 1) throw new WalletTreasuryError("wrong_step", "The contract is version 2 already.");
    await refuseWhilePaymentsInFlight();
    const capUnits = input.capUsdc === null ? null : capUnitsOf(input.capUsdc);
    const chain = deps.chain ?? treasuryChain(network);
    const figures = await heldFigures(chain, current);
    const salt = spendingLimitSalt(input.orgId);
    const base = { usdc: network.tokens.USDC, treasury: wallet, agent: row.agent_address as string, dailyUnits: figures.daily, weeklyUnits: figures.weekly, capUnits, salt, terms, previous: current };
    const planned = passkeyUpgradeCalls({ ...base, deployed: false });
    // CREATE2 ties the address to the code: whatever is there is version 2 for this wallet, and is not deployed twice.
    const deployed = (await readOrRefuse(() => chain.code(planned.contract))) !== "0x";
    const { contract, calls } = passkeyUpgradeCalls({ ...base, deployed });
    return {
      contract,
      previous: current,
      salt,
      deployed,
      dailyUnits: figures.daily.toString(),
      weeklyUnits: figures.weekly.toString(),
      capUnits: capUnits === null ? null : capUnits.toString(),
      calls: calls.map((call) => ({ to: call.to, data: call.data, value: call.value.toString() })),
      chainId: network.chainId,
    };
  });
}

/**
 * Records a passkey wallet's upgrade once the chain shows it (V10): its user operation succeeded, version 2 for this
 * wallet and agent is at `contract`, approved, and version 1's approval reads 0; then the switch, with the revocation
 * already done. Asked about again, it is answered, not recorded twice.
 */
export async function recordPasskeyUpgrade(
  input: { orgId: string; actorId: string; txHash: string; contract: string },
  deps: WalletTreasuryDeps = {}
): Promise<"pending" | "verified"> {
  const hash = txHash(input.txHash);
  let contract: Hex;
  try {
    contract = asAddress(input.contract);
  } catch {
    throw new WalletTreasuryError("chain_refused", "That is not a contract address.");
  }
  return inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network, terms, current } = await upgrading();
    if (row.treasury_signer !== "passkey") throw new WalletTreasuryError("wrong_step", "This workspace's wallet is not a passkey wallet.");
    if (contractVersion(row.version) === 2 && row.approve_tx_hash === hash) return "verified";
    if (contractVersion(row.version) !== 1) throw new WalletTreasuryError("wrong_step", "The contract is version 2 already.");
    const chain = deps.chain ?? treasuryChain(network);
    const receipt = await readOrRefuse(() => chain.receipt(hash));
    if (!receipt) return "pending";
    if (receipt.status !== "success" || !userOperationSucceeded(receipt, wallet)) {
      throw new WalletTreasuryError("chain_refused", "The upgrade failed on chain; nothing changed.");
    }
    const check = await readOrRefuse(() =>
      verifyDeployedAt(chain, { contract, usdc: network.tokens.USDC, treasury: wallet, agent: row.agent_address as string, terms, versions: [2] })
    );
    if (check.state === "pending") return "pending";
    if (check.state === "refused") throw new WalletTreasuryError("chain_refused", check.reason);
    const head = await readOrRefuse(() => chain.blockNumber());
    if (receipt.blockNumber !== undefined && head < receipt.blockNumber) return "pending";
    const [allowance, left] = await Promise.all([
      readOrRefuse(() => chain.allowance(wallet, check.contract, head)),
      readOrRefuse(() => chain.allowance(wallet, current, head)),
    ]);
    if (allowance < 1n) throw new WalletTreasuryError("chain_refused", "The wallet has not approved its new contract; nothing was recorded.");
    if (left !== 0n) throw new WalletTreasuryError("chain_refused", "The earlier contract is still approved; nothing was recorded.");
    // Asked before anything is recorded, so an upgrade asked about again once the payment settles is recorded once.
    await refuseWhilePaymentsInFlight();
    await recordDeployedContract({
      orgId: input.orgId,
      actorId: input.actorId,
      contract: check.contract,
      hash,
      dailyUnits: check.dailyUnits,
      weeklyUnits: check.weeklyUnits,
      version: 2,
      replaces: current,
    });
    await switchToVersion2({
      orgId: input.orgId,
      actorId: input.actorId,
      row,
      wallet,
      next: check.contract,
      deployTxHash: hash,
      approveTxHash: hash,
      revokeTxHash: hash,
      allowanceUnits: allowance,
      signer: "passkey",
    });
    return "verified";
  });
}
