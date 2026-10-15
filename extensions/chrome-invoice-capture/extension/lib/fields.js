/**
 * A draft's fields as the popup shows them, and what it says while one a bill needs is missing. The words are
 * Vestiarion's own (src/lib/invoice-drafts/model.ts MISSING_WORDS); a test holds the two to each other.
 */

export const FIELDS = [
  { name: "supplierName", label: "Supplier", type: "text", max: 160 },
  { name: "invoiceNumber", label: "Invoice number", type: "text", max: 100 },
  { name: "amount", label: "Amount", type: "text", max: 21 },
  { name: "currency", label: "Currency", type: "currency" },
  { name: "invoiceDate", label: "Invoice date", type: "date" },
  { name: "dueDate", label: "Due date", type: "date" },
  { name: "poReference", label: "Purchase order", type: "text", max: 100 },
  { name: "memo", label: "Memo", type: "text", max: 280 },
];

export const MISSING_WORDS = {
  supplierName: "No supplier was read. Type who sent the invoice.",
  invoiceNumber: "No invoice number was read. Add it, so a repeat of this invoice can be told apart.",
  amount: "No amount was read. Type the total due.",
  currency: "No currency was read. Choose USDC or EURC.",
  dueDate: "No due date was read. Add the day it is due.",
};

/** The fields a bill needs that are still empty, each with its words. */
export function missingOf(fields) {
  return Object.keys(MISSING_WORDS)
    .filter((name) => !fields[name] || String(fields[name]).trim() === "")
    .map((name) => ({ field: name, message: MISSING_WORDS[name] }));
}

/** An amount as Vestiarion takes it: a positive number with at most 6 decimals, no thousands separators. */
export function amountProblem(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(text) || Number(text) <= 0) {
    return "Use a positive amount with at most 6 decimal places, such as 1250.00.";
  }
  return null;
}
