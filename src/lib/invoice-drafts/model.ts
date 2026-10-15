import { z } from "zod";
import type { DecisionMode } from "../agent/decide";

/**
 * A draft the Chrome extension captured (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C1-C4, C9-C11):
 * its fields, its states, what the extension is shown of it, and the rules its fields are held to. Pure and
 * browser-safe: the console's card and the server's commands read it alike. A draft is never an invoice; it becomes
 * one only when a person adds it in the console through the add-invoice command.
 */

export const DRAFT_STATES = ["draft", "sent", "confirmed", "discarded"] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

/** The fields a capture is read into, in the order the extension and the console show them. */
export const DRAFT_FIELDS = ["supplierName", "invoiceNumber", "amount", "currency", "invoiceDate", "dueDate", "poReference", "memo"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];
export type DraftFields = Record<DraftField, string | null>;

/** The text a draft keeps, at most: the reader's own limit (C9). */
export const MAX_CAPTURED_CHARS = 20_000;
/** The largest JSON body a capture or an edit may send (C20). */
export const MAX_JSON_BYTES = 100_000;
/** The captured text is removed this many days after capture, whatever the state (C9). */
export const RAW_TEXT_DAYS = 30;
/** A draft never sent is deleted this many days after capture (C10). */
export const UNSENT_DRAFT_DAYS = 7;

/** What a person needs before adding a draft as a bill, each with what the extension says while it is missing (C25). */
export const MISSING_WORDS = {
  supplierName: "No supplier was read. Type who sent the invoice.",
  invoiceNumber: "No invoice number was read. Add it, so a repeat of this invoice can be told apart.",
  amount: "No amount was read. Type the total due.",
  currency: "No currency was read. Choose USDC or EURC.",
  dueDate: "No due date was read. Add the day it is due.",
} as const satisfies Partial<Record<DraftField, string>>;
export type NeededField = keyof typeof MISSING_WORDS;

export function missingFields(fields: DraftFields): Array<{ field: NeededField; message: string }> {
  return (Object.keys(MISSING_WORDS) as NeededField[]).filter((field) => !fields[field]).map((field) => ({ field, message: MISSING_WORDS[field] }));
}

/** A picture is captured but not read: the reader reads none (C2). */
export const PICTURE_NOTE = "A picture is not read. Type the invoice's fields from it, then send the draft.";

/**
 * Text Postgres can keep: without NUL, which neither `text` nor `jsonb` takes and a PDF's text layer can hold, and
 * without half of a surrogate pair, which a cut in the middle of an emoji leaves.
 */
export function storableText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** At most `max` characters, counted as Postgres counts them (code points), never cutting one in two. */
export function firstCharacters(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length > max ? characters.slice(0, max).join("") : value;
}

const AMOUNT = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
const CURRENCY = /^[A-Z]{3,5}$/;

function isRealDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

/** A text field as the extension sends it: a string or null; blank is null; at most `max` characters. */
const text = (max: number, label: string) =>
  z
    .union([z.string(), z.null()])
    .transform((value) => (value === null ? null : storableText(value).trim() || null))
    .refine((value) => value === null || [...value].length <= max, `Keep the ${label} to ${max} characters.`);

const day = (label: string) =>
  z
    .union([z.string(), z.null()])
    .transform((value) => (value === null ? null : value.trim() || null))
    .refine((value) => value === null || isRealDay(value), `The ${label} must be a real day, written YYYY-MM-DD.`);

/**
 * The fields an edit may change (C4), each checked as the invoice form checks it: an amount of at most 6 decimals and
 * above zero, a currency code, real days, and the form's lengths. A field left out is not changed; an unknown one is
 * refused.
 */
export const draftEditSchema = z
  .object({
    supplierName: text(160, "supplier's name"),
    invoiceNumber: text(100, "invoice number"),
    amount: z
      .union([z.string(), z.null()])
      .transform((value) => (value === null ? null : value.trim() || null))
      .refine((value) => value === null || (AMOUNT.test(value) && Number(value) > 0), "Use a positive amount with at most 6 decimal places, such as 1250.00."),
    currency: z
      .union([z.string(), z.null()])
      .transform((value) => (value === null ? null : value.trim().toUpperCase() || null))
      .refine((value) => value === null || CURRENCY.test(value), "Use a currency code, such as USDC or EURC."),
    invoiceDate: day("invoice date"),
    dueDate: day("due date"),
    poReference: text(100, "purchase order"),
    memo: text(280, "memo"),
  })
  .partial()
  .strict();
export type DraftEdit = z.output<typeof draftEditSchema>;

