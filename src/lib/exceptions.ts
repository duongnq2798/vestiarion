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
  /** Its due date, or its early-payment discount's deadline while that is still ahead and earlier. */
  reason: "due" | "discount";
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** E1: the due date, or the discount's deadline while it is still to come and before the due date. */
export function decideByOf(payable: { dueDate: string; discount?: { pct: number; deadline: string } | null }, today: string): DecideBy {
  const due = dayOf(payable.dueDate);
  const deadline = payable.discount ? dayOf(payable.discount.deadline) : null;
  if (deadline && deadline >= today && deadline < due) return { day: deadline, reason: "discount" };
  return { day: due, reason: "due" };
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
  payable: { dueDate: string; discount?: { pct: number; deadline: string } | null; createdBy: string | null; leftOut?: readonly string[] },
  members: readonly ActingMember[],
  today: string
): ExceptionFacts {
  const decideBy = decideByOf(payable, today);
  return { decideBy, priority: priorityOf(decideBy.day, today), owners: whoCanAct(members, payable.createdBy, payable.leftOut).map((member) => member.email) };
}

/** "Decide by Oct 20, 2026", with the discount named when it sets the day. */
export function decideByWords(decideBy: DecideBy): string {
  return `Decide by ${utcDay(`${decideBy.day}T00:00:00.000Z`)}${decideBy.reason === "discount" ? " to keep the early-payment discount" : ""}`;
}

/** Who can act, in a line: the first `max` by email (two by default), then how many more; the viewer as "you". */
export function ownersWords(owners: readonly string[], viewerEmail?: string | null, max = 2): string {
  if (owners.length === 0) return "Nobody in this workspace can approve it yet: an owner invites an approver from Members.";
  const named = owners.map((email) => (viewerEmail && email === viewerEmail ? "you" : email));
  const shown = named.slice(0, max);
  const more = named.length - shown.length;
  return `Who can act: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
