import { z } from "zod";
import type { InvoiceCurrency } from "@/lib/intake-validation";

/**
 * What the model read from an invoice, checked by code against the document
 * itself (invoice from a document D4). The model proposes; this decides what
 * reaches the form. A figure the document does not contain is left blank
 * rather than trusted, so neither a model's slip nor an instruction hidden in
 * the document can put an amount on the form that the invoice never stated.
 */

/** Any field, as a model might send it: a string, a number, null or nothing at all. */
const field = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : String(value).trim() || null));

export const rawExtractionSchema = z.object({
  vendorName: field,
  invoiceNumber: field,
  amount: field,
  currency: field,
  issueDate: field,
  dueDate: field,
  poReference: field,
  earlyPayDiscountPct: field,
  discountDeadline: field,
  payToAddress: field,
  payToChain: field,
  memo: field,
  notes: field,
});

export type RawExtraction = z.output<typeof rawExtractionSchema>;

/** The invoice form's fields as read from a document, every one blank when it could not be read. */
export interface InvoiceDraft {
  vendorName: string | null;
  invoiceNumber: string | null;
  amount: string | null;
  currency: InvoiceCurrency | null;
  dueDate: string | null;
  poReference: string | null;
  earlyPayDiscountPct: string | null;
  discountDeadline: string | null;
  payToAddress: string | null;
  memo: string | null;
}

export type NotFoundField = "amount" | "poReference" | "payToAddress";

export interface NormalizedExtraction {
  fields: InvoiceDraft;
  /** Fields the model gave that the document's text does not contain: blanked. */
  notFound: NotFoundField[];
  /** Why a value was left out, in words for the member. */
  notes: string[];
  /** The model's own note on what to check, shown as the model's: it can be wrong. */
  modelNote: string | null;
}

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;
const DISCOUNT_PCT_PATTERN = /^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** A decimal string as millionths, or null when it has more than 6 places. */
function micros(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]) * BigInt(1_000_000) + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** Every figure written in the text, thousands separators removed: "1,200.00" is one figure, 1200. */
function figures(text: string): Set<bigint> {
  const found = new Set<bigint>();
  for (const [token] of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = micros(token.replace(/,/g, ""));
    if (value !== null) found.add(value);
  }
  return found;
}

function readAmount(value: string | null, text: string): { amount: string | null; notFound: boolean } {
  if (value === null) return { amount: null, notFound: false };
  const cleaned = value.replace(/[,\s]/g, "").replace(/^[$€]/, "");
  const scaled = AMOUNT_PATTERN.test(cleaned) ? micros(cleaned) : null;
  if (scaled === null || scaled <= BigInt(0)) return { amount: null, notFound: false };
  return figures(text).has(scaled) ? { amount: cleaned, notFound: false } : { amount: null, notFound: true };
}

const CURRENCIES: Record<string, InvoiceCurrency> = {
  USDC: "USDC",
  USD: "USDC",
  $: "USDC",
  US$: "USDC",
  EURC: "EURC",
  EUR: "EURC",
  "€": "EURC",
  EURO: "EURC",
  EUROS: "EURC",
};

function isRealDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function cut(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

export function normalizeExtraction(raw: RawExtraction, text: string): NormalizedExtraction {
  const notFound: NotFoundField[] = [];
  const notes: string[] = [];
  const lowerText = text.toLowerCase();

  const amount = readAmount(raw.amount, text);
  if (amount.notFound) notFound.push("amount");

  let currency: InvoiceCurrency | null = null;
  if (raw.currency !== null) {
    currency = CURRENCIES[raw.currency.toUpperCase()] ?? null;
    if (currency === null) notes.push(`The invoice is in ${raw.currency}. Vestiarion pays in USDC or EURC: choose one, at the amount you agree with the vendor.`);
  }

  let poReference: string | null = null;
  if (raw.poReference !== null) {
    if (lowerText.includes(raw.poReference.toLowerCase())) poReference = cut(raw.poReference, 100);
    else notFound.push("poReference");
  }

  // The address is taken as the document writes it, so its checksum casing is the vendor's own.
  let payToAddress: string | null = null;
  if (raw.payToAddress !== null && ADDRESS_PATTERN.test(raw.payToAddress)) {
    const at = lowerText.indexOf(raw.payToAddress.toLowerCase());
    if (at === -1) notFound.push("payToAddress");
    else payToAddress = text.slice(at, at + raw.payToAddress.length);
  }

  const dueDate = isRealDate(raw.dueDate) ? raw.dueDate : null;

  let earlyPayDiscountPct: string | null = null;
  let discountDeadline: string | null = null;
  const pct = raw.earlyPayDiscountPct?.replace(/\s*%$/, "") ?? null;
  const deadline = raw.discountDeadline;
  if (pct !== null || deadline !== null) {
    if (pct !== null && !(DISCOUNT_PCT_PATTERN.test(pct) && Number(pct) > 0)) {
      notes.push("The early-payment discount was left out: its percent is not between 0 and 100.");
    } else if (pct === null || !isRealDate(deadline)) {
      notes.push("The early-payment discount was left out: the invoice gives its percent or its deadline, not both.");
    } else if (dueDate !== null && deadline > dueDate) {
      notes.push("The early-payment discount was left out: its deadline is after the due date.");
    } else {
      earlyPayDiscountPct = pct;
      discountDeadline = deadline;
    }
  }

  return {
    fields: {
      vendorName: cut(raw.vendorName, 160),
      invoiceNumber: cut(raw.invoiceNumber, 100),
      amount: amount.amount,
      currency,
      dueDate,
      poReference,
      earlyPayDiscountPct,
      discountDeadline,
      payToAddress,
      memo: cut(raw.memo, 120),
    },
    notFound,
    notes,
    modelNote: cut(raw.notes, 300),
  };
}
