import {
  allowedTones,
  daysFromDue,
  EARLIEST_DAYS_BEFORE_DUE,
  LATEST_DAYS_AFTER_DUE,
  MAX_REMINDERS,
  MIN_DAYS_BETWEEN,
  REMINDER_TONES,
  referenceReminder,
  reminderAllowed,
  whenInWords,
  type ReminderTone,
  type SentReminder,
} from "../collections";
import { addDays, dayOf, dayWords, money, todayOf, type RequestKind, type RequestOutcome } from "../customer-portal/model";

/**
 * Collections that follow the customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md), pure:
 * from what is known about one receivable (what is still owed, its reminders, what the customer said on its statement,
 * its customer's rules, its HubSpot deal and the tasks a person resolved), the next action and the facts it rests on.
 *
 * The next action is one of: nothing (it is paid), wait, ask the account owner, remind the customer (with a tone), or
 * escalate to finance. A dispute, a payment the customer says it made, a promise not yet due and a hold a person chose
 * hold every reminder (C2); a promise whose day passed goes to finance, never to an automatic reminder (C3). Nothing here
 * sends: the collections stage acts on a proposal only through its own checks, and the receivable's card shows it.
 */

export type Approval = "auto" | "ask_first";
export const APPROVALS: readonly Approval[] = ["auto", "ask_first"];
export type Channel = "email";

/** A customer's reminders may be spaced this many days apart at most (and never closer than code's 3). */
export const MAX_DAYS_BETWEEN = 30;
/** A hold a person chooses lasts at most this many days. */
export const MAX_HOLD_DAYS = 60;

