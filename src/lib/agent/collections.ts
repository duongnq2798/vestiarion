import { z } from "zod";
import { readAllocationRows, toReceivableIn } from "../allocations/book";
import { fromMicros, receivableBalance } from "../allocations/model";
import { siteOrigin } from "../auth/env";
import { proposeNextAction, taskStillNeeded, type CollectionPolicy, type CollectionTask, type Proposal, type ReceivableFacts } from "../collection-context/model";
import { policyOf, readCrmContexts, readPolicies, readSaid, readTasks, tasksByInvoice } from "../collection-context/read";
import { closeObsolete, notifyTasks, openTask } from "../collection-context/tasks";
import { boundTone, boundWaitDays, referenceReminder, reminderAllowed, whenInWords, type ReminderDecision, type ReminderTone, type SentReminder } from "../collections";
import { currentOrgId } from "../context";
import { utcDay } from "../copy";
import { platformDb, unwrap, type OrgDb } from "../dal";
import { receivableReminderEmail } from "../email/receivable-reminder";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { sendOnce } from "../notifications/deliveries";
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
 *
 * A part-paid receivable is reminded of what is still owed, saying what arrived, and a paid one is not reminded at all
 * (docs/superpowers/specs/2026-10-12-allocations-design.md L11). Before migration 0103 runs, nothing is applied.
 *
 * Every open receivable is first read with its customer's context (docs/superpowers/specs/2026-10-13-collections-context-design.md):
 * what the customer said on its statement, its rules, its HubSpot deal and the tasks a person resolved. The proposal
 * (`proposeNextAction`) decides whether a reminder may be weighed at all: a dispute, a payment the customer says it
 * made, a promise not yet due and a person's hold wait; a broken promise, rules that say ask first, a HubSpot deal's
 * owner before the first overdue reminder, a missing billing contact and reminders done each open a task for a person
 * instead, emailed to them once. A reminder a person approved goes at the tone they chose, without the model. Every
 * email has an idempotency key per recipient, event and rules' version, and the opt-out is read again right before it
 * is sent (I11). Before migrations 0109 and 0110 run, none of this holds anything and reminders go as before.
 */

/** The most reminders one cycle sends. */
export const REMINDERS_PER_RUN = 10;
/** The most open receivables one cycle reads. */
export const OPEN_READ = 500;
const DAY_MS = 86_400_000;
/** What a customer said is read back this far, for a dispute resolved or a claim not received. */
const SAID_DAYS = 90;
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
  reminders_on_at: string | null;
  revoked_at: string | null;
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
  deal_id?: string | null;
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
 * Whether the reminder may still go, read again right before the send (I11): the receivable's reminders still on and
 * its link not stopped, and the customer's rules still the version the reminder was decided under.
 */
async function stillWanted(orgDb: OrgDb, invoice: InvoiceRow, decidedUnder: CollectionPolicy): Promise<boolean> {
  const [link, rules] = await Promise.all([
    orgDb.from("receivable_links").select("reminders_on_at, revoked_at").eq("invoice_id", invoice.id).limit(1),
    readPolicies(orgDb, [invoice.counterparty_id]),
  ]);
  if (link.error) throw new Error(link.error.message);
  const row = ((link.data ?? []) as Array<{ reminders_on_at: string | null; revoked_at: string | null }>)[0];
  if (!row?.reminders_on_at || row.revoked_at) return false;
  return policyOf(rules, invoice.counterparty_id).version === decidedUnder.version;
}

const NONE = { data: [], error: null };

/**
 * The stage: every open receivable read with its context, its tasks kept, and, where a reminder may go, decided and,
 * when the decision is to send, emailed and signed. Quietly does nothing in a sandbox or while the agent is paused;
 * without email configured it keeps the tasks and sends nothing.
 */
