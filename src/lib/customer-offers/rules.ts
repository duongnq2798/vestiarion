/**
 * What code allows the agent when it offers customers a discount to pay early (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md
 * C1-C3): when cash is short enough to ask, which receivables it may offer, the discount it may give, and the written
 * policy's answer the model is weighed against. Pure.
 */

/** The ceiling an owner or admin sets: the most the agent gives, in percent (C1). */
export const CUSTOMER_MIN_CEILING_PCT = 0.5;
export const CUSTOMER_MAX_CEILING_PCT = 5;
/** The smallest discount offered, in percent: anything less is not worth a customer's notice (C3). */
export const CUSTOMER_MIN_PCT = 0.25;
/** The most offers one cycle sends (C2). */
export const CUSTOMER_OFFERS_PER_RUN = 3;
/** A receivable is only offered when it falls due this many days or more after today (C2). */
export const CUSTOMER_MIN_DAYS_EARLY = 7;
/** How long a customer has to pay at the discount, at most: the pay-by day is this many days after the offer (C4). */
export const CUSTOMER_PAY_WITHIN_DAYS = 5;
/** A customer who declined an offer is not offered again for this long (C2). */
export const CUSTOMER_DECLINE_COOL_DAYS = 30;
/** A receivable the agent chose not to offer is weighed again after this long (C3). */
export const CUSTOMER_SKIP_RETRY_DAYS = 7;
/** An offer made and not emailed after this long is a stopped run's: withdrawn, and its receivable weighed again (C7). */
export const CUSTOMER_UNSENT_LEASE_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

export type CustomerOfferRefusal =
  | "no_shortfall"
  | "not_open"
  | "not_usdc"
  | "too_soon"
  | "part_paid"
  | "offered_before"
  | "reviewed"
  | "no_email"
  | "no_pay_link"
  | "customer_has_offer"
  | "customer_declined";

export interface CustomerOfferFacts {
  /** What the bills held for cash need beyond the operating USDC (C2); zero or less is no shortfall. */
  shortfall: number;
  /** The receivable is open: not received, not rejected. */
  open: boolean;
  currency: string | null;
  daysEarly: number;
  /** Money already applied to it, by the agent or a person. */
  partPaid: boolean;
  /** Any offer this receivable ever had. */
  offeredBefore: boolean;
  /** The agent already weighed this receivable, and its answer still stands. */
  reviewed: boolean;
  billingEmail: string | null;
  /** Its pay link is kept, so the offer can carry it. */
  payLink: boolean;
  /** The customer has another offer open. */
  customerHasOpenOffer: boolean;
  /** When the customer last declined an offer, or null. */
  customerDeclinedAt: string | null;
  now: number;
}

/** Whether code allows the agent to weigh an offer on this receivable now (C2), and if not, why. */
export function customerOfferAllowed(facts: CustomerOfferFacts): { allowed: true } | { allowed: false; because: CustomerOfferRefusal } {
  if (!(facts.shortfall > 0)) return { allowed: false, because: "no_shortfall" };
  if (!facts.open) return { allowed: false, because: "not_open" };
  if ((facts.currency ?? "USDC") !== "USDC") return { allowed: false, because: "not_usdc" };
  if (facts.daysEarly < CUSTOMER_MIN_DAYS_EARLY) return { allowed: false, because: "too_soon" };
  if (facts.partPaid) return { allowed: false, because: "part_paid" };
  if (facts.offeredBefore) return { allowed: false, because: "offered_before" };
  if (facts.reviewed) return { allowed: false, because: "reviewed" };
  if (!facts.billingEmail) return { allowed: false, because: "no_email" };
  if (!facts.payLink) return { allowed: false, because: "no_pay_link" };
  if (facts.customerHasOpenOffer) return { allowed: false, because: "customer_has_offer" };
  if (facts.customerDeclinedAt && facts.now - Date.parse(facts.customerDeclinedAt) < CUSTOMER_DECLINE_COOL_DAYS * DAY_MS) {
    return { allowed: false, because: "customer_declined" };
  }
  return { allowed: true };
}

/** To the nearest 0.25%. */
const quarter = (pct: number) => Math.round(pct * 4) / 4;

/**
 * The discount the written policy gives (C3): 1% for each 30 days the money comes early, to the nearest 0.25%, at least
 * 0.25% and no more than the ceiling.
 */
export function suggestedCustomerPct(daysEarly: number, ceilingPct: number): number {
  return Number(Math.min(ceilingPct, Math.max(CUSTOMER_MIN_PCT, quarter(daysEarly / 30))).toFixed(2));
}

/** The discount the model chose, kept between 0.25% and the ceiling, to the nearest 0.25% (C3). */
export function boundCustomerPct(chosen: number | undefined, suggestedPct: number, ceilingPct: number): { pct: number; limited: boolean } {
  const valid = typeof chosen === "number" && Number.isFinite(chosen);
  const asked = valid ? quarter(chosen) : suggestedPct;
  const pct = Number(Math.min(ceilingPct, Math.max(CUSTOMER_MIN_PCT, asked)).toFixed(2));
  return { pct, limited: valid && (asked < CUSTOMER_MIN_PCT || asked > ceilingPct) };
}

/** What the customer pays at a discount, to 6 places. */
export function discountedAmount(amount: number, pct: number): number {
  return Number((amount * (100 - pct) / 100).toFixed(6));
}

/**
 * The shortfall (C2): what the payables held for want of cash add up to, with what is already set for payables scheduled
 * before the last of them falls due, less the operating USDC left after this cycle's payments and the reserve (cash ahead
 * A5), and less the receivables already accepted at a discount and not yet paid. Never below zero.
 */
export function cashShortfall(input: { heldForCash: number; scheduled?: number; operating: number; reserve?: number; acceptedUnpaid: number }): number {
  return Number(Math.max(0, input.heldForCash + (input.scheduled ?? 0) - input.operating - (input.reserve ?? 0) - input.acceptedUnpaid).toFixed(6));
}

/**
 * Which allowed receivables to weigh, in order (C2): the largest first, until what they would bring in at the ceiling
 * covers the shortfall, and never more than three.
 */
export function pickCustomerOffers<T extends { amount: number }>(allowed: T[], shortfall: number, ceilingPct: number): T[] {
  const picked: T[] = [];
  let covered = 0;
  for (const row of [...allowed].sort((a, b) => b.amount - a.amount)) {
    if (picked.length >= CUSTOMER_OFFERS_PER_RUN || covered >= shortfall) break;
    picked.push(row);
    covered += discountedAmount(row.amount, ceilingPct);
  }
  return picked;
}

/** The last day a customer can pay at the discount (C4): five days from today, and before the day it falls due. */
export function payByDay(today: string, dueDay: string): string {
  const within = new Date(Date.parse(`${today}T00:00:00Z`) + CUSTOMER_PAY_WITHIN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const beforeDue = new Date(Date.parse(`${dueDay}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  return within < beforeDue ? within : beforeDue;
}

export interface CustomerOfferDecision {
  action: "offer" | "skip";
  pct?: number;
  reasoning: string;
}

/** The written policy (C3): offer every receivable code allows, at the suggested discount. */
export function referenceCustomerDecision(input: { suggestedPct: number; daysEarly: number; shortfall: number }): CustomerOfferDecision {
  return {
    action: "offer",
    pct: input.suggestedPct,
    reasoning: `Bills are held for ${input.shortfall} USDC the operating wallet does not have. This customer's money is due in ${input.daysEarly} days; ${input.suggestedPct.toFixed(2)}% off for paying within ${CUSTOMER_PAY_WITHIN_DAYS} days brings it in sooner.`,
  };
}
