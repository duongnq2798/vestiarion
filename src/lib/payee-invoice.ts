import type { DocumentReadErrorCode } from "./invoice-document/read";
import { storableText } from "./invoice-drafts/model";

/**
 * The invoice a payee sends through its payee link (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P4):
 * an invoice number, the amount in USDC, a due date from today to a year ahead, and optionally a note and the invoice
 * as a PDF or text file. Checked here, in the payee's words, before anything is read or written, and again by the
 * database (0133). Pure and browser-safe: the page's form reads the same limits.
 */

/** The longest invoice number, as a captured draft keeps it (0121). */
export const PAYEE_INVOICE_NUMBER_MAX = 100;
/** The longest note. */
export const PAYEE_INVOICE_NOTE_MAX = 500;
/**
 * The largest file, in bytes: the document reader's limit (src/lib/invoice-document/read.ts), which the page also checks
 * before sending, since a request much larger never reaches the server (next.config.ts allows 5 MB).
 */
export const PAYEE_FILE_MAX_BYTES = 4_000_000;

export type PayeeInvoiceField = "invoiceNumber" | "amount" | "dueDate" | "note" | "file";

/** What the payee reads when a field is not right: fixed sentences, never what failed inside. */
export const PAYEE_INVOICE_MESSAGES: Record<PayeeInvoiceField, string> = {
  invoiceNumber: "Enter your invoice number: up to 100 characters on one line, with no link.",
  amount: "Enter the amount in USDC, more than 0 with at most 6 decimals, such as 1250.00.",
  dueDate: "Choose a due date from today to a year from today.",
  note: "Keep the note to 500 characters of plain text.",
  file: "Choose a PDF or a text file.",
};

/** What the payee reads when the file cannot be read, by the reader's reason (src/lib/invoice-document/read.ts). */
export const PAYEE_FILE_MESSAGES: Record<DocumentReadErrorCode, string> = {
  too_large: "Choose a file of at most 4 MB.",
  unsupported: "Choose a PDF or a text file.",
  scan: "This PDF has no text to read; it may be a scan. Send your invoice without the file, or choose a PDF with text.",
  empty: "This file has no text to read. Send your invoice without it, or choose another file.",
};

const AMOUNT = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Any control character: an invoice number is one line of plain text. */
const CONTROL = /\p{Cc}/u;
/** Any control character but a line break: a note may have lines, and nothing else unseen. */
const CONTROL_BUT_LINE_BREAK = /(?!\n)\p{Cc}/u;
/** A link, which an invoice number never needs and a reviewer might open. */
const LINK = /:\/\/|\bwww\./i;

/** A real `YYYY-MM-DD` day, or null. */
function realDay(value: string): string | null {
  if (!DAY.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value) ? value : null;
}

/** The same day a year later, as Postgres adds a year: the 29th of February becomes the 28th. */
export function yearAfter(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year + 1, month - 1, date, 12));
  if (next.getUTCMonth() !== month - 1) next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
}

export interface PayeeInvoice {
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  note: string | null;
}

/**
 * The fields as the page sends them, checked; `today` is the UTC day. The payee's words are plain text: an invoice
 * number on one line with no control character and no link, a note whose only control character is a line break (a
 * browser sends a text box's line breaks as CR LF, read here as one).
 */
export function readPayeeInvoice(
  raw: { invoiceNumber: string; amount: string; dueDate: string; note: string },
  today: string
): { ok: true; invoice: PayeeInvoice } | { ok: false; field: PayeeInvoiceField; message: string } {
  const refuse = (field: PayeeInvoiceField) => ({ ok: false as const, field, message: PAYEE_INVOICE_MESSAGES[field] });
  // Checked as sent, before anything is dropped from it.
  if (CONTROL.test(raw.invoiceNumber.trim()) || LINK.test(raw.invoiceNumber)) return refuse("invoiceNumber");
  const invoiceNumber = storableText(raw.invoiceNumber).trim();
  if (invoiceNumber === "" || [...invoiceNumber].length > PAYEE_INVOICE_NUMBER_MAX) return refuse("invoiceNumber");
  const amount = raw.amount.trim();
  if (!AMOUNT.test(amount) || !(Number(amount) > 0)) return refuse("amount");
  const dueDate = realDay(raw.dueDate.trim());
  if (!dueDate || dueDate < today || dueDate > yearAfter(today)) return refuse("dueDate");
  const lines = raw.note.replace(/\r\n?/g, "\n").trim();
  if (CONTROL_BUT_LINE_BREAK.test(lines)) return refuse("note");
  const note = storableText(lines);
  if ([...note].length > PAYEE_INVOICE_NOTE_MAX) return refuse("note");
  return { ok: true, invoice: { invoiceNumber, amount, dueDate, note: note || null } };
}
