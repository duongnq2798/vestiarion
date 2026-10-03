/**
 * When to pay an invoice, computed as a pure function.
 *
 * Its figures are handed to the model as context; its own answer
 * (`recommendation` and `reason`) is not. That answer is the fallback when
 * the model is unavailable, the same role `planTreasury` (./treasury.ts)
 * plays for the treasury step, and the reference a model's decision is
 * compared against, so the ledger can record when the two disagree (the AP
 * stage's `timingFacts` in ./orchestrator.ts picks what the model is sent).
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
  /**
   * What sits in the yield-bearing reserve (USYC). Counted in the shortfall
   * check only when `targetOn` is after today: `planTreasury` (./treasury.ts)
   * redeems from the reserve whenever the operating balance would otherwise
   * dip under its buffer over what falls due, so cash swept there today is
   * back in the operating account before a payment scheduled for a later
   * day comes due. It does not count toward paying now — the treasury stage
   * that would redeem it runs after the AP stage in the same cycle, so it is
   * not liquid this minute.
   */
  reserveBalance: number;
  /** Open payables (and verified milestones) due on or before this invoice's target date, excluding this invoice. */
  earlierObligations: number;
  /** What the amounts are in, for the reason's wording: USDC unless the invoice is in EURC. */
  currency?: string;
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
  /**
   * (operatingBalance, plus reserveBalance when targetOn is after today) -
   * earlierObligations < amountDueAt(targetOn).
   */
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

/** An invoice's early-payment discount: the percent off, and the timestamp of the day it lasts through (UTC). */
export interface InvoiceDiscount {
  pct: number;
  deadline: string;
}

/**
 * The early-payment discount an invoice row carries (migration 0038), or
 * null when it has none. A percent the database would refuse anyway — not
 * above 0 and below 100 — or a deadline that is not a date is no discount at
 * all, so the full amount is paid: a row that cannot be read never pays less
 * than it says.
 *
 * `/api/v1/invoices` reads the same two columns the same way, for
 * `earlyPayDiscount` (`invoiceDiscountOf` in
 * src/app/api/v1/invoices/route.ts); a change to one belongs in the other.
 */
export function invoiceDiscount(row: {
  early_pay_discount_pct?: string | number | null;
  discount_due_date?: string | null;
}): InvoiceDiscount | null {
  if (row.early_pay_discount_pct == null || row.discount_due_date == null) return null;
  const pct = typeof row.early_pay_discount_pct === "number" ? row.early_pay_discount_pct : Number(row.early_pay_discount_pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  if (Number.isNaN(Date.parse(row.discount_due_date))) return null;
  return { pct, deadline: row.discount_due_date };
}

/** True through the end of the deadline's UTC day when a discount is set; false when there is none, or once that day has passed. */
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

  if (!isCalendarDateString(dueOn)) {
    return { action: "pay", timingRule: "payon.invalid" };
  }
  if (payOn == null || payOn === "" || !isCalendarDateString(payOn)) {
    return { action: "pay", timingRule: "payon.invalid" };
  }

  // Clamp to the due date *before* checking against today. Checking
  // "not after today" first would let an overdue or due-today invoice come
  // out as "schedule" for a past (or today's) date, just because the
  // unclamped payOn happened to be later than today.
  const clamped = payOn > dueOn;
  const effective = clamped ? dueOn : payOn;

  if (effective <= today) {
    return { action: "pay", timingRule: "payon.not_after_today" };
  }
  return { action: "schedule", payOn: effective, timingRule: clamped ? "payon.after_due" : null };
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
  const unit = input.currency ?? "USDC";

  if (dueOn <= today) {
    return dueOn === today ? "Due today; paying now." : `Overdue since ${utcDay(dueOn)}; paying now.`;
  }

  if (discountValue !== null && deadlineOn) {
    if (discountWins) {
      // "at least as much" on a tie keeps the sentence honest — >= is the
      // brief's rule ("worth at least as much"), and "worth more" would
      // overstate an exact tie.
      const comparison = discountValue === floatValueToDue ? "is worth at least as much as" : "is worth more than";
      return targetOn === today
        ? `A ${input.discount!.pct}% early-payment discount (${discountValue} ${unit}) ${comparison} holding the cash to the due date (${floatValueToDue} ${unit} of yield); the discount deadline is today, so paying now.`
        : `A ${input.discount!.pct}% early-payment discount (${discountValue} ${unit}) ${comparison} holding the cash to the due date (${floatValueToDue} ${unit} of yield); paying on the discount deadline, ${utcDay(deadlineOn)}.`;
    }
    return `Yield to the due date (${floatValueToDue} ${unit}) is worth more than the ${input.discount!.pct}% early-payment discount (${discountValue} ${unit}); paying on the due date, ${utcDay(dueOn)}.`;
  }

  if (input.discount && deadlineOn) {
    // "ended with", not "lapsed on" — the discount was valid through the
    // whole of that UTC day (discountApplies is inclusive), so it did not
    // stop being valid on that date; it stopped the day after.
    return `The ${input.discount.pct}% early-payment discount ended with ${utcDay(deadlineOn)}; paying on the due date, ${utcDay(dueOn)}, keeps ${input.amount} ${unit} available until then.`;
  }

  return `No early-payment discount; paying on the due date, ${utcDay(dueOn)}, keeps ${input.amount} ${unit} available until then.`;
}

