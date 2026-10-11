import { invoiceDiscount } from "./agent/payment-timing";
import { OPEN_PAYABLE_STATUSES } from "./agent/obligations";

/**
 * What the payment plan is measured by, over the last 30 days (docs/superpowers/specs/2026-10-11-payment-plan-design.md
 * P14): bills paid by their due day, and the overdue ones now; discounts actually taken, measured as the report measures
 * them (a paid bill with discount terms, its amount less what its transfer carried); and the days people moved from the
 * plan. Every figure is counted from what happened, never from a plan. Pure: the page hands it the rows it read.
 */

export const OUTCOME_DAYS = 30;

export interface PlanOutcomes {
  paid: number;
  paidOnTime: number;
  overdueNow: number;
  discountsTaken: number;
  moves: number;
}

const DAY_MS = 86_400_000;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const dayOf = (value: string) => new Date(value).toISOString().slice(0, 10);

export function planOutcomes(input: {
  now: number;
  invoices: ReadonlyArray<{
    direction: string;
    status: string;
    amount: number;
    currency?: string | null;
    due_date: string;
    settled_at?: string | null;
    paid_amount: number | null;
    early_pay_discount_pct?: string | number | null;
    discount_due_date?: string | null;
  }>;
  entries: ReadonlyArray<{ ts: string; action: string }>;
}): PlanOutcomes {
  const since = input.now - OUTCOME_DAYS * DAY_MS;
  const today = dayOf(new Date(input.now).toISOString());
  const payables = input.invoices.filter((invoice) => invoice.direction === "payable" && (invoice.currency ?? "USDC") === "USDC");
  const paid = payables.filter((invoice) => invoice.status === "paid" && invoice.settled_at && !Number.isNaN(Date.parse(invoice.settled_at)) && Date.parse(invoice.settled_at) >= since);
  const paidOnTime = paid.filter((invoice) => dayOf(invoice.settled_at as string) <= dayOf(invoice.due_date)).length;
  const discountsTaken = paid.reduce((sum, invoice) => {
    if (!invoiceDiscount(invoice) || invoice.paid_amount === null) return sum;
    const taken = invoice.amount - invoice.paid_amount;
    return taken > 0 ? sum + taken : sum;
  }, 0);
  const overdueNow = payables.filter((invoice) => (OPEN_PAYABLE_STATUSES as readonly string[]).includes(invoice.status) && dayOf(invoice.due_date) < today).length;
  const moves = input.entries.filter((entry) => entry.action === "payment_rescheduled" && Date.parse(entry.ts) >= since).length;
  return { paid: paid.length, paidOnTime, overdueNow, discountsTaken: round6(discountsTaken), moves };
}
