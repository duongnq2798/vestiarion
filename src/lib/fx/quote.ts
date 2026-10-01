import { z } from "zod";

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

export const ARC_TESTNET_EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";

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

export class FxQuoteError extends Error {
  constructor(readonly code: "unavailable" | "no_route" | "malformed") {
    super(
      code === "no_route"
        ? "No EURC→USDC route on Arc testnet right now"
        : code === "malformed"
          ? "The EURC→USDC quote could not be read"
          : "The EURC→USDC quote service did not answer"
    );
    this.name = "FxQuoteError";
  }
}

const baseUnits = z.string().regex(/^\d+$/);
const answerSchema = z.object({ quote: z.object({ estimatedAmount: baseUnits, minAmount: baseUnits }) });

/** A 6-decimal amount as base units, from its fixed-point string (0.30000000000000004 → "300000"). */
function toBaseUnits(amount: number): string {
  const [whole, fraction = ""] = amount.toFixed(6).split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0").slice(0, 6)}`).toString();
}

const fromBaseUnits = (units: string) => Number(BigInt(units)) / 1_000_000;

const cache = new Map<string, { at: number; value: EurcQuote }>();

/**
 * What `amountEurc` EURC is worth in USDC on Arc testnet now. Throws
 * `FxQuoteError` when there is no usable quote, which holds the payable (E4).
 */
export async function quoteEurcInUsdc(
  amountEurc: number,
  options: { fromAddress: string; now?: number; fetch?: typeof fetch; retryDelayMs?: number }
): Promise<EurcQuote> {
  if (!Number.isFinite(amountEurc) || amountEurc <= 0) throw new RangeError("An EURC amount to quote must be positive");
  const now = options.now ?? Date.now();
  const amount = toBaseUnits(amountEurc);
  const held = cache.get(amount);
  if (held && now - held.at <= CACHE_MS) return held.value;

  // Arc testnet's route comes and goes: on 2026-10-01 the same 1.9 EURC was
  // answered "No route available" and, a second later, quoted at 2.310362 USDC.
  // So a no-route or failed answer is asked for once more before the payable
  // is held for want of a rate (E4). An answer that cannot be read is not.
  try {
    return await askForQuote(amount, options.fromAddress, now, options.fetch);
  } catch (error) {
    if (!(error instanceof FxQuoteError) || error.code === "malformed") throw error;
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? RETRY_DELAY_MS));
    return askForQuote(amount, options.fromAddress, now, options.fetch);
  }
}

const RETRY_DELAY_MS = 750;

/** One request to the Stablecoin Service for `amount` base units of EURC, cached when it answers. */
async function askForQuote(amount: string, fromAddress: string, now: number, fetchImpl: typeof fetch | undefined): Promise<EurcQuote> {
  const url = new URL(QUOTE_URL);
  url.search = new URLSearchParams({
    tokenInAddress: ARC_TESTNET_EURC,
    tokenInChain: "Arc_Testnet",
    tokenOutAddress: ARC_TESTNET_USDC,
    tokenOutChain: "Arc_Testnet",
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
  cache.set(amount, { at: now, value });
  return value;
}

/** Test seam: forget cached quotes. */
export function resetFxQuotesForTests(): void {
  cache.clear();
}
