import { z } from "zod";
import { siteOrigin } from "../auth/env";
import { allowedTones, boundTone, boundWaitDays, reminderAllowed, referenceReminder, whenInWords, type ReminderDecision, type ReminderTone, type SentReminder } from "../collections";
import { currentOrgId } from "../context";
import { utcDay } from "../copy";
import { platformDb, unwrap, type OrgDb } from "../dal";
import { receivableReminderEmail } from "../email/receivable-reminder";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { maskEmail } from "../payment-notices";
import { payLinkToken, payLinkUrl } from "../platform/pay-links";
import { REASONING_RULE, REASONING_SHAPE } from "../reasoning-copy";
import type { MasterKey } from "../secrets";
import { workspaceNetwork } from "../workspace-network";
import { decide } from "./decide";
import type { CycleLogLine } from "./orchestrator";
import { agentPaused } from "./pause";

/**
 * The cycle's collections stage (docs/superpowers/specs/2026-10-03-collections-design.md): for each open receivable
 * whose reminders a person turned on (R1), where code allows a reminder now (R3), the model decides whether to email
 * the client now or wait, and how firmly (R5), beside the written policy's answer (R4). The email is a template that
 * carries the pay link (R2, R6); each reminder is claimed before it is sent (R7). Live workspaces only (R9).
 */

