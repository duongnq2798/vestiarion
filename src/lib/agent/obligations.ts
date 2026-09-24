export const OPEN_PAYABLE_STATUSES = ["pending", "matched", "held", "awaiting_info"] as const;

export interface PayableObligation {
  amount: string | number;
  due_date: string;
  status: string;
}

export interface PayableObligationSummary {
  due7d: number;
  due14d: number;
  openTotal: number;
  daysUntilNext: number;
}

/**
 * Held and awaiting-info invoices are unresolved, not forgiven. They remain
 * in the liquidity buffer until paid or explicitly rejected.
 */
export function summarizePayableObligations(rows: PayableObligation[], now = Date.now()): PayableObligationSummary {
  const open = rows.filter((row) => OPEN_PAYABLE_STATUSES.includes(row.status as (typeof OPEN_PAYABLE_STATUSES)[number]));
  const amount = (row: PayableObligation) => typeof row.amount === "number" ? row.amount : Number(row.amount);
  const dueWithin = (days: number) => {
    const cutoff = now + days * 86_400_000;
    return open.filter((row) => Date.parse(row.due_date) <= cutoff).reduce((sum, row) => sum + amount(row), 0);
  };
  const daysUntilNext = open.reduce((soonest, row) => {
    const days = (Date.parse(row.due_date) - now) / 86_400_000;
    return Number.isFinite(days) ? Math.min(soonest, Math.max(0, days)) : soonest;
  }, Number.POSITIVE_INFINITY);

  return {
    due7d: dueWithin(7),
    due14d: dueWithin(14),
    openTotal: open.reduce((sum, row) => sum + amount(row), 0),
    daysUntilNext,
  };
}
