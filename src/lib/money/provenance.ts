import type { Money } from "./money";
import type { FxRate } from "./rate";
import type { ReportingValue } from "./reporting";

/**
 * A money figure with where it came from (docs/superpowers/specs/2026-10-13-currency-provenance-design.md M3): the
 * amount as on the document, the executable amount that moves on Arc, the rates that took one to the other, and the
 * value in the reporting currency. Browser-safe and pure.
 */
export interface MoneyFigure {
  /** As written on the bill, the deal or the record. */
  document: Money;
  /** Where that amount came from: `Bill to pay`, `Xero`, `a bill list`, `HubSpot`, a person's record. */
  source: string;
  /** What moves on Arc, in USDC or EURC; null when nothing does (a payment recorded outside Vestiarion). */
  executable: Money | null;
  /** The rates that took the document's amount to the executable one; empty when they are one currency. */
  conversion: FxRate[];
  reporting: ReportingValue;
  /**
   * For a paid bill converted at a rate: the rate on the day it was paid, or null when none was recorded. Absent when
   * it does not apply.
   */
  paymentRate?: FxRate | null;
}

/** A rate whose source and time say where it came from; a peg needs no time. */
function sourced(rate: FxRate): boolean {
  return rate.source.trim() !== "" && (rate.kind === "peg" || rate.at.trim() !== "");
}

/**
 * Whether a figure carries all that applies to it: the document's amount and source, the conversion's rates with their
 * sources and times when the executable amount is in another currency, a known reporting value when a reporting
 * currency is set, and the rate at payment when a converted bill was paid.
 */
export function fullProvenance(figure: MoneyFigure): boolean {
  if (figure.source.trim() === "") return false;
  const converted = figure.executable !== null && figure.executable.currency !== figure.document.currency;
  if (converted && (figure.conversion.length === 0 || !figure.conversion.every(sourced))) return false;
  if (figure.reporting.state === "unknown") return false;
  if (figure.paymentRate === null) return false;
  return true;
}

/** The share of figures with full provenance: the report's KPI. */
export function provenanceShare(figures: readonly MoneyFigure[]): { full: number; total: number } {
  return { full: figures.filter(fullProvenance).length, total: figures.length };
}
