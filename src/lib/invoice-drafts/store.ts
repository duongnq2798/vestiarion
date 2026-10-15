import { db } from "../dal";
import { CaptureNotSetUpError, isMissingRelation } from "../extension/tokens";
import { draftDuplicates, type BillRow, type OtherDraft } from "./duplicates";
import { DRAFT_COLUMNS, fieldsOfRow, startingMemo, type DraftFields, type DraftRow, type StoredRead } from "./model";

/**
 * Reading and writing captured drafts (invoice capture design C1, C5, C7), inside the workspace's scope. Before
 * migration 0121 every read and write throws `CaptureNotSetUpError`, and the console's list says nothing is set up.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDraftId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function raise(error: { code?: string | null; message: string }): never {
  if (isMissingRelation(error)) throw new CaptureNotSetUpError();
  throw new Error(error.message);
}

/** The draft a connection made with this `Idempotency-Key`, if any (C19). */
export async function draftByKey(connectionId: string, idempotencyKey: string): Promise<DraftRow | null> {
  const found = await db()
    .from("invoice_drafts")
    .select(DRAFT_COLUMNS)
    .eq("connection_id", connectionId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle<DraftRow>();
  if (found.error) raise(found.error);
  return found.data;
}

/** A draft this connection captured; another's, or none, is null (C3, C19). */
export async function draftOfConnection(id: string, connectionId: string): Promise<DraftRow | null> {
  if (!isDraftId(id)) return null;
  const found = await db().from("invoice_drafts").select(DRAFT_COLUMNS).eq("id", id).eq("connection_id", connectionId).maybeSingle<DraftRow>();
  if (found.error) raise(found.error);
  return found.data;
}

export async function draftById(id: string): Promise<DraftRow | null> {
  if (!isDraftId(id)) return null;
  const found = await db().from("invoice_drafts").select(DRAFT_COLUMNS).eq("id", id).maybeSingle<DraftRow>();
  if (found.error) raise(found.error);
  return found.data;
}

/** A new draft, or `clash` when the same key arrived at the same moment, so the caller reads that one instead. */
export async function insertDraft(values: Record<string, unknown>): Promise<{ row: DraftRow } | { clash: true }> {
  const inserted = await db().from("invoice_drafts").insert(values).select(DRAFT_COLUMNS).single<DraftRow>();
  if (inserted.error) {
    if (inserted.error.code === "23505") return { clash: true };
    raise(inserted.error);
  }
  return { row: inserted.data };
}

/**
 * Moves a draft from one state to another in one guarded update, with the other columns given; the row as it is
 * after, or null when it was not in that state (or not this connection's, when one is named).
 */
export async function moveDraft(
  id: string,
  from: DraftRow["state"] | DraftRow["state"][],
  values: Record<string, unknown>,
  options: { connectionId?: string } = {}
): Promise<DraftRow | null> {
  if (!isDraftId(id)) return null;
  let query = db().from("invoice_drafts").update({ ...values, updated_at: new Date().toISOString() }).eq("id", id);
  query = Array.isArray(from) ? query.in("state", from) : query.eq("state", from);
  if (options.connectionId) query = query.eq("connection_id", options.connectionId);
  const moved = await query.select(DRAFT_COLUMNS);
  if (moved.error) raise(moved.error);
  return (moved.data as unknown as DraftRow[])[0] ?? null;
}

/** The bills a draft could repeat: those of the counterparties named, every status (C7). */
export async function billsOf(counterpartyIds: string[]): Promise<BillRow[]> {
  if (counterpartyIds.length === 0) return [];
  const found = await db()
    .from("invoices")
    .select("id, counterparty_id, amount, currency, memo, po_reference, due_date, status")
    .eq("direction", "payable")
    .in("counterparty_id", counterpartyIds);
  if (found.error) throw new Error(found.error.message);
  return found.data as BillRow[];
}

/** Other drafts that name one of these invoice numbers, sent or added (C7). */
export async function draftsNaming(invoiceNumbers: string[]): Promise<OtherDraft[]> {
  if (invoiceNumbers.length === 0) return [];
  const found = await db()
    .from("invoice_drafts")
    .select("id, state, supplier_name, invoice_number, captured_at")
    .in("invoice_number", invoiceNumbers)
    .in("state", ["sent", "confirmed"]);
  if (found.error) raise(found.error);
  return found.data as OtherDraft[];
}

/** A draft to review on Bills & receivables (C5): everything a reviewer reads, and what it may repeat. */
export interface CapturedDraftView {
  id: string;
  source: "selection" | "file";
  documentKind: DraftRow["document_kind"];
  fields: DraftFields;
  capturedAt: string;
  sentAt: string | null;
  capturedBy: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  warnings: string[];
  modelNote: string | null;
  extracted: StoredRead["extracted"] | null;
  reader: StoredRead["reader"];
  rawText: string | null;
  duplicates: string[];
}

/**
 * The drafts sent for review, newest first, at most `limit`, each with what it may repeat. `{ available: false }`
 * before migration 0121.
 */
export async function capturedDraftsToReview(limit = 50): Promise<{ available: true; drafts: CapturedDraftView[] } | { available: false }> {
  const found = await db().from("invoice_drafts").select(DRAFT_COLUMNS).eq("state", "sent").order("sent_at", { ascending: false }).limit(limit);
  if (found.error) {
    if (isMissingRelation(found.error)) return { available: false };
    throw new Error(found.error.message);
  }
  const rows = found.data as unknown as DraftRow[];
  if (rows.length === 0) return { available: true, drafts: [] };
  const counterpartyIds = [...new Set(rows.map((row) => row.counterparty_id).filter((id): id is string => id !== null))];
  const numbers = [...new Set(rows.map((row) => row.invoice_number).filter((number): number is string => !!number))];
  const [bills, others] = await Promise.all([billsOf(counterpartyIds), draftsNaming(numbers)]);
  return {
    available: true,
    drafts: rows.map((row) => {
      const fields = fieldsOfRow(row);
      return {
        id: row.id,
        source: row.source,
        documentKind: row.document_kind,
        fields,
        capturedAt: row.captured_at,
        sentAt: row.sent_at,
        capturedBy: row.captured_by,
        counterpartyId: row.counterparty_id,
        counterpartyName: row.read?.counterpartyName ?? null,
        warnings: row.read?.warnings ?? [],
        modelNote: row.read?.modelNote ?? null,
        extracted: row.read?.extracted ?? null,
        reader: row.read?.reader ?? null,
        rawText: row.raw_text,
        duplicates: draftDuplicates({ id: row.id, counterpartyId: row.counterparty_id, ...fields, memo: startingMemo(fields.invoiceNumber, fields.memo) }, bills, others),
      };
    }),
  };
}
