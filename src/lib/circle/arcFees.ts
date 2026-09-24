import { currentConfig } from "../context";

/**
 * Reads what a transfer actually cost, from Arc itself.
 *
 * Circle's Developer-Controlled Wallets API exposes `networkFeeInUSD` on a
 * transaction, but on Arc testnet it comes back empty — verified by re-fetching
 * four settled transfers well after confirmation. So the app had no
 * chain-reported fee at all and fell back to a hardcoded estimate, which the
 * landing page then correctly refused to present as a measurement.
 *
 * The fee is not missing, though; it is on the chain. Arc is unusual in a way
 * that makes reading it exact rather than approximate: **its native gas token
 * is USDC, with 18 decimals**. So
 *
 *     gasUsed x effectiveGasPrice / 1e18
 *
 * is the fee in dollars directly — no price oracle, no conversion, no moment
 * in time at which the quote was taken. The only input is a transaction hash
 * the provider already gives us.
 *
 * What this measured, against the estimate it replaces:
 *
 *     estimate (ARC_FEE_USD)   $0.01
 *     measured, 4 transfers    $0.003186 - $0.003248
 *
 * The estimate was roughly 3x too high, which also made the treasury policy
 * three times more reluctant to sweep than the economics warranted. Numbers
 * you assert about your own system drift; numbers you read do not.
 */

/** Arc testnet, chain id 5042002. Matches viem's `arcTestnet` definition. */
export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";
export const ARC_TESTNET_CHAIN_ID = 5042002;

/** Arc's gas token is USDC at 18 decimals, so wei convert straight to dollars. */
const ARC_NATIVE_DECIMALS = 18n;

export interface ArcReceipt {
  gasUsed: string;
  effectiveGasPrice: string;
  status: string;
}

/**
 * Converts a receipt to a dollar fee. Kept separate from the network call so
 * the arithmetic — the part that would silently produce a plausible wrong
 * number — is tested directly.
 *
 * Returns null rather than zero when the receipt is unusable: a fee of zero is
 * a claim, and this module only reports what it can actually read.
 */
export function feeUsdFromReceipt(receipt: ArcReceipt | null | undefined): number | null {
  if (!receipt?.gasUsed || !receipt?.effectiveGasPrice) return null;
  let wei: bigint;
  try {
    wei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  } catch {
    return null;
  }
  if (wei < 0n) return null;

  // Divide in bigint down to six decimals before touching floating point, so
  // the conversion cannot lose precision on the way out of 18 decimals.
  const micros = wei / 10n ** (ARC_NATIVE_DECIMALS - 6n);
  const fee = Number(micros) / 1e6;
  return Number.isFinite(fee) ? fee : null;
}

/** True when the receipt records a reverted transaction. */
export function receiptReverted(receipt: ArcReceipt | null | undefined): boolean {
  return receipt?.status === "0x0";
}

async function arcRpc(
  method: string,
  params: unknown[],
  { url, timeoutMs }: { url: string; timeoutMs: number }
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Arc RPC ${method} returned ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`Arc RPC ${method}: ${body.error.message ?? "unknown error"}`);
  return body.result;
}

/**
 * The node to read receipts from. `LiveProvider` passes its configured URL
 * explicitly; this is the fallback for a direct caller, and it reads the
 * running scope rather than the process environment so that two businesses
 * pointed at different nodes do not silently share one.
 */
export function arcRpcUrl(): string {
  return currentConfig().chain.arcRpcUrl || ARC_TESTNET_RPC_URL;
}

/**
 * Fetches the real fee for a transaction hash. Returns null — never a guess —
 * when the receipt is not available yet, the node is unreachable, or the hash
 * is not on this chain. A null here means the caller keeps the estimate and
 * keeps labelling it as one; it must never be mistaken for "the fee was zero".
 */
export async function fetchArcFeeUsd(
  txHash: string,
  options: { url?: string; timeoutMs?: number } = {}
): Promise<number | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  try {
    const receipt = (await arcRpc("eth_getTransactionReceipt", [txHash], {
      url: options.url ?? arcRpcUrl(),
      timeoutMs: options.timeoutMs ?? 15_000,
    })) as ArcReceipt | null;
    return feeUsdFromReceipt(receipt);
  } catch {
    // The chain is a secondary source for a number the app can live without.
    // A treasury cycle must not fail because an RPC node was slow.
    return null;
  }
}
