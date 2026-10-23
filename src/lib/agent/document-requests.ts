import crypto from "node:crypto";
import { missingDetails } from "../added-details";
import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { utcDay } from "../copy";
import { platformDb, unwrap, type OrgDb } from "../dal";
import {
  DOCUMENT_REQUEST_ATTEMPTS,
  DOCUMENT_REQUEST_TTL_DAYS,
  DOCUMENT_REQUESTS_PER_DAY,
  documentRequestAllowed,
  emailDomainOf,
  missingDocuments,
  missingWords,
  shortDay,
  type DocumentRequestStatus,
  type MissingDocument,
} from "../document-requests/rules";
import { readDocumentRequestsSetting } from "../document-requests/setting";
import { documentRequestUrl, generateDocumentToken } from "../document-requests/token";
import { documentRequestEmail } from "../email/document-request";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "../email/send";
import { appendLedgerEntry } from "../ledger";
import type { CycleLogLine } from "./orchestrator";
import { agentPaused } from "./pause";

/**
 * The cycle's document requests stage (docs/superpowers/specs/2026-10-23-document-requests-design.md ER2-ER4): once an
 * owner set it to shadow or on (ER1), each bill waiting for its purchase order or goods receipt, whose vendor has a
 * billing email and is neither frozen nor screened high risk, and that has no request out or lately answered or expired
 * (ER2), gets one request, up to 20 a day in the workspace.
 *
 * In shadow, a request is drafted and signed, and nothing is sent (ER3). On, its one-time link is emailed to the vendor in
 * the workspace's name, claimed before it is sent so two runs never send it twice; a failed email leaves it unsent, tried
 * again at the next cycle, three times at most (ER4). Requests out whose bill no longer waits for information, or whose
 * date passed, are closed first; while the setting is off the stage reads nothing more, and a link out answers only
 * while its bill waits for information.
 *
 * It keys on the bill as it is, never on the decision's guardrail rule, which most match holds leave null. It never
 * changes a bill's status, amount or address, and moves no money (ER7). Never while the agent is paused; before
 * migration 0142, nothing.
 */

