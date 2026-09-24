export interface InvoiceCsvRow {
  direction: string;
  counterparty: string;
  amount: string;
  memo: string;
  po_reference: string;
  goods_received: string;
  due_date: string;
}

const REQUIRED_HEADERS = [
  "direction",
  "counterparty",
  "amount",
  "memo",
  "po_reference",
  "goods_received",
  "due_date",
] as const;

function rowsFromCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]+/g, "_");
}

export function parseInvoiceCsv(csv: string): InvoiceCsvRow[] {
  const rows = rowsFromCsv(csv.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one invoice row");

  const headers = rows[0].map(normalizedHeader);
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Missing CSV column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);

  return rows.slice(1).map((values) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]));
    return Object.fromEntries(REQUIRED_HEADERS.map((header) => [header, record[header] ?? ""])) as unknown as InvoiceCsvRow;
  });
}

export const INVOICE_CSV_TEMPLATE = `${REQUIRED_HEADERS.join(",")}\npayable,Vendor name,100.00,Invoice memo,PO-100,true,2026-10-15`;
