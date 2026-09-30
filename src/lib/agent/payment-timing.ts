/**
 * When to pay an invoice, computed as a pure function.
 *
 * This is handed to the model as context and used as the fallback when the
 * model is unavailable, the same role `planTreasury` (./treasury.ts) plays
 * for the treasury step. It also serves as the reference a model's decision
 * is compared against, so the ledger can record when the two disagree.
 *
 * Every date here is a UTC calendar date. Due dates are stored at noon UTC
 * (`dueDateIso` in `../intake-validation.ts`) specifically so extracting the
 * day never lands on the wrong side of midnight; this module always derives
 * a day with UTC getters, never local time, and never calls `Date.now()` —
 * `now` is an input, like every other fact here.
 *
 * See docs/superpowers/specs/2026-09-30-payment-timing-design.md §1.
 */

import { utcDay } from "../copy";

export interface PaymentTimingInput {
  now: Date;
  amount: number;
  /** ISO timestamp from the invoice. */
  dueDate: string;
  discount: { pct: number; deadline: string } | null;
  operatingBalance: number;
  /** Annualised, as a fraction: 0.045 for 4.5%. */
  reserveApy: number;
  /** Open payables (and verified milestones) due before this invoice's target date, excluding this invoice. */
  earlierObligations: number;
}

export interface PaymentTiming {
  /** YYYY-MM-DD (UTC) */
  today: string;
  /** YYYY-MM-DD (UTC) of dueDate */
  dueOn: string;
  /** round6(amount * pct/100) when a discount is still available today */
  discountValue: number | null;
  /** YYYY-MM-DD, when still available */
  discountAvailableUntil: string | null;
  /** round6(amount * reserveApy * daysBetween(deadline, due)/365) — 0 when no discount is available */
  floatValueToDue: number;
  /** The date the policy would pay on. */
  targetOn: string;
  recommendation: { action: "pay" } | { action: "schedule"; payOn: string };
  /** One sentence, citing the numbers. */
  reason: string;
  /** operatingBalance - earlierObligations < amountDueAt(targetOn) */
  shortfall: boolean;
  /** Discounted when targetOn <= discount deadline. */
  amountDueAtTarget: number;
}

/** Rounds to USDC's six decimals the way `payInvoice`'s balance sync does (`../pay.ts`). */
function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** Whole days between two UTC calendar dates (`YYYY-MM-DD`), `to - from`. */
function daysBetweenDates(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ty, tm, td] = toDay.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** A real `YYYY-MM-DD` calendar date — rejects both malformed strings and rolled-over ones like Feb 30. */
function isCalendarDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

/** A UTC calendar date, `YYYY-MM-DD`. Never touches local time. */
export function utcDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True through the end of the deadline's UTC day; false before the discount exists or after it lapses. */
export function discountApplies(discount: { pct: number; deadline: string } | null, now: Date): boolean {
  if (!discount) return false;
  return utcDate(now) <= utcDate(discount.deadline);
}

/** What actually leaves the account: discounted through the deadline's UTC day, full amount after. */
export function amountToPay(
  amount: number,
  discount: { pct: number; deadline: string } | null,
  now: Date
): { amountPaid: number; discountTaken: number } {
  if (discountApplies(discount, now)) {
    const amountPaid = round6(amount * (1 - discount!.pct / 100));
    const discountTaken = round6(amount - amountPaid);
    return { amountPaid, discountTaken };
  }
  return { amountPaid: round6(amount), discountTaken: 0 };
}

/**
 * Bounds a `payOn` the model chose to what the invoice can actually promise:
 * a real calendar date, after today, no later than the due date. Every
 * correction is reported as `timingRule` so the caller can record it on the
 * ledger entry.
 */
