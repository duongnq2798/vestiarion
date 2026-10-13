import { divRound, money, moneyDigits, pow10, type Money } from "./money";

/**
 * Exchange rates, each saying what kind it is (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M2). A
 * report's rate, the books' rate and the provider's executable quote are different things: a figure names the one it
 * used, and nothing takes one in place of another. Browser-safe and pure.
 */

export type RateKind = "reference" | "quote" | "accounting" | "peg" | "manual";

/** What each kind is, in words a business reads. */
export const RATE_KIND_WORDS: Record<RateKind, string> = {
  reference: "reference rate",
  quote: "provider's quote",
  accounting: "accounting rate",
  peg: "1:1 redemption, not a market rate",
  manual: "typed by a person",
};

export interface FxRate {
  from: string;
  to: string;
  /** How many `to` make one `from`, as a positive decimal string. */
  value: string;
  kind: RateKind;
  /** Who published or set it: `ExchangeRate-API`, `Circle`, a person's scenario. */
  source: string;
  /** When its source published it (ISO); for a peg, empty. */
  at: string;
  /** Its row in `fx_rates`, when it was recorded there. */
  id?: string;
}

const RATE = /^(\d+)(?:\.(\d+))?$/;
/** A rate keeps at most this many decimals: `fx_rates.rate` is `numeric(30, 12)`. */
export const RATE_DECIMALS = 12;

/**
 * A rate's value as a plain positive decimal, trailing zeros dropped; null for anything else, zero included. A number
 * goes through its shortest decimal text (1.35, never 1.3500000000000001), which is exact for any rate a feed writes.
 */
export function rateValue(value: string | number): string | null {
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  if (/e/i.test(text)) text = Number(text).toFixed(RATE_DECIMALS);
  const match = RATE.exec(text);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > RATE_DECIMALS) return null;
  if (/^0+$/.test(whole) && fraction === "") return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The rate as a fraction of integers. */
export function ratio(value: string): { num: bigint; den: bigint } {
  const normal = rateValue(value);
  if (normal === null) throw new Error(`Not a rate: ${value}`);
  const [whole, fraction = ""] = normal.split(".");
  return { num: BigInt(`${whole}${fraction}`), den: pow10(fraction.length) };
}

/** A reference rate of the feed: how many of `currency` make one US dollar. */
export function referenceRate(currency: string, perUsd: string | number, source: string, at: string, id?: string): FxRate | null {
  const value = rateValue(perUsd);
  if (value === null) return null;
  return { from: "USD", to: currency.toUpperCase(), value, kind: "reference", source, at, ...(id ? { id } : {}) };
}

/** A token's redemption at par: 1 USDC is 1 US dollar, 1 EURC is 1 euro. Never a market rate, and said so. */
export function pegRate(token: "USDC" | "EURC"): FxRate {
  return token === "USDC"
    ? { from: "USDC", to: "USD", value: "1", kind: "peg", source: "USDC's 1:1 dollar redemption", at: "" }
    : { from: "EURC", to: "EUR", value: "1", kind: "peg", source: "EURC's 1:1 euro redemption", at: "" };
}

/** The currency a token is redeemed in. */
export function pegCurrency(token: "USDC" | "EURC"): "USD" | "EUR" {
  return token === "USDC" ? "USD" : "EUR";
}

export class RateChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateChainError";
  }
}

/**
 * The amount in `to`, through the rates in order, each used as written (`from` to `to`) or inverted (`to` to `from`).
 * The rates are multiplied as fractions and the result rounded once, half away from zero, at `digits` (the target
 * currency's own unless given), then written at the currency's own digits: exact, whatever the chain.
 */
export function convertMoney(amount: Money, rates: readonly FxRate[], to: string, options: { digits?: number } = {}): Money {
  let current = amount.currency;
  let num = amount.minor;
  let den = pow10(moneyDigits(amount.currency));
  for (const rate of rates) {
    const { num: rNum, den: rDen } = ratio(rate.value);
    if (rate.from === current) {
      num *= rNum;
      den *= rDen;
      current = rate.to;
    } else if (rate.to === current) {
      num *= rDen;
      den *= rNum;
      current = rate.from;
    } else {
      throw new RateChainError(`A rate from ${rate.from} to ${rate.to} does not apply to ${current}`);
    }
  }
  const target = to.toUpperCase();
  if (current !== target) throw new RateChainError(`The rates end in ${current}, not ${target}`);
  const ownDigits = moneyDigits(target);
  const digits = options.digits ?? ownDigits;
  if (digits > ownDigits) throw new RateChainError(`${target} keeps ${ownDigits} digits`);
  const rounded = divRound(num * pow10(digits), den);
  return money(rounded * pow10(ownDigits - digits), target);
}

/** The value for a person: grouped, at least four decimals and no more than it has (`1.3500`, `1,380.2500`, `149.2350`). */
export function formatRateValue(value: string): string {
  const [whole, fraction = ""] = (rateValue(value) ?? value).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(4, "0")}`;
}

/** The day and minute a rate was published, in UTC: `13 Oct 2026, 00:02 UTC`. */
export function rateTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "time not known";
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

/** `1 USD = 1.3500 SGD`. */
export function rateEquation(rate: FxRate): string {
  return `1 ${rate.from} = ${formatRateValue(rate.value)} ${rate.to}`;
}

/** The rate whole, for a figure that used it: `1 USD = 1.3500 SGD, reference rate from ExchangeRate-API, published 13 Oct 2026, 00:02 UTC`. */
export function rateWords(rate: FxRate): string {
  if (rate.kind === "peg") return `1 ${rate.from} = 1 ${rate.to}, ${rate.source}, not a market rate`;
  const when = rate.at ? `, ${rate.kind === "manual" ? "set" : "published"} ${rateTime(rate.at)}` : "";
  const by = rate.kind === "manual" ? `, ${RATE_KIND_WORDS.manual}` : `, ${RATE_KIND_WORDS[rate.kind]} from ${rate.source}`;
  return `${rateEquation(rate)}${by}${when}`;
}

/** Whether two rates are the same rate: same pair, kind, source, value and time. */
export function sameRate(a: FxRate, b: FxRate): boolean {
  return a.from === b.from && a.to === b.to && a.kind === b.kind && a.source === b.source && a.at === b.at && rateValue(a.value) === rateValue(b.value);
}
