import crypto from "node:crypto";
import { z } from "zod";
import { readAllocationRows, toReceivableIn } from "../allocations/book";
import { fromMicros, receivableBalance } from "../allocations/model";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { networkOf, type Network } from "../network";
import { payLinkToken, payLinkUrl } from "../platform/pay-links";
import { takePortalActionToken } from "../rate-limit";
import {
  buildStatement,
  CUSTOMER_PORTAL_ACTIONS,
  dayWords,
  money,
  readSubmission,
  RECENT_PAID_DAYS,
  RECENT_PAID_MAX,
  todayOf,
  type RequestKind,
  type StatementView,
  type SubmissionForm,
} from "./model";
import { readCustomerRequests } from "./requests";
import { customerPortalTokenHash } from "./token";

/**
 * What a customer's statement link reads and sends (docs/superpowers/specs/2026-10-13-customer-portal-design.md P3-P6).
 * No session and no wallet: the link is the credential, and it reaches one customer's own invoices and nothing else of
 * the workspace. A malformed link is never looked up; a well-formed one is looked up by the SHA-256 of its secret through
 * the service role's `customer_portal_by_token` (0109), which answers null for a stopped or unknown link and only the day
 * for an expired one. A live link's statement is then read inside that workspace's own scope, filtered to the link's
 * customer: its receivables, what is still owed on each, their pay links, and what the customer said. The workspace's
 * and the customer's ids go no further than this file.
 *
 * What the customer sends goes through `customer_portal_submit` and `customer_portal_reply`, which check the link, the
 * invoice's customer and a cap of 30 a day per link in one transaction; each is then a signed entry in the workspace's
 * ledger, best effort, with the SHA-256 of the customer's words rather than the words.
 */

const foundSchema = z.union([
  z.object({ expired: z.literal(true), expiresAt: z.string() }),
  z.object({
    expired: z.literal(false),
    linkId: z.string().uuid(),
    orgId: z.string().uuid(),
    counterpartyId: z.string().uuid(),
    createdBy: z.string().nullable(),
    expiresAt: z.string(),
    orgName: z.string(),
    customerName: z.string(),
    mode: z.string(),
    network: z.string().nullable(),
  }),
]);

type Found = z.infer<typeof foundSchema>;
type LiveLink = Extract<Found, { expired: false }>;

/** PostgREST's "no such function" (PGRST202) or Postgres's (42883): migration 0109 has not run here yet. */
const missingFunction = (error: { code?: string }) => error.code === "PGRST202" || error.code === "42883";

async function lookUp(tokenHash: string): Promise<Found | null> {
  const answer = await platformDb().rpc("customer_portal_by_token", { p_token_hash: tokenHash });
  if (answer.error) {
    if (missingFunction(answer.error)) return null;
    throw new Error(answer.error.message);
  }
  if (answer.data === null || answer.data === undefined) return null;
  return foundSchema.parse(answer.data);
}

export type StatementRead = { state: "dead" } | { state: "expired"; expiresAt: string } | { state: "live"; view: StatementView; network: Network; sandbox: boolean };

type InvoiceRow = {
  id: string;
  counterparty_id: string;
  amount: string | number;
  currency: string | null;
  due_date: string;
  memo: string | null;
  po_reference: string | null;
  status: string;
  settled_at: string | null;
  created_at: string | null;
};

const OPEN = new Set(["pending", "matched"]);
/** The most of one customer's open receivables a statement reads. */
const INVOICES_READ = 500;
const INVOICE_COLUMNS = "id, counterparty_id, amount, currency, due_date, memo, po_reference, status, settled_at, created_at";

