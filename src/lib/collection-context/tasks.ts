import { can, type OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { platformDb, unwrap, type OrgDb } from "../dal";
import { collectionTaskEmail } from "../email/collection-task";
import type { EmailMessage, SendResult } from "../email/send";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { sendOnce } from "../notifications/deliveries";
import { listMembers } from "../platform/members";
import { taskProposalOf, type CollectionTask, type Proposal, type ReceivableFacts, type TaskNeed } from "./model";
import { notThereYet, readTaskStart, TASK_COLUMNS, toTask, type TaskRow } from "./read";

/**
 * The collections stage's tasks (docs/superpowers/specs/2026-10-13-collections-context-design.md C6, I11): a task opened
 * once per receivable and subject, with the proposal it was opened for, and signed; one no longer needed closed as
 * obsolete; and the members it asks told by email, each once per task, at most one email each a cycle, their own email
 * switch read again right before the send. Tasks open only from the day they began in the workspace
 * (`collection_task_starts`, set by the stage's first run): what was already so then emails nobody.
 */

export const COLLECTION_TASK_ACTIONS = {
  opened: "collection_task_opened",
  resolved: "collection_task_resolved",
} as const;

/** A task's email goes to at most this many members. */
export const TASK_NOTICE_MAX_RECIPIENTS = 10;
/** An open task not emailed is tried again for this long, then left on the page alone. */
export const TASK_NOTICE_DAYS = 7;

/**
 * The day tasks began in the workspace in scope: read, or set to `today` by the stage's first run. Null before migration
 * 0110 runs. Two runs at once set one day: the second reads what the first set.
 */
export async function taskStart(orgDb: OrgDb, today: string): Promise<string | null> {
  const found = await readTaskStart(orgDb);
  if (found !== "") return found;
  const set = await orgDb.from("collection_task_starts").upsert({ starts_on: today }, { onConflict: "org_id", ignoreDuplicates: true }).select("starts_on");
  if (notThereYet(set.error)) return null;
  if (set.error) throw new Error(set.error.message);
  const inserted = ((set.data ?? []) as Array<{ starts_on: string }>)[0]?.starts_on;
  if (inserted) return String(inserted).slice(0, 10);
  const again = await readTaskStart(orgDb);
  if (again === "") throw new Error("collection task start not set");
  return again;
}

/** Opens the task a proposal needs, once: null when it was open already (another cycle, the same subject). */
export async function openTask(orgDb: OrgDb, facts: ReceivableFacts, proposal: Proposal, need: TaskNeed): Promise<CollectionTask | null> {
  const inserted = await orgDb
    .from("collection_tasks")
    .upsert(
      {
        invoice_id: facts.invoiceId,
        counterparty_id: facts.customerId,
        kind: need.kind,
        reason: need.reason,
        subject_key: need.subjectKey,
        assignee: need.assignee,
        policy_version: facts.policy.version,
        proposal: taskProposalOf(proposal),
      },
      { onConflict: "org_id,invoice_id,subject_key", ignoreDuplicates: true }
    )
    .select(TASK_COLUMNS);
  if (inserted.error) throw new Error(inserted.error.message);
  const row = ((inserted.data ?? []) as TaskRow[])[0];
  if (!row) return null;
  const task = toTask(row);
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "agent",
    domain: "ar",
    action: COLLECTION_TASK_ACTIONS.opened,
    summary: `Asked a person about ${facts.customerName}'s invoice: ${proposal.headline}`,
    detail: {
      taskId: task.id,
      invoiceId: facts.invoiceId,
      counterpartyId: facts.customerId,
      kind: need.kind,
      reason: need.reason,
      policyVersion: facts.policy.version,
      reasons: proposal.reasons.map((reason) => reason.code),
      ...(proposal.reminder ? { reminder: { number: proposal.reminder.number, tone: proposal.reminder.tone } } : {}),
    },
  });
  return task;
}

/** Closes open tasks the receivable no longer needs (paid, a newer rule, the customer answered). */
export async function closeObsolete(orgDb: OrgDb, taskIds: readonly string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  const closed = await orgDb
    .from("collection_tasks")
    .update({ status: "done", outcome: "obsolete", resolved_at: new Date().toISOString() })
    .in("id", [...taskIds])
    .eq("status", "open")
    .select("id");
  if (closed.error) throw new Error(closed.error.message);
  return (closed.data ?? []).length;
}

interface Recipient {
  userId: string;
  email: string;
}

const ROLE_ORDER: readonly OrgRole[] = ["owner", "admin"];

