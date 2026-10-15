import { invoiceDiscount } from "../agent/payment-timing";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { decisionEscalationEmail, type EscalationItem } from "../email/decision-escalation";
import { emailSettingsFromEnv, sendEmail } from "../email/send";
import { decideByOf, whoCanAct } from "../exceptions";
import { chainModes } from "../circle";
import { membersLeftOut } from "../new-payee";
import { firstPaymentFrom, loadNewPayeeFacts } from "../new-payee-facts";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { listMembers } from "../platform/members";
import { decidingRecipients, DIGEST_MAX_RECIPIENTS, DIGEST_SEND_DEADLINE_MS } from "./waiting";

/**
 * Telling the members who can decide payments that held payables passed the day they had to be decided by
 * (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E4). Runs in an organization's scope after a
 * scheduled cycle, beside the waiting digest, with the digest's recipients and their own email switch.
 *
 * Each payable is escalated once per decide-by day: an `approval_escalations` row is claimed before the sends and kept
 * once anyone received the email, so a later cycle never sends it again; a claim nobody received is released, so the next
 * cycle tries again. A decide-by day that moves (the due date changed) is a new escalation.
 *
 * Only a decide-by day on or after the day escalations started in the workspace counts (`approval_escalation_starts`, set
 * by its first run): a payable already past its day then is never emailed, so turning escalations on sends no backlog.
 * Each member gets at most one email a run, about every payable they may act on.
 */

const WAITING = ["held", "flagged", "awaiting_info"] as const;

/** The ledger action of an escalation sent. */
export const ESCALATION_ACTION = "decision_escalated";

type PostgrestError = { code?: string; message?: string } | null;
/** Before migration 0108 runs, its tables are not there: nothing is escalated, and nothing fails. */
const notReady = (error: PostgrestError) =>
  ["PGRST205", "42P01"].includes(error?.code ?? "") || (/approval_escalation/.test(error?.message ?? "") && /schema cache|does not exist/.test(error?.message ?? ""));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface WaitingRow {
  id: string;
  amount: number | string;
  currency: string | null;
  status: EscalationItem["status"];
  due_date: string;
  early_pay_discount_pct: number | string | null;
  discount_due_date: string | null;
  created_by: string | null;
  counterparty_id: string;
  counterparties: { name: string; address?: string | null } | null;
}

/**
 * The day escalations started in the workspace in scope (E4): read, or set to `today` by its first run. Null before
 * migration 0108 runs. Two runs at once set one day: the second reads what the first set.
 */
export async function escalationStart(today: string): Promise<string | null> {
  const read = async () => {
    const found = await db().from("approval_escalation_starts").select("starts_on").limit(1);
    if (notReady(found.error)) return null;
    if (found.error) throw new Error(found.error.message);
    return ((found.data ?? []) as Array<{ starts_on: string }>)[0]?.starts_on?.slice(0, 10) ?? "";
  };
  const found = await read();
  if (found !== "") return found;
  const set = await db().from("approval_escalation_starts").upsert({ starts_on: today }, { onConflict: "org_id", ignoreDuplicates: true }).select("starts_on");
  if (notReady(set.error)) return null;
  if (set.error) throw new Error(set.error.message);
  const inserted = ((set.data ?? []) as Array<{ starts_on: string }>)[0]?.starts_on?.slice(0, 10);
  if (inserted) return inserted;
  const again = await read();
  if (again === "") throw new Error("escalation start not set");
  return again;
}

/**
 * The waiting payables past their decide-by day today, each with that day; with `from`, only a day on or after it. In
 * scope.
 */