/** The statement behind a link: dead, expired (with its day), or the customer's own invoices and requests. */
export async function readStatement(token: string, now: number = Date.now()): Promise<StatementRead> {
  const tokenHash = customerPortalTokenHash(token);
  if (!tokenHash) return { state: "dead" };
  const found = await lookUp(tokenHash);
  if (!found) return { state: "dead" };
  if (found.expired) return { state: "expired", expiresAt: found.expiresAt };
  const link: LiveLink = found;

  return withOrg(link.orgId, async () => {
    const since = new Date(now - RECENT_PAID_DAYS * 86_400_000).toISOString();
    // The open receivables, and apart the ones paid recently, so a long history never hides an open one.
    const [openRows, paidRows] = await Promise.all([
      db()
        .from("invoices")
        .select(INVOICE_COLUMNS)
        .eq("counterparty_id", link.counterpartyId)
        .eq("direction", "receivable")
        .in("status", [...OPEN])
        .order("due_date", { ascending: true })
        .limit(INVOICES_READ),
      db()
        .from("invoices")
        .select(INVOICE_COLUMNS)
        .eq("counterparty_id", link.counterpartyId)
        .eq("direction", "receivable")
        .in("status", ["received", "paid"])
        .gte("settled_at", since)
        .order("settled_at", { ascending: false })
        .limit(RECENT_PAID_MAX),
    ]);
    const invoices = [...new Map([...(unwrap(openRows) as InvoiceRow[]), ...(unwrap(paidRows) as InvoiceRow[])].map((row) => [row.id, row])).values()];
    const openIds = invoices.filter((invoice) => OPEN.has(invoice.status)).map((invoice) => invoice.id);
    const [allocations, links, requests] = await Promise.all([
      openIds.length > 0 ? readAllocationRows(db(), { invoiceIds: openIds }) : Promise.resolve([]),
      openIds.length > 0 ? db().from("receivable_links").select("invoice_id, token_enc").in("invoice_id", openIds).is("revoked_at", null) : Promise.resolve({ data: [], error: null }),
      readCustomerRequests(db(), { counterpartyId: link.counterpartyId, closedSince: since }),
    ]);

    const owed = new Map<string, { outstanding: number; received: number }>();
    for (const invoice of invoices.filter((row) => OPEN.has(row.status))) {
      if (!allocations || !allocations.some((row) => row.invoiceId === invoice.id)) continue;
      const balance = receivableBalance(toReceivableIn({ ...invoice, created_at: invoice.created_at }), allocations, false);
      if (balance.applied > 0) owed.set(invoice.id, { outstanding: fromMicros(balance.outstanding), received: fromMicros(balance.paid) });
    }
    const payLinks = new Map<string, string>();
    if (links.error) console.error("statement: pay links not read", links.error.message);
    for (const row of (links.data ?? []) as Array<{ invoice_id: string; token_enc: unknown }>) {
      const payToken = row.token_enc ? payLinkToken(link.orgId, row.token_enc) : null;
      if (payToken) payLinks.set(row.invoice_id, payLinkUrl(payToken));
    }

    const view = buildStatement({
      orgName: link.orgName,
      customerName: link.customerName,
      expiresAt: link.expiresAt,
      now,
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        amount: Number(invoice.amount),
        currency: invoice.currency ?? "USDC",
        dueDate: invoice.due_date,
        memo: invoice.memo,
        poReference: invoice.po_reference,
        status: invoice.status,
        settledAt: invoice.settled_at,
      })),
      owed,
      payLinks,
      // Who at the business replied never reaches the page: a reply is the business's.
      requests: requests.available ? requests.requests.map((request) => ({ ...request, messages: request.messages.map((message) => ({ ...message, by: null })) })) : [],
    });
    return { state: "live" as const, view, network: networkOf(link.network), sandbox: link.mode !== "live" };
  });
}

export type PortalField = "form" | "paidOn" | "reference" | "amount" | "promisedOn" | "message";
export type PortalAnswer = { ok: true; message: string } | { ok: false; field: PortalField; message: string };

export const PORTAL_MESSAGES = {
  dead: "This link no longer works. Ask the business that sent it for a new one.",
  expired: "This link has expired. Ask the business that sent it for a new one.",
  busy: "You sent several just now. Wait a few seconds, then try again.",
  limit: "This link has sent all it can for today. Try again tomorrow, or contact the business directly.",
  invoice: "That invoice is not on this statement.",
  closed: "This invoice is no longer open. Reload the page to see it as it is now.",
  requestClosed: "This was closed already. Reload the page to see it as it is now.",
  check: "Check what you entered, then try again.",
  failed: "That did not work. Try again in a moment.",
} as const;

const refuse = (message: string, field: PortalField = "form"): PortalAnswer => ({ ok: false, field, message });

