import { siteOrigin } from "../auth/env";
import type { OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { emailSettingsFromEnv, sendEmail } from "../email/send";
import { waitingDigestEmail, type DigestItem } from "../email/waiting-digest";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { listMembers } from "../platform/members";

/**
 * Telling the members who can decide payments which payables wait for them
 * (docs/superpowers/specs/2026-09-29-notifications-design.md, N2–N8). Runs in
 * an organization's scope, after a scheduled cycle (see `runScheduledCycle`).
 *
 * `invoices.notified_at` records what has been told: an invoice is included
 * while it waits and either was never told, or was escalated by the follow-up
 * stage since it was last told. It is stamped only after at least one
 * recipient's send succeeded, so a digest nobody received is retried on the
 * next scheduled cycle.
 */

export interface WaitingInvoice {
  id: string;
  counterpartyName: string;
  amount: number;
  status: "held" | "flagged" | "awaiting_info";
  reasoning: string | null;
  /** Told before, and escalated since: `escalated_at > notified_at`. */
  escalated: boolean;
}

/** At most this many members receive one workspace's digest (N5); the rest are logged, not emailed. */
export const DIGEST_MAX_RECIPIENTS = 25;

/**
 * How long one workspace's sends may take in all. The cron runs workspaces
 * one after another inside a single tick, so a slow Resend must not starve
 * the later workspaces' cycles, or run the function out of time between the
 * sends and the marking. Each send is also bounded, by `SEND_TIMEOUT_MS`.
 */
export const DIGEST_SEND_DEADLINE_MS = 60_000;

const WAITING_STATUSES = ["held", "flagged", "awaiting_info"] as const;

/** The roles that hold `approval.decide`, in the order recipients are chosen. */
const DECIDING_ROLES: readonly OrgRole[] = ["owner", "admin", "approver"];

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The waiting payables the members have not been told about yet, in due order.
 *
 * The "never told, or escalated since" test is made here rather than in the
 * query: PostgREST's `or` filter compares a column with a value, not with
 * another column, so `escalated_at > notified_at` cannot be expressed there.
 * The rows read are the workspace's waiting payables, a short list.
 */
export async function waitingToNotify(): Promise<WaitingInvoice[]> {
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, status, agent_reasoning, notified_at, escalated_at, counterparties(name)")
      .eq("direction", "payable")
      .in("status", WAITING_STATUSES)
      .order("due_date", { ascending: true })
  ) as unknown as Array<{
    id: string;
    amount: string | number;
    status: WaitingInvoice["status"];
    agent_reasoning: string | null;
    notified_at: string | null;
    escalated_at: string | null;
    counterparties: { name: string } | null;
  }>;

  const waiting: WaitingInvoice[] = [];
  for (const row of rows) {
    const escalated =
      row.notified_at !== null &&
      row.escalated_at !== null &&
      new Date(row.escalated_at).getTime() > new Date(row.notified_at).getTime();
    if (row.notified_at !== null && !escalated) continue;
    waiting.push({
      id: row.id,
      counterpartyName: row.counterparties?.name ?? "unknown",
      amount: num(row.amount),
      status: row.status,
      reasoning: row.agent_reasoning,
      escalated,
    });
  }
  return waiting;
}

/** Records that the members were told about these invoices. In scope. */
export async function markNotified(ids: string[], at: Date = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const marked = unwrap(
    await db().from("invoices").update({ notified_at: at.toISOString() }).in("id", ids).select("id")
  ) as Array<{ id: string }>;
  if (marked.length < ids.length) {
    // The one failure mode that would silently re-send every cycle: an
    // update that matched fewer rows than it was given.
    console.warn("notifications: marked fewer invoices than given", marked.length, ids.length, currentOrgId());
  }
}

interface Recipient {
  userId: string;
  email: string;
  role: OrgRole;
}

/**
 * The members who can decide and have the email switched on (N5, N6): owners,
 * then admins, then approvers, by address within a role. The caller caps the list.
 */
async function decidingRecipients(orgId: string): Promise<Recipient[]> {
  const members = await listMembers(orgId);
  const switches = unwrap(
    await platformDb().from("memberships").select("user_id, notify_email").eq("org_id", orgId)
  ) as Array<{ user_id: string; notify_email: boolean }>;
  const switchedOn = new Set(switches.filter((row) => row.notify_email === true).map((row) => row.user_id));

  return members
    .filter((member) => DECIDING_ROLES.includes(member.role) && switchedOn.has(member.userId))
    .sort((a, b) => {
      const byRole = DECIDING_ROLES.indexOf(a.role) - DECIDING_ROLES.indexOf(b.role);
      if (byRole !== 0) return byRole;
      return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
    })
    .map(({ userId, email, role }) => ({ userId, email, role }));
}

