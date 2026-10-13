import { invoiceDiscount } from "../agent/payment-timing";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { decisionEscalationEmail, type EscalationItem } from "../email/decision-escalation";
import { emailSettingsFromEnv, sendEmail } from "../email/send";
import { decideByOf } from "../exceptions";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { decidingRecipients, DIGEST_MAX_RECIPIENTS, DIGEST_SEND_DEADLINE_MS } from "./waiting";

/**
 * Telling the members who can decide payments that held payables passed the day they had to be decided by
 * (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E4). Runs in an organization's scope after a
 * scheduled cycle, beside the waiting digest, with the digest's recipients and their own email switch.
 *
 * Each payable is escalated once per decide-by day: an `approval_escalations` row is claimed before the sends and kept
 * once anyone received the email, so a later cycle never sends it again; a claim nobody received is released, so the next
 * cycle tries again. A decide-by day that moves (the due date changed) is a new escalation.
 */

const WAITING = ["held", "flagged", "awaiting_info"] as const;

/** The ledger action of an escalation sent. */
export const ESCALATION_ACTION = "decision_escalated";

type PostgrestError = { code?: string; message?: string } | null;
/** Before migration 0108 runs, the claims table is not there: nothing is escalated, and nothing fails. */
const notReady = (error: PostgrestError) =>
  ["PGRST205", "42P01"].includes(error?.code ?? "") || (/approval_escalations/.test(error?.message ?? "") && /schema cache|does not exist/.test(error?.message ?? ""));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface WaitingRow {
  id: string;
  amount: number | string;
  currency: string | null;
  status: EscalationItem["status"];
  due_date: string;
  early_pay_discount_pct: number | string | null;
  discount_due_date: string | null;
  counterparties: { name: string } | null;
}

/** The waiting payables past their decide-by day today, each with that day. In scope. */
export async function pastDecideBy(now: Date = new Date()): Promise<Array<{ id: string; item: EscalationItem }>> {
  const today = now.toISOString().slice(0, 10);
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, currency, status, due_date, early_pay_discount_pct, discount_due_date, counterparties(name)")
      .eq("direction", "payable")
      .in("status", WAITING)
      .order("due_date", { ascending: true })
  ) as unknown as WaitingRow[];
  return rows.flatMap((row) => {
    const decideBy = decideByOf({ dueDate: row.due_date, discount: invoiceDiscount(row) }, today);
    if (decideBy.day >= today) return [];
    return [
      {
        id: row.id,
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
 * Emails the members who can decide about every waiting payable that passed its decide-by day and was not escalated for
 * that day yet. Never throws: every failure is logged with the workspace id, and the counts so far are returned.
 */
export async function escalateOverdueDecisions(now: Date = new Date()): Promise<{ sent: number; failed: number; invoices: number }> {
  const counts = { sent: 0, failed: 0, invoices: 0 };
  let orgId: string | undefined;
  try {
    orgId = currentOrgId();
    const scopedOrgId = orgId;
    const past = await pastDecideBy(now);
    if (past.length === 0) return counts;

    const settings = emailSettingsFromEnv();
    if (!settings) {
      console.log("escalations: email not configured", scopedOrgId);
      return counts;
    }
    const eligible = await decidingRecipients(scopedOrgId);
    const recipients = eligible.slice(0, DIGEST_MAX_RECIPIENTS);
    if (eligible.length > recipients.length) console.warn("escalations: recipients over the cap, skipped", eligible.length - recipients.length, scopedOrgId);
    if (recipients.length === 0) {
      console.log("escalations: nobody to tell", scopedOrgId);
      return counts;
    }

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

    const org = unwrap(await platformDb().from("orgs").select("name, slug").eq("id", scopedOrgId).single()) as { name: string; slug: string };
    const origin = siteOrigin();
    const email = decisionEscalationEmail({ orgName: org.name, items: fresh.map(({ item }) => item), link: `${origin}/o/${org.slug}/approvals`, origin });

    const deadline = Date.now() + DIGEST_SEND_DEADLINE_MS;
    for (const [index, recipient] of recipients.entries()) {
      if (Date.now() >= deadline) {
        counts.failed += recipients.length - index;
        console.warn("escalations: send deadline passed, not sent", recipients.length - index, scopedOrgId);
        break;
      }
      const result = await sendEmail({ to: recipient.email, ...email }, settings);
      if (result.sent) counts.sent += 1;
      else {
        counts.failed += 1;
        console.warn("escalations: send failed", scopedOrgId, result.reason);
      }
    }

    const claimIds = claims.map((claim) => claim.id);
    if (counts.sent === 0) {
      // Nobody received it: the claims are released, and the next scheduled cycle tries again.
      console.error("escalations: every send failed", counts.failed, scopedOrgId);
      const released = await db().from("approval_escalations").delete().in("id", claimIds);
      if (released.error) console.error("escalations: claims not released", scopedOrgId, released.error.message);
      return counts;
    }
    const marked = await db().from("approval_escalations").update({ sent_at: new Date().toISOString(), recipients: counts.sent, failed: counts.failed }).in("id", claimIds);
    if (marked.error) console.error("escalations: claims not marked sent", scopedOrgId, marked.error.message);

    await appendLedgerEntryBestEffort(scopedOrgId, {
      actor: "system",
      domain: "system",
      action: ESCALATION_ACTION,
      summary: `Told ${counts.sent} member(s) that ${fresh.length} payment(s) passed the day to decide them`,
      detail: {
        invoiceIds: fresh.map(({ id }) => id),
        decideBy: Object.fromEntries(fresh.map(({ id, item }) => [id, item.decideBy])),
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
