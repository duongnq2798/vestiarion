/**
 * A payable's late fee (docs/superpowers/specs/2026-10-23-late-fees-design.md LF1, LF4): the term its supplier wrote on
 * the invoice, and what waiting costs. Information only: a late fee is never added to a transfer, and a bill paid late is
 * paid at its amount; the person settles any fee with the vendor. Pure and browser-safe. Every day is a UTC calendar day
 * (`YYYY-MM-DD`), as in ./payment-timing.ts.
 */

import { utcDay } from "../copy";

export const LATE_FEE_KINDS = ["percent_month", "fixed"] as const;
export type LateFeeKind = (typeof LATE_FEE_KINDS)[number];

export interface LateFee {
  kind: LateFeeKind;
  /** A percent a month, more than 0 and at most 10; or a fixed amount in the invoice's currency. */
  value: number;
  /** `YYYY-MM-DD`: the first day the fee applies, on or after the due date. */
  startsOn: string;
}

/** The highest percent a month a late fee may be (`invoices_late_fee_value_range`, 0141). */
export const LATE_FEE_MAX_PERCENT = 10;

/** The columns migration 0141 adds, as an explicit select names them. */
export const LATE_FEE_SELECT = "late_fee_kind, late_fee_value, late_fee_starts_on";

const DAY = /^\d{4}-\d{2}-\d{2}/;

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * The late fee an invoice row carries (migration 0141), or null when it has none. A term the database would refuse, or a
 * start that is not a day, is no fee at all: a row that cannot be read never weighs one. A row read before 0141 has none.
 */
export function invoiceLateFee(row: {
  late_fee_kind?: string | null;
  late_fee_value?: string | number | null;
  late_fee_starts_on?: string | null;
}): LateFee | null {
  const kind = row.late_fee_kind;
  if (kind !== "percent_month" && kind !== "fixed") return null;
  if (row.late_fee_value == null || row.late_fee_starts_on == null) return null;
  const value = Number(row.late_fee_value);
  if (!Number.isFinite(value) || value <= 0 || (kind === "percent_month" && value > LATE_FEE_MAX_PERCENT)) return null;
  const startsOn = DAY.exec(String(row.late_fee_starts_on))?.[0];
  if (!startsOn || Number.isNaN(Date.parse(`${startsOn}T00:00:00.000Z`))) return null;
  return { kind, value, startsOn };
}

/** Whether the fee applies on `on`: from its first day. */
export function lateFeeStarted(fee: LateFee, on: string): boolean {
  return on.slice(0, 10) >= fee.startsOn;
}

/** The last day without the fee: the day before it starts. */
export function lastDayWithoutFee(fee: LateFee): string {
  return new Date(Date.parse(`${fee.startsOn}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The coming month a late fee is weighed over (LF6): the 30 days from the day, that day included. */
export const COMING_MONTH_DAYS = 30;

/**
 * What waiting costs in the coming month from `on`, in the invoice's currency (LF4, LF6): a month of the percent of the
 * amount still to pay, whether or not it has started, or the fixed amount while it is still ahead. A fixed fee that has
 * started is owed whatever comes next, so another month costs nothing more; a fee that starts after the coming month
 * costs nothing in it. Never negative; 0 with no fee. It moves with the day, so it orders bills and is never what a plan
 * is told apart by: the term is.
 */
export function lateFeeOf(invoice: { amount: number | string; lateFee: LateFee | null }, on: string): number {
  const fee = invoice.lateFee;
  if (!fee) return 0;
  // The first day after the coming month: a fee from then on costs nothing in it.
  const afterTheMonth = new Date(Date.parse(`${on.slice(0, 10)}T00:00:00.000Z`) + COMING_MONTH_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (fee.startsOn >= afterTheMonth) return 0;
  if (fee.kind === "fixed") return lateFeeStarted(fee, on) ? 0 : Math.max(0, round6(fee.value));
  return aMonthOf(fee, invoice.amount);
}

/** A month of a percent fee past its start: the percent of the amount still to pay; 0 for an amount that is not one. */
function aMonthOf(fee: LateFee, amount: number | string): number {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, round6((value * fee.value) / 100));
}

/** Whether two terms are the same: kind, value and first day (a bill's late fee unchanged, order design O4). */
export function sameLateFee(a: LateFee | null | undefined, b: LateFee | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && Math.abs(a.value - b.value) < 0.0000005 && a.startsOn === b.startsOn;
}

const show = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);

/** The rate alone: "1.5% a month", or "25.00 USDC". */
export function lateFeeRateWords(fee: LateFee, currency = "USDC"): string {
  return fee.kind === "percent_month" ? `${fee.value}% a month` : `${show(fee.value)} ${currency}`;
}

/** The rate with what a month costs: "1.5% a month (1.50 USDC)", or "25.00 USDC" (the approval card's cost box, LF4). */
export function lateFeeWords(fee: LateFee, amount: number, currency = "USDC"): string {
  if (fee.kind === "fixed") return lateFeeRateWords(fee, currency);
  return `${lateFeeRateWords(fee, currency)} (${show(round6((amount * fee.value) / 100))} ${currency})`;
}

/** The fee as a sentence names it: "a 1.5% monthly late fee (1.50 USDC)", or "a 25.00 USDC late fee". */
export function lateFeeClause(fee: LateFee, amount: number, currency = "USDC"): string {
  if (fee.kind === "fixed") return `a ${show(fee.value)} ${currency} late fee`;
  return `a ${fee.value}% monthly late fee (${show(round6((amount * fee.value) / 100))} ${currency})`;
}

/**
 * The term as an entry signs it and the model reads it (LF3, LF7): its kind, value and first day, and what a month past
 * its start costs (`aMonth`, the percent of the amount, or the fixed amount).
 */
export function lateFeeTerms(fee: LateFee, amount: number): { kind: LateFeeKind; value: number; startsOn: string; aMonth: number } {
  return { kind: fee.kind, value: fee.value, startsOn: fee.startsOn, aMonth: fee.kind === "fixed" ? fee.value : aMonthOf(fee, amount) };
}

/**
 * The fee as the approval card's cost box and the Bills list name it (LF4): "Late after Oct 29, 2026", the last day without
 * it, and "1.5% a month (1.50 USDC)" or "25.00 USDC".
 */
export function lateFeeLine(fee: LateFee, amount: number, currency = "USDC"): { label: string; value: string } {
  return { label: `Late after ${utcDay(`${lastDayWithoutFee(fee)}T00:00:00.000Z`)}`, value: lateFeeWords(fee, amount, currency) };
}

/** A column this database does not have yet: Postgres's own code, or PostgREST's for a write naming it. */
export function missingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

/**
 * A read that names the late-fee columns, given as `, late_fee_kind, …` to append to its select, run again without them
 * when the database does not have them yet (production can run code before migration 0141): its rows then carry no fee.
 * Any other failure is left as it is.
 */
export async function readWithLateFee<T extends { error: { code?: string } | null }>(read: (lateFeeColumns: string) => PromiseLike<T>): Promise<T> {
  const first = await read(`, ${LATE_FEE_SELECT}`);
  return missingColumn(first.error) ? read("") : first;
}
