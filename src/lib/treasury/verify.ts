import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbiItem, recoverMessageAddress, type Hex } from "viem";
import type { NetworkProfile } from "../network";
import { SPENDING_LIMIT_ABI } from "../spending-limit/onchain";
import { asAddress, type TreasuryChain, type TreasuryReceipt } from "./chain";
import { deploymentData } from "../spending-limit/deployment";

export { deploymentData };

/**
 * What the server checks before it trusts an owner's wallet, their contract and their approval (docs/superpowers/
 * specs/2026-10-07-wallet-treasury-design.md W3, W8, W9). Each check reads the chain itself: nothing the page sends is
 * taken as said. Addresses are compared whatever case they came in.
 */

/** How long a signed proof stays good, and how far ahead of the server's clock its time may be. */
const PROOF_FRESH_MS = 10 * 60_000;
const PROOF_SKEW_MS = 60_000;

const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** The message an owner's wallet signs to prove it is theirs (W3): the workspace, the network, the wallet and the time. */
export function walletProofMessage(input: { orgSlug: string; network: NetworkProfile; address: string; issuedAt: string }): string {
  return [
    "Vestiarion: pay from this wallet",
    `Workspace: ${input.orgSlug}`,
    `Network: ${input.network.label} (chain ${input.network.chainId})`,
    `Wallet: ${asAddress(input.address)}`,
    `Issued: ${input.issuedAt}`,
  ].join("\n");
}

/**
 * Whether `signature` is the wallet's own over the message this workspace expects, signed in the last 10 minutes (W3).
 * The message is rebuilt from the time it names and must match exactly, so nothing else it says is taken on trust.
 */
export async function verifyWalletProof(input: {
  message: string;
  signature: Hex;
  address: string;
  orgSlug: string;
  network: NetworkProfile;
  now?: number;
}): Promise<{ ok: true; issuedAt: string } | { ok: false; reason: string }> {
  const issuedAt = /^Issued: (.+)$/m.exec(input.message)?.[1]?.trim() ?? "";
  const at = Date.parse(issuedAt);
  if (!issuedAt || Number.isNaN(at)) return { ok: false, reason: "The signed message has no time Vestiarion gave it." };
  if (input.message !== walletProofMessage({ orgSlug: input.orgSlug, network: input.network, address: input.address, issuedAt })) {
    return { ok: false, reason: "The signed message is not the one this workspace asked for." };
  }
  const now = input.now ?? Date.now();
  if (at - now > PROOF_SKEW_MS || now - at > PROOF_FRESH_MS) return { ok: false, reason: "The signature is too old; sign again." };
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: input.message, signature: input.signature });
  } catch {
    return { ok: false, reason: "The signature could not be read." };
  }
  if (!same(signer, input.address)) return { ok: false, reason: "The message was signed by another wallet." };
  return { ok: true, issuedAt };
}

/** ERC-4337's EntryPoint v0.7, the same address on every chain, Arc mainnet included (checked 2026-10-07). */
export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

const USER_OPERATION_EVENT = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
);

/**
 * Whether `receipt` carries a user operation of `sender`'s that succeeded (passkey treasury K7, final review I6). A
 * bundler's transaction succeeds even when a user operation in it reverts, and any hash could be handed back: only the
 * EntryPoint's own event says that this wallet's operation ran, and how it ended.
 */
export function userOperationSucceeded(receipt: TreasuryReceipt, sender: string): boolean {
  return (receipt.logs ?? []).some((log) => {
    if (!same(log.address, ENTRY_POINT_V07)) return false;
    try {
      const event = decodeEventLog({ abi: [USER_OPERATION_EVENT], topics: log.topics as [Hex, ...Hex[]], data: log.data });
      return same(event.args.sender, sender) && event.args.success;
    } catch {
      return false;
    }
  });
}

const LIMITS_SET_EVENT = parseAbiItem("event LimitsSet(uint256 dailyLimit, uint256 weeklyLimit)");
const APPROVAL_EVENT = parseAbiItem("event Approval(address indexed owner, address indexed spender, uint256 value)");

/** Each of `receipt`'s logs that `address` emitted as `event`, decoded; any other log is passed over. */
function eventsIn<T>(receipt: TreasuryReceipt, address: string, decode: (log: { topics: [Hex, ...Hex[]]; data: Hex }) => T): T[] {
  const found: T[] = [];
  for (const log of receipt.logs ?? []) {
    if (!same(log.address, address)) continue;
    try {
      found.push(decode({ topics: log.topics as [Hex, ...Hex[]], data: log.data }));
    } catch {
      // Another event of the same address.
    }
  }
  return found;
}

/**
 * The figures `contract` set in this transaction, from its own `LimitsSet` (treasury wallet controls, review I3): the
 * last one when there are several; null when it set none, whatever else the transaction did.
 */
export function limitsSetIn(receipt: TreasuryReceipt, contract: string): { daily: bigint; weekly: bigint } | null {
  const set = eventsIn(receipt, contract, (log) => decodeEventLog({ abi: [LIMITS_SET_EVENT], ...log }).args);
  const last = set.at(-1);
  return last ? { daily: last.dailyLimit, weekly: last.weeklyLimit } : null;
}

