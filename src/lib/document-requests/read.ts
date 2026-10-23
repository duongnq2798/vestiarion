import { can, type OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { db, platformDb, platformStorage, type OrgDb } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { missingOf, type DocumentRequestStatus, type DocumentRequestView } from "./rules";
import { readDocumentRequestsSetting } from "./setting";

/**
 * What members see and do of the requests the agent sends vendors for a bill's missing document
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER3, ER4, ER6): each bill's latest request as its card on
 * Approvals and Bills shows it, an owner's or admin's Revoke, and opening the vendor's file. Every export runs inside the
 * workspace's scope; before migration 0142, there is nothing to show.
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
}

/** A request as its bill's card shows it, or null for one the card says nothing of. */
function viewOf(row: RequestRow, shadow: boolean, now: number): DocumentRequestView | null {
  const missing = missingOf(row.missing);
  if (row.status === "drafted") return shadow ? { state: "would_ask", missing } : null;
  if (row.status === "answered" && row.answered_at) {
    return {
      state: "answered",
      id: row.id,
      missing,
      answeredAt: row.answered_at,
      poReference: row.po_reference,
      note: row.note,
      fileType: row.file_type,
      fileSize: row.file_size === null ? null : Number(row.file_size),
    };
  }
  if (!row.sent_at || !row.expires_at) return null;
  if (row.status === "open" && Date.parse(row.expires_at) > now) return { state: "asked", id: row.id, missing, sentAt: row.sent_at, expiresAt: row.expires_at };
  if (row.status === "open" || row.status === "expired") return { state: "expired", missing, sentAt: row.sent_at, expiresAt: row.expires_at };
  return null;
}

/**
 * Each of `invoiceIds`' latest request, as its card shows it (ER3, ER4, ER6): what Vestiarion would ask while the setting
 * is shadow, when it asked and until when, what the vendor sent, or a link that expired unanswered. Bills with nothing to
 * show are left out; before migration 0142, all of them.
 */
export async function readDocumentRequests(invoiceIds: string[], orgDb: OrgDb = db(), now: number = Date.now()): Promise<Map<string, DocumentRequestView>> {
  const views = new Map<string, DocumentRequestView>();
  if (invoiceIds.length === 0) return views;
  const { setting, ready } = await readDocumentRequestsSetting(orgDb);
  if (!ready) return views;
  for (let start = 0; start < invoiceIds.length; start += 100) {
    const read = await orgDb
      .from("document_requests")
      .select("id, invoice_id, status, missing, created_at, sent_at, expires_at, answered_at, po_reference, note, file_type, file_size")
      .in("invoice_id", invoiceIds.slice(start, start + 100))
      .order("created_at", { ascending: false });
    if (read.error) {
      if (beforeMigration(read.error)) return views;
      throw new Error(read.error.message);
    }
    const seen = new Set<string>();
    for (const row of (read.data ?? []) as unknown as RequestRow[]) {
      // Newest first: the first row per bill is its latest.
      if (seen.has(row.invoice_id)) continue;
      seen.add(row.invoice_id);
      const view = viewOf(row, setting === "shadow", now);
      if (view) views.set(row.invoice_id, view);
    }
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
