/**
 * CCTP V2 with Circle's Forwarding Service, in either direction: a burn carries the forwarding hook, Circle attests it and
 * submits the mint on the destination chain itself, and Iris, Circle's attestation API, quotes the fee and reports the
 * mint. Payouts burn on Arc for a payee on another chain (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md);
 * adding USDC burns on another chain for a wallet on Arc (docs/superpowers/specs/2026-10-08-add-usdc-from-another-chain-
 * design.md). No Node module here: the browser builds the second.
 */

/** `depositForBurnWithHook`'s hook data asking the Forwarding Service to submit the mint ("cctp-forward"). */
export const CCTP_FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
/** Fast transfer: attested at "confirmed" finality, in seconds rather than minutes. */
export const FAST_FINALITY = 1000;
/** No destination caller: anyone, the Forwarding Service included, may submit the mint. */
export const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

const IRIS_DEADLINE_MS = 10_000;

/** An EVM address as the 32 bytes CCTP takes for a recipient. */
export function toBytes32(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${address} is not an address`);
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * Iris's fast, forwarded route among its fee rows (`/v2/burn/USDC/fees/{source}/{destination}?forward=true`): the
 * forwarding fee's high estimate in USDC base units, and the protocol's minimum fee in basis points of the amount; null
 * when the rows list none.
 */
export function fastForwardedRoute(rows: unknown): { forwardUnits: bigint; bps: number } | null {
  const fast = Array.isArray(rows)
    ? (rows as Array<{ finalityThreshold?: number; minimumFee?: number; forwardFee?: { high?: number } }>).find((row) => row.finalityThreshold === FAST_FINALITY)
    : undefined;
  const forward = fast?.forwardFee?.high;
  if (!fast || typeof forward !== "number" || !Number.isFinite(forward) || forward < 0) return null;
  const bps = typeof fast.minimumFee === "number" && Number.isFinite(fast.minimumFee) && fast.minimumFee > 0 ? fast.minimumFee : 0;
  return { forwardUnits: BigInt(Math.round(forward)), bps };
}

/**
 * The mint the Forwarding Service submitted for a burn on the chain of CCTP domain `domain`, by the burn's transaction
 * hash; null while there is none yet, or when Iris cannot say (not found, an error, no answer).
 */
export async function forwardedMintFrom(iris: string, domain: number, burnTxHash: string, options: { fetch?: typeof fetch } = {}): Promise<{ mintTxHash: string } | null> {
  try {
    const response = await (options.fetch ?? fetch)(`${iris}/v2/messages/${domain}?transactionHash=${burnTxHash}`, {
      signal: AbortSignal.timeout(IRIS_DEADLINE_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { messages?: Array<{ forwardTxHash?: unknown }> };
    const mint = body.messages?.find((message) => typeof message.forwardTxHash === "string" && message.forwardTxHash.length > 0)?.forwardTxHash;
    return typeof mint === "string" ? { mintTxHash: mint } : null;
  } catch {
    return null;
  }
}
