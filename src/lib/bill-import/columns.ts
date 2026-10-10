import type { Table } from "./table";

/**
 * Which column of a bill list holds which part of an invoice (import design B3). A column is matched from the names
 * businesses give it; the person sees every match and changes any of them before anything is read further.
 * Browser-safe and pure.
 */

export const IMPORT_FIELDS = [
  "counterparty",
  "amount",
  "dueDate",
  "invoiceNumber",
  "poReference",
  "currency",
  "memo",
  "goodsReceived",
  "direction",
  "discountPct",
  "discountDeadline",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** The column each field is read from, by its index; a field left out is not in the list. */
export type ColumnMapping = Partial<Record<ImportField, number>>;

/** Each field as the panel names it. */
export const FIELD_LABELS: Record<ImportField, string> = {
  counterparty: "Counterparty",
  amount: "Amount",
  dueDate: "Due date",
  invoiceNumber: "Invoice number",
  poReference: "Purchase order",
  currency: "Currency",
  memo: "Memo",
  goodsReceived: "Goods received",
  direction: "Bill or invoice",
  discountPct: "Early-payment discount (%)",
  discountDeadline: "Discount deadline",
};

/** The fields a row cannot be added without. */
export const REQUIRED_FIELDS: readonly ImportField[] = ["counterparty", "amount", "dueDate"];

/** A header as compared: lower case, without spaces, dots, dashes, underscores, slashes, `#`, `%` or brackets. */
export function headerKey(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s._\-/#%()[\]:'’]+/g, "");
}

/**
 * The names each field is known by, as `headerKey` reads them, most telling first. A bare "Date", an "Invoice date" or a
 * "Type" is never taken: the first two are not the due date, and a list's "Type" is often a category.
 */
const SYNONYMS: Record<ImportField, readonly string[]> = {
  counterparty: [
    "counterparty", "vendor", "supplier", "payee", "customer", "client", "vendorname", "suppliername", "payeename",
    "customername", "clientname", "company", "companyname", "name", "billfrom", "billedto",
  ],
  amount: [
    "amountdue", "balancedue", "amount", "total", "totalamount", "grandtotal", "invoiceamount", "billamount",
    "amountpayable", "openamount", "outstanding", "balance",
  ],
  dueDate: ["duedate", "due", "paymentdue", "dueon", "datedue", "payby", "paymentduedate"],
  invoiceNumber: ["invoiceno", "invoicenumber", "invoice", "billno", "billnumber", "number", "reference", "ref", "documentno", "invoiceid"],
  poReference: ["poreference", "po", "ponumber", "pono", "purchaseorder", "purchaseorderno", "purchaseordernumber", "poref"],
  currency: ["currency", "ccy", "cur", "currencycode"],
  memo: ["memo", "description", "details", "notes", "note", "item", "items"],
  goodsReceived: ["goodsreceived", "received", "delivered", "goodsorservicesreceived"],
  direction: ["direction", "apar", "payablereceivable"],
  discountPct: ["earlypaydiscountpct", "discount", "earlypaymentdiscount", "discountpct", "discountpercent"],
  discountDeadline: ["discountdeadline", "discountuntil", "discountby", "discountdate"],
};

const KNOWN = new Set(Object.values(SYNONYMS).flat());

/** Whether a row reads as column names: at least one of its cells is a name a field is known by. */
export function looksLikeHeader(cells: readonly string[]): boolean {
  return cells.some((cell) => KNOWN.has(headerKey(cell)));
}

/** Each field's column, from the list's column names: a column goes to one field, the first in `IMPORT_FIELDS`. */
export function detectMapping(headers: readonly string[]): ColumnMapping {
  const keys = headers.map(headerKey);
  const taken = new Set<number>();
  const mapping: ColumnMapping = {};
  for (const field of IMPORT_FIELDS) {
    for (const synonym of SYNONYMS[field]) {
      const index = keys.findIndex((key, column) => key === synonym && !taken.has(column));
      if (index >= 0) {
        mapping[field] = index;
        taken.add(index);
        break;
      }
    }
  }
  return mapping;
}

/** A column's letter, as a spreadsheet shows it: A, B, …, Z, AA. */
export function columnLetter(index: number): string {
  let letters = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/** How many columns the widest row has. */
export function columnCount(table: Table): number {
  return table.rows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
}

/** The columns' names: the first row's, when it holds them, or "Column A", "Column B". */
export function columnNames(table: Table, hasHeader: boolean): string[] {
  const header = hasHeader ? table.rows[0]?.cells ?? [] : [];
  return Array.from({ length: columnCount(table) }, (_, index) => header[index]?.trim() || `Column ${columnLetter(index)}`);
}

/** The bills' rows: every row after the column names, or every row when there are none. */
export function billRows(table: Table, hasHeader: boolean): Table["rows"] {
  return hasHeader ? table.rows.slice(1) : table.rows;
}

/** Up to `count` values a column holds, blanks skipped: shown beside the field so the person sees what it reads. */
export function sampleValues(table: Table, hasHeader: boolean, column: number, count = 3): string[] {
  const values: string[] = [];
  for (const row of billRows(table, hasHeader)) {
    const value = row.cells[column]?.trim() ?? "";
    if (value !== "") values.push(value);
    if (values.length === count) break;
  }
  return values;
}
