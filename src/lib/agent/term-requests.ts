import crypto from "node:crypto";
import { z } from "zod";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { utcDay } from "../copy";
import { platformDb, unwrap, type OrgDb } from "../dal";
import { termRequestEmail, termRequestWithdrawnEmail } from "../email/term-request";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import { heldForCash } from "../next-step";
import { maskEmail } from "../payment-notices";
import { listMembers } from "../platform/members";
import { REASONING_RULE, REASONING_SHAPE } from "../reasoning-copy";
import { createTermRequest, TermRequestError, withdrawTermRequest } from "../terms/requests";
import {
  boundTermDays,
  referenceTermDays,
  TERM_REQUESTS_PER_RUN,
  TERM_SKIP_RETRY_DAYS,
  TERM_UNSENT_LEASE_MS,
  termRequestAllowed,
  type TermDecision,
} from "../terms/rules";
import { decide } from "./decide";
import type { CycleLogLine } from "./orchestrator";
import { agentPaused } from "./pause";

/**
 * The cycle's term requests stage (docs/superpowers/specs/2026-10-17-term-requests-design.md): once an owner or admin
 * turned it on (X1), for each bill held for want of cash where code allows a request now (X2), the model decides whether
 * to ask the supplier for more time, and how many days, up to the workspace's most (X3). A request's review is claimed
 * before it is made, and its link is emailed once under its own idempotency key; one not emailed is withdrawn (X6). Every
 * decision is signed. A request only ever moves a due date later, for the same amount (X7).
 *
 * A request out that is no longer needed, because the bill is being paid or is no longer held for want of cash, is
 * withdrawn and the supplier told so, even after the requests are turned off
 * (docs/superpowers/specs/2026-10-17-term-requests-follow-up-design.md F1, F2).
 *
 * In a sandbox, the requests go to the member who turned them on, who answers as the supplier. Never while the agent is
 * paused, or without email; before migration 0128 runs, nothing.
 */

const DAY_MS = 86_400_000;
const HORIZON_DAYS = 30;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

