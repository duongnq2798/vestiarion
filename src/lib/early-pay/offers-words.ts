/**
 * Early-payment offers' figures and words (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md E2, E8):
 * the discount worth asking, what it is worth a year, and what the supplier reads. Pure and browser-safe.
 */

export const MIN_OFFER_PCT = 0.1;
export const MAX_OFFER_PCT = 10;
const MIN_SUGGESTED_PCT = 0.5;
const MAX_SUGGESTED_PCT = 5;
const DAY_MS = 86_400_000;

/** Whole days from now to the due date's UTC day, never less than 0. */
export function daysEarly(dueDate: string, now: Date): number {
  const due = Date.UTC(new Date(dueDate).getUTCFullYear(), new Date(dueDate).getUTCMonth(), new Date(dueDate).getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((due - today) / DAY_MS));
}

export interface OfferSuggestion {
  days: number;
  /** The share of the bill the cash would earn in the reserve by the due date, in percent. */
  breakEvenPct: number;
  /** What to ask: twice the break-even, up to the next 0.25%, from 0.5% to 5% (E2). */
  pct: number;
  /** What the suggested discount is worth a year, in percent. */
  annualPct: number;
}

const roundUpQuarter = (value: number) => Math.ceil(value * 4 - 1e-9) / 4;

/** The discount to ask for paying `days` early, from the reserve's yield (E2). */
export function suggestOffer(input: { dueDate: string; now: Date; reserveApy: number }): OfferSuggestion {
  const days = daysEarly(input.dueDate, input.now);
  const apy = Number.isFinite(input.reserveApy) && input.reserveApy > 0 ? input.reserveApy : 0;
  const breakEvenPct = (apy * days * 100) / 365;
  const pct = Math.min(MAX_SUGGESTED_PCT, Math.max(MIN_SUGGESTED_PCT, roundUpQuarter(breakEvenPct * 2)));
  return { days, breakEvenPct: Number(breakEvenPct.toFixed(4)), pct, annualPct: annualPct(pct, days) };
}

/** A discount for paying `days` early, as a yearly rate, in percent, to one decimal. */
export function annualPct(pct: number, days: number): number {
  if (days <= 0) return 0;
  return Number(((pct / days) * 365).toFixed(1));
}

/** What the supplier receives today for a bill of `amount` at `pct` off. */
export function offeredAmount(amount: number, pct: number): number {
  return Number(((amount * (100 - pct)) / 100).toFixed(6));
}

// Up to 6 decimals, as USDC has: a discount on a small bill is under a cent, and 0.4975 must not read as 0.50.
const money = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);

/** "Paying 20 days early for 1.00% is like earning 18.3% a year, above the reserve's 4.2%." (E8) */
export function offerWorth(input: { pct: number; days: number; reserveApy: number }): string {
  const yearly = annualPct(input.pct, input.days);
  const reserve = input.reserveApy > 0 ? `, above the reserve's ${(input.reserveApy * 100).toFixed(1)}%` : "";
  return `Paying ${input.days} ${input.days === 1 ? "day" : "days"} early for ${input.pct.toFixed(2)}% is like earning ${yearly}% a year${reserve}.`;
}

