import { subtractMoney, type Money } from "./money";
import { convertMoney, pegRate, type FxRate } from "./rate";

/**
 * The FX variance on a paid bill (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M6). A bill in a
 * currency of its own was converted to USDC at its decision rate; its transfer carried that USDC on another day, when
 * the rate may have moved. The variance is what the transfer carried less what the same part of the bill was worth in
 * USDC on the payment day: above zero, the business paid more than the bill was worth that day. Browser-safe and pure.
 */

export interface FxVariance {
  /** The bill's currency. */
  currency: string;
  /** What the transfer carried, in USDC. */
  paid: Money;
  /** The part of the bill the payment covered, in its own currency, at the decision rate. */
  covered: Money;
  /** What that part was worth in USDC at the payment day's rate, to the cent, as the bill's own USDC was worked out. */
  valueAtPayment: Money;
  /** `paid` less `valueAtPayment`. */
  variance: Money;
  /** How many of the currency made one US dollar when the bill was converted. */
  decision: FxRate;
  /** The same on the payment day. */
  payment: FxRate;
}

/**
 * The variance, or null when there is none to have: a payment not in USDC, rates not of the dollar to one currency, or
 * a bill in US dollars, whose rate to the dollar never moves.
 */
export function fxVariance(input: { paid: Money; decision: FxRate; payment: FxRate }): FxVariance | null {
  const { paid, decision, payment } = input;
  if (paid.currency !== "USDC") return null;
  if (decision.from !== "USD" || payment.from !== "USD" || decision.to !== payment.to || decision.to === "USD") return null;
  const peg = pegRate("USDC");
  const covered = convertMoney(paid, [peg, decision], decision.to);
  const valueAtPayment = convertMoney(paid, [peg, decision, payment, peg], "USDC", { digits: 2 });
  return { currency: decision.to, paid, covered, valueAtPayment, variance: subtractMoney(paid, valueAtPayment), decision, payment };
}

/** Within this long before a payment, the feed's newest rate is the one in force: it publishes once a day. */
export const PAYMENT_RATE_WINDOW_MS = 36 * 60 * 60_000;

/**
 * The rate in force when a payment was made: the newest of `rates` (reference rates of one currency) published at or
 * before it, and no more than 36 hours before it. Null when none is: the rate at payment is then unknown.
 */
export function rateAtPayment(rates: readonly FxRate[], paidAt: string): FxRate | null {
  const at = Date.parse(paidAt);
  if (!Number.isFinite(at)) return null;
  let best: FxRate | null = null;
  for (const rate of rates) {
    const published = Date.parse(rate.at);
    if (!Number.isFinite(published) || published > at || at - published > PAYMENT_RATE_WINDOW_MS) continue;
    if (!best || published > Date.parse(best.at)) best = rate;
  }
  return best;
}