/** A customer's collection rules, one version (C4). Version 0 is the default every customer has before any is saved. */
export interface CollectionPolicy {
  id: string | null;
  counterpartyId: string;
  version: number;
  approval: Approval;
  maxTone: ReminderTone;
  minDaysBetween: number;
  channel: Channel;
  /** The member asked before a reminder when the rules say so; null for the owners and admins. */
  accountOwner: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export function defaultPolicy(counterpartyId: string): CollectionPolicy {
  return { id: null, counterpartyId, version: 0, approval: "auto", maxTone: "final", minDaysBetween: MIN_DAYS_BETWEEN, channel: "email", accountOwner: null, createdBy: null, createdAt: null };
}

export type TaskKind = "ask_owner" | "finance_review";
export type TaskReason = "policy_ask_first" | "hubspot_owner" | "no_contact" | "promise_passed" | "reminders_done";
export type TaskOutcome = "approved" | "held" | "no_reminder" | "resumed" | "done" | "obsolete";

/** What a task was opened for, kept with it so its card reads the same later. */
export interface TaskProposal {
  headline: string;
  reasons: Reason[];
  reminder: DraftReminder | null;
}

export interface CollectionTask {
  id: string;
  invoiceId: string;
  counterpartyId: string;
  kind: TaskKind;
  reason: TaskReason;
  subjectKey: string;
  assignee: string | null;
  policyVersion: number;
  proposal: TaskProposal;
  status: "open" | "done";
  outcome: TaskOutcome | null;
  holdUntil: string | null;
  approvedNumber: number | null;
  approvedTone: ReminderTone | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  notifiedAt: string | null;
  createdAt: string;
}

/** What the customer said on its statement (customer portal), as the proposal weighs it. */
export interface CustomerSaid {
  id: string;
  kind: RequestKind;
  status: "open" | "closed";
  outcome: RequestOutcome | null;
  promisedOn: string | null;
  paidOn: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** The HubSpot deal a receivable's deal was planned from, when it was. */
export interface CrmContext {
  provider: "hubspot";
  dealExternalId: string;
  dealName: string;
  /** HubSpot's owner id for the deal; null when it has none (or before it was read). */
  ownerId: string | null;
  /** The deal in HubSpot, when its account is known. */
  url: string | null;
}

export interface ReceivableFacts {
  invoiceId: string;
  customerId: string;
  customerName: string;
  /** Whether the customer has a billing email reminders can go to. */
  billingEmail: boolean;
  amount: number;
  currency: "USDC" | "EURC";
  dueDate: string;
  status: string;
  /** What is still owed, and what arrived, from the payments applied. */
  owed: number;
  received: number;
  remindersOn: boolean;
  /** Whether a pay link the email can carry is kept. */
  payLink: boolean;
  deferredUntil: string | null;
  sent: readonly SentReminder[];
  said: readonly CustomerSaid[];
  policy: CollectionPolicy;
  crm: CrmContext | null;
  tasks: readonly CollectionTask[];
}

export type NextAction = "none" | "wait" | "ask_owner" | "remind" | "escalate";

export type ReasonCode =
  | "paid"
  | "nothing_owed"
  | "closed"
  | "overdue"
  | "due_today"
  | "due_soon"
  | "part_paid"
  | "sent"
  | "dispute"
  | "dispute_resolved"
  | "paid_claim"
  | "claim_not_received"
  | "promise"
  | "promise_passed"
  | "hold"
  | "not_due"
  | "reminders_done"
  | "reviewed"
  | "no_contact"
  | "cadence"
  | "schedule"
  | "policy"
  | "hubspot_owner"
  | "approved"
  | "reminders_off"
  | "no_pay_link";

/** One fact the proposal rests on, in a sentence. */
export interface Reason {
  code: ReasonCode;
  text: string;
}

/** The reminder the proposal would send. */
export interface DraftReminder {
  number: number;
  tone: ReminderTone;
  /** The tones code and the customer's rules allow now. */
  tones: ReminderTone[];
  channel: Channel;
  daysFromDue: number;
  owed: number;
  received: number;
}

export interface TaskNeed {
  kind: TaskKind;
  reason: TaskReason;
  /** One task per receivable and subject: the same need never opens a second one. */
  subjectKey: string;
  assignee: string | null;
}

export type HeldBy = "dispute" | "paid_claim" | "promise" | "promise_passed" | "hold";

export interface Proposal {
  action: NextAction;
  headline: string;
  reasons: Reason[];
  /** What holds the reminders now; null when nothing does. */
  heldBy: HeldBy | null;
  /** The day the wait ends, when it ends on a day. */
  waitUntil: string | null;
  reminder: DraftReminder | null;
  /**
   * How a proposed reminder goes: by the agent on its own; as a person approved it; or not until a person turns
   * reminders on (or makes a pay link). Null for any other action.
   */
  sends: "agent" | "approved" | "off" | null;
  /** The task this proposal needs a person for; the stage opens it once. */
  need: TaskNeed | null;
  /** The task already open for it. */
  openTask: CollectionTask | null;
  /** The task whose approval this reminder goes under. */
  approvedTask: CollectionTask | null;
}

const OPEN = new Set(["pending", "matched"]);
const PAID = new Set(["received", "paid"]);
const DAY_MS = 86_400_000;

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const toneWords = (tone: ReminderTone) => (tone === "final" ? "as the final reminder" : `in a ${tone} tone`);
const toneRank = (tone: ReminderTone) => REMINDER_TONES.indexOf(tone);

/** The strongest of `tones`; friendly when there is none. */
const strongest = (tones: readonly ReminderTone[]): ReminderTone => [...tones].sort((a, b) => toneRank(b) - toneRank(a))[0] ?? "friendly";

/** Whether a reminder went out after the due date, so a first overdue reminder is behind us. */
function sentAfterDue(sent: readonly SentReminder[], dueDate: string): boolean {
  const due = dayOf(dueDate);
  return sent.some((reminder) => dayOf(reminder.sentAt) > due);
}

/** "Rules for Acme, version 3: ask first; at most firm; at least 7 days apart". */
export function policyWords(policy: CollectionPolicy, customerName: string): string {
  if (policy.version === 0) return `${customerName} has no rules of its own: reminders follow the workspace's schedule.`;
  const parts = [
    policy.approval === "ask_first" ? "ask first before any reminder" : "reminders go on their own",
    policy.maxTone === "final" ? "any tone" : policy.maxTone === "firm" ? "at most firm" : "friendly only",
    `at least ${days(policy.minDaysBetween)} apart`,
    "by email",
  ];
  return `Rules for ${customerName}, version ${policy.version}: ${parts.join("; ")}.`;
}

function latestOf<T extends { createdAt: string }>(items: readonly T[]): T | undefined {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * The next action for one receivable, and why (C1–C6). `now` is the instant it is decided at; days are UTC days.
 */
export function proposeNextAction(facts: ReceivableFacts, now: number): Proposal {
  const today = todayOf(now);
  const due = dayOf(facts.dueDate);
  const fromDue = daysFromDue(due, now);
  const policy = facts.policy;
  const reasons: Reason[] = [];
  const result = (action: NextAction, headline: string, more: Partial<Proposal> = {}): Proposal => ({
    action,
    headline,
    reasons,
    heldBy: null,
    waitUntil: null,
    reminder: null,
    sends: null,
    need: null,
    openTask: null,
    approvedTask: null,
    ...more,
  });
  const taskFor = (subjectKey: string) => facts.tasks.find((task) => task.subjectKey === subjectKey);
  /** A need, with its open task, or none when a person already resolved one for the same subject. */
  const needing = (need: TaskNeed): Pick<Proposal, "need" | "openTask"> => {
    const task = taskFor(need.subjectKey);
    if (!task) return { need, openTask: null };
    return task.status === "open" ? { need, openTask: task } : { need: null, openTask: null };
  };

  // Paid, rejected, or nothing left to collect: no action (C1).
  if (!OPEN.has(facts.status)) {
    reasons.push(
      PAID.has(facts.status) ? { code: "paid", text: "Paid in full." } : { code: "closed", text: "This invoice is no longer open." }
    );
    return result("none", PAID.has(facts.status) ? "Paid: nothing to collect" : "Not open: nothing to collect");
  }
  if (facts.owed <= 0) {
    reasons.push({ code: "nothing_owed", text: "The payments applied cover it: nothing is owed." });
    return result("none", "Nothing owed");
  }

  // Where it stands.
  reasons.push(
    fromDue > 0
      ? { code: "overdue", text: `${days(fromDue)} overdue: due ${dayWords(due)}, ${money(facts.owed, facts.currency)} still owed.` }
      : fromDue === 0
        ? { code: "due_today", text: `Due today, ${dayWords(due)}: ${money(facts.owed, facts.currency)} owed.` }
        : { code: "due_soon", text: `Due in ${days(-fromDue)}, on ${dayWords(due)}: ${money(facts.owed, facts.currency)} owed.` }
  );
  if (facts.received > 0) {
    reasons.push({ code: "part_paid", text: `Part paid: ${money(facts.received, facts.currency)} of ${money(facts.amount, facts.currency)} arrived.` });
  }
  if (facts.sent.length > 0) {
    const last = [...facts.sent].sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    reasons.push({
      code: "sent",
      text: `${facts.sent.length} ${facts.sent.length === 1 ? "reminder" : "reminders"} sent, the last on ${dayWords(last.sentAt)} (${last.tone}).`,
    });
  }

  // What the customer said: a dispute or a payment it says it made holds every reminder (C2).
  const open = facts.said.filter((said) => said.status === "open");
  const dispute = latestOf(open.filter((said) => said.kind === "dispute"));
  if (dispute) {
    reasons.push({ code: "dispute", text: `The customer disputed it on ${dayWords(dispute.createdAt)}. Reminders wait until you resolve it under From customers.` });
    return result("wait", "Wait: the customer disputes it", { heldBy: "dispute" });
  }
  const resolved = latestOf(facts.said.filter((said) => said.kind === "dispute" && said.status === "closed" && said.outcome === "resolved").map((said) => ({ ...said, createdAt: said.closedAt ?? said.createdAt })));
  if (resolved) reasons.push({ code: "dispute_resolved", text: `The customer's dispute was resolved on ${dayWords(resolved.createdAt)}.` });
  const claim = latestOf(open.filter((said) => said.kind === "paid"));
  if (claim) {
    reasons.push({
      code: "paid_claim",
      text: `The customer says it paid on ${dayWords(claim.paidOn ?? claim.createdAt)}. Reminders wait until you find the payment or mark it not received.`,
    });
    return result("wait", "Wait: a payment to verify", { heldBy: "paid_claim" });
  }
  const notReceived = latestOf(facts.said.filter((said) => said.kind === "paid" && said.outcome === "not_received"));
  if (notReceived) reasons.push({ code: "claim_not_received", text: `A payment the customer said it made was marked not received on ${dayWords(notReceived.closedAt ?? notReceived.createdAt)}.` });

  // A promise: wait through its day; once it passed, finance reviews it before any reminder (C3).
  const promise = latestOf(open.filter((said) => said.kind === "promise" && said.promisedOn !== null));
  if (promise && (promise.promisedOn as string) >= today) {
    reasons.push({ code: "promise", text: `The customer promised to pay by ${dayWords(promise.promisedOn as string)}. Reminders wait through that day.` });
    return result("wait", `Wait: promised by ${dayWords(promise.promisedOn as string)}`, { heldBy: "promise", waitUntil: promise.promisedOn });
  }
  if (promise) {
    reasons.push({
      code: "promise_passed",
      text: `The customer promised to pay by ${dayWords(promise.promisedOn as string)}, and that day passed with ${money(facts.owed, facts.currency)} still owed. Finance reviews it before any reminder.`,
    });
    return result("escalate", "Escalate to finance: a promise was broken", {
      heldBy: "promise_passed",
      ...needing({ kind: "finance_review", reason: "promise_passed", subjectKey: `promise:${promise.id}`, assignee: null }),
    });
  }

  // A hold a person chose, for example because sales gave the customer more time.
  const hold = facts.tasks
    .filter((task) => task.status === "done" && task.outcome === "held" && task.holdUntil !== null && (task.holdUntil as string) >= today)
    .sort((a, b) => (b.holdUntil as string).localeCompare(a.holdUntil as string))[0];
  if (hold) {
    reasons.push({ code: "hold", text: `A person held reminders until ${dayWords(hold.holdUntil as string)}${hold.resolvedAt ? ` on ${dayWords(hold.resolvedAt)}` : ""}.` });
    return result("wait", `Wait: held until ${dayWords(hold.holdUntil as string)}`, { heldBy: "hold", waitUntil: hold.holdUntil });
  }

  // Too early for any reminder.
  if (fromDue < -EARLIEST_DAYS_BEFORE_DUE) {
    const from = addDays(due, -EARLIEST_DAYS_BEFORE_DUE);
    reasons.push({ code: "not_due", text: `The first reminder can go ${days(EARLIEST_DAYS_BEFORE_DUE)} before the due date, on ${dayWords(from)}.` });
    return result("wait", "Wait: not due yet", { waitUntil: from });
  }

  // The agent's reminders are done: finance follows up.
  const finalSent = facts.sent.find((reminder) => reminder.tone === "final");
  if (finalSent || facts.sent.length >= MAX_REMINDERS || fromDue > LATEST_DAYS_AFTER_DUE) {
    reasons.push({
      code: "reminders_done",
      text: finalSent
        ? `The agent sent its final reminder on ${dayWords(finalSent.sentAt)}.`
        : facts.sent.length >= MAX_REMINDERS
          ? `The agent sent all ${MAX_REMINDERS} reminders.`
          : `More than ${LATEST_DAYS_AFTER_DUE} days past the due date: the agent sends no more reminders.`,
    });
    const reviewed = taskFor("reminders_done");
    if (reviewed?.status === "done") {
      reasons.push({ code: "reviewed", text: `Finance reviewed it on ${dayWords(reviewed.resolvedAt ?? reviewed.createdAt)}: follow up with the customer yourself.` });
      return result("wait", "Follow up with the customer yourself");
    }
    // Only where the agent reminded the customer: an old receivable never reminded is the person's own to follow up.
    const need = facts.sent.length > 0 ? needing({ kind: "finance_review", reason: "reminders_done", subjectKey: "reminders_done", assignee: null }) : { need: null, openTask: null };
    return result("escalate", "Escalate to finance: reminders are done", need);
  }

  // No billing email: no reminder can go. The account owner may know who to write to; finance otherwise.
  if (!facts.billingEmail) {
    reasons.push({ code: "no_contact", text: `${facts.customerName} has no billing email, so no reminder can go.` });
    const owner = policy.accountOwner;
    const need: TaskNeed = owner
      ? { kind: "ask_owner", reason: "no_contact", subjectKey: "no_contact", assignee: owner }
      : { kind: "finance_review", reason: "no_contact", subjectKey: "no_contact", assignee: null };
    return result(owner ? "ask_owner" : "escalate", owner ? "Ask the account owner for a billing contact" : "Escalate to finance: add a billing email", fromDue >= 0 && facts.remindersOn ? needing(need) : {});
  }

  // Cadence: code's bounds, spaced by the customer's rules.
  const sentRead = { now, dueDate: due, sent: facts.sent, deferredUntil: facts.deferredUntil };
  const allowance = reminderAllowed(sentRead, policy.minDaysBetween);
  if (!allowance.allowed) {
    const last = [...facts.sent].sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    const spacing = Math.max(MIN_DAYS_BETWEEN, policy.minDaysBetween);
    const next =
      facts.deferredUntil && Date.parse(facts.deferredUntil) > now
        ? dayOf(facts.deferredUntil)
        : last
          ? dayOf(new Date(Date.parse(last.sentAt) + spacing * DAY_MS).toISOString())
          : null;
    reasons.push({ code: "cadence", text: `No reminder yet: ${allowance.reason}${next ? `. The next can go on ${dayWords(next)}` : ""}.` });
    return result("wait", next ? `Wait until ${dayWords(next)}` : "Wait", { waitUntil: next });
  }
  const reference = referenceReminder(sentRead, allowance);
  const tones = allowedTones(allowance.daysFromDue, facts.sent.length, policy.maxTone);
  // The schedule's tone, or the strongest the customer's rules allow when it is stronger (C4).
  const tone = tones.includes(reference.tone) ? reference.tone : strongest(tones);
  const reminder: DraftReminder = { number: allowance.number, tone, tones, channel: "email", daysFromDue: allowance.daysFromDue, owed: facts.owed, received: facts.received };
  if (reference.action === "wait") {
    const until = addDays(today, reference.waitDays ?? 1);
    reasons.push({ code: "schedule", text: `The workspace's schedule sends reminder ${allowance.number} later: the agent decides again on ${dayWords(until)}.` });
    return result("wait", `Wait until ${dayWords(until)}`, { waitUntil: until, reminder });
  }
  reasons.push({ code: "schedule", text: `The workspace's schedule sends reminder ${allowance.number} now, ${whenInWords(allowance.daysFromDue)}, ${toneWords(tone)}.` });
  if (policy.version > 0) reasons.push({ code: "policy", text: policyWords(policy, facts.customerName) });

  // Reminders off, or no link to carry: a person turns them on first; nobody is asked anything else.
  if (!facts.remindersOn) {
    reasons.push({ code: "reminders_off", text: "Reminders are off for this invoice: turn them on to let the agent send it." });
    return result("remind", `Remind ${facts.customerName} (${tone})`, { reminder, sends: "off" });
  }
  if (!facts.payLink) {
    reasons.push({ code: "no_pay_link", text: "There is no pay link the email can carry: make a new link." });
    return result("remind", `Remind ${facts.customerName} (${tone})`, { reminder, sends: "off" });
  }

  // A person approved this very reminder, under these rules.
  const approved = facts.tasks.find(
    (task) => task.status === "done" && task.outcome === "approved" && task.approvedNumber === allowance.number && task.policyVersion === policy.version && task.approvedTone !== null
  );
  if (approved) {
    const approvedTone = tones.includes(approved.approvedTone as ReminderTone) ? (approved.approvedTone as ReminderTone) : strongest(tones);
    reasons.push({ code: "approved", text: `A person approved reminder ${allowance.number}${approved.resolvedAt ? ` on ${dayWords(approved.resolvedAt)}` : ""}, ${toneWords(approvedTone)}.` });
    return result("remind", `Remind ${facts.customerName} (${approvedTone})`, { reminder: { ...reminder, tone: approvedTone }, sends: "approved", approvedTask: approved });
  }

  // The customer's rules say ask first (C4).
  if (policy.approval === "ask_first") {
    return result("ask_owner", "Ask the account owner before reminding", {
      reminder,
      ...needing({ kind: "ask_owner", reason: "policy_ask_first", subjectKey: `policy:${policy.version}:reminder:${allowance.number}`, assignee: policy.accountOwner }),
    });
  }

  // Sold through HubSpot, with an owner: ask before the first overdue reminder whether sales gave more time (C5).
  if (facts.crm?.ownerId && allowance.daysFromDue > 0 && !sentAfterDue(facts.sent, due)) {
    const subjectKey = `hubspot:${facts.crm.dealExternalId}`;
    const asked = taskFor(subjectKey);
    if (!asked || asked.status === "open") {
      reasons.push({
        code: "hubspot_owner",
        text: `From the HubSpot deal ${facts.crm.dealName}, which has an owner: ask whether sales gave ${facts.customerName} more time before the first overdue reminder.`,
      });
      return result("ask_owner", "Ask the deal's owner before reminding", {
        reminder,
        ...needing({ kind: "ask_owner", reason: "hubspot_owner", subjectKey, assignee: policy.accountOwner }),
      });
    }
  }

  return result("remind", `Remind ${facts.customerName} (${tone})`, { reminder, sends: "agent" });
}

/** The ways a person may resolve an open task (C6). */
export function taskOutcomes(task: Pick<CollectionTask, "kind" | "reason">): TaskOutcome[] {
  switch (task.reason) {
    case "policy_ask_first":
    case "hubspot_owner":
      return ["approved", "held", "no_reminder"];
    case "promise_passed":
      return ["resumed", "held"];
    case "no_contact":
    case "reminders_done":
      return ["done"];
  }
}

export const TASK_LABELS: Record<TaskReason, string> = {
  policy_ask_first: "Approve a reminder",
  hubspot_owner: "Ask the deal's owner",
  no_contact: "Find a billing contact",
  promise_passed: "Review a broken promise",
  reminders_done: "Follow up: reminders are done",
};

export const OUTCOME_LABELS: Record<TaskOutcome, string> = {
  approved: "Send this reminder",
  held: "Hold reminders",
  no_reminder: "No reminders for this invoice",
  resumed: "Let reminders go again",
  done: "Done",
  obsolete: "No longer needed",
};

/** What a resolved task did, in a sentence. */
export function outcomeWords(task: Pick<CollectionTask, "outcome" | "holdUntil" | "approvedNumber" | "approvedTone">): string {
  switch (task.outcome) {
    case "approved":
      return `Approved reminder ${task.approvedNumber ?? ""}${task.approvedTone ? `, ${task.approvedTone}` : ""}.`.replace(" ,", ",");
    case "held":
      return task.holdUntil ? `Reminders held until ${dayWords(task.holdUntil)}.` : "Reminders held.";
    case "no_reminder":
      return "Reminders turned off for this invoice.";
    case "resumed":
      return "The promise was closed and reminders go again.";
    case "done":
      return "Done.";
    case "obsolete":
      return "No longer needed: the invoice changed.";
    default:
      return "Open.";
  }
}

/** Whether a hold day is one a person may choose today: tomorrow up to 60 days ahead. */
export function holdDayAllowed(day: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return false;
  return day > today && day <= addDays(today, MAX_HOLD_DAYS);
}

/** The proposal kept with a task: what it was opened for, small enough for its column. */
export function taskProposalOf(proposal: Proposal): TaskProposal {
  return { headline: proposal.headline, reasons: proposal.reasons.slice(0, 8).map((reason) => ({ code: reason.code, text: reason.text.slice(0, 300) })), reminder: proposal.reminder };
}