/** The most reminders one cycle sends. */
export const REMINDERS_PER_RUN = 10;
const DAY_MS = 86_400_000;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const SYSTEM_PROMPT = `You are the collections step of a treasury agent for a small business. A client owes the business money on an open receivable, the business turned on reminders for it, and code allows a reminder now. Decide whether to email the client a reminder now or to wait, and how firmly.

- Remind in time, without nagging. A client who usually pays on time and is a day or two late needs a friendly nudge; a client who pays late again and again needs a firm one.
- Choose one of the allowed tones you are given. "final" is the last reminder: after it the business follows up itself.
- Wait 1 to 3 days when a reminder now would come too early or add nothing, for example while the due date is still days away and a reminder already went out.
- The written policy's answer is given as a reference. Follow it unless the facts say otherwise, and say why when you depart from it.
- ${REASONING_RULE}

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const reminderSchema = z.object({
  action: z.enum(["send", "wait"]),
  tone: z.enum(["friendly", "firm", "final"]),
  waitDays: z.coerce.number().optional(),
  reasoning: z.string().min(1).max(2000),
});

interface LinkRow {
  id: string;
  invoice_id: string;
  token_enc: unknown;
  reminder_deferred_until: string | null;
}

interface InvoiceRow {
  id: string;
  counterparty_id: string;
  amount: string | number;
  currency: string | null;
  due_date: string;
  memo: string | null;
  po_reference: string | null;
  status: string;
  direction: string;
}

/** How a client paid its earlier receivables: on time, and late by how many days on average. */
interface ClientHistory {
  paidOnTime: number;
  paidLate: number;
  averageDaysLate: number | null;
}

function invoiceWhat(memo: string | null, po: string | null): string | null {
  if (memo && po) return `${memo} (${po})`;
  return memo ?? (po ? `purchase order ${po}` : null);
}

const dayOf = (iso: string) => Math.floor(Date.parse(iso) / DAY_MS);

/** Each client's record from its received receivables (the model weighs it, R5). */
function histories(rows: Array<{ counterparty_id: string; due_date: string; settled_at: string | null }>): Map<string, ClientHistory> {
  const late = new Map<string, number[]>();
  const onTime = new Map<string, number>();
  for (const row of rows) {
    if (!row.settled_at) continue;
    const days = dayOf(row.settled_at) - dayOf(row.due_date);
    if (days <= 0) onTime.set(row.counterparty_id, (onTime.get(row.counterparty_id) ?? 0) + 1);
    else late.set(row.counterparty_id, [...(late.get(row.counterparty_id) ?? []), days]);
  }
  const ids = new Set([...late.keys(), ...onTime.keys()]);
  return new Map(
    [...ids].map((id) => {
      const lateDays = late.get(id) ?? [];
      return [
        id,
        {
          paidOnTime: onTime.get(id) ?? 0,
          paidLate: lateDays.length,
          averageDaysLate: lateDays.length > 0 ? Number((lateDays.reduce((sum, days) => sum + days, 0) / lateDays.length).toFixed(1)) : null,
        },
      ];
    })
  );
}

/**
 * The stage: every receivable with reminders on, decided and, when the decision is to send, emailed and signed.
 * Quietly does nothing in a sandbox, without email configured, while the agent is paused, or with nothing to remind.
 */
export async function sendReceivableReminders(
  orgDb: OrgDb,
  options: { now?: number; send?: (message: EmailMessage) => Promise<SendResult>; origin?: string; keys?: MasterKey[] } = {}
): Promise<CycleLogLine[]> {
  const orgId = currentOrgId();
  const org = unwrap(await platformDb().from("orgs").select("name, mode").eq("id", orgId).single()) as { name: string; mode: string };
  // A sandbox's clients are sample data: it never emails them (R9).
  if (org.mode !== "live") return [];
  const settings = options.send ? null : emailSettingsFromEnv();
  if (!options.send && !settings) return [];
  const send = options.send ?? ((message: EmailMessage) => sendEmail(message, settings));
  const now = options.now ?? Date.now();

  const links = unwrap(
    await orgDb.from("receivable_links").select("id, invoice_id, token_enc, reminder_deferred_until").not("reminders_on_at", "is", null).is("revoked_at", null)
  ) as LinkRow[];
  if (links.length === 0) return [];
  // A pause lands between cycles; one that lands during this one holds the reminders too.
  if (await agentPaused()) return [];

  const invoiceIds = links.map((link) => link.invoice_id);
  const invoices = (unwrap(
    await orgDb.from("invoices").select("id, counterparty_id, amount, currency, due_date, memo, po_reference, status, direction").in("id", invoiceIds)
  ) as InvoiceRow[]).filter((row) => row.direction === "receivable" && (row.status === "pending" || row.status === "matched"));
  if (invoices.length === 0) return [];
  const clientIds = [...new Set(invoices.map((row) => row.counterparty_id))];
  const [clients, reminders, settled] = await Promise.all([
    orgDb.from("counterparties").select("id, name, notice_email").in("id", clientIds),
    orgDb.from("ar_reminders").select("invoice_id, number, tone, sent_at").in("invoice_id", invoices.map((row) => row.id)),
    orgDb.from("invoices").select("counterparty_id, due_date, settled_at").eq("direction", "receivable").in("counterparty_id", clientIds).in("status", ["received", "paid"]),
  ]);
  const clientById = new Map((unwrap(clients) as Array<{ id: string; name: string; notice_email: string | null }>).map((row) => [row.id, row]));
  const sentBy = new Map<string, SentReminder[]>();
  for (const row of unwrap(reminders) as Array<{ invoice_id: string; number: number; tone: ReminderTone; sent_at: string }>) {
    sentBy.set(row.invoice_id, [...(sentBy.get(row.invoice_id) ?? []), { number: row.number, tone: row.tone, sentAt: row.sent_at }]);
  }
  const historyBy = histories(unwrap(settled) as Array<{ counterparty_id: string; due_date: string; settled_at: string | null }>);
  const linkBy = new Map(links.map((link) => [link.invoice_id, link]));

  const origin = options.origin ?? siteOrigin();
  const lines: CycleLogLine[] = [];
  let sentCount = 0;
  for (const invoice of invoices) {
    if (sentCount >= REMINDERS_PER_RUN) break;
    const link = linkBy.get(invoice.id);
    const client = clientById.get(invoice.counterparty_id);
    // The client's billing email and the link the email carries (R3); without either the card says what to do.
    if (!link || !client?.notice_email) continue;
    const token = payLinkToken(orgId, link.token_enc, options.keys);
    if (!token) continue;

    const sent = sentBy.get(invoice.id) ?? [];
    const facts = { now, dueDate: invoice.due_date, sent, deferredUntil: link.reminder_deferred_until };
    const allowance = reminderAllowed(facts);
    if (!allowance.allowed) continue;
    const reference = referenceReminder(facts, allowance);
    const tones = allowedTones(allowance.daysFromDue, sent.length);
    const currency = invoice.currency === "EURC" ? "EURC" : "USDC";
    const amount = AMOUNT.format(Number(invoice.amount));
    const dueOn = utcDay(invoice.due_date);

    const { value, mode, agreedWithReference } = await decide<ReminderDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to email this client a reminder about the receivable now, or to wait, and in which tone.",
        receivable: { amount: Number(invoice.amount), currency, dueDate: dueOn, daysFromDueDate: allowance.daysFromDue, when: whenInWords(allowance.daysFromDue), forWhat: invoiceWhat(invoice.memo, invoice.po_reference) },
        client: { name: client.name, earlierReceivables: historyBy.get(invoice.counterparty_id) ?? { paidOnTime: 0, paidLate: 0, averageDaysLate: null } },
        remindersSent: sent.map((reminder) => ({ number: reminder.number, tone: reminder.tone, sentOn: utcDay(reminder.sentAt) })),
        thisWouldBeReminder: allowance.number,
        allowedTones: tones,
        writtenPolicy: { action: reference.action, tone: reference.tone, waitDays: reference.waitDays ?? null, reasoning: reference.reasoning },
        responseShape: { action: "send | wait", tone: tones.join(" | "), waitDays: "1 to 3, when waiting", reasoning: REASONING_SHAPE },
      }),
      schema: reminderSchema,
      fallback: () => reference,
    });
    const referenceDecision = { action: reference.action, tone: reference.tone, waitDays: reference.waitDays ?? null };

    if (value.action === "wait") {
      const waitDays = boundWaitDays(value.waitDays);
      const until = new Date(now + waitDays * DAY_MS).toISOString();
      const res = await orgDb.from("receivable_links").update({ reminder_deferred_until: until }).eq("invoice_id", invoice.id);
      if (res.error) throw new Error(res.error.message);
      await appendLedgerEntry({
        actor: "agent",
        domain: "ar",
        action: "ar_reminder_deferred",
        summary: `Decided to wait ${waitDays} ${waitDays === 1 ? "day" : "days"} before reminding ${client.name} of ${amount} ${currency}`,
        detail: {
          invoiceId: invoice.id,
          counterpartyId: invoice.counterparty_id,
          until,
          daysFromDue: allowance.daysFromDue,
          remindersSent: sent.length,
          decision: { action: "wait", waitDays, reasoning: value.reasoning },
          referenceDecision,
          decisionMode: mode,
          agreedWithReference,
        },
      });
      lines.push({ domain: "ar", message: `${client.name}: waiting ${waitDays} d before a reminder` });
      continue;
    }

    const bounded = boundTone(value.tone, allowance.daysFromDue, sent.length);
    // Claimed before it is sent: two cycles at once never send the same reminder twice (R7).
    const claim = await orgDb
      .from("ar_reminders")
      .insert({ invoice_id: invoice.id, number: allowance.number, tone: bounded.tone, sent_at: new Date(now).toISOString() })
      .select("id")
      .single<{ id: string }>();
    if (claim.error?.code === "23505") continue;
    if (claim.error) throw new Error(claim.error.message);

    const email = receivableReminderEmail({
      orgName: org.name,
      clientName: client.name,
      amount,
      token: currency,
      what: invoiceWhat(invoice.memo, invoice.po_reference),
      dueOn,
      daysFromDue: allowance.daysFromDue,
      tone: bounded.tone,
      payUrl: payLinkUrl(token),
      origin,
      network: workspaceNetwork().id,
    });
    let result: SendResult;
    try {
      result = await send({ to: client.notice_email, ...email });
    } catch (error) {
      result = { sent: false, reason: error instanceof Error ? error.message : "send failed" };
    }
    if (!result.sent) {
      // Released, so the next cycle may try again.
      await orgDb.from("ar_reminders").delete().eq("id", claim.data.id);
      console.error("receivable reminder not sent", invoice.id, result.reason);
      lines.push({ domain: "ar", message: `Reminder to ${client.name} not sent (${result.reason}); tried again at the next cycle` });
      continue;
    }
    sentCount += 1;
    const cleared = await orgDb.from("receivable_links").update({ reminder_deferred_until: null }).eq("invoice_id", invoice.id);
    if (cleared.error) console.error("reminder wait not cleared", invoice.id, cleared.error.message);
    const reasoning = bounded.limited
      ? `${value.reasoning} [The model chose a ${value.tone} tone; code allows ${tones.join(" or ")} ${whenInWords(allowance.daysFromDue)} with ${sent.length} sent, so it went out ${bounded.tone}.]`
      : value.reasoning;
    await appendLedgerEntry({
      actor: "agent",
      domain: "ar",
      action: "ar_reminder_sent",
      summary: `Reminded ${client.name} by email of ${amount} ${currency} due ${dueOn} (${bounded.tone})`,
      detail: {
        invoiceId: invoice.id,
        counterpartyId: invoice.counterparty_id,
        to: maskEmail(client.notice_email),
        number: allowance.number,
        tone: bounded.tone,
        daysFromDue: allowance.daysFromDue,
        amount: Number(invoice.amount),
        currency,
        linkId: link.id,
        decision: { action: "send", tone: bounded.tone, reasoning },
        referenceDecision,
        decisionMode: mode,
        agreedWithReference,
        ...(bounded.limited ? { toneLimited: { chosen: value.tone, sent: bounded.tone } } : {}),
      },
    });
    lines.push({ domain: "ar", message: `Reminded ${client.name} by email: ${amount} ${currency} due ${dueOn} (${bounded.tone})` });
  }
  return lines;
}