/**
 * Emails the digest of waiting payables to every member of the workspace in
 * scope who can decide them. Each recipient gets a message of their own; the
 * invoices are marked once at least one send succeeded, and the ledger
 * records ids and counts, never an address (N8).
 *
 * The sends stop at `DIGEST_SEND_DEADLINE_MS`: the recipients not reached
 * by then are counted as failed without a send, and the invoices are still
 * marked if anyone was told. They are marked with the time they were read,
 * so an escalation that lands while the sends run is later than the mark,
 * and is news again on the next cycle.
 *
 * Never throws (N2): every failure is logged with the workspace id, and the
 * counts so far are returned.
 */
export async function notifyWaitingDecisions(): Promise<{ sent: number; failed: number; invoices: number }> {
  const counts = { sent: 0, failed: 0, invoices: 0 };
  let orgId: string | undefined;
  try {
    orgId = currentOrgId();
    const scopedOrgId = orgId;

    const readAt = new Date();
    const waiting = await waitingToNotify();
    if (waiting.length === 0) return counts;
    counts.invoices = waiting.length;

    const settings = emailSettingsFromEnv();
    if (!settings) {
      console.log("notifications: email not configured", scopedOrgId);
      return counts;
    }

    const org = unwrap(
      await platformDb().from("orgs").select("name, slug").eq("id", scopedOrgId).single()
    ) as { name: string; slug: string };

    const eligible = await decidingRecipients(scopedOrgId);
    const recipients = eligible.slice(0, DIGEST_MAX_RECIPIENTS);
    if (eligible.length > recipients.length) {
      console.warn("notifications: recipients over the cap, skipped", eligible.length - recipients.length, scopedOrgId);
    }
    if (recipients.length === 0) {
      console.log("notifications: nobody to tell", scopedOrgId);
      return counts;
    }

    const items: DigestItem[] = waiting.map((invoice) => ({
      counterpartyName: invoice.counterpartyName,
      amount: invoice.amount,
      status: invoice.status,
      reason: invoice.reasoning,
      escalated: invoice.escalated,
    }));
    const origin = siteOrigin();
    const email = waitingDigestEmail({ orgName: org.name, items, link: `${origin}/o/${org.slug}/approvals`, origin });

    const deadline = Date.now() + DIGEST_SEND_DEADLINE_MS;
    for (const [index, recipient] of recipients.entries()) {
      if (Date.now() >= deadline) {
        const unsent = recipients.length - index;
        counts.failed += unsent;
        console.warn("notifications: send deadline passed, not sent", unsent, scopedOrgId);
        break;
      }
      const result = await sendEmail({ to: recipient.email, ...email }, settings);
      if (result.sent) {
        counts.sent += 1;
      } else {
        counts.failed += 1;
        console.warn("notifications: send failed", scopedOrgId, result.reason);
      }
    }

    if (counts.sent === 0) {
      // Nobody received it: nothing is marked, and the next scheduled cycle tries again.
      console.error("notifications: every send failed", counts.failed, scopedOrgId);
      return counts;
    }

    const invoiceIds = waiting.map((invoice) => invoice.id);
    const escalatedIds = waiting.filter((invoice) => invoice.escalated).map((invoice) => invoice.id);
    try {
      await markNotified(invoiceIds, readAt);
    } catch (error) {
      // The emails are out but unmarked, so the next cycle sends them again: say how many, never to whom.
      console.error(
        "notifications: marking failed after the sends",
        scopedOrgId,
        { recipients: counts.sent, failed: counts.failed },
        messageOf(error)
      );
      return counts;
    }

    await appendLedgerEntryBestEffort(scopedOrgId, {
      actor: "system",
      domain: "system",
      action: "notification_sent",
      summary: `Told ${counts.sent} member(s) that ${waiting.length} payment(s) need a decision`,
      detail: { invoiceIds, escalatedIds, recipients: counts.sent, failed: counts.failed },
    });
    return counts;
  } catch (error) {
    console.error("notifications: digest failed", orgId ?? "no organization in scope", messageOf(error));
    return counts;
  }
}