/** A refusal of 0109's functions, in the customer's words. */
function refusalOf(message: string): PortalAnswer | null {
  if (/customer_portal_link_dead/.test(message)) return refuse(PORTAL_MESSAGES.dead);
  if (/customer_portal_limit/.test(message)) return refuse(PORTAL_MESSAGES.limit);
  if (/customer_portal_invoice_not_found|customer_portal_request_not_found/.test(message)) return refuse(PORTAL_MESSAGES.invoice);
  if (/customer_portal_invoice_closed/.test(message)) return refuse(PORTAL_MESSAGES.closed);
  if (/customer_request_closed/.test(message)) return refuse(PORTAL_MESSAGES.requestClosed);
  if (/customer_portal_invalid/.test(message)) return refuse(PORTAL_MESSAGES.check);
  return null;
}

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** The live link behind a token, or the customer's words for why there is none. */
async function liveLink(token: string, now: number): Promise<{ ok: true; link: LiveLink; tokenHash: string } | { ok: false; answer: PortalAnswer }> {
  const tokenHash = customerPortalTokenHash(token);
  if (!tokenHash) return { ok: false, answer: refuse(PORTAL_MESSAGES.dead) };
  if (!takePortalActionToken(tokenHash, now)) return { ok: false, answer: refuse(PORTAL_MESSAGES.busy) };
  const found = await lookUp(tokenHash);
  if (!found) return { ok: false, answer: refuse(PORTAL_MESSAGES.dead) };
  if (found.expired) return { ok: false, answer: refuse(PORTAL_MESSAGES.expired) };
  return { ok: true, link: found, tokenHash };
}

const submitted = z.object({
  requestId: z.string().uuid(),
  appended: z.boolean(),
  superseded: z.array(z.string()),
  orgId: z.string().uuid(),
  linkId: z.string().uuid(),
  counterpartyId: z.string().uuid(),
  invoiceId: z.string().uuid(),
});

const THANKS: Record<RequestKind, (org: string, day: string | null) => string> = {
  paid: (org) => `Thanks. ${org} will check for your payment. The invoice stays open until they find it.`,
  promise: (org, day) => `Thanks. ${org} knows you will pay by ${day}, and reminders about this invoice wait until then.`,
  dispute: (org) => `Sent. ${org} will reply here, and reminders about this invoice wait until they resolve it.`,
  pay_link: (org) => `Sent. ${org} will add a pay link here.`,
};

/** The invoice's amount and the customer's name, for the entry's summary; null when they cannot be read. */
async function invoiceFacts(invoiceId: string): Promise<{ amount: number; currency: string } | null> {
  const row = (unwrap(await db().from("invoices").select("amount, currency").eq("id", invoiceId).limit(1)) as Array<{ amount: string | number; currency: string | null }>)[0];
  return row ? { amount: Number(row.amount), currency: row.currency ?? "USDC" } : null;
}

/**
 * The customer tells the business something about one of its open invoices (P4): it paid, it will pay by a day, it
 * disputes it, or it needs a pay link. Nothing is settled by it.
 */
