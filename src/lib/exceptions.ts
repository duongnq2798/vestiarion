import { lastDayWithoutFee, lateFeeRateWords, lateFeeStarted, type LateFee } from "./agent/late-fee";
import { utcDay } from "./copy";

/**
 * A held payable as an exception someone owns (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E1-E3,
 * E5): the day it must be decided by, its priority from that day, and who can act on it. Browser-safe and pure: the
 * Approvals card, the payable's row on Bills and the escalation email read the same answers.
 */

export type ExceptionPriority = "overdue" | "today" | "week" | "later";

export const PRIORITY_LABELS: Record<ExceptionPriority, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Due this week",
  later: "Later",
};

/** The roles that may decide a payable (`approval.decide`), in the order they are named. */
const DECIDING_ROLES = ["owner", "admin", "approver"] as const;

export interface DecideBy {
  /** `YYYY-MM-DD`. */
  day: string;
  /**
   * Its due date; its early-payment discount's deadline while that is still ahead and earlier; or, past its due date,
   * the last day before its late fee, when the fee leaves days after the due date (late fees LF5).
   */
  reason: "due" | "discount" | "late_fee";
  /**
   * With `late_fee`: the due date it is past, the fee's first day, its rate in words ("1.5% a month"), and whether the
   * fee has started.
   */
  lateFee?: { dueOn: string; startsOn: string; rate: string; started: boolean };
}

const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * E1: the due date, or the discount's deadline while it is still to come and before the due date. For a bill past its due
 * date whose late fee starts later than the day after it, the last day before the fee (late fees LF5): before the fee
 * starts and after, so the day, its escalation and the item that ages from it stay the same once the fee runs.
 */
export function decideByOf(
  payable: { dueDate: string; discount?: { pct: number; deadline: string } | null; lateFee?: LateFee | null; currency?: string | null },
  today: string
): DecideBy {
  const due = dayOf(payable.dueDate);
  const deadline = payable.discount ? dayOf(payable.discount.deadline) : null;
  if (deadline && deadline >= today && deadline < due) return { day: deadline, reason: "discount" };
  const fee = payable.lateFee;
  if (fee && due < today && due < lastDayWithoutFee(fee)) {
    return {
      day: lastDayWithoutFee(fee),
      reason: "late_fee",
      lateFee: { dueOn: due, startsOn: fee.startsOn, rate: lateFeeRateWords(fee, payable.currency ?? "USDC"), started: lateFeeStarted(fee, today) },
    };
  }
  return { day: due, reason: "due" };
}

/**
 * Whether a held payable is escalated today (E4): once its decide-by day has passed; or, for the last day before a late
 * fee, on that day itself, so the email comes while paying still avoids the fee (late fees LF5).
 */
export function decideByReached(decideBy: DecideBy, today: string): boolean {
  return decideBy.reason === "late_fee" ? decideBy.day <= today : decideBy.day < today;
}

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** E2: past the day, the day itself, within the next six days, or later. */
export function priorityOf(decideBy: string, today: string): ExceptionPriority {
  if (decideBy < today) return "overdue";
  if (decideBy === today) return "today";
  return decideBy <= addDays(today, 6) ? "week" : "later";
}

export interface ActingMember {
  userId: string;
  email: string;
  role: string;
}

/**
 * E3: the members whose role may decide it, owners first, less the person who entered it (who never approves their own
 * payable) and, for a first payment, the members its address leaves out (`membersLeftOut`, new payee check N4). The
 * workspace's only deciding member is named whatever they entered, gave or confirmed; with more, none may be left.
 */
export function whoCanAct<T extends ActingMember>(members: readonly T[], enteredBy: string | null, leftOut: readonly string[] = []): T[] {
  const deciding = members
    .filter((member) => (DECIDING_ROLES as readonly string[]).includes(member.role))
    .sort((a, b) => DECIDING_ROLES.indexOf(a.role as (typeof DECIDING_ROLES)[number]) - DECIDING_ROLES.indexOf(b.role as (typeof DECIDING_ROLES)[number]) || a.email.localeCompare(b.email));
  const others = deciding.filter((member) => member.userId !== enteredBy && !leftOut.includes(member.userId));
  return others.length > 0 || deciding.length !== 1 ? others : deciding;
}

export interface ExceptionFacts {
  decideBy: DecideBy;
  priority: ExceptionPriority;
  /** The emails of who can act, owners first. */
  owners: string[];
}

export function exceptionFacts(
  payable: {
    dueDate: string;
    discount?: { pct: number; deadline: string } | null;
    lateFee?: LateFee | null;
    currency?: string | null;
    createdBy: string | null;
    leftOut?: readonly string[];
  },
  members: readonly ActingMember[],
  today: string
): ExceptionFacts {
  const decideBy = decideByOf(payable, today);
  return { decideBy, priority: priorityOf(decideBy.day, today), owners: whoCanAct(members, payable.createdBy, payable.leftOut).map((member) => member.email) };
}

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/**
 * "Decide by Oct 20, 2026", with the discount named when it sets the day, or the late fee: "Decide by Oct 29, 2026:
 * overdue since Oct 20, 2026; a late fee of 1.5% a month starts Oct 30, 2026", or "applies since" once it has.
 */
export function decideByWords(decideBy: DecideBy): string {
  if (decideBy.reason === "late_fee" && decideBy.lateFee) {
    const { dueOn, startsOn, rate, started } = decideBy.lateFee;
    return `Decide by ${dayWords(decideBy.day)}: overdue since ${dayWords(dueOn)}; a late fee of ${rate} ${started ? "applies since" : "starts"} ${dayWords(startsOn)}`;
  }
  return `Decide by ${dayWords(decideBy.day)}${decideBy.reason === "discount" ? " to keep the early-payment discount" : ""}`;
}

/** Who can act, in a line: the first `max` by email (two by default), then how many more; the viewer as "you". */
export function ownersWords(owners: readonly string[], viewerEmail?: string | null, max = 2): string {
  if (owners.length === 0) return "Nobody in this workspace can approve it yet: an owner invites an approver from Members.";
  const named = owners.map((email) => (viewerEmail && email === viewerEmail ? "you" : email));
  const shown = named.slice(0, max);
  const more = named.length - shown.length;
  return `Who can act: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
