import { missingDetails } from "../added-details";
import { can, type OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { db, platformDb, platformStorage, unwrap, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { ID_CHUNK } from "../new-payee-facts";
import {
  missingDocuments,
  missingOf,
  type DocumentCheckView,
  type DocumentReceivedView,
  type DocumentRequestStatus,
  type DocumentRequestsSetting,
  type DocumentRequestView,
  type MissingDocument,
} from "./rules";
import { readDocumentRequestsSetting } from "./setting";

/**
 * What members see and do of the requests the agent sends vendors for a bill's missing document
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER3, ER4, ER6): each bill's latest request as its card on
 * Approvals and Bills shows it, an owner's or admin's Revoke, and opening the vendor's file. Every export runs inside the
 * workspace's scope; before migration 0142, there is nothing to show. From migration 0144 the card also says who sent a
 * document, the vendor or a member who attached it, and what the cycle's check found in it
 * (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK13); before it, part 1's card as it was.
 */

/** Postgres's or PostgREST's "no such table, column or function": migration 0142 has not run here yet. */
function beforeMigration(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

interface RequestRow {
  id: string;
  invoice_id: string;
  status: DocumentRequestStatus;
  missing: unknown;
  created_at: string;
  sent_at: string | null;
  expires_at: string | null;
  answered_at: string | null;
  po_reference: string | null;
  note: string | null;
  file_type: string | null;
  file_size: number | null;
  /** From migration 0144 (document checks DK11, DK12). */
  source?: string | null;
  checked_at?: string | null;
  check_outcome?: string | null;
  check_reason?: string | null;
  check_shadow?: boolean | null;
  document_po?: string | null;
  po_written?: boolean | null;
}

const COLUMNS = "id, invoice_id, status, missing, created_at, sent_at, expires_at, answered_at, po_reference, note, file_type, file_size";
/** Part 1's columns and 0144's: who sent the document, and what its check found. */
const CHECK_COLUMNS = `${COLUMNS}, source, checked_at, check_outcome, check_reason, check_shadow, document_po, po_written`;

/** What the cards need of a bill: whether it still waits, and for what (shadow's "would ask", a match's lines). */
interface BillFacts {
  status: string;
  poReference: string | null;
  goodsReceived: boolean;
  purchaseOrderRequired: boolean;
}

/** How the card reads a request's check: the setting now, and the bills it was checked against, as they are now. */
interface CheckContext {
  /** Whether migration 0144's columns were read. */
  checks: boolean;
  setting: DocumentRequestsSetting;
  bills: Map<string, BillFacts>;
}

/**
 * What the check found in an answered request's document (DK13): waiting for the next cycle, while vendor requests are
 * shadow or on; a match, naming the purchase order only where one was compared, as the bill is now; or the sentence of
 * a mismatch, a file it could not read, or a skip. Nothing before migration 0144, nor for a document waiting while
 * vendor requests are off (DK1).
 */
function checkOf(row: RequestRow, context: CheckContext): DocumentCheckView | null {
  if (!context.checks) return null;
  if (!row.checked_at) return context.setting === "off" ? null : { outcome: "pending" };
  const outcome = row.check_outcome;
  if (outcome === "matched") {
    const bill = context.bills.get(row.invoice_id);
    const added = row.po_written === true;
    // The purchase order the document names was compared only where the bill needs one (DK5).
    const po = row.document_po && (added || bill?.purchaseOrderRequired !== false) ? row.document_po : null;
    return { outcome: "matched", po, added, shadowLeftPo: !added && row.check_shadow === true && po !== null && bill?.poReference === null };
  }
  if (outcome === "mismatched" || outcome === "unreadable" || outcome === "skipped") return { outcome, reason: row.check_reason ?? "" };
  return null;
}

/** An answered request, as its bill's card shows what the vendor sent, or a member attached, and what its check found. */
function receivedOf(row: RequestRow, context: CheckContext): DocumentReceivedView | null {
  if (row.status !== "answered" || !row.answered_at) return null;
  const check = checkOf(row, context);
  return {
    state: "answered",
    id: row.id,
    missing: missingOf(row.missing),
    answeredAt: row.answered_at,
    poReference: row.po_reference,
    note: row.note,
    fileType: row.file_type,
    fileSize: row.file_size === null ? null : Number(row.file_size),
    ...(context.checks ? { source: row.source === "member" ? ("member" as const) : ("vendor" as const) } : {}),
    ...(check ? { check } : {}),
  };
}

/**
 * A request as its bill's card shows it, or null for one the card says nothing of. A drafted one shows only in shadow,
 * as what the bill lacks now (`wouldAsk`), and not at all once the bill no longer waits for a document.
 */
function viewOf(row: RequestRow, wouldAsk: MissingDocument[] | null, now: number, context: CheckContext): DocumentRequestView | null {
  const missing = missingOf(row.missing);
  if (row.status === "drafted") return wouldAsk ? { state: "would_ask", missing: wouldAsk } : null;
  if (row.status === "answered") return receivedOf(row, context);
  if (!row.sent_at || !row.expires_at) return null;
  if (row.status === "open" && Date.parse(row.expires_at) > now) return { state: "asked", id: row.id, missing, sentAt: row.sent_at, expiresAt: row.expires_at };
  if (row.status === "open" || row.status === "expired") return { state: "expired", missing, sentAt: row.sent_at, expiresAt: row.expires_at };
  return null;
}

/** What the cards need of each of `invoiceIds` now: see `BillFacts`. */
async function billFactsOf(orgDb: OrgDb, invoiceIds: string[]): Promise<Map<string, BillFacts>> {
  const facts = new Map<string, BillFacts>();
  for (let start = 0; start < invoiceIds.length; start += ID_CHUNK) {
    const rows = unwrap(
      await orgDb
        .from("invoices")
        .select("id, status, po_reference, goods_received, counterparties(purchase_order_required)")
        .in("id", invoiceIds.slice(start, start + ID_CHUNK))
    ) as unknown as Array<{
      id: string;
      status: string;
      po_reference: string | null;
      goods_received: boolean | null;
      counterparties: { purchase_order_required?: boolean | null } | null;
    }>;
    for (const row of rows) {
      facts.set(row.id, {
        status: row.status,
        poReference: row.po_reference,
        goodsReceived: row.goods_received === true,
        purchaseOrderRequired: row.counterparties?.purchase_order_required !== false,
      });
    }
  }
  return facts;
}

/**
 * What a bill lacks now that a vendor can send, while it still waits for information: shadow's "would ask" follows the
 * bill as it is, not as it was when the request was drafted. Null for one that lacks nothing, or no longer waits.
 */
function stillMissing(bill: BillFacts | undefined): MissingDocument[] | null {
  if (!bill || bill.status !== "awaiting_info") return null;
  const lacks = missingDocuments(missingDetails(bill));
  return lacks.length > 0 ? lacks : null;
}

/**
 * Each of `invoiceIds`' latest request, as its card shows it (ER3, ER4, ER6): what Vestiarion would ask while the setting
 * is shadow and the bill still waits for a document, when it asked and until when, what the vendor sent, or a link that
 * expired unanswered. What a vendor sent with an earlier request stays beside a newer one, or shows alone when the newer
 * one shows nothing, so its file and purchase order never drop off the card. Each document says who sent it and what
 * its check found (DK13). Bills with nothing to show are left out; before migration 0142, all of them. Before migration
 * 0144, the requests are read again without its columns, and the cards show what they showed before it.
 */
export async function readDocumentRequests(invoiceIds: string[], orgDb: OrgDb = db(), now: number = Date.now()): Promise<Map<string, DocumentRequestView>> {
  const views = new Map<string, DocumentRequestView>();
  if (invoiceIds.length === 0) return views;
  const { setting, ready } = await readDocumentRequestsSetting(orgDb);
  if (!ready) return views;
  const latest = new Map<string, RequestRow>();
  const answered = new Map<string, RequestRow>();
  let checks = true;
  for (let start = 0; start < invoiceIds.length; start += ID_CHUNK) {
    const ids = invoiceIds.slice(start, start + ID_CHUNK);
    const select = (columns: string) => orgDb.from("document_requests").select(columns).in("invoice_id", ids).order("created_at", { ascending: false });
    let read = await select(checks ? CHECK_COLUMNS : COLUMNS);
    // Before migration 0144, its columns are not there: part 1's card, from part 1's columns (DK15).
    if (read.error && checks && beforeMigration(read.error)) {
      checks = false;
      read = await select(COLUMNS);
    }
    if (read.error) {
      if (beforeMigration(read.error)) return views;
      throw new Error(read.error.message);
    }
    // Newest first: the first row per bill is its latest, and the first answered one its latest answer.
    for (const row of (read.data ?? []) as unknown as RequestRow[]) {
      if (!latest.has(row.invoice_id)) latest.set(row.invoice_id, row);
      if (row.status === "answered" && !answered.has(row.invoice_id)) answered.set(row.invoice_id, row);
    }
  }
  // The bills read again: a drafted request's in shadow, and a matched document's, whose lines follow the bill as it is.
  const drafted = setting === "shadow" ? [...latest.values()].filter((row) => row.status === "drafted").map((row) => row.invoice_id) : [];
  const matched = [...answered.values()].filter((row) => row.check_outcome === "matched" && row.document_po && row.po_written !== true).map((row) => row.invoice_id);
  const wanted = [...new Set([...drafted, ...matched])];
  const bills = wanted.length > 0 ? await billFactsOf(orgDb, wanted) : new Map<string, BillFacts>();
  const context: CheckContext = { checks, setting, bills };
  for (const [invoiceId, row] of latest) {
    const view = viewOf(row, setting === "shadow" ? stillMissing(bills.get(invoiceId)) : null, now, context);
    const earlier = answered.get(invoiceId);
    const received = earlier && earlier !== row ? receivedOf(earlier, context) : null;
    if (view && view.state !== "answered" && received) views.set(invoiceId, { ...view, received });
    else if (view) views.set(invoiceId, view);
    else if (received) views.set(invoiceId, received);
  }
  return views;
}

/** Why a Revoke was refused (ER6). */
export class RevokeDocumentRequestError extends Error {
  constructor(readonly code: "forbidden" | "not_open") {
    super(code === "forbidden" ? "Only an owner or admin can revoke a request." : "This request is no longer open.");
    this.name = "RevokeDocumentRequestError";
  }
}

/**
 * An owner or admin stops an open request (ER6): its link answers nothing from now, and the agent does not ask the vendor
 * about that bill again. Signed as `document_request_revoked`, best effort: the link is stopped by then.
 */
export async function revokeDocumentRequest(input: { actorId: string; role: OrgRole; requestId: string }): Promise<void> {
  if (!can(input.role, "records.write")) throw new RevokeDocumentRequestError("forbidden");
  const orgId = currentOrgId();
  const done = await platformDb().rpc("revoke_document_request", { p_org_id: orgId, p_id: input.requestId });
  if (done.error) {
    if (beforeMigration(done.error)) throw new RevokeDocumentRequestError("not_open");
    throw new Error(done.error.message);
  }
  const row = done.data as { id: string | null; invoice_id: string | null; counterparty_id: string | null } | null;
  if (!row?.id) throw new RevokeDocumentRequestError("not_open");
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "document_request_revoked",
    summary: "Revoked the request for a missing document; its link no longer works",
    detail: { by: input.actorId, requestId: row.id, invoiceId: row.invoice_id, counterpartyId: row.counterparty_id },
  });
}

/** PostgREST's `max_rows` on Supabase: one request answers at most this many rows, and cuts the rest without an error. */
const ROW_PAGE = 1000;
/** How many entries one Storage call lists, or removes. */
const STORAGE_PAGE = 100;
/** How many folders are listed at once. */
const LIST_AT_ONCE = 8;

/**
 * Every file a workspace's requests hold in the private storage, under its own folder: each kept document, and any upload
 * a vendor started and never sent. Read before the rows go, so their files can follow: when the workspace is deleted, by
 * its owner, with its last member's account or as an idle sandbox, and, for the requests to `counterpartyIds` alone,
 * when those counterparties are deleted with the sample data. Read in pages by id, since one request stops at
 * `ROW_PAGE`. None before migration 0142; what was read when a page cannot be.
 */
export async function documentFilesOf(orgId: string, counterpartyIds?: string[]): Promise<string[]> {
  const read = async () => {
    const files: string[] = [];
    let after: string | null = null;
    for (;;) {
      const base = db().from("document_requests").select("id, file_path");
      const scoped = counterpartyIds ? base.in("counterparty_id", counterpartyIds) : base;
      const rows = await (after ? scoped.gt("id", after) : scoped).order("id", { ascending: true }).limit(ROW_PAGE);
      if (rows.error) {
        if (!beforeMigration(rows.error)) console.error("document files not read", orgId);
        return files;
      }
      const page = (rows.data ?? []) as Array<{ id: string; file_path: string | null }>;
      for (const row of page) files.push(`${orgId}/document-requests/${row.id}/upload`, ...(row.file_path ? [row.file_path] : []));
      if (page.length < ROW_PAGE) return files;
      after = page[page.length - 1].id;
    }
  };
  try {
    return scopedTo(orgId) ? await read() : await withOrg(orgId, read);
  } catch {
    console.error("document files not read", orgId);
    return [];
  }
}

function scopedTo(orgId: string): boolean {
  try {
    return currentOrgId() === orgId;
  } catch {
    return false;
  }
}

/** Removes the files `documentFilesOf` named, once their rows are deleted. Best effort: it never throws. */
export async function removeDocumentFiles(paths: string[]): Promise<void> {
  for (let start = 0; start < paths.length; start += STORAGE_PAGE) {
    try {
      const removed = await platformStorage().remove(paths.slice(start, start + STORAGE_PAGE));
      if (removed.error) console.error("document files not removed", removed.error.message);
    } catch {
      console.error("document files not removed");
    }
  }
}

/**
 * Every file under `folder` in the private storage, in its folders too, a page at a time; what was listed when a page
 * cannot be. Storage lists a folder inside it as an entry with no id.
 */
async function filesUnder(folder: string): Promise<string[]> {
  const files: string[] = [];
  const folders: string[] = [];
  for (let offset = 0; ; offset += STORAGE_PAGE) {
    const listed = await platformStorage()
      .list(folder, { limit: STORAGE_PAGE, offset })
      .catch(() => null);
    if (!listed?.data || listed.error) {
      console.error("document files not listed", folder, listed?.error?.message ?? "none");
      break;
    }
    for (const entry of listed.data) (entry.id === null ? folders : files).push(`${folder}/${entry.name}`);
    if (listed.data.length < STORAGE_PAGE) break;
  }
  for (let start = 0; start < folders.length; start += LIST_AT_ONCE) {
    const inside = await Promise.all(folders.slice(start, start + LIST_AT_ONCE).map(filesUnder));
    files.push(...inside.flat());
  }
  return files;
}

/**
 * Once a workspace is deleted, removes the files `documentFilesOf` named and then every file left under its own
 * `document-requests` folder: one kept for an answer that did not go through and could not be removed then, or one an
 * answer kept after the rows were read, which no row names any more. The names read from the rows still go when the folder
 * cannot be listed. Best effort: it never throws.
 */
export async function removeWorkspaceDocumentFiles(orgId: string, named: string[]): Promise<void> {
  const root = `${orgId}/document-requests`;
  const found = await filesUnder(root).catch(() => {
    console.error("document files not listed", root);
    return [];
  });
  await removeDocumentFiles([...new Set([...named, ...found])]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTENSION: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

/**
 * A one-minute address where a member opens the vendor's file (ER6), downloaded rather than shown on Vestiarion's own
 * pages; null for a request of another workspace, or with no file. The caller checks the person is a member.
 */
export async function documentOpenUrl(requestId: string, orgDb: OrgDb = db()): Promise<string | null> {
  if (!UUID.test(requestId)) return null;
  const read = await orgDb.from("document_requests").select("id, status, file_path, file_type").eq("id", requestId).maybeSingle();
  if (read.error) {
    if (beforeMigration(read.error)) return null;
    throw new Error(read.error.message);
  }
  const row = read.data as { id: string; status: string; file_path: string | null; file_type: string | null } | null;
  if (!row || row.status !== "answered" || !row.file_path) return null;
  const made = await platformStorage().openUrl(row.file_path, 60, `document-${row.id}.${EXTENSION[row.file_type ?? ""] ?? "bin"}`);
  if (made.error || !made.data?.signedUrl) throw new Error(made.error?.message ?? "no address to open the file");
  return made.data.signedUrl;
}
