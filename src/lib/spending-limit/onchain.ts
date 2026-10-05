import { workspaceNetwork } from "../workspace-network";
import { createHash } from "node:crypto";
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import { networkRpcUrl } from "../circle/arcFees";
import artifact from "./artifact.json";

/**
 * Reading a workspace's spending limit contract without sending anything
 * (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md R7, R8, R14): the contract's verdict on one
 * payment, from an `eth_call` of the same `pay` from the agent's address, and its figures with what it counts as
 * paid. Nothing here can move money; a read that does not complete is `unreadable`, never "allowed".
 */

export const SPENDING_LIMIT_ABI = artifact.abi as Abi;
/** What the agent's wallet calls: the contract's only function that moves money. */
export const PAY_SIGNATURE = "pay(address,uint256,bytes32)";
export const SET_LIMITS_SIGNATURE = "setLimits(uint256,uint256)";

const UNITS = 1_000_000;
const RPC_TIMEOUT_MS = 6_000;

export interface SpendingLimitReadOptions {
  fetch?: typeof fetch;
  rpcUrl?: string;
}

/** The contract's errors a verdict can name; the three that carry figures carry what was paid, the amount and the figure. */
export type SpendingLimitRefusal =
  | { state: "refused"; error: "OverDailyLimit" | "OverWeeklyLimit"; spent: number; amount: number; limit: number }
  | { state: "refused"; error: "AlreadyPaid" | "NotAgent" | "InvalidPayment" | "TransferFailed" | string };

export type SpendingLimitVerdict = { state: "allowed" } | SpendingLimitRefusal | { state: "unreadable"; reason: string };

export type SpendingLimitReading =
  | { state: "read"; dailyUsdc: number | null; weeklyUsdc: number | null; spentToday: number; spentThisWeek: number }
  | { state: "unreadable" };

/**
 * The 32 bytes naming one payment on the contract (R2 of §2): from its source, never its attempt, so a payment
 * cannot leave twice through the contract whatever keys its attempts were sent under.
 */
export function spendingLimitRef(sourceType: string, sourceId: string): Hex {
  return `0x${createHash("sha256").update(`vestiarion/spending-limit/v1/${sourceType}/${sourceId}`, "utf8").digest("hex")}`;
}

/** USDC in the token's 6-decimal units, rounded once, so 0.1 + 0.2 is 300000. */
export function usdcUnits(amount: number): bigint {
  return BigInt(Math.round(amount * UNITS));
}

function usdc(units: bigint): number {
  return Number(units) / UNITS;
}

/** An address as viem accepts it: whatever case it was stored in. */
export function checksummed(address: string): Hex {
  return getAddress(address.toLowerCase());
}

/** The workspace's network's RPC (network threading P1, P2): read in its scope, with no other network to fall back to. */
function defaultRpcUrl(): string {
  return networkRpcUrl(workspaceNetwork());
}

type CallOutcome = { ok: true; result: Hex } | { ok: false; revert: Hex | null; reason: string };

/** One `eth_call` at the latest block. A revert comes back with its data when the node gives it. */
async function ethCall(call: { from?: string; to: string; data: Hex }, options: SpendingLimitReadOptions): Promise<CallOutcome> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(options.rpcUrl ?? defaultRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, revert: null, reason: `Arc testnet did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
  const answer = (await response.json().catch(() => ({}))) as {
    result?: unknown;
    error?: { message?: string; data?: unknown };
  };
  if (!response.ok) return { ok: false, revert: null, reason: `Arc testnet answered ${response.status}` };
  if (typeof answer.result === "string" && answer.result.startsWith("0x")) return { ok: true, result: answer.result as Hex };
  const data = answer.error?.data;
  const revert =
    typeof data === "string" && data.startsWith("0x")
      ? (data as Hex)
      : data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string"
        ? ((data as { data: string }).data as Hex)
        : null;
  return { ok: false, revert, reason: answer.error?.message ?? "Arc testnet gave no answer" };
}

/**
 * What the contract would do with this payment now, asked as the agent (R7): `allowed`, `refused` with the
 * contract's own error and figures, or `unreadable`. Sends nothing.
 */
export async function spendingLimitVerdict(
  input: { contract: string; agent: string; to: string; amount: number; ref: Hex },
  options: SpendingLimitReadOptions = {}
): Promise<SpendingLimitVerdict> {
  let data: Hex;
  try {
    data = encodeFunctionData({ abi: SPENDING_LIMIT_ABI, functionName: "pay", args: [checksummed(input.to), usdcUnits(input.amount), input.ref] });
  } catch (error) {
    return { state: "unreadable", reason: `The payment could not be put to the contract: ${error instanceof Error ? error.message : String(error)}` };
  }
  const outcome = await ethCall({ from: checksummed(input.agent), to: checksummed(input.contract), data }, options);
  if (outcome.ok) return { state: "allowed" };
  if (!outcome.revert || outcome.revert === "0x") return { state: "unreadable", reason: outcome.reason };
  try {
    const decoded = decodeErrorResult({ abi: SPENDING_LIMIT_ABI, data: outcome.revert });
    if ((decoded.errorName === "OverDailyLimit" || decoded.errorName === "OverWeeklyLimit") && Array.isArray(decoded.args)) {
      const [spent, amount, limit] = decoded.args as [bigint, bigint, bigint];
      return { state: "refused", error: decoded.errorName, spent: usdc(spent), amount: usdc(amount), limit: usdc(limit) };
    }
    return { state: "refused", error: decoded.errorName };
  } catch {
    return { state: "unreadable", reason: `The contract refused with an error it does not name (${outcome.revert.slice(0, 10)})` };
  }
}

/** The contract's figures and what it counts as paid today and in the 7-day window (R14); 0 is a figure not set. */
export async function readSpendingLimit(contract: string, options: SpendingLimitReadOptions = {}): Promise<SpendingLimitReading> {
  const views = ["dailyLimit", "weeklyLimit", "spentToday", "spentThisWeek"] as const;
  try {
    const to = checksummed(contract);
    const read = await Promise.all(
      views.map(async (functionName) => {
        const outcome = await ethCall({ to, data: encodeFunctionData({ abi: SPENDING_LIMIT_ABI, functionName }) }, options);
        if (!outcome.ok) throw new Error(outcome.reason);
        return decodeFunctionResult({ abi: SPENDING_LIMIT_ABI, functionName, data: outcome.result }) as bigint;
      })
    );
    const [daily, weekly, today, week] = read;
    return {
      state: "read",
      dailyUsdc: daily === 0n ? null : usdc(daily),
      weeklyUsdc: weekly === 0n ? null : usdc(weekly),
      spentToday: usdc(today),
      spentThisWeek: usdc(week),
    };
  } catch {
    return { state: "unreadable" };
  }
}
