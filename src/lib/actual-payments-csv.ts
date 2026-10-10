import { actualCurrency, actualMethod, paidDay, REFERENCE_MAX, type ActualMethod, type ActualRecord } from "./actual-payment-fields";
import { billAmount, billDigits } from "./bill-amount";
import { normalizedHeader, rowsFromCsv } from "./csv-rows";

/**
 * What the business paid, from a CSV (docs/superpowers/specs/2026-10-10-actual-payments-design.md A6). Each row names a
 * payable by its Vestiarion invoice id or by its invoice number, with the day paid, the amount, and optionally the
 * currency (the bill's own when blank), a reference and the method (other when blank). Pure: the preview and the save
 * both match the rows against the payables they read, so what is saved is what the preview said, read again.
 *
 * Vestiarion keeps no invoice-number field, so a number matches the one payable whose memo carries it as a whole word.
 */

export const ACTUALS_CSV_MAX_ROWS = 200;
export const ACTUALS_CSV_MAX_BYTES = 1_000_000;

export interface ActualsCsvRow {
  /** The row's line in the file, the header being line 1. */
  line: number;
  invoice: string;
  paidDate: string;
  amount: string;
  currency: string;
  reference: string;
  method: string;
}

/** A payable as the matcher reads it: its memo for an invoice number, its own currency, and its newest record. */
export interface MatchBill {
  id: string;
  memo: string | null;
  payee: string;
  amount: number;
  currency: string;
  /** The bill as written, when it was in a currency of its own. */
  bill: { amount: number; currency: string } | null;
  dueDate: string | null;
  current: ActualRecord | null;
}

export interface MatchedRecord {
  paidOn: string;
  amount: number;
  currency: string;
  method: ActualMethod;
  reference: string | null;
}

export type PreviewRow =
  | { line: number; status: "new" | "correction" | "same"; invoiceId: string; payee: string; record: MatchedRecord; replaces: string | null }
  | { line: number; status: "unmatched" | "invalid"; invoice: string; why: string };

const COLUMNS: Record<keyof Omit<ActualsCsvRow, "line">, readonly string[]> = {
  invoice: ["invoice", "invoice_id", "invoice_number"],
  paidDate: ["paid_date", "paid_on"],
  amount: ["amount"],
  currency: ["currency"],
  reference: ["reference"],
  method: ["method"],
};
const REQUIRED = ["invoice", "paidDate", "amount"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A file that cannot be read as a payments CSV, in words to show the person who chose it. */
export class ActualsCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActualsCsvError";
  }
}

