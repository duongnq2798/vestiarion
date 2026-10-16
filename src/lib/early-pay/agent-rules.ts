/**
 * What code allows the agent when it makes early-payment offers (docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md
 * AO1-AO3): which bills it may offer, the discount it may ask, and the written policy's answer the model is weighed
 * against. Pure.
 */

/** The ceiling an owner or admin sets: the most the agent asks, in percent (AO1). */
export const AGENT_MIN_CEILING_PCT = 0.5;
export const AGENT_MAX_CEILING_PCT = 10;
/** The most offers one cycle sends (AO2). */
export const AGENT_OFFERS_PER_RUN = 3;
/** An offer is only worth making this many days or more before the due date (AO2). */
export const AGENT_MIN_DAYS_EARLY = 7;
/** A supplier who declined an offer is not offered again for this long (AO2). */
export const DECLINE_COOL_DAYS = 30;
/** A bill the agent chose not to offer is weighed again after this long (AO3). */
export const SKIP_RETRY_DAYS = 7;
/** An offer made and not emailed after this long is a stopped run's: withdrawn, and its bill weighed again (AO4). */
export const UNSENT_LEASE_MS = 15 * 60_000;
/** The payables falling due within this many days come first: the cash for them is never offered (AO2). */
export const CASH_HORIZON_DAYS = 7;

const DAY_MS = 86_400_000;

export type AgentOfferRefusal =
  | "not_scheduled"
  | "not_usdc"
  | "too_soon"
  | "offered_before"
  | "reviewed"
  | "no_email"
  | "supplier_has_offer"
  | "supplier_declined"
  | "above_ceiling"
  | "cash";

export interface AgentOfferFacts {
  status: string;
  currency: string | null;
  daysEarly: number;
  /** Any offer this bill ever had, by a person or by the agent. */
  offeredBefore: boolean;
  /** The agent already weighed this bill, and its answer still stands. */
  reviewed: boolean;
  noticeEmail: string | null;
  /** The supplier has another offer open. */
  supplierHasOpenOffer: boolean;
  /** When the supplier last declined an offer, or null. */
  supplierDeclinedAt: string | null;
  /** The suggested discount (E2), the floor the agent asks. */
  floorPct: number;
  ceilingPct: number;
  /** What the supplier would receive at the floor, and the cash code leaves for offers. */
  offeredAtFloor: number;
  cashForOffers: number;
  now: number;
}

/** Whether code allows the agent to weigh an offer on this bill now (AO2), and if not, why. */
export function agentOfferAllowed(facts: AgentOfferFacts): { allowed: true } | { allowed: false; because: AgentOfferRefusal } {
  if (facts.status !== "scheduled") return { allowed: false, because: "not_scheduled" };
  if ((facts.currency ?? "USDC") !== "USDC") return { allowed: false, because: "not_usdc" };
  if (facts.daysEarly < AGENT_MIN_DAYS_EARLY) return { allowed: false, because: "too_soon" };
  if (facts.offeredBefore) return { allowed: false, because: "offered_before" };
  if (facts.reviewed) return { allowed: false, because: "reviewed" };
  if (!facts.noticeEmail) return { allowed: false, because: "no_email" };
  if (facts.supplierHasOpenOffer) return { allowed: false, because: "supplier_has_offer" };
  if (facts.supplierDeclinedAt && facts.now - Date.parse(facts.supplierDeclinedAt) < DECLINE_COOL_DAYS * DAY_MS) return { allowed: false, because: "supplier_declined" };
  if (facts.floorPct > facts.ceilingPct) return { allowed: false, because: "above_ceiling" };
  if (facts.offeredAtFloor > facts.cashForOffers) return { allowed: false, because: "cash" };
  return { allowed: true };
}

/** The discount the model chose, kept between the floor and the ceiling, to the nearest 0.25% (AO3). */
export function boundOfferPct(chosen: number | undefined, floorPct: number, ceilingPct: number): { pct: number; limited: boolean } {
  const asked = typeof chosen === "number" && Number.isFinite(chosen) ? Math.round(chosen * 4) / 4 : floorPct;
  const pct = Number(Math.min(ceilingPct, Math.max(floorPct, asked)).toFixed(2));
  // Limited when code moved the model's answer outside rounding: below the floor or above the ceiling.
  return { pct, limited: typeof chosen === "number" && Number.isFinite(chosen) && (asked < floorPct || asked > ceilingPct) };
}

export interface AgentOfferDecision {
  action: "offer" | "skip";
  pct?: number;
  reasoning: string;
}

/** The written policy (AO3): offer every bill code allows, at the floor. */
export function referenceOfferDecision(input: { floorPct: number; daysEarly: number; annualPct: number }): AgentOfferDecision {
  return {
    action: "offer",
    pct: input.floorPct,
    reasoning: `Paying ${input.daysEarly} days early for ${input.floorPct.toFixed(2)}% is like earning ${input.annualPct}% a year, twice what the cash would earn in the reserve or more, and the operating wallet can pay it today.`,
  };
}

/** The cash code leaves for offers (AO2): the operating USDC after this cycle's payments, less what falls due soon and the offers already out. */
export function cashForOffers(input: { operating: number; dueSoon: number; openOffers: number }): number {
  return Number(Math.max(0, input.operating - input.dueSoon - input.openOffers).toFixed(6));
}