/**
 * What `owner` approved `spender` to move of `token` in this transaction, from the token's own `Approval` (review I3):
 * the last when there are several; null when it approved nothing of the kind.
 */
export function approvalIn(receipt: TreasuryReceipt, input: { token: string; owner: string; spender: string }): bigint | null {
  const approvals = eventsIn(receipt, input.token, (log) => decodeEventLog({ abi: [APPROVAL_EVENT], ...log }).args).filter(
    (approval) => same(approval.owner, input.owner) && same(approval.spender, input.spender)
  );
  return approvals.at(-1)?.value ?? null;
}

/** A check that reads the chain: not mined yet, refused with why, or verified with what it found. */
export type ChainCheck<T> = { state: "pending" } | { state: "refused"; reason: string } | ({ state: "verified" } & T);

/**
 * The owner's deployment of their contract (W8): mined, successful, from their wallet, creating a contract whose code is
 * exactly what Vestiarion's contract deployed with this USDC, wallet and agent leaves, as the network's RPC simulates it.
 * The token, treasury, owner and agent are immutables written into that code, so an equal code proves the wiring; the
 * figures, in storage, are read from the contract.
 */
export async function verifyDeployment(
  chain: TreasuryChain,
  input: { txHash: Hex; usdc: string; treasury: string; agent: string }
): Promise<ChainCheck<{ contract: Hex; dailyUnits: bigint; weeklyUnits: bigint }>> {
  const receipt = await chain.receipt(input.txHash);
  if (!receipt) return { state: "pending" };
  if (receipt.status !== "success") return { state: "refused", reason: "The deployment failed on chain; nothing was deployed." };
  if (!same(receipt.from, input.treasury)) return { state: "refused", reason: "That deployment was not sent from this workspace's wallet." };
  if (!receipt.contractAddress) return { state: "refused", reason: "That transaction did not deploy a contract." };
  return verifyDeployedAt(chain, { contract: receipt.contractAddress, usdc: input.usdc, treasury: input.treasury, agent: input.agent });
}

/**
 * Vestiarion's contract for this USDC, wallet and agent at `contract`, wherever it came from (passkey treasury K7): a
 * smart account deploys it through the bundler and the deterministic deployment proxy, so no receipt names it. CREATE2
 * ties the address to the code, and an equal code proves the wiring, as for a wallet's own deployment (W8).
 */
export async function verifyDeployedAt(
  chain: TreasuryChain,
  input: { contract: string; usdc: string; treasury: string; agent: string }
): Promise<ChainCheck<{ contract: Hex; dailyUnits: bigint; weeklyUnits: bigint }>> {
  const contract = asAddress(input.contract);
  const [code, expected] = await Promise.all([
    chain.code(contract),
    chain.simulateDeploy({ from: asAddress(input.treasury), data: deploymentData({ usdc: input.usdc, treasury: input.treasury, agent: input.agent, dailyUnits: 1n, weeklyUnits: 1n }) }),
  ]);
  // A node with no creation calls cannot check a deployment: unreadable, so the owner's deployment is asked about again
  // once it can be, and never refused as someone else's after they paid its gas.
  if (!expected || expected === "0x") throw new Error("The node gave no code for a creation call; it cannot check a deployment.");
  // A successful deployment whose code a node does not show yet is one it has not caught up with.
  if (code === "0x") return { state: "pending" };
  if (!same(code, expected)) {
    return { state: "refused", reason: "The contract it deployed is not Vestiarion's spending limit contract for this wallet and agent." };
  }
  const figure = async (functionName: "dailyLimit" | "weeklyLimit") =>
    decodeFunctionResult({ abi: SPENDING_LIMIT_ABI, functionName, data: await chain.read(contract, encodeFunctionData({ abi: SPENDING_LIMIT_ABI, functionName })) }) as bigint;
  const [dailyUnits, weeklyUnits] = await Promise.all([figure("dailyLimit"), figure("weeklyLimit")]);
  return { state: "verified", contract, dailyUnits, weeklyUnits };
}

/**
 * The owner's approval of their contract on USDC (W9): mined, successful, from their wallet, sent to USDC, and leaving
 * the contract allowed at least `minimumUnits`. The allowance is read from the token itself, not from the transaction.
 */
export async function verifyApproval(
  chain: TreasuryChain,
  input: { txHash: Hex; usdc: string; treasury: string; contract: string; minimumUnits: bigint }
): Promise<ChainCheck<{ allowanceUnits: bigint }>> {
  const receipt = await chain.receipt(input.txHash);
  if (!receipt) return { state: "pending" };
  if (receipt.status !== "success") return { state: "refused", reason: "The approval failed on chain; nothing was approved." };
  if (!same(receipt.from, input.treasury)) return { state: "refused", reason: "That approval was not sent from this workspace's wallet." };
  if (!same(receipt.to, input.usdc)) return { state: "refused", reason: "That transaction was not an approval on USDC." };
  const allowanceUnits = await chain.allowance(asAddress(input.treasury), asAddress(input.contract));
  if (allowanceUnits < input.minimumUnits) {
    return { state: "refused", reason: `The wallet approves ${Number(allowanceUnits) / 1_000_000} USDC to its contract, less than the ${Number(input.minimumUnits) / 1_000_000} USDC needed.` };
  }
  return { state: "verified", allowanceUnits };
}
