/**
 * What a late fee comes to a number of days after the due date (docs/superpowers/specs/2026-10-28-payment-terms-design.md
 * PT4), as the contract says it is charged: a percent a month for each month or part of one, a percent a month by the
 * day, or a fixed amount once, after any days of grace. Always on the amount alone: no fee on a fee, nothing compounded.
 * The limits are a bill's late fee's (late fees LF1, src/lib/intake-validation.ts): a percent a month more than 0 and at
 * most `LATE_FEE_MAX_PERCENT` (src/lib/agent/late-fee.ts) with at most 2 decimal places, a fixed amount at most the
 * invoice's amount; a fixed amount is also at least 0.01, which a bill's need not be, so the page never shows a fee of
 * 0.00. Pure and browser-safe.
 */

import { plural } from "@/lib/copy";
import { LATE_FEE_MAX_PERCENT, type LateFee, type LateFeeKind } from "@/lib/agent/late-fee";
import { addDays, hasAtMostDecimals, MAX_NET_DAYS, money, readFigure, readWholeNumber } from "./terms";

/** How a percent a month is charged: for each month or part of one, or by the day. */
export type LateFeeCharge = "month" | "day";

export interface CalculatorLateFee {
  kind: LateFeeKind;
  /** A percent a month, or a fixed amount. */
  value: number;
  /** Ignored for a fixed fee. */
  charge: LateFeeCharge;
  /** Days after the due date before the fee applies. */
  graceDays: number;
}

export interface LateFeeAt {
  daysLate: number;
  fee: number;
  /** How it was worked out: "1,000.00 × 1.5% × 2 months = 30.00". */
  formula: string;
}

/** The days after the due date the calculator always shows the fee at. */
export const LATE_FEE_DAYS = [7, 30, 60] as const;

/** A month, for a fee charged for each month or part of one. */
export const DAYS_A_MONTH = 30;

/** The most days late the calculator takes. */
export const MAX_DAYS_LATE = 3650;

/** The smallest fixed fee: one under a cent would show as 0.00, the page's figures having 2 decimals. */
export const MIN_FIXED_FEE = 0.01;

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** The fee `daysLate` days after the due date: day 1 is the day after it. */
export function lateFeeAfter(amount: number, fee: CalculatorLateFee, daysLate: number): LateFeeAt {
  const charged = Math.max(0, daysLate - fee.graceDays);
  if (charged === 0) {
    const grace = plural(fee.graceDays, "the first day after the due date is grace", `the first ${fee.graceDays} days after the due date are grace`);
    return { daysLate, fee: 0, formula: `No fee yet: ${grace}.` };
  }
  if (fee.kind === "fixed") return { daysLate, fee: round6(fee.value), formula: `A fixed fee, charged once: ${money(fee.value)}` };
  if (fee.charge === "month") {
    const months = Math.ceil(charged / DAYS_A_MONTH);
    const value = round6(((amount * fee.value) / 100) * months);
    return { daysLate, fee: value, formula: `${money(amount)} × ${fee.value}% × ${months} ${plural(months, "month", "months")} = ${money(value)}` };
  }
  const value = round6((((amount * fee.value) / 100) * 12 * charged) / 365);
  return { daysLate, fee: value, formula: `${money(amount)} × ${fee.value}% × 12 ÷ 365 × ${charged} ${plural(charged, "day", "days")} = ${money(value)}` };
}

/** The first day the fee applies: the day after the due date, after any days of grace. */
export function lateFeeStartsOn(dueOn: string, graceDays: number): string {
  return addDays(dueOn, graceDays + 1);
}

/** The fee as the agent's payment timing names it (`planPaymentTiming`'s `lateFee`, late fees LF7). */
export function plannerLateFee(fee: CalculatorLateFee, dueOn: string): LateFee {
  return { kind: fee.kind, value: fee.value, startsOn: lateFeeStartsOn(dueOn, fee.graceDays) };
}

export type LateFeeRead = { ok: true; fee: CalculatorLateFee | null } | { ok: false; field: "value" | "grace"; message: string };

/**
 * The late fee's fields as typed: none when its value is blank, or what is wrong with them. `amount` is the invoice's,
 * which a fixed fee may not exceed; null while the amount itself cannot be read, which its own field says.
 */
export function readLateFee(input: { value: string; kind: LateFeeKind; charge: LateFeeCharge; grace: string; amount: number | null }): LateFeeRead {
  if (input.value.trim() === "") return { ok: true, fee: null };
  const value = readFigure(input.value);
  if (input.kind === "percent_month") {
    if (value === null || value <= 0 || value > LATE_FEE_MAX_PERCENT || !hasAtMostDecimals(value, 2)) {
      return { ok: false, field: "value", message: `A late fee as a percent a month is more than 0 and at most ${LATE_FEE_MAX_PERCENT}, with at most 2 decimal places.` };
    }
  } else if (value === null || value < MIN_FIXED_FEE || (input.amount !== null && value > input.amount)) {
    return { ok: false, field: "value", message: `A fixed late fee is at least ${MIN_FIXED_FEE} and at most the invoice's amount.` };
  }
  const graceDays = input.grace.trim() === "" ? 0 : readWholeNumber(input.grace);
  if (graceDays === null || graceDays > MAX_NET_DAYS) {
    return { ok: false, field: "grace", message: `Days of grace are a whole number from 0 to ${MAX_NET_DAYS}.` };
  }
  return { ok: true, fee: { kind: input.kind, value, charge: input.charge, graceDays } };
}
