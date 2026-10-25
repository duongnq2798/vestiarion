import crypto from "node:crypto";
import { missingDetails } from "../added-details";
import { can, type OrgRole } from "../auth/roles";
import { currentOrgId } from "../context";
import { db, platformDb, platformStorage } from "../dal";
import { MAX_DOCUMENT_BYTES } from "../invoice-document/read";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { missingDocuments, sniffDocumentType } from "./rules";
import { documentChecksMode, readDocumentChecksStatus } from "./setting";

/**
 * An owner or admin attaches the vendor's document to a bill
 * (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK11): a purchase order or a delivery note a
 * vendor emailed the business, checked by the cycle as one sent through a request's link is. Offered while vendor
 * requests are in shadow or on, once migration 0144 has run, on a payable that waits for its purchase order or goods
 * receipt with no payment sent for it.
 *
 * One PDF of at most 4,000,000 bytes, known by its first bytes, never by its name or the type the browser claimed. It is
 * kept in the workspace's private storage at `{org}/document-requests/{id}/{sha256}`, by an upload that never
 * overwrites, before 0144's attach_document inserts the answered member row: a file the function refuses is removed.
 * Signed as `document_received { by, via: "attached" }`, best effort: the row is there by then. Attaching changes nothing
 * on the bill; the cycle's check, and a person's approval, do the rest (DK7, DK8). Runs inside the workspace's scope.
 */

/** Why an attachment was refused, in the words the dialog shows (DK11). */
export type AttachRefusal = "forbidden" | "invalid_file" | "same_file" | "busy" | "not_waiting" | "off" | "not_ready";

export const ATTACH_MESSAGES: Record<AttachRefusal, string> = {
  forbidden: "Only an owner or admin can attach a document.",
  invalid_file: "Choose a PDF of up to 4 MB.",
  same_file: "This file is already on this bill.",
  busy: "The last document attached to this bill is still waiting to be checked. Try again in a minute.",
  not_waiting: "This bill no longer waits for a purchase order or goods receipt. Reload the page to see it.",
  off: "Turn on vendor requests in Settings, in shadow or on, to check documents.",
  not_ready: "Checking documents is not available in this workspace yet.",
};

/** What the dialog says once the document is attached. */
export const ATTACHED = "Attached. Vestiarion checks it within a minute.";

export class AttachDocumentError extends Error {
  constructor(readonly code: AttachRefusal) {
    super(ATTACH_MESSAGES[code]);
    this.name = "AttachDocumentError";
  }
}

/** Postgres's or PostgREST's "no such table, column or function": migration 0144 has not run here yet (DK15). */
function beforeMigration(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

interface BillRow {
  id: string;
  direction: string;
  status: string;
  memo: string | null;
  po_reference: string | null;
  goods_received: boolean | null;
  tx_ref: string | null;
  counterparty_id: string;
  counterparties: { name: string; purchase_order_required?: boolean | null } | null;
}

/** Attaches `bytes` to the bill: see the module comment. Returns the new request's id and how it is checked. */
export async function attachDocument(input: {
  actorId: string;
  role: OrgRole;
  invoiceId: string;
  bytes: Uint8Array;
}): Promise<{ requestId: string; mode: "shadow" | "on" }> {
  if (!can(input.role, "records.write")) throw new AttachDocumentError("forbidden");
  const { bytes } = input;
  // By its first bytes, before anything is read or stored.
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_BYTES || sniffDocumentType(bytes) !== "application/pdf") throw new AttachDocumentError("invalid_file");

  const status = await readDocumentChecksStatus(db());
  if (!status.checks) throw new AttachDocumentError("not_ready");
  const mode = documentChecksMode(status);
  if (!mode) throw new AttachDocumentError("off");

  const read = await db()
    .from("invoices")
    .select("id, direction, status, memo, po_reference, goods_received, tx_ref, counterparty_id, counterparties(name, purchase_order_required)")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (read.error) throw new Error(`the bill could not be read: ${read.error.message}`);
  const bill = read.data as unknown as BillRow | null;
  const missing =
    bill && bill.direction === "payable" && bill.status === "awaiting_info" && bill.tx_ref === null
      ? missingDocuments(
          missingDetails({ poReference: bill.po_reference, goodsReceived: bill.goods_received === true, purchaseOrderRequired: bill.counterparties?.purchase_order_required !== false })
        )
      : [];
  if (!bill || missing.length === 0) throw new AttachDocumentError("not_waiting");

  const orgId = currentOrgId();
  const requestId = crypto.randomUUID();
  const fileSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const path = `${orgId}/document-requests/${requestId}/${fileSha256}`;
  const storage = platformStorage();
  const stored = await storage.upload(path, bytes, "application/pdf");
  if (stored.error) throw new Error(`the document could not be stored: ${stored.error.message}`);
  const drop = async () => {
    const removed = await storage.remove([path]).catch(() => null);
    if (!removed || removed.error) console.error("attached document: refused file not removed", requestId);
  };

  const done = await platformDb().rpc("attach_document", {
    p_org_id: orgId,
    p_id: requestId,
    p_invoice_id: bill.id,
    p_by: input.actorId,
    p_missing: missing,
    p_file_path: path,
    p_file_sha256: fileSha256,
    p_file_size: bytes.byteLength,
  });
  if (done.error) {
    await drop();
    if (beforeMigration(done.error)) throw new AttachDocumentError("not_ready");
    throw new Error(done.error.message);
  }
  if (done.data !== "attached") {
    await drop();
    throw new AttachDocumentError(done.data === "busy" || done.data === "same_file" ? done.data : "not_waiting");
  }

  const vendorName = bill.counterparties?.name ?? "The vendor";
  const invoice = bill.memo?.trim() ? `invoice ${bill.memo.trim()}` : "their invoice";
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "document_received",
    summary: `A member attached ${vendorName}'s document for ${invoice}`,
    // Who attached it and the file's hash: never the document's text.
    detail: {
      by: input.actorId,
      via: "attached",
      invoiceId: bill.id,
      counterpartyId: bill.counterparty_id,
      requestId,
      fileSha256,
      fileType: "application/pdf",
      fileSize: bytes.byteLength,
    },
  });
  return { requestId, mode };
}
