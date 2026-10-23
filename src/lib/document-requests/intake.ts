import crypto from "node:crypto";
import { platformDb, platformStorage } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { notifyDocumentReceived } from "../notifications/document-received";
import { takeDocumentAddressToken, takeDocumentLinkToken } from "../rate-limit";
import { MAX_VENDOR_DOCUMENT_BYTES, missingOf, readDocumentFields, sniffDocumentType, type MissingDocument } from "./rules";
import { documentTokenHash } from "./token";

/**
 * The vendor's side of a document request (docs/superpowers/specs/2026-10-23-document-requests-design.md ER5, ER6): no
 * session, the link is the vendor's only credential. Each step checks what costs nothing first: the token's shape and
 * the fields, then one of the address's tries, then the link (an open request whose bill still waits for information),
 * then one of the live link's tries.
 *
 * The file goes from the vendor's browser straight to the workspace's private storage, at an upload address made for the
 * request, so a file of up to 10 MB never passes through a server function. Sending it then reads the file back, knows
 * it by its first bytes (a PDF, a PNG or a JPEG, never by its name), and keeps it under its SHA-256, where the upload
 * address can no longer write; one that is not one of those is removed. The file kept is read back and taken only when
 * it hashes as the file checked, since the upload address could write again in between. 0142's
 * answer_document_request takes it once, while the request is open. Signed as `document_received` (by no member) and
 * told to the owners and admins, both best effort: the answer is taken by then. It never changes the bill, and is read
 * by no model (ER7).
 */

export interface DocumentRequestPreview {
  orgName: string;
  vendorName: string;
  /** The vendor's own invoice number, as the bill's reference; null when the bill has none. */
  reference: string | null;
  amount: number;
  currency: string;
  dueDate: string;
  missing: MissingDocument[];
  expiresAt: string;
}

interface PreviewRow {
  request_id: string;
  org_id: string;
  org_name: string;
  counterparty_name: string;
  invoice_reference: string | null;
  amount: string | number;
  currency: string | null;
  due_date: string;
  missing: unknown;
  expires_at: string;
}

/** Postgres's or PostgREST's "no such table, column or function": migration 0142 has not run here yet. */
function beforeMigration(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

/** The open request a token stands for, or null for any other link; reading changes nothing. */
async function lookUp(tokenHash: string): Promise<PreviewRow | null> {
  const read = await platformDb().rpc("document_request_preview", { p_token_hash: tokenHash });
  if (read.error) {
    if (beforeMigration(read.error)) return null;
    throw new Error(read.error.message);
  }
  return ((read.data ?? []) as PreviewRow[])[0] ?? null;
}

/** Where the vendor's browser puts the file, under the request's own folder; only the upload address writes here. */
const uploadPath = (row: PreviewRow) => `${row.org_id}/document-requests/${row.request_id}/upload`;
/** Where the file is kept once checked: named by its SHA-256, out of the upload address's reach. */
const keptPath = (row: PreviewRow, sha256: string) => `${row.org_id}/document-requests/${row.request_id}/${sha256}`;

/** What the vendor's page shows (ER5), for an open, unexpired request whose bill still waits; null for any other link. */
export async function previewDocumentRequest(token: string): Promise<DocumentRequestPreview | null> {
  const tokenHash = documentTokenHash(token);
  if (!tokenHash) return null;
  const row = await lookUp(tokenHash);
  if (!row) return null;
  return {
    orgName: row.org_name,
    vendorName: row.counterparty_name,
    reference: row.invoice_reference,
    amount: Number(row.amount),
    currency: row.currency ?? "USDC",
    dueDate: row.due_date,
    missing: missingOf(row.missing),
    expiresAt: row.expires_at,
  };
}

const TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

export type UploadStart = { ok: true; url: string } | { ok: false; reason: "invalid_link" | "busy" | "no_file" | "too_large" | "file_type" | "unavailable" };

/**
 * An upload address for the vendor's file (ER5): for one PDF, PNG or JPEG of at most 10 MB, as the browser says it is;
 * the file itself is checked when it is sent. `client` is the vendor's address, for its rate limit.
 */
export async function startDocumentUpload(token: string, file: { size: number; type: string }, client: string, now: number = Date.now()): Promise<UploadStart> {
  const tokenHash = documentTokenHash(token);
  if (!tokenHash) return { ok: false, reason: "invalid_link" };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, reason: "no_file" };
  if (file.size > MAX_VENDOR_DOCUMENT_BYTES) return { ok: false, reason: "too_large" };
  if (!TYPES.has(file.type)) return { ok: false, reason: "file_type" };
  if (!takeDocumentAddressToken(client, now)) return { ok: false, reason: "busy" };
  const row = await lookUp(tokenHash);
  if (!row) return { ok: false, reason: "invalid_link" };
  if (!takeDocumentLinkToken(tokenHash, now)) return { ok: false, reason: "busy" };
  const made = await platformStorage().uploadUrl(uploadPath(row));
  if (made.error || !made.data?.signedUrl) {
    console.error("document request: no upload address", made.error?.message ?? "none");
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, url: made.data.signedUrl };
}

export type DocumentSubmission =
  | { ok: true; orgName: string }
  | { ok: false; reason: "invalid_link" | "busy" | "no_file" | "too_large" | "file_type" | "unavailable" | "failed_check" }
  | { ok: false; reason: "invalid"; field: "poReference" | "note"; message: string };

