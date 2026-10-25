import type { OrgDb } from "../dal";
import { ID_CHUNK } from "../new-payee-facts";

/**
 * Checking a vendor's document against its bill (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md):
 * the AP stage's read of the bills whose purchase order came from a vendor's document (DK8).
 */

/** Postgres's or PostgREST's "no such table, column or function": migration 0144 has not run here yet (DK15). */
function beforeMigration(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

/** A bill's purchase order came from this request's document, which code checked against the bill (DK7, DK8). */
export interface VendorDocument {
  requestId: string;
  /** Who sent the document: the vendor, through its link, or a member, who attached it. */
  source: "vendor" | "member";
  fileSha256: string | null;
}

/**
 * The payables among `payableIds` whose purchase order a vendor's document wrote (DK8): the request whose
 * `po_written` 0144's check_document_request set, the newest when there are more. Read once per AP stage, before
 * anything is decided. None before migration 0144, which is safe: nothing can have been written then. Any other
 * failure throws, so the stage stops rather than pays past it.
 */
export async function vendorDocumentsOf(orgDb: Pick<OrgDb, "from">, payableIds: readonly string[]): Promise<Map<string, VendorDocument>> {
  const found = new Map<string, VendorDocument>();
  for (let start = 0; start < payableIds.length; start += ID_CHUNK) {
    const read = await orgDb
      .from("document_requests")
      .select("id, invoice_id, source, file_sha256")
      .in("invoice_id", payableIds.slice(start, start + ID_CHUNK))
      .eq("po_written", true)
      .order("checked_at", { ascending: false });
    if (read.error) {
      if (beforeMigration(read.error)) return new Map();
      throw new Error(`the bills' vendor documents could not be read: ${read.error.message}`);
    }
    for (const row of (read.data ?? []) as unknown as Array<{ id: string; invoice_id: string; source: string | null; file_sha256: string | null }>) {
      if (found.has(row.invoice_id)) continue;
      found.set(row.invoice_id, { requestId: row.id, source: row.source === "member" ? "member" : "vendor", fileSha256: row.file_sha256 });
    }
  }
  return found;
}