export function boundPayOn(
  payOn: string | undefined,
  input: { now: Date; dueDate: string }
):
  | { action: "pay"; timingRule: "payon.not_after_today" | "payon.invalid" | null }
  | { action: "schedule"; payOn: string; timingRule: "payon.after_due" | null } {
  const today = utcDate(input.now);
  const dueOn = utcDate(input.dueDate);

  if (payOn == null || payOn === "" || !isCalendarDateString(payOn)) {
    return { action: "pay", timingRule: "payon.invalid" };
  }
  if (payOn <= today) {
    return { action: "pay", timingRule: "payon.not_after_today" };
  }
  if (payOn > dueOn) {
    return { action: "schedule", payOn: dueOn, timingRule: "payon.after_due" };
  }
  return { action: "schedule", payOn, timingRule: null };
}

function buildReason(args: {
  input: PaymentTimingInput;
  today: string;
  dueOn: string;
  deadlineOn: string | null;
  discountValue: number | null;
  floatValueToDue: number;
  discountWins: boolean;
  targetOn: string;
}): string {
  const { input, today, dueOn, deadlineOn, discountValue, floatValueToDue, discountWins, targetOn } = args;

  if (dueOn <= today) {
    return dueOn === today ? "Due today; paying now." : `Overdue since ${utcDay(dueOn)}; paying now.`;
  }

  if (discountValue !== null && deadlineOn) {
    if (discountWins) {
      return targetOn === today
        ? `A ${input.discount!.pct}% early-payment discount (${discountValue} USDC) is worth more than holding the cash to the due date (${floatValueToDue} USDC of yield); the discount deadline is today, so paying now.`
        : `A ${input.discount!.pct}% early-payment discount (${discountValue} USDC) is worth more than holding the cash to the due date (${floatValueToDue} USDC of yield); paying on the discount deadline, ${utcDay(deadlineOn)}.`;
    }
    return `Yield to the due date (${floatValueToDue} USDC) is worth more than the ${input.discount!.pct}% early-payment discount (${discountValue} USDC); paying on the due date, ${utcDay(dueOn)}.`;
  }

  if (input.discount && deadlineOn) {
    return `The ${input.discount.pct}% early-payment discount lapsed on ${utcDay(deadlineOn)}; paying on the due date, ${utcDay(dueOn)}, keeps ${input.amount} USDC available until then.`;
  }

  return `No early-payment discount; paying on the due date, ${utcDay(dueOn)}, keeps ${input.amount} USDC available until then.`;
}

/**
 * The reference answer: capture the discount on its last valid day, otherwise
 * hold the cash until the due date, and never later than that.
 */
export function planPaymentTiming(input: PaymentTimingInput): PaymentTiming {
  const today = utcDate(input.now);
  const dueOn = utcDate(input.dueDate);
  const available = discountApplies(input.discount, input.now);
  const deadlineOn = input.discount ? utcDate(input.discount.deadline) : null;

  const discountValue = available ? round6(input.amount * (input.discount!.pct / 100)) : null;
  const discountAvailableUntil = available ? deadlineOn : null;
  const floatValueToDue = available
    ? round6((input.amount * input.reserveApy * daysBetweenDates(deadlineOn as string, dueOn)) / 365)
    : 0;
  const discountWins = available && discountValue !== null && discountValue >= floatValueToDue;

  const targetOn = dueOn <= today ? today : discountWins ? (deadlineOn as string) : dueOn;

  const recommendation: PaymentTiming["recommendation"] =
    targetOn > today ? { action: "schedule", payOn: targetOn } : { action: "pay" };

  const reason = buildReason({ input, today, dueOn, deadlineOn, discountValue, floatValueToDue, discountWins, targetOn });

  const amountDueAtTarget = amountToPay(input.amount, input.discount, new Date(`${targetOn}T12:00:00.000Z`)).amountPaid;
  const shortfall = input.operatingBalance - input.earlierObligations < amountDueAtTarget;

  return {
    today,
    dueOn,
    discountValue,
    discountAvailableUntil,
    floatValueToDue,
    targetOn,
    recommendation,
    reason,
    shortfall,
    amountDueAtTarget,
  };
}
