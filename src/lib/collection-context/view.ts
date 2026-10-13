import { allowedTones, type ReminderTone } from "../collections";
import { utcDay } from "../copy";
import { addDays, dayOf, dayWords, money, type Coin } from "../customer-portal/model";
import { receivableReminderEmail } from "../email/receivable-reminder";
import type { Network } from "../network";
import {
  MAX_DAYS_BETWEEN,
  MAX_HOLD_DAYS,
  OUTCOME_LABELS,
  outcomeWords,
  policyWords,
  TASK_LABELS,
  taskOutcomes,
  type Approval,
  type CollectionPolicy,
  type CollectionTask,
  type NextAction,
  type Proposal,
  type TaskOutcome,
} from "./model";

/**
 * Collections as the Receivables tab shows them (docs/superpowers/specs/2026-10-13-collections-context-design.md C8),
 * pure: each receivable's proposal in words, the reminder it would send as the customer would read it (subject, body,
 * channel), its open task with the ways to resolve it, its customer's rules, and the Collections panel's figures. The page
 * and the pictures build them with these, from what they read.
 */

export const ACTION_LABELS: Record<NextAction, string> = {
  none: "Nothing to do",
  wait: "Wait",
  ask_owner: "Ask the account owner",
  remind: "Remind",
  escalate: "Escalate to finance",
};

export const ACTION_TONES: Record<NextAction, "neutral" | "agent" | "held" | "refused" | "proof"> = {
  none: "proof",
  wait: "neutral",
  ask_owner: "held",
  remind: "agent",
  escalate: "refused",
};

export const TONE_LABELS: Record<ReminderTone, string> = { friendly: "Friendly", firm: "Firm", final: "Final" };

export interface ReminderPreview {
  subject: string;
  text: string;
  /** The billing email it goes to, with most of its name hidden. */
  to: string;
  channel: "Email";
  tone: ReminderTone;
}

export interface TaskView {
  id: string;
  label: string;
  /** Who it asks, in words. */
  askedOf: string;
  opened: string;
  outcomes: Array<{ value: TaskOutcome; label: string }>;
  /** For an approval: the tones the drafted reminder offers, and the one it proposes. */
  tones: ReminderTone[];
  tone: ReminderTone | null;
  /** For a hold: the first and last day a person may choose. */
  holdFrom: string;
  holdTo: string;
}

export interface RulesView {
  counterpartyId: string;
  customerName: string;
  version: number;
  approval: Approval;
  maxTone: ReminderTone;
  minDaysBetween: number;
  maxDaysBetween: number;
  accountOwner: string | null;
  words: string;
  /** Who may be the account owner: the owners and admins. */
  owners: Array<{ id: string; email: string }>;
  savedOn: string | null;
}

export interface ProposalView {
  invoiceId: string;
  customerName: string;
  invoiceLabel: string;
  owed: string;
  due: string;
  /** The due day, YYYY-MM-DD, for the panel's order. */
  dueDate: string;
  action: NextAction;
  actionLabel: string;
  headline: string;
  reasons: string[];
  /** How a proposed reminder goes, in a sentence; null for any other action. */
  sends: string | null;
  preview: ReminderPreview | null;
  task: TaskView | null;
  /** The last task a person resolved for it, in a sentence. */
  resolved: string | null;
  rules: RulesView;
  /** The HubSpot deal it was sold through, when there is one. */
  crm: { name: string; url: string | null; hasOwner: boolean } | null;
  href: string;
}

/** An address with most of its name hidden: "bi***@acme.example". */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** The reminder the proposal would send, exactly as the template writes it (C8): the customer reads nothing else. */
export function reminderPreview(input: {
  orgName: string;
  customerName: string;
  billingEmail: string;
  currency: Coin;
  amount: number;
  memo: string | null;
  poReference: string | null;
  dueDate: string;
  reminder: NonNullable<Proposal["reminder"]>;
  payUrl: string | null;
  origin: string;
  network: Network;
}): ReminderPreview {
  const what = input.memo && input.poReference ? `${input.memo} (${input.poReference})` : (input.memo ?? (input.poReference ? `purchase order ${input.poReference}` : null));
  const email = receivableReminderEmail({
    orgName: input.orgName,
    clientName: input.customerName,
    amount: AMOUNT.format(input.reminder.owed),
    token: input.currency,
    what,
    dueOn: utcDay(`${dayOf(input.dueDate)}T12:00:00Z`),
    daysFromDue: input.reminder.daysFromDue,
    tone: input.reminder.tone,
    payUrl: input.payUrl ?? `${input.origin}/pay/…`,
    origin: input.origin,
    network: input.network,
    ...(input.reminder.received > 0 ? { partPaid: { invoiced: AMOUNT.format(input.amount), received: AMOUNT.format(input.reminder.received) } } : {}),
  });
  return { subject: email.subject, text: email.text, to: maskAddress(input.billingEmail), channel: "Email", tone: input.reminder.tone };
}

/** How a proposed reminder goes, in a sentence. */
export function sendsWords(proposal: Proposal): string | null {
  if (proposal.action !== "remind") return null;
  switch (proposal.sends) {
    case "agent":
      return "The agent decides at its next cycle whether to send it now or wait a day or two, within these bounds.";
    case "approved":
      return "A person approved it: the agent sends it at its next cycle, unless something changes first.";
    case "off":
      return "Nothing goes until reminders are on for this invoice, with a pay link.";
    default:
      return null;
  }
}

/** Who a task asks, in words. */
function askedOf(task: CollectionTask, members: ReadonlyMap<string, string>): string {
  if (task.assignee) return `Asks ${members.get(task.assignee) ?? "the account owner"}`;
  return "Asks the owners and admins";
}

