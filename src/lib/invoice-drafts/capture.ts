import { documentPayToOf } from "../invoice-document/provenance";
import { createHash } from "node:crypto";
import { readInvoiceDocument } from "../invoice-document/draft";
import { MAX_DOCUMENT_BYTES } from "../invoice-document/read";
import { firstCharacters, MAX_CAPTURED_CHARS, PICTURE_NOTE, startingMemo, storableText, type DraftFields, type StoredRead } from "./model";

/**
 * Reads what the extension captured into a draft's fields (invoice capture design C2, C3, C9): selected text, or a
 * file of at most 4 MB. A PDF, a `.txt` or an `.eml` goes through `readInvoiceDocument`, the reader From a document
 * and every chat use, with its checks against the document; a picture is not read, and its draft starts blank. The
 * file itself is never kept: only its kind and SHA-256, and the text read from it. Runs inside the workspace's scope,
 * since the reader matches the workspace's counterparties; throws `DocumentReadError` for a document it cannot read.
 */

export type CaptureInput = { source: "selection"; text: string } | { source: "file"; bytes: Uint8Array; name: string; type: string };

export interface CaptureRead {
  fields: DraftFields;
  read: StoredRead;
  document: { kind: "pdf" | "email" | "text" | "image"; sha256: string };
  /** The text read, kept for the reviewer until the draft is decided (C9); null for a picture. */
  rawText: string | null;
  counterpartyId: string | null;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What makes two captures the same capture, for an `Idempotency-Key` (C19): the source and its content. */
export function captureRequestHash(input: CaptureInput): string {
  return input.source === "selection" ? sha256(`selection\n${input.text}`) : sha256(`file\n${sha256(input.bytes)}`);
}

/** A PNG, a JPEG, a GIF or a WebP, by its first bytes. */
export function isPicture(bytes: Uint8Array): boolean {
  const starts = (...head: number[]) => head.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return true;
  if (starts(0xff, 0xd8, 0xff)) return true;
  if (starts(0x47, 0x49, 0x46, 0x38)) return true;
  return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

/** Whether the capture fits the caps (C20): at most 20,000 characters selected, at most 4 MB in a file. */
export function captureTooLarge(input: CaptureInput): string | null {
  if (input.source === "selection" && [...input.text].length > MAX_CAPTURED_CHARS) return "Select at most 20,000 characters.";
  if (input.source === "file" && input.bytes.length > MAX_DOCUMENT_BYTES) return "Choose a file of at most 4 MB.";
  return null;
}

const BLANK: DraftFields = {
  supplierName: null,
  invoiceNumber: null,
  amount: null,
  currency: null,
  invoiceDate: null,
  dueDate: null,
  poReference: null,
  memo: null,
};

/** Every string in what was read, as Postgres can keep it (`storableText`). */
function storable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === "string" ? storableText(item) : item)) as T;
}

export async function readCapture(input: CaptureInput, today: string): Promise<CaptureRead> {
  return storable(await read(input, today));
}

async function read(input: CaptureInput, today: string): Promise<CaptureRead> {
  if (input.source === "file" && isPicture(input.bytes)) {
    return {
      fields: BLANK,
      read: {
        reader: null,
        warnings: [PICTURE_NOTE],
        documentNotes: [PICTURE_NOTE],
        modelNote: null,
        counterpartyName: null,
        extracted: { counterpartyId: null, amount: null, currency: null, dueDate: null, poReference: null, earlyPayDiscountPct: null, discountDeadline: null, memo: null },
      },
      document: { kind: "image", sha256: sha256(input.bytes) },
      rawText: null,
      counterpartyId: null,
    };
  }

  const document = await readInvoiceDocument(input.source === "selection" ? { text: input.text } : { bytes: input.bytes, name: input.name, type: input.type }, today);
  const { draft } = document.read;
  const fields: DraftFields = {
    supplierName: draft.vendorName,
    invoiceNumber: draft.invoiceNumber,
    amount: draft.amount,
    currency: draft.currency,
    invoiceDate: document.issueDate,
    dueDate: draft.dueDate,
    poReference: draft.poReference,
    memo: draft.memo,
  };
  return {
    fields,
    read: {
      reader: document.read.reader,
      ...(documentPayToOf(draft) ? { payTo: documentPayToOf(draft) as string } : {}),
      warnings: document.read.warnings,
      documentNotes: document.documentWarnings,
      modelNote: document.read.modelNote,
      counterpartyName: document.read.counterpartyName,
      extracted: {
        counterpartyId: draft.counterpartyId,
        amount: draft.amount,
        currency: draft.currency,
        dueDate: draft.dueDate,
        poReference: draft.poReference,
        earlyPayDiscountPct: draft.earlyPayDiscountPct,
        discountDeadline: draft.discountDeadline,
        memo: startingMemo(draft.invoiceNumber, draft.memo),
      },
    },
    document: { kind: document.read.document.kind, sha256: document.read.document.sha256 },
    rawText: firstCharacters(storableText(document.text), MAX_CAPTURED_CHARS),
    counterpartyId: draft.counterpartyId,
  };
}