export async function pastDecideBy(
  now: Date = new Date(),
  from?: string
): Promise<Array<{ id: string; createdBy: string | null; counterpartyId: string; address: string | null; item: EscalationItem }>> {
  const today = now.toISOString().slice(0, 10);
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, currency, status, due_date, early_pay_discount_pct, discount_due_date, created_by, counterparty_id, counterparties(name, address)")
      .eq("direction", "payable")
      .in("status", WAITING)
      .order("due_date", { ascending: true })
  ) as unknown as WaitingRow[];
  return rows.flatMap((row) => {
    const decideBy = decideByOf({ dueDate: row.due_date, discount: invoiceDiscount(row) }, today);
    if (decideBy.day >= today || (from !== undefined && decideBy.day < from)) return [];
    return [
      {
        id: row.id,
        createdBy: row.created_by ?? null,
        counterpartyId: row.counterparty_id,
        address: row.counterparties?.address ?? null,
        item: {
          counterpartyName: row.counterparties?.name ?? "unknown",
          amount: Number(row.amount),
          currency: row.currency === "EURC" ? "EURC" : "USDC",
          status: row.status,
          decideBy: decideBy.day,
          discount: decideBy.reason === "discount",
        },
      },
    ];
  });
}

/**
 * For each payable whose payment would be the first to its payee's address, where payments are real: the members that
 * address leaves out of approving it (new payee check N4). None elsewhere.
 */
async function firstPaymentsLeftOut(past: ReadonlyArray<{ id: string; counterpartyId: string; address: string | null }>): Promise<Map<string, string[]>> {
  if (past.length === 0 || chainModes().mode !== "live") return new Map();
  const facts = await loadNewPayeeFacts(db(), [...new Set(past.map(({ counterpartyId }) => counterpartyId))]);
  return new Map(past.map(({ id, counterpartyId, address }) => [id, membersLeftOut(firstPaymentFrom(facts, { id: counterpartyId, address }))]));
}

/**
 * Emails the members who can act on each waiting payable that passed its decide-by day, on or after the day escalations
 * started here, and was not escalated for that day yet: each member with the email switch on is told about the payables
 * they may decide (`whoCanAct`, as the Approvals card names them), in one message. Everything the sends need is read
 * before anything is claimed, and a payable nobody received is released for the next cycle. Never throws: every failure
 * is logged with the workspace id, and the counts so far are returned.
 */