export function taskView(task: CollectionTask, members: ReadonlyMap<string, string>, today: string): TaskView {
  const reminder = task.proposal.reminder;
  return {
    id: task.id,
    label: TASK_LABELS[task.reason],
    askedOf: askedOf(task, members),
    opened: `Opened ${dayWords(task.createdAt)}`,
    outcomes: taskOutcomes(task).map((value) => ({ value, label: OUTCOME_LABELS[value] })),
    tones: reminder?.tones ?? [],
    tone: reminder?.tone ?? null,
    holdFrom: addDays(today, 1),
    holdTo: addDays(today, MAX_HOLD_DAYS),
  };
}

export function rulesView(policy: CollectionPolicy, customerName: string, owners: ReadonlyArray<{ id: string; email: string }>): RulesView {
  return {
    counterpartyId: policy.counterpartyId,
    customerName,
    version: policy.version,
    approval: policy.approval,
    maxTone: policy.maxTone,
    minDaysBetween: policy.minDaysBetween,
    maxDaysBetween: MAX_DAYS_BETWEEN,
    accountOwner: policy.accountOwner,
    words: policyWords(policy, customerName),
    owners: [...owners],
    savedOn: policy.createdAt ? dayWords(policy.createdAt) : null,
  };
}

/** The tones a draft could offer at all, for the rules' cap: every tone code may allow some day. */
export const ALL_TONES: ReminderTone[] = allowedTones(30, 3);

/** A proposal in words, with its preview, task and rules (C8). */
export function proposalView(input: {
  proposal: Proposal;
  invoice: { id: string; memo: string | null; dueDate: string; amount: number; currency: Coin; owed: number };
  customerName: string;
  policy: CollectionPolicy;
  tasks: readonly CollectionTask[];
  members: ReadonlyMap<string, string>;
  owners: ReadonlyArray<{ id: string; email: string }>;
  preview: ReminderPreview | null;
  crm: { name: string; url: string | null; hasOwner: boolean } | null;
  today: string;
  href: string;
}): ProposalView {
  const { proposal, invoice } = input;
  const lastResolved = [...input.tasks].filter((task) => task.status === "done" && task.outcome !== "obsolete").sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))[0];
  return {
    invoiceId: invoice.id,
    customerName: input.customerName,
    invoiceLabel: invoice.memo?.trim() || `Invoice due ${dayWords(invoice.dueDate)}`,
    owed: proposal.action === "none" ? money(invoice.amount, invoice.currency) : `${money(invoice.owed, invoice.currency)} owed`,
    due: `Due ${dayWords(invoice.dueDate)}`,
    dueDate: dayOf(invoice.dueDate),
    action: proposal.action,
    actionLabel: proposal.action === "remind" && proposal.reminder ? `Remind · ${TONE_LABELS[proposal.reminder.tone].toLowerCase()}` : ACTION_LABELS[proposal.action],
    headline: proposal.headline,
    reasons: proposal.reasons.map((reason) => reason.text),
    sends: sendsWords(proposal),
    preview: input.preview,
    task: proposal.openTask ? taskView(proposal.openTask, input.members, input.today) : null,
    resolved: lastResolved ? `${TASK_LABELS[lastResolved.reason]}: ${outcomeWords(lastResolved)}${lastResolved.resolvedAt ? ` (${dayWords(lastResolved.resolvedAt)})` : ""}` : null,
    rules: rulesView(input.policy, input.customerName, input.owners),
    crm: input.crm,
    href: input.href,
  };
}

/** One promise, with how its invoice ended, for the panel's record. */
export interface PromiseOutcome {
  promisedOn: string;
  outcome: string | null;
  /** When its invoice was settled; null while it is open. */
  settledAt: string | null;
}

/**
 * Promises kept and broken (C8): of the promises whose day came in the last 90 days, those whose invoice was paid by
 * the day are kept, those still open after it, or paid later, broken. One replaced by a newer promise is not counted.
 */
export function promiseRecord(promises: readonly PromiseOutcome[], today: string): { kept: number; broken: number } {
  const from = addDays(today, -90);
  let kept = 0;
  let broken = 0;
  for (const promise of promises) {
    if (promise.outcome === "superseded" || promise.promisedOn < from) continue;
    const paidOn = promise.settledAt ? dayOf(promise.settledAt) : null;
    if (paidOn !== null && paidOn <= promise.promisedOn) kept += 1;
    else if (promise.promisedOn < today) broken += 1;
  }
  return { kept, broken };
}

export interface CollectionsPanelView {
  /** Receivables whose next step is a person's: ask the account owner, or escalate to finance. */
  waiting: number;
  sentThisWeek: number;
  promises: { kept: number; broken: number };
  /** The receivables to look at first: a person's step, then reminders, then waits. */
  items: ProposalView[];
  more: number;
}

const ORDER: Record<NextAction, number> = { escalate: 0, ask_owner: 1, remind: 2, wait: 3, none: 4 };
/** The panel lists at most this many. */
export const PANEL_ITEMS = 6;

export function collectionsPanel(input: { views: readonly ProposalView[]; sentThisWeek: number; promises: { kept: number; broken: number } }): CollectionsPanelView {
  const listed = input.views
    .filter((view) => view.action !== "none")
    .sort((a, b) => ORDER[a.action] - ORDER[b.action] || a.dueDate.localeCompare(b.dueDate) || a.invoiceId.localeCompare(b.invoiceId));
  return {
    waiting: input.views.filter((view) => view.action === "ask_owner" || view.action === "escalate").length,
    sentThisWeek: input.sentThisWeek,
    promises: input.promises,
    items: listed.slice(0, PANEL_ITEMS),
    more: Math.max(0, listed.length - PANEL_ITEMS),
  };
}
