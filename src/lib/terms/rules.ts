/**
 * What code allows the agent when it asks a supplier for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md
 * X2, X3): which held bills it may ask about, how many days, and the written policy's answer. Pure.
 */

/** The most days an owner or admin may let the agent ask for, and the fewest the agent asks (X1, X3). */
export const MIN_TERM_DAYS = 3;
export const MAX_TERM_DAYS = 30;
/** The most requests one cycle sends (X2). */
export const TERM_REQUESTS_PER_RUN = 3;
/** A bill falling due within this many days, or past due by no more than LATE_DAYS, may be asked about (X2). */
export const ASK_WITHIN_DAYS = 14;
export const LATE_DAYS = 7;
/** A supplier who declined is not asked again for this long (X2). */
export const TERM_DECLINE_COOL_DAYS = 30;
/** A bill the agent chose not to ask about is weighed again after this long (X3). */
export const TERM_SKIP_RETRY_DAYS = 7;
/** A request made and not emailed after this long is a stopped run's: withdrawn, and its bill weighed again (X6). */
export const TERM_UNSENT_LEASE_MS = 15 * 60_000;
/** How long a request stands, unless the new due date comes first (X4). */
export const TERM_REQUEST_TTL_MS = 5 * 24 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;

export type TermRefusal = "not_held_for_cash" | "not_due_soon" | "asked_before" | "reviewed" | "no_email" | "supplier_has_request" | "supplier_declined";

export interface TermFacts {
  /** The bill's latest decision held it for want of cash. */
  heldForCash: boolean;
  /** Days from today to the due date: negative when past due. */
  daysToDue: number;
  askedBefore: boolean;
  reviewed: boolean;
  noticeEmail: string | null;
  supplierHasOpenRequest: boolean;
  supplierDeclinedAt: string | null;
  now: number;
}

/** Whether code allows the agent to weigh a request on this bill now (X2), and if not, why. */
export function termRequestAllowed(facts: TermFacts): { allowed: true } | { allowed: false; because: TermRefusal } {
  if (!facts.heldForCash) return { allowed: false, because: "not_held_for_cash" };
  if (facts.daysToDue > ASK_WITHIN_DAYS || facts.daysToDue < -LATE_DAYS) return { allowed: false, because: "not_due_soon" };
  if (facts.askedBefore) return { allowed: false, because: "asked_before" };
  if (facts.reviewed) return { allowed: false, because: "reviewed" };
  if (!facts.noticeEmail) return { allowed: false, because: "no_email" };
  if (facts.supplierHasOpenRequest) return { allowed: false, because: "supplier_has_request" };
  if (facts.supplierDeclinedAt && facts.now - Date.parse(facts.supplierDeclinedAt) < TERM_DECLINE_COOL_DAYS * DAY_MS) return { allowed: false, because: "supplier_declined" };
  return { allowed: true };
}

/** The days the model chose, kept from MIN_TERM_DAYS to the workspace's most, whole days (X3). */
export function boundTermDays(chosen: number | undefined, maxDays: number, fallback: number): { days: number; limited: boolean } {
  const asked = typeof chosen === "number" && Number.isFinite(chosen) ? Math.round(chosen) : fallback;
  const days = Math.min(maxDays, Math.max(MIN_TERM_DAYS, asked));
  return { days, limited: typeof chosen === "number" && Number.isFinite(chosen) && (asked < MIN_TERM_DAYS || asked > maxDays) };
}

/**
 * The written policy's days (X3): until the money customers owe covers the bill, after what falls due before it, from 7
 * up to the most; the most when what is owed never covers it within the most.
 */
export function referenceTermDays(input: {
  amount: number;
  /** The operating USDC now, less what else falls due before the new day would be. */
  cashNow: number;
  /** What customers owe, by how many days from the bill's due date it is expected. */
  incoming: Array<{ daysAfterDue: number; amount: number }>;
  maxDays: number;
}): number {
  let cash = input.cashNow;
  for (const item of [...input.incoming].sort((a, b) => a.daysAfterDue - b.daysAfterDue)) {
    if (item.daysAfterDue > input.maxDays) break;
    cash += item.amount;
    if (cash >= input.amount) return Math.min(input.maxDays, Math.max(7, item.daysAfterDue + 1));
  }
  return input.maxDays;
}

export interface TermDecision {
  action: "ask" | "skip";
  days?: number;
  reasoning: string;
}
