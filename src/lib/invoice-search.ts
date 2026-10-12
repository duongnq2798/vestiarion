import { parseAmount, toMicros, type PaymentIn } from "./allocations/model";

/**
 * Search on Bills & receivables (docs/superpowers/specs/2026-10-12-allocations-design.md L14, I09). Pure: the page
 * reads `q` from its address and keeps the invoices and payments this finds. An invoice is found by its Vestiarion id
 * (whole, or its first 8 characters or more), any part of its memo (which starts with its invoice number), its purchase
 * order, its counterparty, its amount or what is still owed on it, and a payment applied to it, by that payment's
 * transaction hash, Circle id or sender (6 characters or more).
 */

export const SEARCH_MAX = 100;
/** The shortest piece of an id that finds it. */
const ID_PREFIX = 8;
/** The shortest piece of a hash, a Circle id or an address that finds it. */
const REFERENCE_PIECE = 6;

export interface SearchQuery {
  /** As typed, trimmed, at most `SEARCH_MAX` characters. */
  text: string;
  lower: string;
  /** The amount it reads as, in millionths, or null. */
  amount: number | null;
}

export function parseSearch(raw: string | undefined): SearchQuery | null {
  const text = (raw ?? "").trim().slice(0, SEARCH_MAX);
  if (text === "") return null;
  return { text, lower: text.toLowerCase(), amount: parseAmount(text) };
}

export interface SearchableInvoice {
  id: string;
  memo: string | null;
  po_reference: string | null;
  counterparty_name: string;
  amount: number;
}

export interface SearchExtras {
  /** What is still owed on a part-paid receivable, in millionths. */
  outstanding?: number;
  /** The payments applied to it, or matched to it whole. */
  payments?: ReadonlyArray<{ txHash: string | null; circleTxId: string; from: string | null }>;
}

export type SearchMatch = "id" | "memo" | "po" | "counterparty" | "amount" | "outstanding" | "payment";

const contains = (value: string | null | undefined, lower: string) => Boolean(value && value.toLowerCase().includes(lower));

function namesPayment(query: SearchQuery, payment: { txHash: string | null; circleTxId: string; from: string | null }): boolean {
  if (query.lower.length < REFERENCE_PIECE) return false;
  return contains(payment.txHash, query.lower) || contains(payment.circleTxId, query.lower) || contains(payment.from, query.lower);
}

/** Why an invoice is found, the first reason in the order above; null when it is not. */
export function invoiceMatch(query: SearchQuery, invoice: SearchableInvoice, extras: SearchExtras = {}): SearchMatch | null {
  const id = invoice.id.toLowerCase();
  if (id === query.lower || (query.lower.length >= ID_PREFIX && id.startsWith(query.lower))) return "id";
  if (contains(invoice.memo, query.lower)) return "memo";
  if (contains(invoice.po_reference, query.lower)) return "po";
  if (contains(invoice.counterparty_name, query.lower)) return "counterparty";
  if (query.amount !== null && toMicros(invoice.amount) === query.amount) return "amount";
  if (query.amount !== null && extras.outstanding !== undefined && extras.outstanding === query.amount) return "outstanding";
  if ((extras.payments ?? []).some((payment) => namesPayment(query, payment))) return "payment";
  return null;
}

/** Whether a payment is found: its hash, Circle id or sender, or its amount. */
export function paymentMatches(query: SearchQuery, payment: PaymentIn): boolean {
  if (query.amount !== null && payment.amount === query.amount) return true;
  return namesPayment(query, payment);
}
