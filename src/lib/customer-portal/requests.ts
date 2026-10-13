import crypto from "node:crypto";
import { currentOrgId } from "../context";
import { db, type OrgDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { portalTableMissing } from "./links";
import { CUSTOMER_PORTAL_ACTIONS, MESSAGE_MAX, reminderPause, type CloseOutcome, type CustomerRequest, type ReminderPause, type RequestKind, type RequestMessage, type RequestOutcome } from "./model";

/**
 * What customers said through their statement links, read and answered in the workspace in scope
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P7, P8): the requests and their threads, a reply, a close,
 * and the pauses a promise or a dispute puts on the agent's reminders. Before migration 0109 runs, reads answer
 * `available: false` (or no pause) and writes refuse with `not_ready`.
 */

export const REQUEST_COLUMNS = "id, kind, invoice_id, counterparty_id, link_id, paid_on, reference, amount, promised_on, status, outcome, created_at, closed_at";
const MESSAGE_COLUMNS = "id, request_id, author, body, by, created_at";
/** The most requests one read takes: open ones are few, and closed ones are kept short. */
export const REQUESTS_READ = 500;

type RequestRow = {
  id: string;
  kind: RequestKind;
  invoice_id: string;
  counterparty_id: string;
  link_id: string;
  paid_on: string | null;
  reference: string | null;
  amount: string | number | null;
  promised_on: string | null;
  status: "open" | "closed";
  outcome: RequestOutcome | null;
  created_at: string;
  closed_at: string | null;
};

type MessageRow = { id: string; request_id: string; author: "customer" | "business"; body: string; by: string | null; created_at: string };

export function toCustomerRequest(row: RequestRow, messages: RequestMessage[] = []): CustomerRequest {
  return {
    id: row.id,
    kind: row.kind,
    invoiceId: row.invoice_id,
    counterpartyId: row.counterparty_id,
    linkId: row.link_id,
    paidOn: row.paid_on,
    reference: row.reference,
    amount: row.amount === null ? null : Number(row.amount),
    promisedOn: row.promised_on,
    status: row.status,
    outcome: row.outcome,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    messages,
  };
}

export interface RequestFilter {
  counterpartyId?: string;
  invoiceIds?: readonly string[];
  /** Open requests, and those closed since this instant; every request when absent. */
  closedSince?: string;
  /** Open requests only. */
  openOnly?: boolean;
}

/** The requests that match, with their threads, newest first. `available: false` before migration 0109. */
export async function readCustomerRequests(orgDb: OrgDb, filter: RequestFilter = {}): Promise<{ available: false } | { available: true; requests: CustomerRequest[] }> {
  if (filter.invoiceIds && filter.invoiceIds.length === 0) return { available: true, requests: [] };
  let query = orgDb.from("customer_requests").select(REQUEST_COLUMNS).order("created_at", { ascending: false }).limit(REQUESTS_READ);
  if (filter.counterpartyId) query = query.eq("counterparty_id", filter.counterpartyId);
  if (filter.invoiceIds) query = query.in("invoice_id", [...filter.invoiceIds]);
  if (filter.openOnly) query = query.eq("status", "open");
  else if (filter.closedSince) query = query.or(`status.eq.open,closed_at.gte.${filter.closedSince}`);
  const read = await query;
  if (read.error) {
    if (portalTableMissing(read.error)) return { available: false };
    throw new Error(read.error.message);
  }
  const rows = (read.data ?? []) as RequestRow[];
  if (rows.length === 0) return { available: true, requests: [] };
  const threads = await orgDb
    .from("customer_request_messages")
    .select(MESSAGE_COLUMNS)
    .in(
      "request_id",
      rows.map((row) => row.id)
    )
    .order("created_at", { ascending: true });
  if (threads.error) throw new Error(threads.error.message);
  const byRequest = new Map<string, RequestMessage[]>();
  for (const row of (threads.data ?? []) as MessageRow[]) {
    byRequest.set(row.request_id, [...(byRequest.get(row.request_id) ?? []), { id: row.id, author: row.author, body: row.body, createdAt: row.created_at, by: row.by }]);
  }
  return { available: true, requests: rows.map((row) => toCustomerRequest(row, byRequest.get(row.id) ?? [])) };
}

/**
 * Whether each of these invoices' reminders wait on its customer (P7): an open dispute, or an open promise through its
 * day. Before migration 0109 runs, none do.
 */
export async function readReminderPauses(orgDb: OrgDb, invoiceIds: readonly string[], today: string): Promise<Map<string, ReminderPause>> {
  const pauses = new Map<string, ReminderPause>();
  if (invoiceIds.length === 0) return pauses;
  const read = await orgDb.from("customer_requests").select("invoice_id, kind, status, promised_on").in("invoice_id", [...invoiceIds]).eq("status", "open").in("kind", ["promise", "dispute"]);
  if (read.error) {
    if (portalTableMissing(read.error)) return pauses;
    throw new Error(read.error.message);
  }
  const byInvoice = new Map<string, Array<{ kind: RequestKind; status: "open" | "closed"; promisedOn: string | null }>>();
  for (const row of (read.data ?? []) as Array<{ invoice_id: string; kind: RequestKind; status: "open" | "closed"; promised_on: string | null }>) {
    byInvoice.set(row.invoice_id, [...(byInvoice.get(row.invoice_id) ?? []), { kind: row.kind, status: row.status, promisedOn: row.promised_on }]);
  }
  for (const [invoiceId, requests] of byInvoice) {
    const pause = reminderPause(requests, today);
    if (pause) pauses.set(invoiceId, pause);
  }
  return pauses;
}

export type RequestErrorCode = "not_ready" | "not_found" | "closed" | "empty" | "too_long" | "outcome";

export const REQUEST_MESSAGES: Record<RequestErrorCode, string> = {
  not_ready: "Customer statements are not set up on this deployment yet.",
  not_found: "That request is not one of this workspace's.",
  closed: "That request was closed already. Reload the page to see it as it is now.",
  empty: "Write a reply first.",
  too_long: "Keep the reply under 2,000 characters.",
  outcome: "Choose how to close it.",
};

export class CustomerRequestError extends Error {
  constructor(readonly code: RequestErrorCode) {
    super(REQUEST_MESSAGES[code]);
    this.name = "CustomerRequestError";
  }
}

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

async function requestById(requestId: string): Promise<RequestRow & { customerName: string }> {
  const found = await db().from("customer_requests").select(REQUEST_COLUMNS).eq("id", requestId).limit(1);
  if (found.error) {
    if (portalTableMissing(found.error)) throw new CustomerRequestError("not_ready");
    if (found.error.code === "22P02") throw new CustomerRequestError("not_found");
    throw new Error(found.error.message);
  }
  const row = ((found.data ?? []) as RequestRow[])[0];
  if (!row) throw new CustomerRequestError("not_found");
  const customer = await db().from("counterparties").select("name").eq("id", row.counterparty_id).limit(1);
  const name = ((customer.data ?? []) as Array<{ name: string }>)[0]?.name;
  return { ...row, customerName: name ?? "the customer" };
}

/**
 * A member's reply under a request, which the customer reads on its statement under the business's name, never the
 * member's. Signed as `customer_request_replied`, with the SHA-256 of the words rather than the words.
 */
export async function replyToCustomer(input: { actorId: string; requestId: string; body: string }): Promise<{ customerName: string }> {
  const body = input.body.trim();
  if (!body) throw new CustomerRequestError("empty");
  if (body.length > MESSAGE_MAX) throw new CustomerRequestError("too_long");
  const request = await requestById(input.requestId);
  if (request.status !== "open") throw new CustomerRequestError("closed");
  const written = await db().from("customer_request_messages").insert({ request_id: request.id, body, by: input.actorId }).select("id").single<{ id: string }>();
  if (written.error) {
    if (/customer_request_closed/.test(written.error.message ?? "")) throw new CustomerRequestError("closed");
    throw new Error(written.error.message);
  }
  const customerName = request.customerName;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: CUSTOMER_PORTAL_ACTIONS.replied,
    summary: `Replied to ${customerName} on its statement`,
    detail: { by: input.actorId, requestId: request.id, messageId: written.data.id, invoiceId: request.invoice_id, counterpartyId: request.counterparty_id, kind: request.kind, textSha256: sha256hex(body) },
  });
  return { customerName };
}