const SYSTEM_PROMPT = `You are the payment-terms step of a treasury agent for a small business. A bill is held because the operating wallet cannot pay it on time, and the business turned on requests for more time: the agent may ask the supplier, by email, to accept the same amount on a later day. Code allows a request on this bill now. Decide whether to ask, and for how many days.

- Ask for enough days that the money customers owe, or what comes in, covers the bill after what else falls due; asking for more than that strains the supplier for nothing.
- Ask for at least the fewest days and no more than the most you are given.
- Skip when asking would not help, for example when no money is expected in time even with the most days, or when what you know of the supplier says the request would not be welcome; the bill then waits for a person.
- The written policy's answer is given as a reference. Follow it unless the facts say otherwise, and say why when you depart from it.
- ${REASONING_RULE}

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const termSchema = z.object({
  action: z.enum(["ask", "skip"]),
  days: z.coerce.number().optional(),
  reasoning: z.string().min(1).max(2000),
});

interface HeldRow {
  id: string;
  counterparty_id: string;
  amount: string;
  currency: string | null;
  due_date: string;
  memo: string | null;
  counterparties: { name: string; notice_email: string | null } | null;
}

interface RequestRow {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  status: string;
  days: number;
  due_date: string;
  decided_at: string | null;
  expires_at: string;
}

interface BillRow {
  id: string;
  status: string;
  amount: string;
  currency: string | null;
  due_date: string;
  memo: string | null;
  counterparties: { name: string; notice_email: string | null } | null;
}

interface ReviewRow {
  id: string;
  invoice_id: string;
  action: "ask" | "skip";
  request_id: string | null;
  decided_at: string;
  emailed_at: string | null;
}

const startOfDay = (time: number) => {
  const d = new Date(time);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const daysFrom = (now: number, iso: string) => Math.round((startOfDay(Date.parse(iso)) - startOfDay(now)) / DAY_MS);

/** The stage: see the module comment. `operatingBalance` is the operating USDC left after this cycle's payments. */
export async function makeTermRequests(
  orgDb: OrgDb,
  input: { operatingBalance: number },
  options: { now?: number; send?: (message: EmailMessage) => Promise<SendResult>; origin?: string } = {}
): Promise<CycleLogLine[]> {
  const orgId = currentOrgId();
  const org = await platformDb()
    .from("orgs")
    .select("name, mode, term_requests_on_at, term_requests_on_by, term_requests_max_days")
    .eq("id", orgId)
    .single<{ name: string; mode: string; term_requests_on_at: string | null; term_requests_on_by: string | null; term_requests_max_days: number | null }>();
  // Before migration 0128 the columns are not there: nothing to do.
  if (org.error || !org.data) return [];
  const { name: orgName, mode, term_requests_on_at: onAt } = org.data;
  const maxDays = Number(org.data.term_requests_max_days);
  if (mode !== "live" && mode !== "sandbox") return [];
  // Off, no new request is made; the ones already out are still followed up (F2).
  const on = onAt !== null && Number.isFinite(maxDays) && maxDays > 0;
  if (await agentPaused()) return [];
  const ready = await orgDb.rpc("term_requests_ready");
  if (ready.error) return [];
  const settings = options.send ? null : emailSettingsFromEnv();
  const send = options.send ?? (settings ? (message: EmailMessage) => sendEmail({ ...message, meter: "term_request" }, settings) : null);
  if (!send) return [];
  // A sandbox's suppliers are sample data: its requests go to the member who turned them on (X1).
  const sandbox = mode === "sandbox";
  const sandboxTo = sandbox ? await memberEmail(orgId, org.data.term_requests_on_by) : null;
  if (sandbox && !sandboxTo) return [];
  const now = options.now ?? Date.now();
  const origin = options.origin ?? siteOrigin();
  const lines: CycleLogLine[] = [];

  // Reviews: a request left unsent by a stopped run is withdrawn and its bill weighed again; a skip, after a week.
  const reviews = unwrap(await orgDb.from("payment_term_request_reviews").select("id, invoice_id, action, request_id, decided_at, emailed_at").limit(2000)) as ReviewRow[];
  const reviewed = new Set<string>();
  for (const review of reviews) {
    const age = now - Date.parse(review.decided_at);
    if (review.action === "ask" && !review.emailed_at && age > TERM_UNSENT_LEASE_MS) {
      if (review.request_id && (await withdrawTermRequest(orgId, review.request_id))) {
        await appendLedgerEntry({
          actor: "agent",
          domain: "ap",
          action: "term_request_withdrawn",
          summary: "Request for more time withdrawn: its email never went",
          detail: { requestId: review.request_id, invoiceId: review.invoice_id, via: "agent", reason: "not_emailed" },
        });
      }
      await orgDb.from("payment_term_request_reviews").delete().eq("id", review.id);
      continue;
    }
    if (review.action === "skip" && age > TERM_SKIP_RETRY_DAYS * DAY_MS) {
      await orgDb.from("payment_term_request_reviews").delete().eq("id", review.id);
      continue;
    }
    reviewed.add(review.invoice_id);
  }

  const requests = unwrap(
    await orgDb.from("payment_term_requests").select("id, invoice_id, counterparty_id, status, days, due_date, decided_at, expires_at").order("created_at", { ascending: false }).limit(1000)
  ) as RequestRow[];

  // Requests no longer needed (F1): one out whose bill is being paid, or is no longer held for want of cash, is withdrawn
  // and its supplier told, so no one agrees to a later date the business does not need. One still being emailed is left.
  const inFlight = new Set(reviews.filter((review) => review.action === "ask" && !review.emailed_at).map((review) => review.request_id));
  const out = requests.filter((row) => row.status === "open" && Date.parse(row.expires_at) > now && !inFlight.has(row.id));
  if (out.length > 0) {
    const ids = [...new Set(out.map((row) => row.invoice_id))];
    const [billsRead, startedRead, latestOut] = await Promise.all([
      orgDb.from("invoices").select("id, status, amount, currency, due_date, memo, counterparties(name, notice_email)").in("id", ids),
      orgDb.from("payment_intents").select("source_id").eq("source_type", "invoice").in("source_id", ids),
      latestDecisions(orgDb, ids),
    ]);
    const bills = new Map((unwrap(billsRead) as unknown as BillRow[]).map((row) => [row.id, row] as const));
    const started = new Set((unwrap(startedRead) as Array<{ source_id: string }>).map((row) => row.source_id));
    for (const request of out) {
      const bill = bills.get(request.invoice_id);
      if (!bill) continue;
      const paying = bill.status === "paid" || started.has(bill.id);
      if (!paying && bill.status === "held" && heldForCash(latestOut.get(bill.id))) continue;
      if (!(await withdrawTermRequest(orgId, request.id))) continue;
      request.status = "withdrawn";
      const reason = paying ? "paid" : "not_needed";
      const supplierName = bill.counterparties?.name ?? "the supplier";
      const email = sandbox ? sandboxTo : (bill.counterparties?.notice_email ?? null);
      let told = false;
      if (email) {
        const message = termRequestWithdrawnEmail({
          orgName,
          supplierName,
          reference: bill.memo,
          amount: AMOUNT.format(Number(bill.amount)),
          token: bill.currency ?? "USDC",
          days: request.days,
          dueOn: utcDay(bill.due_date),
          paying,
          origin,
          sandbox,
        });
        const idempotencyKey = crypto.createHash("sha256").update(`term_request_withdrawn\n${request.id}`, "utf8").digest("hex");
        const result = await send({ to: email, ...message, idempotencyKey });
        told = result.sent;
        if (!result.sent) console.error("term request withdrawal email not sent", request.id, result.reason);
      }
      await appendLedgerEntry({
        actor: "agent",
        domain: "ap",
        action: "term_request_withdrawn",
        summary: paying ? `Request for more time to ${supplierName} withdrawn: the bill is being paid on time` : `Request for more time to ${supplierName} withdrawn: the bill is no longer held for want of cash`,
        detail: { requestId: request.id, invoiceId: bill.id, counterpartyId: request.counterparty_id, via: "agent", reason, days: request.days, supplierTold: told, ...(email ? { to: maskEmail(email) } : {}) },
      });
      lines.push({ domain: "ap", message: `Withdrew the request for more time to ${supplierName}: ${paying ? "the bill is being paid on time" : "it is no longer needed"}${told ? ", and told them" : ""}` });
    }
  }
  if (!on) return lines;

  const held = unwrap(
    await orgDb
      .from("invoices")
      .select("id, counterparty_id, amount, currency, due_date, memo, counterparties(name, notice_email)")
      .eq("direction", "payable")
      .eq("status", "held")
      .order("due_date", { ascending: true })
      .limit(200)
  ) as unknown as HeldRow[];
  if (held.length === 0) return lines;

  // Each held bill's latest decision: only one held for want of cash may be asked about (X2).
  const latest = await latestDecisions(orgDb, held.map((row) => row.id));

  // A bill asked about before is not asked again, but a request withdrawn before its email went was never seen (X6): the
  // ones the agent signed as sent are the ones the supplier got.
  const withdrawnIds = requests.filter((row) => row.status === "withdrawn").map((row) => row.id);
  const sentRead = withdrawnIds.length > 0 ? await orgDb.from("ledger_entries").select("detail").eq("action", "term_request_sent").in("detail->>requestId", withdrawnIds) : null;
  const sent = new Set(
    ((sentRead && !sentRead.error ? sentRead.data : []) as Array<{ detail: Record<string, unknown> | null }>)
      .map((entry) => (typeof entry.detail?.requestId === "string" ? entry.detail.requestId : null))
      .filter((id): id is string => id !== null)
  );
  const askedBills = new Set(requests.filter((row) => row.status !== "withdrawn" || sent.has(row.id)).map((row) => row.invoice_id));
  const supplier = (id: string) => {
    const mine = requests.filter((row) => row.counterparty_id === id);
    const declined = mine.filter((row) => row.status === "declined" && row.decided_at).map((row) => row.decided_at as string).sort();
    return {
      made: mine.length,
      accepted: mine.filter((row) => row.status === "accepted").length,
      declined: declined.length,
      lastDeclinedAt: declined.at(-1) ?? null,
      hasOpen: mine.some((row) => row.status === "open" && Date.parse(row.expires_at) > now),
    };
  };

  // The cash picture the model weighs (X3): what falls due in the next 30 days, and what customers owe, by day.
  const horizon = new Date(startOfDay(now) + (HORIZON_DAYS + maxDays) * DAY_MS).toISOString();
  const [dueRows, owedRows] = await Promise.all([
    orgDb.from("invoices").select("id, amount, due_date").eq("direction", "payable").in("status", ["pending", "scheduled", "held"]).lte("due_date", horizon).limit(500),
    orgDb.from("invoices").select("amount, due_date").eq("direction", "receivable").in("status", ["pending", "matched"]).lte("due_date", horizon).limit(500),
  ]);
  const due = unwrap(dueRows) as Array<{ id: string; amount: string; due_date: string }>;
  const owed = unwrap(owedRows) as Array<{ amount: string; due_date: string }>;

  let made = 0;
  for (const row of held) {
    if (made >= TERM_REQUESTS_PER_RUN) break;
    const amount = Number(row.amount);
    const daysToDue = daysFrom(now, row.due_date);
    const email = sandbox ? sandboxTo : (row.counterparties?.notice_email ?? null);
    const history = supplier(row.counterparty_id);
    const allowance = termRequestAllowed({
      heldForCash: heldForCash(latest.get(row.id)),
      daysToDue,
      askedBefore: askedBills.has(row.id),
      reviewed: reviewed.has(row.id),
      noticeEmail: email,
      supplierHasOpenRequest: history.hasOpen,
      supplierDeclinedAt: history.lastDeclinedAt,
      now,
    });
    if (!allowance.allowed) continue;
    const supplierName = row.counterparties?.name ?? "the supplier";
    // What else falls due on or before this bill's day comes first; what customers owe after it is what may cover it.
    const dueBefore = due.filter((bill) => bill.id !== row.id && Date.parse(bill.due_date) <= Date.parse(row.due_date)).reduce((sum, bill) => sum + Number(bill.amount), 0);
    const cashNow = Number((input.operatingBalance - dueBefore).toFixed(6));
    const incoming = owed.map((item) => ({ daysAfterDue: daysFrom(Date.parse(row.due_date), item.due_date), amount: Number(item.amount) }));
    const referenceDays = referenceTermDays({ amount, cashNow, incoming, maxDays });
    const newDueOn = (days: number) => utcDay(new Date(Date.parse(row.due_date) + days * DAY_MS).toISOString());
    const reference: TermDecision = {
      action: "ask",
      days: referenceDays,
      reasoning: `The wallet cannot pay ${AMOUNT.format(amount)} ${row.currency ?? "USDC"} on ${utcDay(row.due_date)}; ${referenceDays} more days, to ${newDueOn(referenceDays)}, ${referenceDays < maxDays ? "is when what customers owe covers it" : "is the most the business asks"}.`,
    };
    const decided = await decide<TermDecision>({
      purpose: "term_request",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to ask this supplier for more time on the held bill, and for how many days.",
        bill: { amount, currency: row.currency ?? "USDC", dueDate: utcDay(row.due_date), daysToDue, reference: row.memo },
        supplier: { name: supplierName, requestsBefore: { made: history.made, accepted: history.accepted, declined: history.declined } },
        cash: {
          operatingAfterTodaysPayments: input.operatingBalance,
          dueOnOrBeforeThisBill: Number(dueBefore.toFixed(6)),
          customersOweByDaysAfterDue: incoming.filter((item) => item.daysAfterDue <= maxDays).sort((a, b) => a.daysAfterDue - b.daysAfterDue),
        },
        days: { fewest: 3, most: maxDays },
        writtenPolicy: reference,
        responseShape: { action: "ask | skip", days: `3 to ${maxDays}, when asking`, reasoning: REASONING_SHAPE },
      }),
      schema: termSchema,
      fallback: () => reference,
    });
    const value = decided.value;
    const referenceDecision = { action: reference.action, days: reference.days ?? null };

    if (value.action === "skip") {
      const claim = await orgDb.from("payment_term_request_reviews").insert({ invoice_id: row.id, action: "skip", decided_at: new Date(now).toISOString() }).select("id").single<{ id: string }>();
      if (claim.error?.code === "23505") continue;
      if (claim.error) throw new Error(claim.error.message);
      await appendLedgerEntry({
        actor: "agent",
        domain: "ap",
        action: "term_request_skipped",
        summary: `Decided not to ask ${supplierName} for more time on ${AMOUNT.format(amount)} USDC due ${utcDay(row.due_date)}`,
        detail: { invoiceId: row.id, counterpartyId: row.counterparty_id, decision: { action: "skip", reasoning: value.reasoning }, referenceDecision, decisionMode: decided.mode, agreedWithReference: decided.agreedWithReference },
      });
      lines.push({ domain: "ap", message: `${supplierName}: no request for more time, weighed again in ${TERM_SKIP_RETRY_DAYS} days` });
      continue;
    }

    const bounded = boundTermDays(value.days, maxDays, referenceDays);
    // Claimed before the request is made: two runs at once never ask about the same bill twice (X6).
    const claim = await orgDb.from("payment_term_request_reviews").insert({ invoice_id: row.id, action: "ask", days: bounded.days, decided_at: new Date(now).toISOString() }).select("id").single<{ id: string }>();
    if (claim.error?.code === "23505") continue;
    if (claim.error) throw new Error(claim.error.message);
    const release = () => orgDb.from("payment_term_request_reviews").delete().eq("id", claim.data.id);

    let request: Awaited<ReturnType<typeof createTermRequest>>;
    try {
      request = await createTermRequest({ orgId, invoiceId: row.id, days: bounded.days, origin, now });
    } catch (error) {
      await release();
      if (error instanceof TermRequestError) continue;
      throw error;
    }
    const linked = await orgDb.from("payment_term_request_reviews").update({ request_id: request.row.id }).eq("id", claim.data.id);
    if (linked.error) console.error("term request review not linked", row.id, linked.error.message);

    const message = termRequestEmail({
      orgName,
      supplierName,
      reference: row.memo,
      amount: AMOUNT.format(amount),
      token: request.row.currency,
      days: bounded.days,
      dueOn: utcDay(request.row.due_date),
      newDueOn: utcDay(request.row.new_due_date),
      until: utcDay(request.row.expires_at),
      url: request.url,
      origin,
      sandbox,
    });
    const idempotencyKey = crypto.createHash("sha256").update(`term_request\n${request.row.id}`, "utf8").digest("hex");
    const result = await send({ to: email as string, ...message, idempotencyKey });
    if (!result.sent) {
      // Never a link the supplier did not get: withdrawn, and the bill weighed again at the next cycle (X6).
      await withdrawTermRequest(orgId, request.row.id);
      await release();
      console.error("term request email not sent", row.id, result.reason);
      lines.push({ domain: "ap", message: `Request for more time to ${supplierName} not sent (${result.reason}); tried again at the next cycle` });
      continue;
    }
    const emailed = await orgDb.from("payment_term_request_reviews").update({ emailed_at: new Date().toISOString() }).eq("id", claim.data.id);
    if (emailed.error) console.error("term request review not marked emailed", row.id, emailed.error.message);
    made += 1;
    const reasoning = bounded.limited ? `${value.reasoning} [The model asked for ${value.days} days; code allows 3 to ${maxDays}, so the request asks for ${bounded.days}.]` : value.reasoning;
    await appendLedgerEntry({
      actor: "agent",
      domain: "ap",
      action: "term_request_sent",
      summary: `Asked ${supplierName} for ${bounded.days} more days on ${AMOUNT.format(amount)} ${request.row.currency}: due ${utcDay(request.row.new_due_date)} instead of ${utcDay(request.row.due_date)}`,
      detail: {
        via: "agent",
        requestId: request.row.id,
        invoiceId: row.id,
        counterpartyId: row.counterparty_id,
        to: maskEmail(email as string),
        days: bounded.days,
        amount,
        currency: request.row.currency,
        dueDate: request.row.due_date,
        newDueDate: request.row.new_due_date,
        expiresAt: request.row.expires_at,
        decision: { action: "ask", days: bounded.days, reasoning },
        referenceDecision,
        decisionMode: decided.mode,
        agreedWithReference: decided.agreedWithReference,
        ...(bounded.limited ? { daysLimited: { chosen: value.days, sent: bounded.days } } : {}),
        ...(sandbox ? { sandbox: true } : {}),
      },
    });
    lines.push({ domain: "ap", message: `Asked ${supplierName} by email for ${bounded.days} more days, to ${utcDay(request.row.new_due_date)}` });
  }
  return lines;
}

/** Each bill's latest AP decision, by bill: what it was held for (X2, F1). */
async function latestDecisions(orgDb: OrgDb, invoiceIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const latest = new Map<string, Record<string, unknown>>();
  if (invoiceIds.length === 0) return latest;
  const decisions = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("seq, detail")
      .in("action", ["ap_pay", "ap_hold"])
      .in("detail->>invoiceId", invoiceIds)
      .order("seq", { ascending: false })
      .limit(1000)
  ) as Array<{ seq: number; detail: Record<string, unknown> }>;
  for (const entry of decisions) {
    const id = typeof entry.detail.invoiceId === "string" ? entry.detail.invoiceId : null;
    if (id && !latest.has(id)) latest.set(id, entry.detail);
  }
  return latest;
}

/** A sandbox's recipient: the member who turned the requests on; null once they left or the members cannot be read. */
async function memberEmail(orgId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    return (await listMembers(orgId)).find((member) => member.userId === userId)?.email ?? null;
  } catch {
    return null;
  }
}
