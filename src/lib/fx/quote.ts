import { z } from "zod";
import { FxQuoteError } from "./errors";
import { askAgain } from "./retry";
import { FeatureOffError, type NetworkProfile } from "../network";

/**
 * The EURC→USDC rate for an EURC invoice (docs/superpowers/specs/2026-10-01-eurc-invoices-design.md, E2).
 *
 * Circle's Stablecoin Service quotes a swap of this exact amount on Arc
 * testnet; it needs no key (the App Kit's swap provider calls the same
 * endpoint). Its estimated USDC output is the invoice's USDC value, the figure
 * a payment limit is checked against (E3). A testnet pool's price is not the
 * EUR/USD reference rate, so every use records the source with the rate (R1).
 *
 * Amounts cross the wire as 6-decimal base units, converted with integer
 * arithmetic on the decimal string, never through a float multiply.
 */

/**
 * The Stablecoin Service on a network (docs/superpowers/specs/2026-10-05-network-threading-design.md P2, P5): its name for
 * the chain, and the chain's USDC and EURC. A network without the service has no quote to give: it refuses as a quote
 * error does, so the payable waits as it does when Circle has no route, and says why.
 */
export function stablecoinServiceOf(network: NetworkProfile): { chain: string; usdc: string; eurc: string } {
  if (!network.stablecoinServiceChain) throw new FxQuoteError("unavailable", new FeatureOffError("The EURC swap", network).message);
  return { chain: network.stablecoinServiceChain, usdc: network.tokens.USDC, eurc: network.tokens.EURC };
}

const QUOTE_URL = "https://api.circle.com/v1/stablecoinKits/quote";
const DEADLINE_MS = 10_000;
const CACHE_MS = 5 * 60_000;
const SLIPPAGE_BPS = 300;
const NO_ROUTE = 331001;

export interface EurcQuote {
  usdcEstimated: number;
  usdcMinimum: number;
  /** USDC per EURC, from the estimate. */
  rate: number;
  source: "circle-stablecoin-quote";
  quotedAt: string;
}

// The error and the asking again live beside this module, for the swap service to share (src/lib/fx/retry.ts).
export { FxQuoteError };

const baseUnits = z.string().regex(/^\d+$/);
const answerSchema = z.object({ quote: z.object({ estimatedAmount: baseUnits, minAmount: baseUnits }) });

/** A 6-decimal amount as base units, from its fixed-point string (0.30000000000000004 → "300000"). */
export function toBaseUnits(amount: number): string {
  const [whole, fraction = ""] = amount.toFixed(6).split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`).toString();
}

export const fromBaseUnits = (units: string) => Number(BigInt(units)) / 1_000_000;

const cache = new Map<string, { at: number; value: EurcQuote }>();

/**
 * What `amountEurc` EURC is worth in USDC on Arc testnet now. Throws
 * `FxQuoteError` when there is no usable quote, which holds the payable (E4).
 */
export async function quoteEurcInUsdc(
  amountEurc: number,
  options: { network: NetworkProfile; fromAddress: string; now?: number; fetch?: typeof fetch; retryDelayMs?: number; once?: boolean }
): Promise<EurcQuote> {
  if (!Number.isFinite(amountEurc) || amountEurc <= 0) throw new RangeError("An EURC amount to quote must be positive");
  const service = stablecoinServiceOf(options.network);
  const now = options.now ?? Date.now();
  const amount = toBaseUnits(amountEurc);
  const key = `${options.network.id}:${amount}`;
  const held = cache.get(key);
  if (held && now - held.at <= CACHE_MS) return held.value;

  // Arc testnet's route comes and goes, so a no-route or failed answer is asked
  // again before the payable is held for want of a rate (E4; src/lib/fx/retry.ts).
  return askAgain(() => askForQuote(service, key, amount, options.fromAddress, now, options.fetch), { delayMs: options.retryDelayMs, once: options.once });
}

/** One request to the Stablecoin Service for `amount` base units of EURC, cached when it answers. */
async function askForQuote(
  service: { chain: string; usdc: string; eurc: string },
  key: string,
  amount: string,
  fromAddress: string,
  now: number,
  fetchImpl: typeof fetch | undefined
): Promise<EurcQuote> {
  const url = new URL(QUOTE_URL);
  url.search = new URLSearchParams({
    tokenInAddress: service.eurc,
    tokenInChain: service.chain,
    tokenOutAddress: service.usdc,
    tokenOutChain: service.chain,
    fromAddress,
    toAddress: fromAddress,
    amount,
    slippageBps: String(SLIPPAGE_BPS),
  }).toString();

  let response: Response;
  try {
    response = await (fetchImpl ?? fetch)(url.toString(), { signal: AbortSignal.timeout(DEADLINE_MS), cache: "no-store" });
  } catch {
    throw new FxQuoteError("unavailable");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FxQuoteError("malformed");
  }
  if (!response.ok) {
    throw new FxQuoteError((body as { code?: unknown } | null)?.code === NO_ROUTE ? "no_route" : "unavailable");
  }
  const parsed = answerSchema.safeParse(body);
  if (!parsed.success || BigInt(parsed.data.quote.estimatedAmount) === BigInt(0)) throw new FxQuoteError("malformed");

  const usdcEstimated = fromBaseUnits(parsed.data.quote.estimatedAmount);
  const value: EurcQuote = {
    usdcEstimated,
    usdcMinimum: fromBaseUnits(parsed.data.quote.minAmount),
    // Six decimals, as amounts are: 3 EURC at 3.647451 USDC is 1.215817, not 1.2158170000000001.
    rate: Number((usdcEstimated / fromBaseUnits(amount)).toFixed(6)),
    source: "circle-stablecoin-quote",
    quotedAt: new Date(now).toISOString(),
  };
  cache.set(key, { at: now, value });
  return value;
}

/** Test seam: forget cached quotes. */
export function resetFxQuotesForTests(): void {
  cache.clear();
}