/**
 * What counts toward the shortfall check for a payment targeted at `targetOn`:
 * the operating balance alone when that target is today (the cycle's
 * liquidity step, before AP, has already brought back from the reserve what
 * today's payments need, so what is still there was not liquid this cycle),
 * plus the reserve balance when the target is a later day — the treasury has
 * time to redeem it back before then.
 */
function availableBy(input: PaymentTimingInput, targetOn: string, today: string): number {
  return targetOn > today ? input.operatingBalance + input.reserveBalance : input.operatingBalance;
}

/**
 * The reference answer: capture the discount on its last valid day, otherwise
 * hold the cash until the due date, and never later than that.
 */
export function planPaymentTiming(input: PaymentTimingInput): PaymentTiming {
  const today = utcDate(input.now);
  const dueOn = utcDate(input.dueDate);

  // Defense in depth: a due date that cannot be read is not a licence to
  // schedule against an unknown day. Pay now, same as the "overdue" rule
  // would if the date were known to be in the past.
  if (!isCalendarDateString(dueOn)) {
    const amountDueAtTarget = amountToPay(input.amount, input.discount, input.now).amountPaid;
    return {
      today,
      dueOn: today,
      discountValue: null,
      discountAvailableUntil: null,
      floatValueToDue: 0,
      targetOn: today,
      recommendation: { action: "pay" },
      reason: "The due date could not be read; paying now rather than scheduling against an unknown date.",
      shortfall: availableBy(input, today, today) - input.earlierObligations < amountDueAtTarget,
      amountDueAtTarget,
    };
  }

  const available = discountApplies(input.discount, input.now);
  const deadlineOn = input.discount ? utcDate(input.discount.deadline) : null;

  const discountValue = available ? round6(input.amount * (input.discount!.pct / 100)) : null;
  const discountAvailableUntil = available ? deadlineOn : null;
  const floatValueToDue = available
    ? round6((input.amount * input.reserveApy * daysBetweenDates(deadlineOn as string, dueOn)) / 365)
    : 0;
  const discountWins = available && discountValue !== null && discountValue >= floatValueToDue;

  let targetOn: string;
  if (dueOn <= today) {
    // Due today or overdue: pay now. `today` can be later than `dueOn` here
    // by design (that is what "overdue" means) — the defensive due-date clamp
    // below must not apply to this branch.
    targetOn = today;
  } else {
    const rawTarget = discountWins ? (deadlineOn as string) : dueOn;
    // Defense in depth: P2 says the due date is the latest any invoice waits,
    // always. A discount deadline stored later than the due date (which
    // intake validation should already forbid) must not schedule past it.
    targetOn = rawTarget > dueOn ? dueOn : rawTarget;
  }

  const recommendation: PaymentTiming["recommendation"] =
    targetOn > today ? { action: "schedule", payOn: targetOn } : { action: "pay" };

  const reason = buildReason({ input, today, dueOn, deadlineOn, discountValue, floatValueToDue, discountWins, targetOn });

  const amountDueAtTarget = amountToPay(input.amount, input.discount, new Date(`${targetOn}T12:00:00.000Z`)).amountPaid;
  const shortfall = availableBy(input, targetOn, today) - input.earlierObligations < amountDueAtTarget;

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
