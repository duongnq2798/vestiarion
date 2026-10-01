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
/** A purchase order as people write one: letters, digits and separators, with at least one digit. */
const PO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9#/.\- ]{2,}$/;
const CURRENCY_CODES = "USDC|EURC|USD|EUR";

/** A decimal string as millionths, or null when it has more than 6 places. */
function micros(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]) * BigInt(1_000_000) + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every amount written in the text. A comma counts as a thousands separator
 * only between groups of three digits, so "1,200.00" is 1200 and "12,50" is
 * no figure at all, rather than 1250. Digits inside an address, a purchase
 * order, an invoice number or a date are not figures (review C1, I1).
 */
function figures(text: string): Set<bigint> {
  const spaced = text
    .replace(/0x[0-9a-fA-F]+/g, " ")
    .replace(new RegExp(`\\b(${CURRENCY_CODES})(?=\\d)`, "gi"), "$1 ")
    .replace(new RegExp(`(\\d)(${CURRENCY_CODES})\\b`, "gi"), "$1 $2");
  const found = new Set<bigint>();
  for (const token of spaced.split(/\s+/)) {
    // A word that mixes letters and digits is an identifier: PO-1042, INV-2207, an IBAN.
    if (/[A-Za-z]/.test(token) && /\d/.test(token)) continue;
    for (const [figure] of token.matchAll(/(?<![\d.,\-/#])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d\-/]|[.,]\d)/g)) {
      const value = micros(figure.replace(/,/g, ""));
      if (value !== null) found.add(value);
    }
  }
  return found;
}

/** The model's amount as a plain decimal, or null when it is not one: "1,200.00" is 1200.00; "12,50" and "1.200,00" are not read. */
function plainAmount(value: string): string | null {
  const bare = value
    .replace(/^[$€]\s*/, "")
    .replace(new RegExp(`\\s*(${CURRENCY_CODES})$`, "i"), "")
    .trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/.test(bare)) return bare.replace(/,/g, "");
  if (/^\d+(?:\.\d{1,6})?$/.test(bare)) return bare;
  return null;
}

type AmountReading = { amount: string } | { amount: null; why: "absent" | "unreadable" | "not_found" };

function readAmount(value: string | null, text: string): AmountReading {
  if (value === null) return { amount: null, why: "absent" };
  const plain = plainAmount(value);
  const scaled = plain !== null && AMOUNT_PATTERN.test(plain) ? micros(plain) : null;
  if (plain === null || scaled === null || scaled <= BigInt(0)) return { amount: null, why: "unreadable" };
  return figures(text).has(scaled) ? { amount: plain } : { amount: null, why: "not_found" };
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

/** Whether the text writes this percent as a discount: "2%", "2 %", "2/10 net 30", "2 percent" (review M3). */
function statesPercent(text: string, pct: string): boolean {
  const canonical = escapeRegExp(String(Number(pct)));
  return new RegExp(`(?<![\\d.])${canonical}(?:\\.0+)?\\s*(?:%|/|percent|pct)`, "i").test(text);
}

export function normalizeExtraction(raw: RawExtraction, text: string): NormalizedExtraction {
  const notFound: NotFoundField[] = [];
  const notes: string[] = [];
  const lowerText = text.toLowerCase();

  // A currency Vestiarion does not pay in leaves the amount blank too: the
  // figure is not a USDC or EURC amount, and must not sit beside one (review I2).
  let currency: InvoiceCurrency | null = null;
  let foreign = false;
  if (raw.currency !== null) {
    currency = CURRENCIES[raw.currency.toUpperCase()] ?? null;
    if (currency === null) {
      foreign = true;
      const named = /^[A-Za-z$€£¥]{1,5}$/.test(raw.currency) ? raw.currency : "another currency";
      notes.push(`The invoice is in ${named}. Vestiarion pays in USDC or EURC: choose one, and type the amount you agree with the vendor.`);
    }
  }

  const reading = foreign ? ({ amount: null, why: "absent" } as const) : readAmount(raw.amount, text);
  if (reading.amount === null && reading.why === "not_found") notFound.push("amount");
  if (reading.amount === null && reading.why === "unreadable") notes.push("The amount could not be read as a number. Type it in from the invoice.");

  // A purchase order must read as one, and stand on its own in the text: "PO-104" is not in "PO-1042" (review M2).
  let poReference: string | null = null;
  if (raw.poReference !== null) {
    const standsAlone = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(raw.poReference)}(?![A-Za-z0-9])`, "i");
    if (PO_PATTERN.test(raw.poReference) && /\d/.test(raw.poReference) && standsAlone.test(text)) poReference = cut(raw.poReference, 100);
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
    } else if (!statesPercent(text, pct)) {
      notes.push("The early-payment discount was left out: the document does not state that percent.");
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
      amount: reading.amount,
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