export function parseActualsCsv(csv: string): ActualsCsvRow[] {
  let rows: string[][];
  try {
    rows = rowsFromCsv(csv.replace(/^\uFEFF/, ""));
  } catch {
    throw new ActualsCsvError("The CSV has a quoted field that is never closed.");
  }
  if (rows.length === 0) throw new ActualsCsvError("The CSV is empty.");
  const headers = rows[0].map(normalizedHeader);
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, headers.findIndex((header) => names.includes(header))])) as Record<keyof typeof COLUMNS, number>;
  const missing = REQUIRED.filter((key) => at[key] === -1).map((key) => COLUMNS[key][0]);
  if (missing.length > 0) throw new ActualsCsvError(`Missing CSV column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);

  const cell = (values: string[], key: keyof typeof COLUMNS) => (at[key] === -1 ? "" : (values[at[key]] ?? "").trim());
  const read = rows.slice(1).flatMap((values, index) => {
    const row: ActualsCsvRow = {
      line: index + 2,
      invoice: cell(values, "invoice"),
      paidDate: cell(values, "paidDate"),
      amount: cell(values, "amount"),
      currency: cell(values, "currency"),
      reference: cell(values, "reference"),
      method: cell(values, "method"),
    };
    // A row not filled in, such as the template's, is no payment.
    return row.paidDate === "" && row.amount === "" ? [] : [row];
  });
  if (read.length === 0) throw new ActualsCsvError("The CSV has a header but no payment.");
  if (read.length > ACTUALS_CSV_MAX_ROWS) throw new ActualsCsvError(`Import at most ${ACTUALS_CSV_MAX_ROWS} payments at a time.`);
  return read;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The payables a row names: the one with its id, or those whose memo carries its number as a whole word. */
function billsNamed(invoice: string, bills: readonly MatchBill[]): { found: MatchBill[]; byId: boolean } {
  if (UUID.test(invoice)) return { found: bills.filter((bill) => bill.id.toLowerCase() === invoice.toLowerCase()), byId: true };
  const number = invoice.replace(/^#/, "").trim();
  if (number === "") return { found: [], byId: false };
  const word = new RegExp(`(^|[^A-Za-z0-9])${escaped(number)}([^A-Za-z0-9]|$)`, "i");
  return { found: bills.filter((bill) => bill.memo !== null && word.test(bill.memo)), byId: false };
}

/** The bill's own currency: as written, when it was in a currency of its own, else the invoice's. */
const ownCurrency = (bill: MatchBill) => bill.bill?.currency ?? bill.currency;

function sameAsRecorded(record: MatchedRecord, current: ActualRecord): boolean {
  return (
    current.outcome === "paid" &&
    current.paidOn === record.paidOn &&
    current.currency === record.currency &&
    current.amount !== null &&
    Math.abs(current.amount - record.amount) < 0.5 * 10 ** -billDigits(record.currency) &&
    current.method === record.method &&
    (current.reference ?? null) === record.reference
  );
}

/** Each row as it would be saved, or why it would not. */
export function matchActualsCsv(rows: readonly ActualsCsvRow[], bills: readonly MatchBill[], today: string): PreviewRow[] {
  const firstLine = new Map<string, number>();
  return rows.map((row): PreviewRow => {
    const invalid = (why: string): PreviewRow => ({ line: row.line, status: "invalid", invoice: row.invoice, why });
    if (row.invoice === "") return invalid("The invoice column is empty.");
    const { found, byId } = billsNamed(row.invoice, bills);
    if (found.length === 0) {
      return { line: row.line, status: "unmatched", invoice: row.invoice, why: byId ? "No payable in this workspace has that id." : "No payable carries that invoice number in its memo." };
    }
    if (found.length > 1) {
      return { line: row.line, status: "unmatched", invoice: row.invoice, why: `${found.length} payables carry that invoice number in their memo. Use the Vestiarion invoice id instead.` };
    }
    const bill = found[0];
    const paidOn = paidDay(row.paidDate, today);
    if (!paidOn) return invalid("The paid date is not a day on or before tomorrow, written as YYYY-MM-DD.");
    const currency = row.currency === "" ? ownCurrency(bill) : actualCurrency(row.currency);
    if (!currency) return invalid("The currency is not a three-letter code, USDC or EURC.");
    const amount = billAmount(row.amount, currency);
    if (amount === null) return invalid("The amount is not one above zero, such as 1,250.00.");
    const method = actualMethod(row.method);
    if (!method) return invalid("The method is not bank transfer, card, cash or other.");
    if (row.reference.length > REFERENCE_MAX) return invalid(`Keep the reference to ${REFERENCE_MAX} characters.`);
    const before = firstLine.get(bill.id);
    if (before !== undefined) return invalid(`Row ${before} is for the same bill.`);
    firstLine.set(bill.id, row.line);

    const record: MatchedRecord = { paidOn, amount, currency, method, reference: row.reference === "" ? null : row.reference };
    const status = !bill.current ? "new" : sameAsRecorded(record, bill.current) ? "same" : "correction";
    return { line: row.line, status, invoiceId: bill.id, payee: bill.payee, record, replaces: bill.current?.id ?? null };
  });
}

/** A field as a CSV writes it: quoted when it holds a comma, a quote or a line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const fixed = (amount: number, currency: string) => amount.toFixed(billDigits(currency));

/**
 * The bills not recorded yet, ready to fill in and import: each with its id, payee, own amount and currency and due
 * day, and the currency to pay in set to the bill's own. The columns the import does not read are there to recognise
 * each bill by.
 */
export function actualsCsvTemplate(bills: readonly MatchBill[]): string {
  const header = "invoice,payee,bill_amount,bill_currency,due_date,paid_date,amount,currency,method,reference";
  const lines = bills.map((bill) => {
    const own = bill.bill ?? { amount: bill.amount, currency: bill.currency };
    return [bill.id, csvField(bill.payee), fixed(own.amount, own.currency), own.currency, bill.dueDate ? bill.dueDate.slice(0, 10) : "", "", "", own.currency, "", ""].join(",");
  });
  return [header, ...lines].join("\n");
}
