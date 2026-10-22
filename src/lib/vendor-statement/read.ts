import { findHeaderRow, headerWords, suggestColumns, type ColumnMapping } from "../bank-statement/columns";
import { readStatement, type StatementChoices, type StatementLine, type StatementRead } from "../bank-statement/lines";
import { readTable } from "../bank-statement/table";
import { billDigits } from "../bill-amount";

/**
 * Reading a vendor's statement of account (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS2), with the
 * bank statement's reader: the same table, header row, dates and amounts, asked when they read two ways. What differs
 * is the columns and the sign. A vendor writes its invoices as charges (debits) and our payments as credits, so its
 * charge is the bank reader's money out, and a single amount column writes a charge as a positive value unless the
 * person says otherwise. Pure and browser-safe: the browser and the server read the same text the same way.
 */

/** What a vendor's statement header names, beyond a bank's: its invoice or document number, its charges and payments. */
const NUMBER = /\b(invoice|inv|document|doc|number|no|nr|ref|reference|bill)\b/;
const CHARGES = /\b(charge|charges|charged|invoiced|billed|amount due|invoice amount|debit|debits|dr)\b/;
const PAYMENTS = /\b(payment|payments|paid|received|receipt|receipts|credit|credits|cr)\b/;
const DESCRIPTION = /\b(type|transaction|description|details|memo|narrative|particulars)\b/;

/**
 * The columns a vendor's statement most likely has, from its header row: the bank reader's suggestion, then a number
 * column, a charges and a payments column, and a description, where it found none. A header takes one role.
 */
export function suggestVendorColumns(headers: readonly string[]): ColumnMapping {
  const mapping = suggestColumns(headers);
  const taken = new Set(Object.values(mapping).filter((index): index is number => index !== null));
  const first = (pattern: RegExp) => headers.findIndex((header, index) => !taken.has(index) && pattern.test(headerWords(header)));
  const fill = (role: keyof ColumnMapping, pattern: RegExp) => {
    if (mapping[role] !== null) return;
    const index = first(pattern);
    if (index !== -1) {
      mapping[role] = index;
      taken.add(index);
    }
  };
  // A "Balance" column is the bank reader's already; an invoice number is this reader's reference.
  fill("reference", NUMBER);
  fill("moneyOut", CHARGES);
  fill("moneyIn", PAYMENTS);
  fill("description", DESCRIPTION);
  // Charges and payments in two columns win over a lone amount, as in the bank reader. A lone amount beside only one of
  // them is the other: "Invoice Amount" beside "Payments" is the charges, "Amount paid" beside "Charges" the payments.
  if (mapping.moneyOut !== null && mapping.moneyIn !== null) mapping.amount = null;
  else if (mapping.amount !== null && mapping.moneyIn !== null) [mapping.moneyOut, mapping.amount] = [mapping.amount, null];
  else if (mapping.amount !== null && mapping.moneyOut !== null) [mapping.moneyIn, mapping.amount] = [mapping.amount, null];
  return mapping;
}

/**
 * The statement read with the person's choices (VS2): the vendor's columns when none were chosen, a single amount
 * column's charges positive unless the person said otherwise, and the bank reader's questions and problems.
 */
export function readVendorStatement(source: string, choices: StatementChoices, today: string): StatementRead {
  let columns = choices.columns ?? null;
  if (!columns) {
    const table = readTable(source, choices.delimiter ?? undefined);
    const headerRow = choices.headerRow != null ? choices.headerRow : findHeaderRow(table.records);
    columns = headerRow >= 0 && table.records[headerRow] ? suggestVendorColumns(table.records[headerRow].cells) : null;
  }
  // A charge is money out of the business; a vendor writes it positive unless told otherwise. Its lines are named by their
  // number, so a description is optional, and a debit balance is what is owed to the vendor.
  const outIs = choices.outIs ?? "positive";
  return readStatement(source, { ...choices, outIs, ...(columns ? { columns } : {}) }, today, { descriptionOptional: true, owedBalance: true });
}

/** A statement line as the matching reads it (VS3): a charge (their invoice) or a payment they received. */
export interface VendorStatementLine {
  line: number;
  on: string;
  /** The invoice or document number it names, as written; null when the line names none. */
  number: string | null;
  description: string;
  kind: "charge" | "payment";
  /** Positive, in the currency's major units. */
  amount: number;
  currency: string;
  /** The running balance after it, in major units, when the statement prints one. */
  balance: number | null;
}

/** The bank reader's lines as a vendor's (VS2): money out is their charge, money in a payment they received. */
export function vendorLines(lines: readonly StatementLine[]): VendorStatementLine[] {
  return lines
    .filter((line) => line.minor !== 0)
    .map((line) => {
      // In the currency's minor units, as the bank reader read them.
      const scale = 10 ** billDigits(line.currency);
      return {
        line: line.line,
        on: line.bookedOn,
        number: line.reference.trim() || null,
        description: line.description || line.payee,
        kind: line.minor < 0 ? ("charge" as const) : ("payment" as const),
        amount: Math.abs(line.minor) / scale,
        currency: line.currency,
        balance: line.balance === null ? null : line.balance / scale,
      };
    });
}
