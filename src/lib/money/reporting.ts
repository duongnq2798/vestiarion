import { addMoney, isToken, totalsByCurrency, type Money } from "./money";
import { convertMoney, pegCurrency, pegRate, sameRate, type FxRate } from "./rate";

/**
 * Amounts in the workspace's reporting currency (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M4):
 * through the US dollar, with the reference rates recorded for each currency, rounded once. USDC and EURC reach the
 * dollar and the euro by the peg, which every figure that used it names. A currency with no rate makes the figure
 * unknown, with the reason: never a guess, never 1:1. Browser-safe and pure.
 */

export interface RateBook {
  /** Each currency's reference rate to the US dollar (`from: "USD"`), by currency. */
  rates: ReadonlyMap<string, FxRate>;
  /** Why a currency has no usable rate, by currency, when that is known (`too old`, `not read`). */
  missing: ReadonlyMap<string, string>;
}

export const EMPTY_BOOK: RateBook = { rates: new Map(), missing: new Map() };

export function rateBook(rates: readonly FxRate[], missing: Record<string, string> = {}): RateBook {
  return {
    rates: new Map(rates.filter((rate) => rate.from === "USD").map((rate) => [rate.to, rate])),
    missing: new Map(Object.entries(missing)),
  };
}

export type ReportingValue =
  /** The amount is in the reporting currency already. */
  | { state: "same"; money: Money }
  | { state: "converted"; money: Money; rates: FxRate[] }
  /** A rate it needs was not recorded: the value is not known, and is never guessed. */
  | { state: "unknown"; reason: string; currency: string }
  /** No reporting currency is set. */
  | { state: "not_set" };

/** Why a currency's rate is missing, in words. */
function noRate(book: RateBook, currency: string): string {
  return book.missing.get(currency) ?? `No ${currency} rate was recorded.`;
}

/** The rates that take `from` to `to`, in order; or the currency whose rate is missing. */
export function ratesBetween(from: string, to: string, book: RateBook): { rates: FxRate[] } | { missing: string; reason: string } {
  if (from === to) return { rates: [] };
  const rates: FxRate[] = [];
  let start = from;
  if (isToken(from)) {
    rates.push(pegRate(from));
    start = pegCurrency(from);
  }
  if (isToken(to)) throw new Error("A report is never in a token");
  if (start === to) return { rates };
  if (start !== "USD") {
    const rate = book.rates.get(start);
    if (!rate) return { missing: start, reason: noRate(book, start) };
    rates.push(rate);
  }
  if (to !== "USD") {
    const rate = book.rates.get(to);
    if (!rate) return { missing: to, reason: noRate(book, to) };
    rates.push(rate);
  }
  return { rates };
}

export function toReporting(amount: Money, reporting: string | null, book: RateBook): ReportingValue {
  if (!reporting) return { state: "not_set" };
  if (amount.currency === reporting) return { state: "same", money: amount };
  const path = ratesBetween(amount.currency, reporting, book);
  if ("missing" in path) return { state: "unknown", reason: path.reason, currency: path.missing };
  return { state: "converted", money: convertMoney(amount, path.rates, reporting), rates: path.rates };
}

export interface ReportingRow {
  total: Money;
  count: number;
  value: ReportingValue;
}

export type ReportingTotal =
  | { state: "not_set" }
  | { state: "known"; money: Money }
  /** At least one currency has no rate: the total is unknown; `known` adds the rest, said apart. */
  | { state: "unknown"; known: Money | null; missing: string[] };

export interface ReportingTotals {
  reporting: string | null;
  /** One row per currency, in currency order: the total as written, and the same in the reporting currency. */
  rows: ReportingRow[];
  total: ReportingTotal;
  /** Every rate the rows used, once. */
  rates: FxRate[];
}

/** Each currency's total, then each total in the reporting currency, then their sum: never across currencies otherwise. */
export function reportingTotals(amounts: Iterable<Money>, reporting: string | null, book: RateBook): ReportingTotals {
  const rows: ReportingRow[] = totalsByCurrency(amounts).map(({ total, count }) => ({ total, count, value: toReporting(total, reporting, book) }));
  const rates: FxRate[] = [];
  for (const row of rows) {
    if (row.value.state !== "converted") continue;
    for (const rate of row.value.rates) if (!rates.some((seen) => sameRate(seen, rate))) rates.push(rate);
  }
  if (!reporting) return { reporting, rows, total: { state: "not_set" }, rates };
  let known: Money | null = null;
  const missing: string[] = [];
  for (const row of rows) {
    if (row.value.state === "unknown") {
      if (!missing.includes(row.value.currency)) missing.push(row.value.currency);
      continue;
    }
    if (row.value.state === "same" || row.value.state === "converted") known = known ? addMoney(known, row.value.money) : row.value.money;
  }
  const total: ReportingTotal =
    missing.length > 0 ? { state: "unknown", known, missing: missing.sort() } : { state: "known", money: known ?? { minor: BigInt(0), currency: reporting } };
  return { reporting, rows, total, rates };
}