/** The supplier's line (E8): "Northwind Supply offers to pay invoice INV-108 today: 990.00 USDC instead of 1,000.00 USDC on Oct 30, 2026." */
export function offerLine(input: { orgName: string; reference: string | null; amount: number; offered: number; currency: string; dueDate: string }): string {
  const due = new Date(input.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const bill = input.reference ? `invoice ${input.reference}` : "your invoice";
  return `${input.orgName} offers to pay ${bill} today: ${money(input.offered)} ${input.currency} instead of ${money(input.amount)} ${input.currency} on ${due}.`;
}

export interface OfferCandidate {
  invoiceId: string;
  counterpartyName: string;
  reference: string | null;
  amount: number;
  currency: string;
  dueDate: string;
  suggestion: OfferSuggestion;
  /** The open offer, when one is out: its discount, what it pays, and when it lapses. */
  open: { id: string; pct: number; offered: number; expiresAt: string; byAgent: boolean; counterPct: number | null } | null;
}

export interface OffersView {
  reserveApy: number;
  /**
   * Whether the agent makes these offers itself, and the most it asks (agent early-payment offers AO1); null before
   * migration 0126.
   */
  agent: { on: boolean; maxPct: number | null; /** A sandbox: its offers go to the member who turned them on (sandbox offers S1). */ sandbox?: boolean } | null;
  candidates: OfferCandidate[];
  /** The last decided offers, newest first. */
  recent: Array<{ id: string; counterpartyName: string; pct: number; status: "accepted" | "declined" | "withdrawn"; decidedAt: string; /** What the supplier proposed instead, when it countered (offer counters N7). */ counterPct?: number | null }>;
  /** What the offers came to (offer results R1); absent before the workspace made any. */
  results?: OfferResults | null;
}

/** One offer as the results read it (offer results R1). */
export interface OfferOutcome {
  status: string;
  amount: number;
  offered: number;
  byAgent: boolean;
  /** Accepted after the supplier proposed a smaller discount. */
  countered: boolean;
  /** When the supplier answered, and the bill's due date: how early it was paid. */
  decidedAt: string | null;
  dueDate: string | null;
  /** The bill was paid, at the discounted amount. */
  paid: boolean;
}

export interface OfferResults {
  made: number;
  byAgent: number;
  accepted: number;
  afterCounter: number;
  declined: number;
  /** What paying early saved on the bills paid so: their amounts less what was paid. */
  saved: number;
  /** That saving as a yearly rate on the cash paid early, in percent; null when nothing was paid early yet. */
  annualPct: number | null;
}

/**
 * What a workspace's early-payment offers came to (docs/superpowers/specs/2026-10-17-offer-results-design.md R1): how many
 * were made, by the agent among them, accepted (after a counter among them) and declined, and what the bills paid early
 * saved, as an amount and as a yearly rate on the cash paid early.
 */
export function offerResults(rows: OfferOutcome[]): OfferResults {
  const accepted = rows.filter((row) => row.status === "accepted");
  const paidEarly = accepted.filter((row) => row.paid);
  const saved = paidEarly.reduce((sum, row) => sum + (row.amount - row.offered), 0);
  // The cash paid early, weighted by how long before the due date it went.
  const cashYears = paidEarly.reduce((sum, row) => (row.decidedAt && row.dueDate ? sum + (row.offered * daysEarly(row.dueDate, new Date(row.decidedAt))) / 365 : sum), 0);
  return {
    made: rows.length,
    byAgent: rows.filter((row) => row.byAgent).length,
    accepted: accepted.length,
    afterCounter: accepted.filter((row) => row.countered).length,
    declined: rows.filter((row) => row.status === "declined").length,
    saved: Number(saved.toFixed(6)),
    annualPct: cashYears > 0 ? Number(((saved / cashYears) * 100).toFixed(1)) : null,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "So far: 3 offers made, 2 by the agent; 2 accepted, 1 of them after a counter; none declined. Paying early saved 0.0225 USDC, like earning 6.6% a year." (R1) */
export function offerResultsLine(results: OfferResults, currency = "USDC"): string {
  const made = `${plural(results.made, "offer", "offers")} made${results.byAgent > 0 ? `, ${results.byAgent} by the agent` : ""}`;
  const accepted = `${results.accepted} accepted${results.afterCounter > 0 ? `, ${results.afterCounter} of them after a counter` : ""}`;
  const declined = results.declined === 0 ? "none declined" : `${results.declined} declined`;
  const saved =
    results.saved > 0
      ? ` Paying early saved ${money(results.saved)} ${currency}${results.annualPct !== null ? `, like earning ${results.annualPct}% a year` : ""}.`
      : "";
  return `So far: ${made}; ${accepted}; ${declined}.${saved}`;
}