export async function escalateOverdueDecisions(now: Date = new Date()): Promise<{ sent: number; failed: number; invoices: number }> {
  const counts = { sent: 0, failed: 0, invoices: 0 };
  let orgId: string | undefined;
  try {
    orgId = currentOrgId();
    const scopedOrgId = orgId;
    // The day escalations started here, set by the first run: what was already past its day then never emails.
    const startsOn = await escalationStart(now.toISOString().slice(0, 10));
    if (startsOn === null) return counts;
    const past = await pastDecideBy(now, startsOn);
    if (past.length === 0) return counts;

    const settings = emailSettingsFromEnv();
    if (!settings) {
      console.log("escalations: email not configured", scopedOrgId);
      return counts;
    }
    // One email per member a run: a member listed twice, by id or address, is told once.
    const seen = new Set<string>();
    const eligible = (await decidingRecipients(scopedOrgId)).filter((recipient) => {
      const address = recipient.email.trim().toLowerCase();
      if (seen.has(recipient.userId) || seen.has(address)) return false;
      seen.add(recipient.userId);
      seen.add(address);
      return true;
    });
    const recipients = eligible.slice(0, DIGEST_MAX_RECIPIENTS);
    if (eligible.length > recipients.length) console.warn("escalations: recipients over the cap, skipped", eligible.length - recipients.length, scopedOrgId);
    if (recipients.length === 0) {
      console.log("escalations: nobody to tell", scopedOrgId);
      return counts;
    }

    // Everything the sends need, read before anything is claimed: a read that fails leaves every payable for the next
    // cycle, never claimed and unsent.
    const org = unwrap(await platformDb().from("orgs").select("name, slug").eq("id", scopedOrgId).single()) as { name: string; slug: string };
    const origin = siteOrigin();
    const link = `${origin}/o/${org.slug}/approvals`;
    // Who may act on each payable, from every member, so whoever entered one decides it only when nobody else may (E3),
    // and whoever a first payment's address leaves out does not (N4). One that leaves no one is still told to the members
    // who may decide, as before: its card says why none of them can approve it alone.
    const members = await listMembers(scopedOrgId);
    const leftOut = await firstPaymentsLeftOut(past);
    const actingOn = new Map(
      past.map(({ id, createdBy }) => {
        const acting = whoCanAct(members, createdBy, leftOut.get(id));
        return [id, new Set((acting.length > 0 ? acting : whoCanAct(members, createdBy)).map((member) => member.userId))];
      })
    );

    // Claim each payable for its decide-by day: one claimed already was escalated, or is being escalated now.
    const claimed = await db()
      .from("approval_escalations")
      .upsert(
        past.map(({ id, item }) => ({ invoice_id: id, decide_by: item.decideBy })),
        { onConflict: "org_id,invoice_id,decide_by", ignoreDuplicates: true }
      )
      .select("id, invoice_id, decide_by");
    if (notReady(claimed.error)) return counts;
    if (claimed.error) throw new Error(claimed.error.message);
    const claims = (claimed.data ?? []) as Array<{ id: string; invoice_id: string; decide_by: string }>;
    const claimedKeys = new Set(claims.map((claim) => `${claim.invoice_id}|${claim.decide_by}`));
    const fresh = past.filter(({ id, item }) => claimedKeys.has(`${id}|${item.decideBy}`));
    if (fresh.length === 0) return counts;
    counts.invoices = fresh.length;

    const delivered = new Set<string>();
    const claimOf = new Map(claims.map((claim) => [claim.invoice_id, claim.id]));
    try {
      const deadline = Date.now() + DIGEST_SEND_DEADLINE_MS;
      for (const [index, recipient] of recipients.entries()) {
        if (Date.now() >= deadline) {
          counts.failed += recipients.length - index;
          console.warn("escalations: send deadline passed, not sent", recipients.length - index, scopedOrgId);
          break;
        }
        const theirs = fresh.filter(({ id }) => actingOn.get(id)?.has(recipient.userId));
        if (theirs.length === 0) continue;
        const email = decisionEscalationEmail({ orgName: org.name, items: theirs.map(({ item }) => item), link, origin });
        const result = await sendEmail({ to: recipient.email, ...email, meter: "escalation" }, settings);
        if (result.sent) {
          counts.sent += 1;
          for (const { id } of theirs) delivered.add(id);
        } else {
          counts.failed += 1;
          console.warn("escalations: send failed", scopedOrgId, result.reason);
        }
      }
    } finally {
      // A payable nobody received is released, even when a send threw, and the next scheduled cycle tries again; the
      // others are kept as sent.
      const unsent = fresh.filter(({ id }) => !delivered.has(id)).map(({ id }) => claimOf.get(id) as string);
      if (unsent.length > 0) {
        if (counts.sent === 0) console.error("escalations: nobody received it", counts.failed, scopedOrgId);
        const released = await db().from("approval_escalations").delete().in("id", unsent);
        if (released.error) console.error("escalations: claims not released", scopedOrgId, released.error.message);
      }
    }
    const told = fresh.filter(({ id }) => delivered.has(id));
    if (told.length === 0) return counts;
    const marked = await db()
      .from("approval_escalations")
      .update({ sent_at: new Date().toISOString(), recipients: counts.sent, failed: counts.failed })
      .in("id", told.map(({ id }) => claimOf.get(id) as string));
    if (marked.error) console.error("escalations: claims not marked sent", scopedOrgId, marked.error.message);

    await appendLedgerEntryBestEffort(scopedOrgId, {
      actor: "system",
      domain: "system",
      action: ESCALATION_ACTION,
      summary: `Told ${counts.sent} member(s) that ${told.length} payment(s) passed the day to decide them`,
      detail: {
        invoiceIds: told.map(({ id }) => id),
        decideBy: Object.fromEntries(told.map(({ id, item }) => [id, item.decideBy])),
        recipients: counts.sent,
        failed: counts.failed,
      },
    });
    return counts;
  } catch (error) {
    console.error("escalations: failed", orgId ?? "no organization in scope", messageOf(error));
    return counts;
  }
}