export async function submitCustomerRequest(token: string, form: SubmissionForm, now: number = Date.now()): Promise<PortalAnswer> {
  const live = await liveLink(token, now);
  if (!live.ok) return live.answer;
  const read = readSubmission(form, todayOf(now));
  if (!read.ok) return refuse(read.message, read.field);
  const { submission } = read;
  const { link } = live;

  const answer = await platformDb().rpc("customer_portal_submit", {
    p_token_hash: live.tokenHash,
    p_invoice_id: submission.invoiceId,
    p_kind: submission.kind,
    p_paid_on: submission.paidOn,
    p_reference: submission.reference,
    p_amount: submission.amount,
    p_promised_on: submission.promisedOn,
    p_message: submission.message,
  });
  if (answer.error) {
    if (missingFunction(answer.error)) return refuse(PORTAL_MESSAGES.dead);
    const refusal = refusalOf(answer.error.message ?? "");
    if (refusal) return refusal;
    throw new Error(answer.error.message);
  }
  const done = submitted.parse(answer.data);

  // Signed in the workspace's ledger, best effort: what the customer said is recorded already.
  try {
    await withOrg(done.orgId, async () => {
      const facts = await invoiceFacts(done.invoiceId);
      const of = facts ? ` of ${money(facts.amount, facts.currency)}` : "";
      const customer = link.customerName;
      const words = [submission.reference, submission.message].filter((text): text is string => Boolean(text));
      const detail = {
        via: "customer_portal",
        linkId: done.linkId,
        requestId: done.requestId,
        invoiceId: done.invoiceId,
        counterpartyId: done.counterpartyId,
        kind: submission.kind,
        ...(submission.paidOn ? { paidOn: submission.paidOn } : {}),
        ...(submission.amount !== null ? { amount: submission.amount, currency: facts?.currency ?? null } : {}),
        ...(submission.promisedOn ? { promisedOn: submission.promisedOn } : {}),
        ...(done.superseded.length > 0 ? { superseded: done.superseded } : {}),
        ...(words.length > 0 ? { textSha256: sha256hex(words.join("\n")) } : {}),
      };
      const summary = done.appended
        ? `${customer} wrote more on its ${submission.kind === "dispute" ? "dispute" : "request for a pay link"} of an invoice${of}`
        : submission.kind === "paid"
          ? `${customer} says it paid an invoice${of} on ${dayWords(submission.paidOn as string)}: its word, not a payment received`
          : submission.kind === "promise"
            ? `${customer} promised to pay an invoice${of} by ${dayWords(submission.promisedOn as string)}; its reminders wait until then`
            : submission.kind === "dispute"
              ? `${customer} disputed an invoice${of}; its reminders wait until the dispute is resolved`
              : `${customer} asked for a pay link for an invoice${of}`;
      await appendLedgerEntryBestEffort(done.orgId, {
        actor: "human",
        domain: "ar",
        action: done.appended ? CUSTOMER_PORTAL_ACTIONS.customerWrote : CUSTOMER_PORTAL_ACTIONS.said[submission.kind],
        summary,
        detail,
      });
    });
  } catch (error) {
    console.error("statement request not signed", error instanceof Error ? error.name : "unknown");
  }

  if (done.appended) return { ok: true, message: `Added. ${link.orgName} will reply here.` };
  return { ok: true, message: THANKS[submission.kind](link.orgName, submission.promisedOn ? dayWords(submission.promisedOn) : null) };
}

const replied = z.object({
  messageId: z.string().uuid(),
  requestId: z.string().uuid(),
  kind: z.enum(["paid", "promise", "dispute", "pay_link"]),
  orgId: z.string().uuid(),
  linkId: z.string().uuid(),
  counterpartyId: z.string().uuid(),
  invoiceId: z.string().uuid(),
});

/** The customer writes more under one of its own open requests (P5). */
export async function replyAsCustomer(token: string, form: { requestId?: string; message?: string }, now: number = Date.now()): Promise<PortalAnswer> {
  const live = await liveLink(token, now);
  if (!live.ok) return live.answer;
  const requestId = (form.requestId ?? "").trim();
  if (!z.string().uuid().safeParse(requestId).success) return refuse(PORTAL_MESSAGES.invoice);
  const message = (form.message ?? "").trim();
  if (!message) return refuse("Write your message first.", "message");
  if (message.length > 2000) return refuse("Keep your message under 2,000 characters.", "message");

  const answer = await platformDb().rpc("customer_portal_reply", { p_token_hash: live.tokenHash, p_request_id: requestId, p_message: message });
  if (answer.error) {
    if (missingFunction(answer.error)) return refuse(PORTAL_MESSAGES.dead);
    const refusal = refusalOf(answer.error.message ?? "");
    if (refusal) return refusal;
    throw new Error(answer.error.message);
  }
  const done = replied.parse(answer.data);
  // Signed in the workspace's ledger, best effort, with no member behind it: the link is the credential.
  try {
    await withOrg(done.orgId, () =>
      appendLedgerEntryBestEffort(done.orgId, {
        actor: "human",
        domain: "ar",
        action: CUSTOMER_PORTAL_ACTIONS.customerWrote,
        summary: `${live.link.customerName} wrote on its statement`,
        detail: {
          via: "customer_portal",
          linkId: done.linkId,
          requestId: done.requestId,
          messageId: done.messageId,
          invoiceId: done.invoiceId,
          counterpartyId: done.counterpartyId,
          kind: done.kind,
          textSha256: sha256hex(message),
        },
      })
    );
  } catch (error) {
    console.error("statement message not signed", error instanceof Error ? error.name : "unknown");
  }
  return { ok: true, message: `Sent. ${live.link.orgName} will reply here.` };
}