export async function sendReceivableReminders(
  orgDb: OrgDb,
  options: { now?: number; send?: (message: EmailMessage) => Promise<SendResult>; origin?: string; keys?: MasterKey[] } = {}
): Promise<CycleLogLine[]> {
  const orgId = currentOrgId();
  const org = unwrap(await platformDb().from("orgs").select("name, mode, slug").eq("id", orgId).single()) as { name: string; mode: string; slug?: string };
  // A sandbox's clients are sample data: it never emails them (R9).
  if (org.mode !== "live") return [];
  // A pause lands between cycles; one that lands during this one holds the reminders too.
  if (await agentPaused()) return [];
  const settings = options.send ? null : emailSettingsFromEnv();
  const send = options.send ?? (settings ? (message: EmailMessage) => sendEmail(message, settings) : null);
  const now = options.now ?? Date.now();

  const invoices = (
    unwrap(
      await orgDb
        .from("invoices")
        .select("id, counterparty_id, amount, currency, due_date, memo, po_reference, status, direction, deal_id")
        .eq("direction", "receivable")
        .in("status", ["pending", "matched"])
        .order("due_date", { ascending: true })
        .limit(OPEN_READ)
    ) as InvoiceRow[]
  ).filter((row) => row.direction === "receivable" && (row.status === "pending" || row.status === "matched"));
  const invoiceIds = invoices.map((row) => row.id);
  // Tasks still open on receivables no longer open (paid, rejected) are closed below, as no longer needed.
  const openTasks = await readTasks(orgDb, { openOnly: true });
  if (invoices.length === 0 && (!openTasks.available || openTasks.tasks.length === 0)) return [];

  const links =
    invoiceIds.length > 0
      ? (unwrap(await orgDb.from("receivable_links").select("id, invoice_id, token_enc, reminders_on_at, revoked_at, reminder_deferred_until").in("invoice_id", invoiceIds)) as LinkRow[])
      : [];
  // What is still owed on each, from the payments a person applied (0103); none before it runs.
  const allocations = invoiceIds.length > 0 ? ((await readAllocationRows(orgDb, { invoiceIds })) ?? []) : [];
  const owedBy = new Map(invoices.map((row) => [row.id, receivableBalance(toReceivableIn({ ...row, created_at: null }), allocations, false)] as const));
  const clientIds = [...new Set(invoices.map((row) => row.counterparty_id))];
  const saidSince = new Date(now - SAID_DAYS * DAY_MS).toISOString();
  const [clients, reminders, settled, said, policies, tasks, crm] = await Promise.all([
    clientIds.length > 0 ? orgDb.from("counterparties").select("id, name, notice_email").in("id", clientIds) : Promise.resolve(NONE),
    invoiceIds.length > 0 ? orgDb.from("ar_reminders").select("invoice_id, number, tone, sent_at").in("invoice_id", invoiceIds) : Promise.resolve(NONE),
    clientIds.length > 0
      ? orgDb.from("invoices").select("counterparty_id, due_date, settled_at").eq("direction", "receivable").in("counterparty_id", clientIds).in("status", ["received", "paid"])
      : Promise.resolve(NONE),
    // What the customers said on their statements (0109): a dispute, a claim or a promise holds the reminders (C2, C3).
    readSaid(orgDb, invoiceIds, saidSince),
    readPolicies(orgDb, clientIds),
    readTasks(orgDb, { invoiceIds }),
    readCrmContexts(orgDb, invoices),
  ]);
  const clientById = new Map((unwrap(clients) as Array<{ id: string; name: string; notice_email: string | null }>).map((row) => [row.id, row]));
  const sentBy = new Map<string, SentReminder[]>();
  for (const row of unwrap(reminders) as Array<{ invoice_id: string; number: number; tone: ReminderTone; sent_at: string }>) {
    sentBy.set(row.invoice_id, [...(sentBy.get(row.invoice_id) ?? []), { number: row.number, tone: row.tone, sentAt: row.sent_at }]);
  }
  const historyBy = histories(unwrap(settled) as Array<{ counterparty_id: string; due_date: string; settled_at: string | null }>);
  const linkBy = new Map(links.map((link) => [link.invoice_id, link]));
  const tasksBy = tasksByInvoice(tasks.available ? tasks.tasks : []);

  const origin = options.origin ?? siteOrigin();
  const lines: CycleLogLine[] = [];
  const opened: CollectionTask[] = [];
  const obsolete: string[] = [];
  let sentCount = 0;

  for (const invoice of invoices) {
    const link = linkBy.get(invoice.id);
    const client = clientById.get(invoice.counterparty_id);
    const balance = owedBy.get(invoice.id);
    const token = link && !link.revoked_at ? payLinkToken(orgId, link.token_enc, options.keys) : null;
    const facts: ReceivableFacts = {
      invoiceId: invoice.id,
      customerId: invoice.counterparty_id,
      customerName: client?.name ?? "The customer",
      billingEmail: Boolean(client?.notice_email),
      amount: Number(invoice.amount),
      currency: invoice.currency === "EURC" ? "EURC" : "USDC",
      dueDate: invoice.due_date,
      status: invoice.status,
      // What is still owed: the whole invoice, or the rest of a part-paid one.
      owed: balance && balance.applied > 0 ? fromMicros(balance.outstanding) : Number(invoice.amount),
      // What arrived from the client: its payments, never a fee a person recorded beside them.
      received: balance && balance.applied > 0 ? fromMicros(balance.paid) : 0,
      remindersOn: Boolean(link?.reminders_on_at) && !link?.revoked_at,
      payLink: token !== null,
      deferredUntil: link?.reminder_deferred_until ?? null,
      sent: sentBy.get(invoice.id) ?? [],
      said: said.get(invoice.id) ?? [],
      policy: policyOf(policies, invoice.counterparty_id),
      crm: crm.get(invoice.id) ?? null,
      tasks: tasksBy.get(invoice.id) ?? [],
    };
    const proposal = proposeNextAction(facts, now);

    // The task this receivable needs, opened once; any other open one is no longer needed.
    if (tasks.available) {
      if (proposal.need && !proposal.openTask) {
        const task = await openTask(orgDb, facts, proposal, proposal.need);
        if (task) {
          opened.push(task);
          lines.push({ domain: "ar", message: `${facts.customerName}: ${proposal.headline}. A person was asked` });
        }
      }
      for (const task of facts.tasks) if (task.status === "open" && !taskStillNeeded(task, facts, proposal)) obsolete.push(task.id);
    }

    if (proposal.action !== "remind" || (proposal.sends !== "agent" && proposal.sends !== "approved") || !proposal.reminder) continue;
    if (!send || !link || !client?.notice_email || !token || sentCount >= REMINDERS_PER_RUN) continue;
    const outcome = await remind({
      orgDb,
      orgName: org.name,
      invoice,
      link,
      client: { name: client.name, email: client.notice_email },
      token,
      facts,
      proposal,
      history: historyBy.get(invoice.counterparty_id),
      now,
      origin,
      send,
    });
    if (outcome.sent) sentCount += 1;
    if (outcome.line) lines.push(outcome.line);
  }

  if (openTasks.available && invoices.length < OPEN_READ) {
    const stillOpen = new Set(invoiceIds);
    for (const task of openTasks.tasks) if (!stillOpen.has(task.invoiceId)) obsolete.push(task.id);
  }
  if (obsolete.length > 0) await closeObsolete(orgDb, [...new Set(obsolete)]);

  // Tell the members each new task asks, and any not told yet: once each, their own email switch read again (I11).
  if (send && tasks.available) {
    const closed = new Set(obsolete);
    const seen = new Set<string>();
    const toTell = [...opened, ...(openTasks.available ? openTasks.tasks : [])].filter((task) => {
      if (closed.has(task.id) || seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
    const slug = org.slug ?? "";
    await notifyTasks(orgDb, toTell, {
      orgName: org.name,
      customerNames: new Map([...clientById.values()].map((row) => [row.id, row.name])),
      linkOf: (task) => `${origin}/o/${slug}/invoices?tab=receivables&open=${task.invoiceId}`,
      origin,
      send,
      now,
    });
  }
  return lines;
}

/** One reminder: decided by the model (or as a person approved it), claimed, sent once, and signed. */
async function remind(input: {
  orgDb: OrgDb;
  orgName: string;
  invoice: InvoiceRow;
  link: LinkRow;
  client: { name: string; email: string };
  token: string;
  facts: ReceivableFacts;
  proposal: Proposal;
  history: ClientHistory | undefined;
  now: number;
  origin: string;
  send: (message: EmailMessage) => Promise<SendResult>;
}): Promise<{ sent: boolean; line: CycleLogLine | null }> {
  const { orgDb, invoice, link, client, facts, proposal, now } = input;
  const draft = proposal.reminder as NonNullable<Proposal["reminder"]>;
  const policy = facts.policy;
  const sent = facts.sent;
  const sentRead = { now, dueDate: invoice.due_date, sent, deferredUntil: link.reminder_deferred_until };
  const allowance = reminderAllowed(sentRead, policy.minDaysBetween);
  if (!allowance.allowed) return { sent: false, line: null };
  const reference = referenceReminder(sentRead, allowance);
  const tones = draft.tones;
  const owed = facts.owed;
  const currency = facts.currency;
  const partPaid = facts.received > 0 ? { invoiced: facts.amount, received: facts.received } : null;
  const amount = AMOUNT.format(owed);
  const dueOn = utcDay(invoice.due_date);
  const approved = proposal.sends === "approved" ? proposal.approvedTask : null;

  let value: ReminderDecision;
  let mode: string;
  let agreedWithReference: boolean | null;
  if (approved) {
    // A person approved this reminder at this tone: the model is not asked (collections context C6).
    value = { action: "send", tone: draft.tone, reasoning: `A person approved reminder ${draft.number} in a ${draft.tone} tone.` };
    mode = "person";
    agreedWithReference = null;
  } else {
    const decided = await decide<ReminderDecision>({
      purpose: "reminder",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to email this client a reminder about the receivable now, or to wait, and in which tone.",
        receivable: {
          amount: owed,
          currency,
          dueDate: dueOn,
          daysFromDueDate: allowance.daysFromDue,
          when: whenInWords(allowance.daysFromDue),
          forWhat: invoiceWhat(invoice.memo, invoice.po_reference),
          ...(partPaid ? { partPaid: { invoiced: partPaid.invoiced, alreadyReceived: partPaid.received } } : {}),
        },
        client: { name: client.name, earlierReceivables: input.history ?? { paidOnTime: 0, paidLate: 0, averageDaysLate: null } },
        remindersSent: sent.map((reminder) => ({ number: reminder.number, tone: reminder.tone, sentOn: utcDay(reminder.sentAt) })),
        thisWouldBeReminder: allowance.number,
        allowedTones: tones,
        customerContext: proposal.reasons.map((reason) => reason.text),
        writtenPolicy: { action: reference.action, tone: reference.tone, waitDays: reference.waitDays ?? null, reasoning: reference.reasoning },
        responseShape: { action: "send | wait", tone: tones.join(" | "), waitDays: "1 to 3, when waiting", reasoning: REASONING_SHAPE },
      }),
      schema: reminderSchema,
      fallback: () => reference,
    });
    value = decided.value;
    mode = decided.mode;
    agreedWithReference = decided.agreedWithReference;
  }
  const referenceDecision = { action: reference.action, tone: reference.tone, waitDays: reference.waitDays ?? null };
  const context = { policyVersion: policy.version, reasons: proposal.reasons.map((reason) => reason.code) };

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
        ...(partPaid ? { owed, partPaid } : {}),
        decision: { action: "wait", waitDays, reasoning: value.reasoning },
        referenceDecision,
        decisionMode: mode,
        agreedWithReference,
        context,
      },
    });
    return { sent: false, line: { domain: "ar", message: `${client.name}: waiting ${waitDays} d before a reminder` } };
  }

  const bounded = approved ? { tone: draft.tone, limited: false } : boundTone(value.tone, allowance.daysFromDue, sent.length, policy.maxTone);
  // Claimed before it is sent: two cycles at once never send the same reminder twice (R7).
  const claim = await orgDb
    .from("ar_reminders")
    .insert({ invoice_id: invoice.id, number: allowance.number, tone: bounded.tone, sent_at: new Date(now).toISOString() })
    .select("id")
    .single<{ id: string }>();
  if (claim.error?.code === "23505") return { sent: false, line: null };
  if (claim.error) throw new Error(claim.error.message);

  const email = receivableReminderEmail({
    orgName: input.orgName,
    clientName: client.name,
    amount,
    token: currency,
    what: invoiceWhat(invoice.memo, invoice.po_reference),
    dueOn,
    daysFromDue: allowance.daysFromDue,
    tone: bounded.tone,
    payUrl: payLinkUrl(input.token),
    origin: input.origin,
    network: workspaceNetwork().id,
    ...(partPaid ? { partPaid: { invoiced: AMOUNT.format(partPaid.invoiced), received: AMOUNT.format(partPaid.received) } } : {}),
  });
  // Sent once per recipient, reminder and rules' version, the opt-out read again first (I11).
  const result = await sendOnce(
    orgDb,
    { kind: "collection_reminder", subjectId: invoice.id, event: `reminder:${invoice.id}:${allowance.number}`, recipient: client.email, policyVersion: policy.version },
    { to: client.email, ...email, meter: "reminder" },
    input.send,
    () => stillWanted(orgDb, invoice, policy)
  );
  if (!result.sent) {
    // Sent by an earlier run under the same key: the claim stays, and nothing is sent again.
    if (result.reason === "sent_before") return { sent: false, line: { domain: "ar", message: `Reminder ${allowance.number} to ${client.name} went out already; not sent again` } };
    // Released, so the next cycle may try again.
    await orgDb.from("ar_reminders").delete().eq("id", claim.data.id);
    if (result.reason === "opted_out") return { sent: false, line: { domain: "ar", message: `Reminder to ${client.name} not sent: its reminders or its rules changed just before the send` } };
    if (result.reason === "in_flight") return { sent: false, line: null };
    console.error("receivable reminder not sent", invoice.id, result.detail);
    return { sent: false, line: { domain: "ar", message: `Reminder to ${client.name} not sent (${result.detail ?? "failed"}); tried again at the next cycle` } };
  }
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
      to: maskEmail(client.email),
      number: allowance.number,
      tone: bounded.tone,
      daysFromDue: allowance.daysFromDue,
      amount: owed,
      currency,
      ...(partPaid ? { partPaid } : {}),
      linkId: link.id,
      decision: { action: "send", tone: bounded.tone, reasoning },
      referenceDecision,
      decisionMode: mode,
      agreedWithReference,
      context,
      ...(approved ? { approvedTaskId: approved.id, approvedBy: approved.resolvedBy } : {}),
      ...(bounded.limited ? { toneLimited: { chosen: value.tone, sent: bounded.tone } } : {}),
    },
  });
  return { sent: true, line: { domain: "ar", message: `Reminded ${client.name} by email: ${amount} ${currency} due ${dueOn} (${bounded.tone})` } };
}
