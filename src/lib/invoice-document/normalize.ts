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
  lateFeePercentPerMonth: field,
  lateFeeAmount: field,
  lateFeeStartsOn: field,
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
  /**
   * A late fee the document states (late fees LF2), as the invoice form's three fields: named only when one was read,
   * so a reading stored before late fees reads the same. Its start is the day after the due date when it gives none.
   */
  lateFeeKind?: "percent_month" | "fixed";
  lateFeeValue?: string;
  lateFeeStartsOn?: string | null;
  payToAddress: string | null;
  memo: string | null;
}

/** A late fee as a reading names it: its three fields, all absent when it names none. */
export interface LateFeeRead {
  lateFeeKind?: string | null;
  lateFeeValue?: string | null;
  lateFeeStartsOn?: string | null;
}

/**
 * A reading's late fee as the form starts from it and a stored reading keeps it (late fees LF2): its three fields when
 * it names one, and nothing when it does not, as a reading stored before late fees does not.
 */
export function lateFeeFieldsOf(read: LateFeeRead | null | undefined): { lateFeeKind?: string; lateFeeValue?: string; lateFeeStartsOn?: string | null } {
  if (!read?.lateFeeKind || !read.lateFeeValue) return {};
  return { lateFeeKind: read.lateFeeKind, lateFeeValue: read.lateFeeValue, lateFeeStartsOn: read.lateFeeStartsOn ?? null };
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
/** The most a late fee may be a month (`LATE_FEE_MAX_PERCENT`, src/lib/agent/late-fee.ts). */
const LATE_FEE_MAX_PERCENT = 10;
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
 * A figure written with a decimal comma, as most of Europe and Vietnam write money: one or two digits after the comma,
 * and before it plain digits or groups of three set off by points or spaces. "3,50" is 3.50 and "1.200,00" is 1200.00;
 * a comma followed by three digits is a thousands separator, so "1,250" never reads this way (reader follow-up F1).
 */
const DECIMAL_COMMA = /^(\d{1,3}(?:[. ]\d{3})+|\d+),(\d{1,2})$/;

/**
 * Every amount written in the text. A comma counts as a thousands separator
 * only between groups of three digits, so "1,200.00" is 1200, and as a decimal
 * comma only before one or two final digits, so "12,50" is 12.50: never 1250.
 * Digits inside an address, a purchase order, an invoice number or a date are
 * not figures (review C1, I1; reader follow-up F1).
 */
function figures(text: string): Set<bigint> {
  const spaced = text
    .replace(/0x[0-9a-fA-F]+/g, " ")
    .replace(new RegExp(`\\b(${CURRENCY_CODES})(?=\\d)`, "gi"), "$1 ")
    .replace(new RegExp(`(\\d)(${CURRENCY_CODES})\\b`, "gi"), "$1 $2")
    // "1 200,00": thousands set off by spaces stay one figure.
    .replace(/(?<![\d.,])(\d{1,3}(?: \d{3})+),(\d{1,2})(?!\d)/g, (_figure, whole: string, cents: string) => `${whole.replace(/ /g, "")},${cents}`);
  const found = new Set<bigint>();
  for (const token of spaced.split(/\s+/)) {
    // A word that mixes letters and digits is an identifier: PO-1042, INV-2207, an IBAN.
    if (/[A-Za-z]/.test(token) && /\d/.test(token)) continue;
    for (const [figure] of token.matchAll(/(?<![\d.,\-/#])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d\-/]|[.,]\d)/g)) {
      const value = micros(figure.replace(/,/g, ""));
      if (value !== null) found.add(value);
    }
    for (const [figure] of token.matchAll(/(?<![\d.,\-/#])(?:\d{1,3}(?:\.\d{3})+|\d+),\d{1,2}(?![\d.,\-/])/g)) {
      const plain = commaDecimal(figure);
      const value = plain === null ? null : micros(plain);
      if (value !== null) found.add(value);
    }
  }
  return found;
}

/** A decimal-comma figure as a plain decimal, or null when it is not one. */
function commaDecimal(value: string): string | null {
  const match = DECIMAL_COMMA.exec(value);
  return match ? `${match[1].replace(/[. ]/g, "")}.${match[2]}` : null;
}

/**
 * The model's amount as a plain decimal, or null when it is not one: "1,200.00" is 1200.00, "3,50" is 3.50 and
 * "1.200,00" is 1200.00; a figure that is neither form, such as "1,200,5", is not read.
 */
function plainAmount(value: string): string | null {
  const bare = value
    .replace(/^[$€]\s*/, "")
    .replace(new RegExp(`\\s*(${CURRENCY_CODES})$`, "i"), "")
    .trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/.test(bare)) return bare.replace(/,/g, "");
  if (/^\d+(?:\.\d{1,6})?$/.test(bare)) return bare;
  return commaDecimal(bare);
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

/** A real `YYYY-MM-DD` calendar day: not a malformed string, nor one rolled over like Feb 30. */
export function isRealDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "3 November 2026". */
function spelled(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function isoOf(year: string, month: string, day: string): string | null {
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isRealDate(iso) ? iso : null;
}

/** Each date the text writes all in numbers that reads as two different days, day first or month first, with both. */
function swappableDates(text: string): Array<{ written: string; readings: string[] }> {
  const found: Array<{ written: string; readings: string[] }> = [];
  for (const [written, first, , second, year] of text.matchAll(/(?<![\d./-])(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?![\d./-])/g)) {
    const dayFirst = isoOf(year, second, first);
    const monthFirst = isoOf(year, first, second);
    if (dayFirst && monthFirst && dayFirst !== monthFirst) found.push({ written, readings: [dayFirst, monthFirst] });
  }
  return found;
}

/** Whether the text writes this day so it can only be it: 2026-11-03, 15/10/2026, 05.05.2026, 3 November 2026, Nov 3, 2026. */
function writtenPlainly(text: string, iso: string): boolean {
  if (text.includes(iso)) return true;
  const [year, month, day] = iso.split("-").map(Number);
  const name = `(?:${MONTHS[month - 1]}|${MONTHS[month - 1].slice(0, 3)}\\.?)`;
  const dayOf = `0?${day}(?:st|nd|rd|th)?`;
  if (new RegExp(`(?<!\\d)${dayOf}\\s+${name},?\\s+${year}|${name}\\s+${dayOf},?\\s+${year}`, "i").test(text)) return true;
  if (day <= 12 && day !== month) return false;
  // Each backreference is closed off from the year after it: "\12026" would read as one escape, not \1 then 2026.
  return new RegExp(`(?<![\\d./-])(?:0?${day}([./-])0?${month}(?:\\1)${year}|0?${month}([./-])0?${day}(?:\\2)${year})(?![\\d./-])`).test(text);
}

/**
 * A due date read from a date written all in numbers may have been the other day: 03/11/2026 is 3 November in most of
 * the world and 11 March in the United States. The model chooses; a member should know there was a choice, and which
 * one it made, as should a due date worked out from such an invoice date (reader follow-up F2). Information only.
 */
function dateNotes(text: string, dueDate: string | null, issueDate: string | null): string[] {
  // A due date the document also writes so it can only be that day leaves no choice to report.
  if (!dueDate || writtenPlainly(text, dueDate)) return [];
  const swappable = swappableDates(text);
  const due = swappable.find((date) => date.readings.includes(dueDate));
  if (due) {
    const other = due.readings.find((reading) => reading !== dueDate) ?? dueDate;
    return [`The due date, ${spelled(dueDate)}, was read from ${due.written}, which can also mean ${spelled(other)}. Check it against the invoice.`];
  }
  const issued = issueDate ? swappable.find((date) => date.readings.includes(issueDate)) : undefined;
  if (!issueDate || !issued) return [];
  const other = issued.readings.find((reading) => reading !== issueDate) ?? issueDate;
  return [
    `The due date, ${spelled(dueDate)}, was worked out from the invoice date ${issued.written}, read as ${spelled(issueDate)}; it can also mean ${spelled(other)}. Check both against the invoice.`,
  ];
}

function cut(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

/** Whether the text writes this percent as a discount: "2%", "2 %", "2/10 net 30", "2 percent" (review M3). */
function statesPercent(text: string, pct: string): boolean {
  const canonical = escapeRegExp(String(Number(pct)));
  return new RegExp(`(?<![\\d.])${canonical}(?:\\.0+)?\\s*(?:%|/|percent|pct)`, "i").test(text);
}

/** The day after a `YYYY-MM-DD` day. */
function dayAfter(iso: string): string {
  return new Date(Date.parse(`${iso}T12:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A late fee the document states (late fees LF2), checked as the discount is: a percent a month the text writes as a
 * percent, at most 10, or a fixed amount the text contains, in a currency Vestiarion pays in; not both. Its start is
 * the day written when that is a real day on or after the due date, else the day after the due date, which is what the
 * form takes a blank start as. A fee left out says why.
 */
function readLateFee(
  raw: RawExtraction,
  text: string,
  read: { dueDate: string | null; foreign: boolean; notes: string[] }
): Pick<InvoiceDraft, "lateFeeKind" | "lateFeeValue" | "lateFeeStartsOn"> | null {
  const percent = raw.lateFeePercentPerMonth?.replace(/\s*%$/, "") ?? null;
  const amount = raw.lateFeeAmount;
  if (percent === null && amount === null) return null;
  let kind: "percent_month" | "fixed";
  let value: string;
  if (percent !== null && amount !== null) {
    read.notes.push("The late fee was left out: it was read as both a percent and a fixed amount. Enter the one the invoice charges.");
    return null;
  }
  if (percent !== null) {
    if (!(DISCOUNT_PCT_PATTERN.test(percent) && Number(percent) > 0)) {
      read.notes.push("The late fee was left out: its percent could not be read as one.");
      return null;
    }
    if (Number(percent) > LATE_FEE_MAX_PERCENT) {
      read.notes.push(`The late fee was left out: it is more than ${LATE_FEE_MAX_PERCENT}% a month. Check it against the invoice, and enter it if it is right.`);
      return null;
    }
    if (!statesPercent(text, percent)) {
      read.notes.push("The late fee was left out: the document does not state that percent.");
      return null;
    }
    kind = "percent_month";
    value = percent;
  } else {
    if (read.foreign) {
      read.notes.push("The late fee was left out: it is in a currency Vestiarion does not pay in.");
      return null;
    }
    const reading = readAmount(amount, text);
    if (reading.amount === null) {
      read.notes.push(reading.why === "not_found" ? "The late fee was left out: the document does not state that amount." : "The late fee was left out: its amount could not be read as a number.");
      return null;
    }
    kind = "fixed";
    value = reading.amount;
  }
  const written = raw.lateFeeStartsOn;
  if (isRealDate(written) && (read.dueDate === null || written >= read.dueDate)) return { lateFeeKind: kind, lateFeeValue: value, lateFeeStartsOn: written };
  if (written !== null && read.dueDate !== null) {
    read.notes.push("The day the late fee starts was read as before the due date or could not be read: it is set to the day after the due date. Check it against the invoice.");
  }
  return { lateFeeKind: kind, lateFeeValue: value, lateFeeStartsOn: read.dueDate === null ? null : dayAfter(read.dueDate) };
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
  notes.push(...dateNotes(text, dueDate, isRealDate(raw.issueDate) ? raw.issueDate : null));

  // A percent the document states reaches the form even when its deadline cannot be used: the form then
  // requires a deadline, so the member enters it or clears the discount, rather than adding the invoice
  // without a discount the vendor offered (the intake rule in src/lib/intake-validation.ts).
  let earlyPayDiscountPct: string | null = null;
  let discountDeadline: string | null = null;
  const pct = raw.earlyPayDiscountPct?.replace(/\s*%$/, "") ?? null;
  const deadline = raw.discountDeadline;
  if (pct !== null || deadline !== null) {
    if (pct !== null && !(DISCOUNT_PCT_PATTERN.test(pct) && Number(pct) > 0)) {
      notes.push("The early-payment discount was left out: its percent is not between 0 and 100.");
    } else if (pct === null) {
      notes.push("The early-payment discount was left out: the invoice gives its deadline but not its percent.");
    } else if (!statesPercent(text, pct)) {
      notes.push("The early-payment discount was left out: the document does not state that percent.");
    } else if (!isRealDate(deadline)) {
      earlyPayDiscountPct = pct;
      notes.push("The discount deadline was left blank: the invoice does not give one that could be read. Enter the last day the discount applies, or clear the discount.");
    } else if (dueDate !== null && deadline > dueDate) {
      earlyPayDiscountPct = pct;
      notes.push(
        "The discount deadline was left blank: the invoice's is after its due date. Enter the last day the discount applies, on or before the due date, or clear the discount."
      );
    } else {
      earlyPayDiscountPct = pct;
      discountDeadline = deadline;
    }
  }

  const lateFee = readLateFee(raw, text, { dueDate, foreign, notes });

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
      ...(lateFee ?? {}),
      payToAddress,
      memo: cut(raw.memo, 120),
    },
    notFound,
    notes,
    modelNote: cut(raw.notes, 300),
  };
}