interface AnswerRow {
  outcome: "answered" | "not_valid";
  request_id: string | null;
  org_id: string | null;
  org_name: string | null;
  org_slug: string | null;
  invoice_id: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  invoice_reference: string | null;
}

/**
 * The vendor sends the file it uploaded, with an optional purchase order number and note (ER5): see the module comment.
 * The owners' and admins' email goes through `defer`, after the vendor has its page, when the caller gives one.
 */
export async function submitDocument(
  token: string,
  input: { poReference: string; note: string },
  client: string,
  options: { now?: number; defer?: (work: () => Promise<unknown>) => void } = {}
): Promise<DocumentSubmission> {
  const now = options.now ?? Date.now();
  const tokenHash = documentTokenHash(token);
  if (!tokenHash) return { ok: false, reason: "invalid_link" };
  const fields = readDocumentFields(input);
  if (!fields.ok) return { ok: false, reason: "invalid", field: fields.field, message: fields.message };
  if (!takeDocumentAddressToken(client, now)) return { ok: false, reason: "busy" };
  const row = await lookUp(tokenHash);
  if (!row) return { ok: false, reason: "invalid_link" };
  if (!takeDocumentLinkToken(tokenHash, now)) return { ok: false, reason: "busy" };

  const storage = platformStorage();
  const uploaded = uploadPath(row);
  const read = await storage.download(uploaded);
  if (read.error || !read.data) return { ok: false, reason: "no_file" };
  const bytes = new Uint8Array(await read.data.arrayBuffer());
  const refuse = async (reason: "too_large" | "file_type" | "no_file") => {
    const removed = await storage.remove([uploaded]);
    if (removed.error) console.error("document request: refused file not removed", row.request_id);
    return { ok: false as const, reason };
  };
  if (bytes.byteLength === 0) return refuse("no_file");
  if (bytes.byteLength > MAX_VENDOR_DOCUMENT_BYTES) return refuse("too_large");
  // By its first bytes, never its name or the type the browser claimed.
  const fileType = sniffDocumentType(bytes);
  if (!fileType) return refuse("file_type");
  const fileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const kept = keptPath(row, fileSha256);
  const moved = await storage.move(uploaded, kept);
  if (moved.error) {
    console.error("document request: file not kept", row.request_id, moved.error.message);
    return { ok: false, reason: "unavailable" };
  }
  const dropKept = async () => {
    const removed = await storage.remove([kept]);
    if (removed.error) console.error("document request: unused file not removed", row.request_id);
  };
  // The upload address lets the vendor's browser write the upload again while it was read and checked, so the file moved
  // may not be the one checked: it is read back from where it is kept, out of that address's reach, and taken only when
  // it is the same file.
  const again = await storage.download(kept);
  const keptBytes = again.error || !again.data ? null : new Uint8Array(await again.data.arrayBuffer());
  if (!keptBytes || crypto.createHash("sha256").update(keptBytes).digest("hex") !== fileSha256) {
    console.error("document request: kept file is not the one checked", row.request_id);
    await dropKept();
    return { ok: false, reason: "failed_check" };
  }

  const done = await platformDb().rpc("answer_document_request", {
    p_token_hash: tokenHash,
    p_file_path: kept,
    p_file_sha256: fileSha256,
    p_file_type: fileType,
    p_file_size: bytes.byteLength,
    p_po_reference: fields.poReference,
    p_note: fields.note,
  });
  if (done.error) {
    await dropKept();
    // The database's own check refused what this one passed: said as a fixed sentence.
    if (/document_request_invalid/.test(done.error.message ?? "")) return { ok: false, reason: "failed_check" };
    if (beforeMigration(done.error)) return { ok: false, reason: "invalid_link" };
    throw new Error(done.error.message);
  }
  const answered = ((done.data ?? []) as AnswerRow[])[0];
  if (!answered || answered.outcome !== "answered" || !answered.org_id || !answered.request_id || !answered.invoice_id) {
    await dropKept();
    return { ok: false, reason: "invalid_link" };
  }
  const orgId = answered.org_id;
  const vendorName = answered.counterparty_name ?? "The vendor";
  const bill = answered.invoice_reference ? `invoice ${answered.invoice_reference}` : "their invoice";

  // The answer is taken by now: what follows is recorded and told, and never undoes it. By the vendor, so by no member.
  try {
    await withOrg(orgId, () =>
      appendLedgerEntryBestEffort(orgId, {
        actor: "human",
        domain: "ap",
        action: "document_received",
        summary: `${vendorName} sent a document for ${bill}${fields.poReference ? `, with purchase order ${fields.poReference}` : ""}`,
        detail: {
          by: null,
          via: "document_request",
          invoiceId: answered.invoice_id,
          counterpartyId: answered.counterparty_id,
          requestId: answered.request_id,
          ...(fields.poReference ? { poReference: fields.poReference } : {}),
          fileSha256,
          fileType,
          fileSize: bytes.byteLength,
        },
      })
    );
  } catch {
    console.error("ledger entry not recorded", "document_received", orgId);
  }
  if (answered.org_slug) {
    const work = () =>
      notifyDocumentReceived({
        orgId,
        orgName: answered.org_name ?? "Your workspace",
        slug: answered.org_slug as string,
        invoiceId: answered.invoice_id as string,
        vendorName,
        reference: answered.invoice_reference,
        typedPo: fields.poReference !== null,
      });
    if (options.defer) {
      try {
        options.defer(work);
      } catch {
        await work();
      }
    } else await work();
  }
  return { ok: true, orgName: answered.org_name ?? row.org_name };
}
