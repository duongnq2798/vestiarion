import { can } from "../auth/roles";
import { MIN_DAYS_BETWEEN, REMINDER_TONES, type ReminderTone } from "../collections";
import { currentOrgId } from "../context";
import { CustomerRequestError, closeCustomerRequest } from "../customer-portal/requests";
import { todayOf } from "../customer-portal/model";
import { db } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { setReminders } from "../platform/pay-links";
import { listMembers } from "../platform/members";
import { APPROVALS, holdDayAllowed, MAX_DAYS_BETWEEN, taskOutcomes, type Approval, type CollectionPolicy, type TaskOutcome, type TaskReason } from "./model";
import { notThereYet, readPolicies, TASK_COLUMNS, toTask, type TaskRow } from "./read";
import { COLLECTION_TASK_ACTIONS } from "./tasks";

/**
 * What a person changes about collections, in the workspace in scope
 * (docs/superpowers/specs/2026-10-13-collections-context-design.md C4, C6): a customer's rules, saved as a new version
 * over the one they saw, and a collection task resolved once. Both are `records.write` (owners and admins), from the
 * console only, through the commands. Each is signed: `collection_policy_set`, `collection_task_resolved`.
 */

export const COLLECTION_POLICY_ACTION = "collection_policy_set";

export type CollectionErrorCode = "not_ready" | "not_found" | "not_client" | "changed" | "rules" | "owner" | "outcome" | "tone" | "hold";

export const COLLECTION_MESSAGES: Record<CollectionErrorCode, string> = {
  not_ready: "Collection rules are not set up on this deployment yet.",
  not_found: "That is not one of this workspace's.",
  not_client: "Collection rules are for a customer.",
  changed: "Someone changed this a moment ago. Reload the page to see it as it is now.",
  rules: "Choose how reminders go, the strongest tone, and 3 to 30 days between reminders.",
  owner: "The account owner must be an owner or admin of this workspace.",
  outcome: "Choose what to do.",
  tone: "Choose one of the tones offered.",
  hold: "Choose a day from tomorrow up to 60 days ahead.",
};

export class CollectionError extends Error {
  constructor(readonly code: CollectionErrorCode) {
    super(COLLECTION_MESSAGES[code]);
    this.name = "CollectionError";
  }
}

export interface PolicyInput {
  counterpartyId: string;
  approval: string;
  maxTone: string;
  minDaysBetween: number;
  accountOwner: string | null;
  /** The version the person saw: a newer one saved since is not written over. */
  expectedVersion: number;
}

/** Checks a person's rules, as typed: what each may be. */
export function readPolicyInput(input: PolicyInput): { approval: Approval; maxTone: ReminderTone; minDaysBetween: number } {
  const approval = input.approval as Approval;
  const maxTone = input.maxTone as ReminderTone;
  const days = Number(input.minDaysBetween);
  if (!APPROVALS.includes(approval) || !REMINDER_TONES.includes(maxTone) || !Number.isInteger(days) || days < MIN_DAYS_BETWEEN || days > MAX_DAYS_BETWEEN) {
    throw new CollectionError("rules");
  }
  return { approval, maxTone, minDaysBetween: days };
}

/** Saves a customer's rules as the next version, over the version the person saw. */
export async function saveCollectionPolicy(input: PolicyInput & { actorId: string }): Promise<{ customerName: string; policy: CollectionPolicy }> {
  const rules = readPolicyInput(input);
  const found = await db().from("counterparties").select("id, name, role").eq("id", input.counterpartyId).limit(1);
  if (found.error) {
    if (found.error.code === "22P02") throw new CollectionError("not_found");
    throw new Error(found.error.message);
  }
  const customer = ((found.data ?? []) as Array<{ id: string; name: string; role: string }>)[0];
  if (!customer) throw new CollectionError("not_found");
  if (customer.role !== "client") throw new CollectionError("not_client");
  if (input.accountOwner) {
    const member = (await listMembers(currentOrgId())).find((candidate) => candidate.userId === input.accountOwner);
    if (!member || !can(member.role, "records.write")) throw new CollectionError("owner");
  }
  const read = await readPolicies(db(), [customer.id]);
  if (!read.available) throw new CollectionError("not_ready");
  const latest = read.latest.get(customer.id)?.version ?? 0;
  if (latest !== input.expectedVersion) throw new CollectionError("changed");
  const inserted = await db()
    .from("collection_policies")
    .insert({
      counterparty_id: customer.id,
      version: latest + 1,
      approval: rules.approval,
      max_tone: rules.maxTone,
      min_days_between: rules.minDaysBetween,
      channel: "email",
      account_owner: input.accountOwner,
      created_by: input.actorId,
    })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (inserted.error) {
    if (inserted.error.code === "23505" || /collection_policy_version/.test(inserted.error.message ?? "")) throw new CollectionError("changed");
    if (notThereYet(inserted.error)) throw new CollectionError("not_ready");
    throw new Error(inserted.error.message);
  }
  const policy: CollectionPolicy = {
    id: inserted.data.id,
    counterpartyId: customer.id,
    version: latest + 1,
    approval: rules.approval,
    maxTone: rules.maxTone,
    minDaysBetween: rules.minDaysBetween,
    channel: "email",
    accountOwner: input.accountOwner,
    createdBy: input.actorId,
    createdAt: inserted.data.created_at,
  };
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: COLLECTION_POLICY_ACTION,
    summary: `Set ${customer.name}'s collection rules, version ${policy.version}`,
    detail: {
      by: input.actorId,
      counterpartyId: customer.id,
      version: policy.version,
      approval: policy.approval,
      maxTone: policy.maxTone,
      minDaysBetween: policy.minDaysBetween,
      channel: policy.channel,
      accountOwner: policy.accountOwner,
    },
  });
  return { customerName: customer.name, policy };
}

