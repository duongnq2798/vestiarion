import { db } from "../dal";
import { CaptureNotSetUpError, isMissingRelation } from "../extension/tokens";
import { draftDuplicates, type BillRow, type OtherDraft } from "./duplicates";
import { DRAFT_COLUMNS, fieldsOfRow, REVIEW_LIMIT, startingMemo, type DraftFields, type DraftRow, type DraftSource, type StoredRead } from "./model";

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

/**
 * The payee link a payee's draft came through (0133), for the bill's entry; null when it names none. Read on its own,
 * so every other read of a draft stays as it was before 0133 added the column.
 */
export async function draftPayeeLink(id: string): Promise<string | null> {
  if (!isDraftId(id)) return null;
  const found = await db().from("invoice_drafts").select("payee_link_id").eq("id", id).maybeSingle<{ payee_link_id: string | null }>();
  if (found.error) raise(found.error);
  return found.data?.payee_link_id ?? null;
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

/** How many drafts never sent this connection keeps, counted up to `atMost` (M8). */
export async function unsentDraftCount(connectionId: string, atMost: number): Promise<number> {
  const found = await db().from("invoice_drafts").select("id").eq("connection_id", connectionId).eq("state", "draft").limit(atMost);
  if (found.error) raise(found.error);
  return (found.data as unknown[]).length;
}

/** Whether a bill with this id is in the workspace: a captured draft's, looked for after a failure (I1). */
export async function invoiceExists(id: string): Promise<boolean> {
  const found = await db().from("invoices").select("id").eq("id", id).maybeSingle<{ id: string }>();
  if (found.error) throw new Error(found.error.message);
  return found.data !== null;
}

/** The supplier's name a draft read, for Counterparties' Add counterparty to start from (I2); null for none. */
export async function draftSupplierName(id: string): Promise<string | null> {
  if (!isDraftId(id)) return null;
  const found = await db().from("invoice_drafts").select("supplier_name").eq("id", id).maybeSingle<{ supplier_name: string | null }>();
  if (found.error) raise(found.error);
  return found.data?.supplier_name ?? null;
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
  source: DraftSource;
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
  duplicates: string[];
  /** The payee's note, on an invoice it sent through its payee link (P4). */
  note?: string | null;
}

/** Every column the review list reads: all but the captured text, which is read when a person opens it. */
const REVIEW_COLUMNS = DRAFT_COLUMNS.split(", ").filter((column) => column !== "raw_text").join(", ");

/**
 * The drafts sent for review, newest first, at most `REVIEW_LIMIT` (`more` when there are others), each with what it
 * may repeat. Never their captured text: the list is part of every Bills & receivables page and its refreshes, and
 * the text is read by `capturedText` when someone opens it. `{ available: false }` before migration 0121.
 */
export async function capturedDraftsToReview(): Promise<{ available: true; drafts: CapturedDraftView[]; more: boolean } | { available: false }> {
  const found = await db().from("invoice_drafts").select(REVIEW_COLUMNS).eq("state", "sent").order("sent_at", { ascending: false }).limit(REVIEW_LIMIT + 1);
  if (found.error) {
    if (isMissingRelation(found.error)) return { available: false };
    throw new Error(found.error.message);
  }
  const all = found.data as unknown as DraftRow[];
  const more = all.length > REVIEW_LIMIT;
  const rows = all.slice(0, REVIEW_LIMIT);
  if (rows.length === 0) return { available: true, drafts: [], more: false };
  const counterpartyIds = [...new Set(rows.map((row) => row.counterparty_id).filter((id): id is string => id !== null))];
  const numbers = [...new Set(rows.map((row) => row.invoice_number).filter((number): number is string => !!number))];
  const [bills, others] = await Promise.all([billsOf(counterpartyIds), draftsNaming(numbers)]);
  return {
    available: true,
    more,
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
        duplicates: draftDuplicates(
          { id: row.id, counterpartyId: row.counterparty_id, ...fields, memo: startingMemo(fields.invoiceNumber, fields.memo ?? row.read?.note ?? null) },
          bills,
          others
        ),
        ...(row.source === "payee_link" ? { note: row.read?.note ?? null } : {}),
      };
    }),
  };
}

/**
 * The text a draft was read from, for the person reviewing it (C9): null when it was removed, as it is once the draft
 * is decided or 30 days after capture, or for a draft not sent for review.
 */
export async function capturedText(id: string): Promise<string | null> {
  if (!isDraftId(id)) return null;
  const found = await db().from("invoice_drafts").select("raw_text, state").eq("id", id).maybeSingle<{ raw_text: string | null; state: string }>();
  if (found.error) raise(found.error);
  return found.data?.state === "sent" ? found.data.raw_text : null;
}
