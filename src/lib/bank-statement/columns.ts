import type { TableRecord } from "./table";
import { looksLikeDate } from "./values";

/**
 * Which column of a statement is which (docs/superpowers/specs/2026-10-10-bank-statement-design.md B2, B3): suggested
 * from the header's words, in English and a few banks' own languages, for the person to confirm or change. Pure and
 * browser-safe.
 */

export const ROLES = ["bookingDate", "valueDate", "description", "payee", "amount", "moneyOut", "moneyIn", "reference", "currency", "balance"] as const;
export type Role = (typeof ROLES)[number];

/** Each role's column, by its index in the row; null when the statement has none. */
export type ColumnMapping = Record<Role, number | null>;

/** Each role in words, for the person mapping the columns. */
export const ROLE_WORDS: Record<Role, string> = {
  bookingDate: "Booking date",
  valueDate: "Value date",
  description: "Description",
  payee: "Payee",
  amount: "Amount",
  moneyOut: "Money out",
  moneyIn: "Money in",
  reference: "Reference",
  currency: "Currency",
  balance: "Balance",
};

export const NO_COLUMNS: ColumnMapping = Object.fromEntries(ROLES.map((role) => [role, null])) as ColumnMapping;

/** A header's words: lower case, accents and punctuation dropped, spaces collapsed. */
export function headerWords(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The words that name each role, tried in this order on each header: the first that matches takes it. */
const RULES: ReadonlyArray<readonly [Role, RegExp]> = [
  ["balance", /\b(balance|saldo|solde|kontostand)\b/],
  ["valueDate", /\b(value date|valuta\w*|wertstellung|date valeur|effective date)\b/],
  ["bookingDate", /\b(date|datum|buchungstag|buchungsdatum|fecha|posted|posting)\b/],
  ["moneyOut", /\b(debit|debits|withdrawal|withdrawals|withdrawn|money out|paid out|outflow|out|soll|dr)\b/],
  ["moneyIn", /\b(credit|credits|deposit|deposits|money in|paid in|inflow|in|haben|cr)\b/],
  ["amount", /\b(amount|amt|betrag|montant|importe|umsatz)\b/],
  ["currency", /\b(currency|ccy|curr|cur|wahrung|devise|moneda)\b/],
  ["reference", /\b(reference|ref|ref no|cheque|check|transaction id|id|end to end id)\b/],
  ["payee", /\b(payee|beneficiary|counterparty|counter party|recipient|merchant|name|empfanger|auftraggeber|other party)\b/],
  ["description", /\b(description|narrative|details|detail|particulars|remarks|memo|verwendungszweck|buchungstext|libelle|purpose|text)\b/],
];

/** The column each role most likely is, from the header row's words. A header takes one role, a role one header. */
export function suggestColumns(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = { ...NO_COLUMNS };
  headers.forEach((header, index) => {
    const words = headerWords(header);
    if (words === "") return;
    const rule = RULES.find(([role, pattern]) => mapping[role] === null && pattern.test(words));
    if (rule) mapping[rule[0]] = index;
  });
  return mapping;
}

const HEADER_SEARCH = 30;

/**
 * The header row, as an index into the records: the first of the first 30 whose cells name a date column and an amount
 * (or money out, or money in) column. When none does, -1 (no header) if the first row already holds a date, else 0.
 */
export function findHeaderRow(records: readonly TableRecord[]): number {
  const found = records.slice(0, HEADER_SEARCH).findIndex((record) => {
    const mapping = suggestColumns(record.cells);
    return mapping.bookingDate !== null && (mapping.amount !== null || mapping.moneyOut !== null || mapping.moneyIn !== null);
  });
  if (found !== -1) return found;
  return records[0]?.cells.some(looksLikeDate) ? -1 : 0;
}