/** The database's columns for each field. */
export const FIELD_COLUMNS = {
  supplierName: "supplier_name",
  invoiceNumber: "invoice_number",
  amount: "amount",
  currency: "currency",
  invoiceDate: "invoice_date",
  dueDate: "due_date",
  poReference: "po_reference",
  memo: "memo",
} as const satisfies Record<DraftField, string>;

/** An edit as the columns it changes. */
export function columnsOfEdit(edit: DraftEdit): Record<string, string | null> {
  const columns: Record<string, string | null> = {};
  for (const field of DRAFT_FIELDS) {
    if (field in edit) columns[FIELD_COLUMNS[field]] = edit[field] ?? null;
  }
  return columns;
}

/**
 * What the reader made of a capture, kept with the draft (C3, C5, C6): everything to check, for the console; the
 * document's own notes, for the extension; the counterparty it matched; and the fields as read, which the bill's entry
 * compares with what the person added.
 */
export interface StoredRead {
  /** Who read it; null for a picture, which is not read. */
  reader: DecisionMode | null;
  /** Everything a reviewer should check, the counterparty match's warnings included. */
  warnings: string[];
  /** What the document alone says to check, which the extension is shown: never a counterparty's name or address. */
  documentNotes: string[];
  modelNote: string | null;
  counterpartyName: string | null;
  /** The invoice form's fields as read, before anyone changed them. */
  extracted: {
    counterpartyId: string | null;
    amount: string | null;
    currency: string | null;
    dueDate: string | null;
    poReference: string | null;
    earlyPayDiscountPct: string | null;
    discountDeadline: string | null;
    memo: string | null;
  };
}

/** A draft as the database row holds it. */
export interface DraftRow {
  id: string;
  state: DraftState;
  source: "selection" | "file";
  document_kind: "pdf" | "email" | "text" | "image" | null;
  document_sha256: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  amount: string | null;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
  po_reference: string | null;
  memo: string | null;
  read: StoredRead | null;
  raw_text: string | null;
  counterparty_id: string | null;
  connection_id: string;
  idempotency_key: string;
  request_sha256: string;
  captured_by: string | null;
  captured_at: string;
  sent_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  invoice_id: string | null;
}

/** Every column a draft is read with. */
export const DRAFT_COLUMNS =
  "id, state, source, document_kind, document_sha256, supplier_name, invoice_number, amount, currency, invoice_date, due_date, po_reference, memo, read, raw_text, counterparty_id, connection_id, idempotency_key, request_sha256, captured_by, captured_at, sent_at, decided_by, decided_at, invoice_id";

/** A date column as a day: PostgREST answers `date` as `YYYY-MM-DD` already, a timestamp as more. */
function dayOf(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

export function fieldsOfRow(row: Pick<DraftRow, "supplier_name" | "invoice_number" | "amount" | "currency" | "invoice_date" | "due_date" | "po_reference" | "memo">): DraftFields {
  return {
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    amount: row.amount,
    currency: row.currency,
    invoiceDate: dayOf(row.invoice_date),
    dueDate: dayOf(row.due_date),
    poReference: row.po_reference,
    memo: row.memo,
  };
}

/** What the extension is shown of its own draft (C3, C19): its fields, what is missing and the document's notes. */
export interface ExtensionDraftView {
  id: string;
  state: DraftState;
  source: "selection" | "file";
  document: { kind: string; sha256: string } | null;
  fields: DraftFields;
  missing: Array<{ field: NeededField; message: string }>;
  notes: string[];
  capturedAt: string;
  sentAt: string | null;
  /** The console's page where it is reviewed, once it was sent. */
  reviewUrl: string | null;
}

export function extensionView(row: DraftRow, reviewUrl: string | null): ExtensionDraftView {
  const fields = fieldsOfRow(row);
  const read = row.read;
  const notes = [...(read?.documentNotes ?? []), ...(read?.modelNote ? [`The model's note: ${read.modelNote}`] : [])];
  return {
    id: row.id,
    state: row.state,
    source: row.source,
    document: row.document_kind && row.document_sha256 ? { kind: row.document_kind, sha256: row.document_sha256 } : null,
    fields,
    missing: missingFields(fields),
    notes,
    capturedAt: row.captured_at,
    sentAt: row.sent_at,
    reviewUrl: row.state === "draft" ? null : reviewUrl,
  };
}

/**
 * The memo a bill starts with in the console: the invoice number first, as an imported bill's is, then the memo, at
 * most the form's 280 characters.
 */
export function startingMemo(invoiceNumber: string | null, memo: string | null): string | null {
  const joined = [invoiceNumber, memo].filter((part): part is string => !!part && part.trim() !== "").join(" · ");
  return joined ? joined.slice(0, 280) : null;
}