const DAY_MS = 86_400_000;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** Postgres's or PostgREST's "no such table, column or function": a migration has not run here yet. */
function beforeMigration(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

interface BillRow {
  id: string;
  counterparty_id: string;
  amount: string;
  currency: string | null;
  due_date: string;
  memo: string | null;
  po_reference: string | null;
  goods_received: boolean | null;
  status: string;
  counterparties: {
    name: string;
    notice_email: string | null;
    risk_level: string | null;
    purchase_order_required?: boolean | null;
    /** Migration 0137's; absent before it runs. */
    frozen_at?: string | null;
  } | null;
}

interface RequestRow {
  id: string;
  invoice_id: string;
  status: DocumentRequestStatus;
  send_attempts: number;
  created_at: string;
  sent_at: string | null;
  expires_at: string | null;
  answered_at: string | null;
}

const BILL_COLUMNS = "id, counterparty_id, amount, currency, due_date, memo, po_reference, goods_received, status";

/** The payables waiting for information, oldest due first, with their vendors; read without the freeze before 0137. */
async function waitingBills(orgDb: OrgDb): Promise<BillRow[]> {
  const read = (frozen: boolean) =>
    orgDb
      .from("invoices")
      .select(`${BILL_COLUMNS}, counterparties(name, notice_email, risk_level, purchase_order_required${frozen ? ", frozen_at" : ""})`)
      .eq("direction", "payable")
      .eq("status", "awaiting_info")
      .order("due_date", { ascending: true })
      .limit(200);
  const withFreeze = await read(true);
  const rows = withFreeze.error && beforeMigration(withFreeze.error) ? unwrap(await read(false)) : unwrap(withFreeze);
  return rows as unknown as BillRow[];
}

function defaultSend(): ((message: EmailMessage) => Promise<SendResult>) | null {
  const settings = emailSettingsFromEnv();
  return settings ? (message: EmailMessage) => sendEmail({ ...message, meter: "document_request" }, settings) : null;
}

/**
 * The stage: see the module comment. `send` stands in for Resend in tests; null says email is not set up, and then a
 * workspace set to on asks no one.
 */
export async function requestMissingDocuments(
  orgDb: OrgDb,
  options: { now?: number; send?: ((message: EmailMessage) => Promise<SendResult>) | null; origin?: string } = {}
): Promise<CycleLogLine[]> {
  const { setting, ready } = await readDocumentRequestsSetting(orgDb);
  // Off, a link already out still answers only while its bill waits for information: the page checks that itself.
  if (!ready || setting === "off") return [];
  if (await agentPaused()) return [];
  const orgId = currentOrgId();

  // Links out for a bill paid, scheduled or held for another reason since, or past their date, are closed.
  const closed = await platformDb().rpc("close_document_requests", { p_org_id: orgId });
  if (closed.error) {
    if (beforeMigration(closed.error)) return [];
    throw new Error(closed.error.message);
  }
  const send = options.send === undefined ? defaultSend() : options.send;
  if (setting === "on" && !send) return [];
  const now = options.now ?? Date.now();

  const bills = await waitingBills(orgDb);
  if (bills.length === 0) return [];

  const requestsRead = await orgDb
    .from("document_requests")
    .select("id, invoice_id, status, send_attempts, created_at, sent_at, expires_at, answered_at")
    .in("invoice_id", bills.map((bill) => bill.id))
    .order("created_at", { ascending: false })
    .limit(2000);
  if (requestsRead.error) {
    if (beforeMigration(requestsRead.error)) return [];
    throw new Error(requestsRead.error.message);
  }
  const requests = (requestsRead.data ?? []) as unknown as RequestRow[];

  // The day's requests across the workspace: at most 20 made, and 20 emailed, in 24 hours (ER2).
  const since = new Date(now - DAY_MS).toISOString();
  const today = unwrap(
    await orgDb
      .from("document_requests")
      .select("id, created_at, sent_at")
      .or(`created_at.gte.${since},sent_at.gte.${since}`)
      .limit(DOCUMENT_REQUESTS_PER_DAY * 4)
  ) as Array<{ id: string; created_at: string; sent_at: string | null }>;
  let made = today.filter((row) => Date.parse(row.created_at) >= now - DAY_MS).length;
  let sent = today.filter((row) => row.sent_at && Date.parse(row.sent_at) >= now - DAY_MS).length;

  let orgName: string | null = null;
  const lines: CycleLogLine[] = [];
  for (const bill of bills) {
    if (made >= DOCUMENT_REQUESTS_PER_DAY && sent >= DOCUMENT_REQUESTS_PER_DAY) break;
    const vendor = bill.counterparties;
    if (!vendor) continue;
    const missing = missingDocuments(
      missingDetails({ poReference: bill.po_reference, goodsReceived: bill.goods_received === true, purchaseOrderRequired: vendor.purchase_order_required !== false })
    );
    const history = requests.filter((row) => row.invoice_id === bill.id);
    // A request drafted and not yet emailed: shadow's record of the bill, or one whose email failed. Shadow keeps it as it
    // is; on emails it, once the bill still qualifies.
    const drafted = history.find((row) => row.status === "drafted") ?? null;
    const allowance = documentRequestAllowed({
      status: bill.status,
      missing,
      noticeEmail: vendor.notice_email,
      frozen: Boolean(vendor.frozen_at),
      riskLevel: vendor.risk_level ?? "unscreened",
      requests: history
        .filter((row) => row !== drafted)
        .map((row) => ({ status: row.status, createdAt: row.created_at, sentAt: row.sent_at, expiresAt: row.expires_at, answeredAt: row.answered_at })),
      now,
    });
    if (!allowance.allowed) continue;
    const email = vendor.notice_email as string;
    const emailDomain = emailDomainOf(email) as string;

    let request: { id: string; send_attempts: number };
    if (drafted) {
      if (setting !== "on") continue;
      request = drafted;
    } else {
      if (made >= DOCUMENT_REQUESTS_PER_DAY) continue;
      const created = await platformDb().rpc("create_document_request", { p_org_id: orgId, p_invoice_id: bill.id, p_missing: missing, p_email_domain: emailDomain });
      if (created.error) {
        if (beforeMigration(created.error)) return lines;
        throw new Error(created.error.message);
      }
      const row = created.data as { id: string | null; send_attempts?: number | null } | null;
      // The bill moved on since it was read, or another run drafted it first.
      if (!row?.id) continue;
      made += 1;
      request = { id: row.id, send_attempts: Number(row.send_attempts ?? 0) };
      if (setting === "shadow") {
        await appendLedgerEntry({
          actor: "agent",
          domain: "ap",
          action: "document_request_drafted",
          summary: `Would ask ${vendor.name} for ${missingWords(missing)}; vendor requests are in shadow, so nothing was sent`,
          // The email's domain is the only part of the address signed (ER3).
          detail: { invoiceId: bill.id, counterpartyId: bill.counterparty_id, requestId: row.id, missing, emailDomain },
        });
        lines.push({ domain: "ap", message: `Would ask ${vendor.name} for ${missingWords(missing)} (vendor requests are in shadow)` });
        continue;
      }
    }

    if (request.send_attempts >= DOCUMENT_REQUEST_ATTEMPTS || sent >= DOCUMENT_REQUESTS_PER_DAY) continue;
    orgName ??= await workspaceName(orgId);
    const outcome = await emailRequest({
      orgId,
      orgName,
      bill,
      vendorName: vendor.name,
      email,
      emailDomain,
      missing,
      request,
      now,
      origin: options.origin ?? siteOrigin(),
      send: send as (message: EmailMessage) => Promise<SendResult>,
    });
    if (outcome.sent) sent += 1;
    if (outcome.line) lines.push(outcome.line);
  }
  return lines;
}

async function workspaceName(orgId: string): Promise<string> {
  const org = await platformDb().from("orgs").select("name").eq("id", orgId).single<{ name: string }>();
  return org.data?.name ?? "Your customer";
}

/**
 * One attempt at a request's email (ER4): claimed under a new token, so two runs never send it twice; sent in the
 * workspace's name under a key of its own; and, once it went, its link opened for 14 days and signed. One that did not
 * go is drafted again for the next cycle, or dropped after the third attempt.
 */
async function emailRequest(input: {
  orgId: string;
  orgName: string;
  bill: BillRow;
  vendorName: string;
  email: string;
  emailDomain: string;
  missing: MissingDocument[];
  request: { id: string; send_attempts: number };
  now: number;
  origin: string;
  send: (message: EmailMessage) => Promise<SendResult>;
}): Promise<{ sent: boolean; line: CycleLogLine | null }> {
  const { orgId, bill, request, missing, vendorName } = input;
  const { token, tokenHash } = generateDocumentToken();
  const claimed = await platformDb().rpc("claim_document_request_send", {
    p_org_id: orgId,
    p_id: request.id,
    p_attempts: request.send_attempts,
    p_token_hash: tokenHash,
    p_missing: missing,
    p_email_domain: input.emailDomain,
  });
  if (claimed.error) throw new Error(claimed.error.message);
  // Another run claimed this attempt, or the bill moved on since it was read.
  if (claimed.data !== true) return { sent: false, line: null };

  const expiresAt = new Date(input.now + DOCUMENT_REQUEST_TTL_DAYS * DAY_MS).toISOString();
  const message = documentRequestEmail({
    orgName: input.orgName,
    vendorName,
    reference: bill.memo,
    amount: AMOUNT.format(Number(bill.amount)),
    token: bill.currency ?? "USDC",
    dueOn: utcDay(bill.due_date),
    until: utcDay(expiresAt),
    missing,
    url: documentRequestUrl(input.origin, token),
    origin: input.origin,
  });
  const attempt = request.send_attempts + 1;
  const idempotencyKey = crypto.createHash("sha256").update(`document_request\n${request.id}\n${attempt}`, "utf8").digest("hex");
  const result = await input.send({ to: input.email, ...message, fromName: input.orgName, idempotencyKey });
  if (!result.sent) {
    // Never a link the vendor did not get: its token is dropped, and the request waits for the next cycle (ER4).
    const released = await platformDb().rpc("release_document_request_send", { p_org_id: orgId, p_id: request.id, p_token_hash: tokenHash });
    if (released.error) console.error("document request not released", request.id);
    console.error("document request email not sent", request.id, result.reason);
    return {
      sent: false,
      line: {
        domain: "ap",
        message:
          released.data === "expired"
            ? `The request to ${vendorName} was not emailed after ${DOCUMENT_REQUEST_ATTEMPTS} tries (${result.reason}); it was dropped`
            : `The request to ${vendorName} was not emailed (${result.reason}); tried again at the next cycle`,
      },
    };
  }
  const marked = await platformDb().rpc("mark_document_request_sent", { p_org_id: orgId, p_id: request.id, p_token_hash: tokenHash, p_expires_at: expiresAt });
  if (marked.error || marked.data !== true) {
    // Emailed, but its link does not answer: the next cycle emails a new one.
    console.error("document request not marked sent", request.id);
    return { sent: true, line: null };
  }
  await appendLedgerEntry({
    actor: "agent",
    domain: "ap",
    action: "document_requested",
    summary: `Asked ${vendorName} by email for ${missingWords(missing)}, for ${bill.memo ? `invoice ${bill.memo}` : "their invoice"}; the link expires ${utcDay(expiresAt)}`,
    // The email's domain is the only part of the address signed; never the link.
    detail: { invoiceId: bill.id, counterpartyId: bill.counterparty_id, requestId: request.id, missing, emailDomain: input.emailDomain, expiresAt },
  });
  return { sent: true, line: { domain: "ap", message: `Asked ${vendorName} by email for ${missingWords(missing)}; the link expires ${shortDay(expiresAt)}` } };
}