/**
 * Who tasks may ask, read once a cycle: the owners and admins (`records.write`, who resolve tasks) whose email switch is
 * on, owners first.
 */
async function askable(orgId: string): Promise<Array<Recipient & { role: OrgRole }>> {
  const members = await listMembers(orgId);
  const switches = unwrap(await platformDb().from("memberships").select("user_id, notify_email").eq("org_id", orgId)) as Array<{ user_id: string; notify_email: boolean }>;
  const on = new Set(switches.filter((row) => row.notify_email === true).map((row) => row.user_id));
  return members
    .filter((member) => can(member.role, "records.write") && on.has(member.userId))
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0))
    .map((member) => ({ userId: member.userId, email: member.email, role: member.role }));
}

/**
 * Who a task asks: its assignee when the customer's rules name one who still may act and gets email, else the owners
 * and admins whose email switch is on, owners first, at most ten.
 */
export function taskRecipients(able: ReadonlyArray<Recipient>, assignee: string | null): Recipient[] {
  const named = assignee ? able.find((member) => member.userId === assignee) : undefined;
  const chosen = named ? [named] : able.slice(0, TASK_NOTICE_MAX_RECIPIENTS);
  return chosen.map((member) => ({ userId: member.userId, email: member.email }));
}

/** Whether a member still gets email: read again right before each send (I11). */
async function stillOn(orgId: string, userId: string): Promise<boolean> {
  const row = unwrap(await platformDb().from("memberships").select("notify_email, role").eq("org_id", orgId).eq("user_id", userId).limit(1)) as Array<{ notify_email: boolean; role: OrgRole }>;
  return row.length === 1 && row[0].notify_email === true && can(row[0].role, "records.write");
}

/**
 * Emails each open task not emailed yet (opened in the last week) to the members it asks, once per member and task,
 * the task waiting longest first; stamps the task once one member got it. Each member gets at most one email a cycle:
 * a task whose members all had theirs waits for the next cycle. Best effort per task: a failure is logged and the next
 * run tries again, under the same keys.
 */
export async function notifyTasks(
  orgDb: OrgDb,
  tasks: readonly CollectionTask[],
  context: { orgName: string; customerNames: ReadonlyMap<string, string>; linkOf: (task: CollectionTask) => string; origin: string; send: (message: EmailMessage) => Promise<SendResult>; now: number }
): Promise<number> {
  const orgId = currentOrgId();
  const cutoff = context.now - TASK_NOTICE_DAYS * 86_400_000;
  const due = tasks
    .filter((task) => task.status === "open" && task.notifiedAt === null && Date.parse(task.createdAt) >= cutoff)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (due.length === 0) return 0;
  let able: Array<Recipient & { role: OrgRole }>;
  try {
    able = await askable(orgId);
  } catch (error) {
    console.error("collection task: members not read", error instanceof Error ? error.message : "unknown");
    return 0;
  }
  // The members emailed this cycle: one email each, whatever the number of tasks.
  const emailed = new Set<string>();
  let told = 0;
  for (const task of due) {
    try {
      const recipients = taskRecipients(able, task.assignee).filter((recipient) => !emailed.has(recipient.userId));
      if (recipients.length === 0) continue;
      const email = collectionTaskEmail({
        orgName: context.orgName,
        customerName: context.customerNames.get(task.counterpartyId) ?? "A customer",
        reason: task.reason,
        facts: task.proposal.reasons.map((reason) => reason.text),
        link: context.linkOf(task),
        origin: context.origin,
      });
      let sent = 0;
      for (const recipient of recipients) {
        const result = await sendOnce(
          orgDb,
          { kind: "collection_task", subjectId: task.id, event: `task:${task.id}`, recipient: recipient.email, policyVersion: task.policyVersion },
          { to: recipient.email, ...email, meter: "collection_task" },
          context.send,
          () => stillOn(orgId, recipient.userId)
        );
        if (result.sent) emailed.add(recipient.userId);
        if (result.sent || result.reason === "sent_before") sent += 1;
        else if (result.reason === "failed") console.error("collection task: email not sent", task.id, result.detail ?? "unknown");
      }
      if (sent > 0) {
        const stamped = await orgDb.from("collection_tasks").update({ notified_at: new Date(context.now).toISOString() }).eq("id", task.id).is("notified_at", null);
        if (stamped.error) console.error("collection task: not stamped as emailed", task.id, stamped.error.message);
        told += 1;
      }
    } catch (error) {
      console.error("collection task: members not told", task.id, error instanceof Error ? error.message : "unknown");
    }
  }
  return told;
}