/**
 * A member closes an open request (P8): a claim of payment as found or not received, anything else as resolved. A
 * closed dispute or promise no longer holds the reminders. Signed as `customer_request_closed`.
 */
export async function closeCustomerRequest(input: { actorId: string; requestId: string; outcome: CloseOutcome }): Promise<{ customerName: string; kind: RequestKind }> {
  const request = await requestById(input.requestId);
  if (input.outcome !== "resolved" && !(input.outcome === "not_received" && request.kind === "paid")) throw new CustomerRequestError("outcome");
  if (request.status !== "open") throw new CustomerRequestError("closed");
  const closed = await db()
    .from("customer_requests")
    .update({ status: "closed", outcome: input.outcome, closed_at: new Date().toISOString(), closed_by: input.actorId })
    .eq("id", request.id)
    .eq("status", "open")
    .select("id");
  if (closed.error) {
    if (/customer_request_closed/.test(closed.error.message ?? "")) throw new CustomerRequestError("closed");
    throw new Error(closed.error.message);
  }
  // Someone else closed it, or the customer replaced it, between the read and this write.
  if ((closed.data ?? []).length === 0) throw new CustomerRequestError("closed");
  const customerName = request.customerName;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "ar",
    action: CUSTOMER_PORTAL_ACTIONS.closed,
    summary: `Closed ${customerName}'s ${request.kind === "paid" ? "claim of payment" : request.kind === "promise" ? "promise to pay" : request.kind === "dispute" ? "dispute" : "request for a pay link"} (${input.outcome.replace("_", " ")})`,
    detail: { by: input.actorId, requestId: request.id, invoiceId: request.invoice_id, counterpartyId: request.counterparty_id, kind: request.kind, outcome: input.outcome },
  });
  return { customerName, kind: request.kind };
}
