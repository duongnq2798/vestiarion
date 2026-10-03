import type { ObligationAt } from "./treasury";

export const OPEN_PAYABLE_STATUSES = ["pending", "matched", "held", "awaiting_info", "scheduled"] as const;

/**
 * The USDC amounts of `rows` added up. A row with no currency is USDC; a EURC
 * one is left out: every treasury figure stays USDC, so no USDC total quietly
 * includes euros (EURC invoices design R3).
 */
export function sumUsdcAmounts(rows: ReadonlyArray<{ amount: string | number; currency?: string | null }>): number {
  return rows
    .filter((row) => (row.currency ?? "USDC") === "USDC")
    .reduce((sum, row) => sum + (typeof row.amount === "number" ? row.amount : Number(row.amount)), 0);
}

export interface PayableObligation {
  amount: string | number;
  /** USDC when absent. A EURC payable is paid from EURC, so the USDC buffer leaves it out. */
  currency?: string | null;
  due_date: string;
  status: string;
  /** Set once a `scheduled` invoice has a target day; that day, not `due_date`, is when the cash leaves. */
  scheduled_for?: string | null;
}

export interface PayableObligationSummary {
  due7d: number;
  due14d: number;
  openTotal: number;
  daysUntilNext: number;
  /** Each open USDC payable due within 30 days, on its day, overdue ones at 0 (treasury hold horizon R1). */
  schedule: ObligationAt[];
}

/**
 * Held and awaiting-info invoices are unresolved, not forgiven. They remain
 * in the liquidity buffer until paid or explicitly rejected.
 */
export function summarizePayableObligations(rows: PayableObligation[], now = Date.now()): PayableObligationSummary {
  const open = rows.filter(
    (row) => OPEN_PAYABLE_STATUSES.includes(row.status as (typeof OPEN_PAYABLE_STATUSES)[number]) && (row.currency ?? "USDC") === "USDC"
  );
  const amount = (row: PayableObligation) => typeof row.amount === "number" ? row.amount : Number(row.amount);
  // A scheduled row leaves the account on scheduled_for, not on due_date —
  // that is the date the buffer has to hold cash for. Every other row (and a
  // scheduled one with no target day yet) falls back to due_date as before.
  const effectiveDate = (row: PayableObligation) => row.scheduled_for ?? row.due_date;
  const dueWithin = (days: number) => {
    const cutoff = now + days * 86_400_000;
    return open.filter((row) => Date.parse(effectiveDate(row)) <= cutoff).reduce((sum, row) => sum + amount(row), 0);
  };
  const daysUntilNext = open.reduce((soonest, row) => {
    const days = (Date.parse(effectiveDate(row)) - now) / 86_400_000;
    return Number.isFinite(days) ? Math.min(soonest, Math.max(0, days)) : soonest;
  }, Number.POSITIVE_INFINITY);

  const schedule = open
    .map((row) => ({ days: Math.max(0, (Date.parse(effectiveDate(row)) - now) / 86_400_000), amount: amount(row) }))
    .filter((due) => Number.isFinite(due.days) && due.days < 30);

  return {
    due7d: dueWithin(7),
    due14d: dueWithin(14),
    openTotal: open.reduce((sum, row) => sum + amount(row), 0),
    daysUntilNext,
    schedule,
  };
}