export interface ResolveInput {
  actorId: string;
  taskId: string;
  outcome: string;
  /** For a hold: the last day reminders wait (YYYY-MM-DD). */
  holdUntil?: string | null;
  /** For an approval: the tone, one the drafted reminder offered. */
  tone?: string | null;
  now?: number;
}

/**
 * Resolves an open task, once (C6). An approval names the drafted reminder and a tone it offered; the agent sends it at
 * its next cycle, through every check. A hold names its last day. "No reminders" turns the invoice's reminders off. For
 * a broken promise, the promise is closed first, so reminders may go again (or after the hold); for a claim of payment
 * nobody found within a week, the claim is closed as not received first, the same way.
 */
export interface Resolved {
  customerName: string;
  invoiceId: string;
  reason: TaskReason;
  outcome: TaskOutcome;
  holdUntil: string | null;
  approvedNumber: number | null;
  approvedTone: ReminderTone | null;
  /** An approval or reminders let go again: the agent's next cycle may send now. */
  startsCycle: boolean;
}

export async function resolveCollectionTask(input: ResolveInput): Promise<Resolved> {
  const found = await db().from("collection_tasks").select(TASK_COLUMNS).eq("id", input.taskId).limit(1);
  if (found.error) {
    if (notThereYet(found.error)) throw new CollectionError("not_ready");
    if (found.error.code === "22P02") throw new CollectionError("not_found");
    throw new Error(found.error.message);
  }
  const row = ((found.data ?? []) as TaskRow[])[0];
  if (!row) throw new CollectionError("not_found");
  const task = toTask(row);
  if (task.status !== "open") throw new CollectionError("changed");
  const outcome = input.outcome as TaskOutcome;
  if (!taskOutcomes(task).includes(outcome)) throw new CollectionError("outcome");
  const today = todayOf(input.now ?? Date.now());

  let approvedNumber: number | null = null;
  let approvedTone: ReminderTone | null = null;
  let holdUntil: string | null = null;
  if (outcome === "approved") {
    const reminder = task.proposal.reminder;
    if (!reminder) throw new CollectionError("outcome");
    const tone = (input.tone ?? reminder.tone) as ReminderTone;
    if (!reminder.tones.includes(tone)) throw new CollectionError("tone");
    approvedNumber = reminder.number;
    approvedTone = tone;
  }
  if (outcome === "held") {
    if (!input.holdUntil || !holdDayAllowed(input.holdUntil, today)) throw new CollectionError("hold");
    holdUntil = input.holdUntil;
  }

  const customer = await db().from("counterparties").select("name").eq("id", task.counterpartyId).limit(1);
  const customerName = ((customer.data ?? []) as Array<{ name: string }>)[0]?.name ?? "the customer";

  // What the outcome does beyond the task, first: a task marked done whose effect failed would hold nothing.
  if (outcome === "no_reminder") await setReminders({ actorId: input.actorId, invoiceId: task.invoiceId, on: false });
  // The customer's request the task is about is closed first: a promise as reviewed, a claim nobody found as not received.
  const request =
    task.reason === "promise_passed" && task.subjectKey.startsWith("promise:")
      ? { requestId: task.subjectKey.slice("promise:".length), outcome: "resolved" as const }
      : task.reason === "claim_unverified" && task.subjectKey.startsWith("claim:")
        ? { requestId: task.subjectKey.slice("claim:".length), outcome: "not_received" as const }
        : null;
  if (request) {
    try {
      await closeCustomerRequest({ actorId: input.actorId, ...request });
    } catch (error) {
      // Closed already (by a person, or replaced by the customer): what the task needed is done.
      if (!(error instanceof CustomerRequestError && (error.code === "closed" || error.code === "not_found"))) throw error;
    }
  }

  const resolvedAt = new Date(input.now ?? Date.now()).toISOString();
  const updated = await db()
    .from("collection_tasks")
    .update({ status: "done", outcome, hold_until: holdUntil, approved_number: approvedNumber, approved_tone: approvedTone, resolved_at: resolvedAt, resolved_by: input.actorId })
    .eq("id", task.id)
    .eq("status", "open")
    .select("id");
  if (updated.error) {
    if (/collection_task_resolved/.test(updated.error.message ?? "")) throw new CollectionError("changed");
    throw new Error(updated.error.message);
  }
  if ((updated.data ?? []).length === 0) throw new CollectionError("changed");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: COLLECTION_TASK_ACTIONS.resolved,
    summary: `Resolved a collection task about ${customerName}'s invoice: ${outcome.replace("_", " ")}`,
    detail: {
      by: input.actorId,
      taskId: task.id,
      invoiceId: task.invoiceId,
      counterpartyId: task.counterpartyId,
      reason: task.reason,
      outcome,
      policyVersion: task.policyVersion,
      ...(holdUntil ? { holdUntil } : {}),
      ...(approvedNumber !== null ? { reminder: { number: approvedNumber, tone: approvedTone } } : {}),
    },
  });
  return { customerName, invoiceId: task.invoiceId, reason: task.reason, outcome, holdUntil, approvedNumber, approvedTone, startsCycle: outcome === "approved" || outcome === "resumed" };
}
