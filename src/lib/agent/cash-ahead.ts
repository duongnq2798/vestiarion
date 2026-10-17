import { amountToPay, type InvoiceDiscount } from "./payment-timing";

/**
 * Scheduled payments checked against the cash ahead (docs/superpowers/specs/2026-10-17-cash-ahead-design.md).
 *
 * A scheduled bill waits, undecided, until its day. It was scheduled when the cash covered it then; something may have
 * taken that cash since: a bill due earlier, a bill held for want of cash that falls due first, a milestone verified.
 * Each cycle, code measures every USDC bill scheduled for a later day the way the written policy measures it (A1): the
 * cash counted for a later day, the operating USDC and the reserve, less what falls due on or before its day, against
 * what it needs on its day. One that falls short is decided again now, by the AP stage, with every check, so a bill
 * that cannot be paid is held days ahead, while there is still time to ask the supplier for more time or a customer to
 * pay sooner, rather than on its day.
 *
 * Pure: the AP stage passes the rows, the balances, what falls due by a day (`obligationsDueBy`) and each bill's latest
 * scheduling as the ledger recorded it.
 */

/** At most this many scheduled bills are decided before their day in one cycle, the earliest scheduled first (A3). */
export const CASH_AHEAD_PER_CYCLE = 5;

/** What the check measured for one bill, as the AP decision's ledger entry records it (A4). */
export interface CashAhead {
  /** The day it was scheduled for, `YYYY-MM-DD`. */
  scheduledFor: string;
  /** The cash counted for that day: the operating USDC and the reserve. */
  cashCounted: number;
  /** What falls due on or before that day, this bill aside. */
  dueBefore: { total: number; count: number };
  /** What it needs on that day, its early-payment discount taken when it still applies then. */
  needed: number;
}

/** A scheduled bill the AP stage loaded and is not deciding this cycle. */
export interface AheadCandidate {
  id: string;
  amount: number;
  currency: "USDC" | "EURC";
  scheduledFor: string | null;
  discount: InvoiceDiscount | null;
  /** Paid to a bank account in another token (bank payouts B13): the operating USDC is not what it needs. */
  paidToBank: boolean;
}

/** A bill's latest scheduling, from the ledger: the agent's decision, or a person's move from the payment plan. */
export type LatestScheduling =
  | { by: "person" }
  | { by: "agent"; shortfall: boolean | null; cashAhead: Pick<CashAhead, "cashCounted" | "dueBefore"> | null };

const CENT_MILLIONTH = 0.0000005;

const dayOf = (value: string | null): string | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

/**
 * Whether the cash ahead got worse for a bill since a check last decided it before its day (A3): less cash counted,
 * or more falling due before it. Unchanged, the decision then stands until its day.
 */
function worseSince(seen: Pick<CashAhead, "cashCounted" | "dueBefore">, now: Pick<CashAhead, "cashCounted" | "dueBefore">): boolean {
  return now.cashCounted < seen.cashCounted - CENT_MILLIONTH || now.dueBefore.total > seen.dueBefore.total + CENT_MILLIONTH;
}

/**
 * The scheduled bills the cash will not cover on their day, to be decided again now (A1, A3), keyed by id, with what
 * was measured. Only USDC bills scheduled for a day after today and not paid to a bank account are measured. A bill
 * is left to its day when a person moved it there, when its decision scheduled it knowing the cash fell short, or
 * when a check already decided it early and the cash ahead is no worse now.
 */
export function shortAhead(input: {
  candidates: readonly AheadCandidate[];
  today: string;
  operatingBalance: number;
  reserveBalance: number;
  /** What falls due on or before `by`, the bill `excludeId` aside: the AP stage's `obligationsDueBy` over its book. */
  dueBy: (excludeId: string, by: string) => { total: number; count: number };
  latest: ReadonlyMap<string, LatestScheduling>;
}): Map<string, CashAhead> {
  const cashCounted = Number((input.operatingBalance + input.reserveBalance).toFixed(6));
  const measured: Array<{ id: string; ahead: CashAhead }> = [];
  for (const row of input.candidates) {
    if (row.currency !== "USDC" || row.paidToBank) continue;
    const scheduledFor = dayOf(row.scheduledFor);
    if (scheduledFor === null || scheduledFor <= input.today) continue;
    const dueBefore = input.dueBy(row.id, scheduledFor);
    const needed = amountToPay(row.amount, row.discount, new Date(`${scheduledFor}T12:00:00.000Z`)).amountPaid;
    if (cashCounted - dueBefore.total >= needed - CENT_MILLIONTH) continue;
    const ahead: CashAhead = { scheduledFor, cashCounted, dueBefore: { total: Number(dueBefore.total.toFixed(6)), count: dueBefore.count }, needed };
    const latest = input.latest.get(row.id);
    if (latest?.by === "person") continue;
    if (latest?.by === "agent") {
      if (latest.cashAhead ? !worseSince(latest.cashAhead, ahead) : latest.shortfall === true) continue;
    }
    measured.push({ id: row.id, ahead });
  }
  measured.sort((a, b) => (a.ahead.scheduledFor === b.ahead.scheduledFor ? 0 : a.ahead.scheduledFor < b.ahead.scheduledFor ? -1 : 1));
  return new Map(measured.slice(0, CASH_AHEAD_PER_CYCLE).map(({ id, ahead }) => [id, ahead] as const));
}

/**
 * A bill's latest scheduling from the newest-first ledger entries about it (`ap_schedule` and `payment_rescheduled`):
 * the first one seen. Unreadable details count as an agent's decision that saw no shortfall.
 */
export function latestSchedulingOf(entries: ReadonlyArray<{ action: string; detail: Record<string, unknown> }>): Map<string, LatestScheduling> {
  const latest = new Map<string, LatestScheduling>();
  for (const entry of entries) {
    const id = typeof entry.detail.invoiceId === "string" ? entry.detail.invoiceId : null;
    if (!id || latest.has(id)) continue;
    if (entry.action === "payment_rescheduled") {
      latest.set(id, { by: "person" });
      continue;
    }
    const timing = entry.detail.timing;
    const shortfall = typeof timing === "object" && timing !== null && typeof (timing as Record<string, unknown>).shortfall === "boolean" ? ((timing as Record<string, unknown>).shortfall as boolean) : null;
    latest.set(id, { by: "agent", shortfall, cashAhead: seenAhead(entry.detail.cashAhead) });
  }
  return latest;
}

function seenAhead(value: unknown): Pick<CashAhead, "cashCounted" | "dueBefore"> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const due = record.dueBefore as Record<string, unknown> | undefined;
  const cashCounted = Number(record.cashCounted);
  const total = Number(due?.total);
  const count = Number(due?.count);
  if (!Number.isFinite(cashCounted) || !Number.isFinite(total)) return null;
  return { cashCounted, dueBefore: { total, count: Number.isFinite(count) ? count : 0 } };
}
