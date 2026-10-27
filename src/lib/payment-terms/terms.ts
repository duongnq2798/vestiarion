/**
 * The payment terms calculator's terms and dates (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT1, PT2):
 * terms as someone types them, read with the invoice reader's own `readWrittenTerms` plus "n/30" and EOM, and the
 * discount deadline and due date they give from an invoice date. Every day is a calendar day, `YYYY-MM-DD`, counted in
 * UTC as in src/lib/agent/payment-timing.ts. Pure and browser-safe.
 */

import { readWrittenTerms } from "./read";

/** Terms as the calculator reads them. */
export interface PaymentTerms {
  /** The percent off and the days it lasts; null for net terms alone. */
  discount: { pct: number; days: number } | null;
  /** The days to the due date. */
  netDays: number;
  /** "EOM": the days count from the last day of the invoice's month, not the invoice date. */
  endOfMonth: boolean;
}

export type TermsRead = { ok: true; terms: PaymentTerms } | { ok: false; message: string };

/** The longest terms the calculator takes. */
export const MAX_NET_DAYS = 365;

const EXAMPLES = '"2/10 net 30", "net 45" or "net 30 EOM"';
const END_OF_MONTH = /\bEOM\b|\bend\s+of\s+(?:the\s+)?month\b/i;
const END_OF_MONTH_ALL = new RegExp(END_OF_MONTH.source, "gi");
/** "n/30", as in "2/10 n/30", for "net 30". */
const N_SLASH = /\bn\s*\/\s*(\d+)/gi;
/** "2% 10" or "2%/10", as in "1% 10 net 30", for "2/10". */
const PERCENT_DAYS = /(\d+(?:\.\d+)?)\s*%\s*\/?\s*(\d+)/g;
/** "days", as in "2/10 days, net 30 days": the days are counted either way. */
const DAYS_WORD = /\bdays?\b/gi;
/** Anything that looks like a discount: a "d/D", or a percent left over once "2% 10" is read as "2/10". */
const DISCOUNT_LIKE = /\d+(?:\.\d+)?\s*\/\s*\d+|%/g;

/**
 * What someone typed as terms, or what is wrong with it: never a guess (PT1). Before the invoice reader's
 * `readWrittenTerms` sees the terms, "n/30" becomes "net 30", "2% 10" becomes "2/10", and the words "days" and EOM go,
 * EOM being read on its own; so "2/10 EOM, n/30" and "1% 10 net 30" read as their discount. A discount it still cannot
 * read, such as one written after the net days ("net 30, 2/10"), or more than one, is refused, never dropped.
 */
export function parseTerms(text: string): TermsRead {
  if (text.trim() === "") return { ok: false, message: `Enter the terms as the invoice writes them, such as ${EXAMPLES}.` };
  const plain = text.replace(N_SLASH, "net $1").replace(PERCENT_DAYS, "$1/$2").replace(DAYS_WORD, " ").replace(END_OF_MONTH_ALL, " ");
  const written = readWrittenTerms(plain);
  if (!written) return { ok: false, message: `These terms could not be read. Write them as ${EXAMPLES}.` };
  if ((plain.match(DISCOUNT_LIKE)?.length ?? 0) !== (written.discount ? 1 : 0)) {
    return { ok: false, message: 'A discount in these terms could not be read. Write it as "2/10 net 30" or "2% 10 net 30", with one discount at most.' };
  }
  const pct = written.discount ? Number(written.discount.pct) : null;
  if (pct !== null && !(pct > 0 && pct < 100)) return { ok: false, message: "A discount is more than 0% and less than 100%." };
  if (written.netDays > MAX_NET_DAYS) return { ok: false, message: `Net days are at most ${MAX_NET_DAYS}.` };
  if (written.discount && written.discount.days >= written.netDays) {
    return { ok: false, message: "The discount's days must be fewer than the net days: 2/10 net 30 gives 10 days for the discount and 30 to pay." };
  }
  return {
    ok: true,
    terms: {
      discount: written.discount && pct !== null ? { pct, days: written.discount.days } : null,
      netDays: written.netDays,
      endOfMonth: END_OF_MONTH.test(text),
    },
  };
}

/** Terms written the usual way: "2/10 net 30", "net 30 EOM". */
export function termsWords(terms: PaymentTerms): string {
  const net = `net ${terms.netDays}${terms.endOfMonth ? " EOM" : ""}`;
  return terms.discount ? `${terms.discount.pct}/${terms.discount.days} ${net}` : net;
}

/** The path of a term's page under /payment-terms: "2-10-net-30", "net-30-eom". */
export function termSlug(terms: PaymentTerms): string {
  return termsWords(terms).toLowerCase().replace(/[^a-z0-9.]+/g, "-");
}

/** A real `YYYY-MM-DD` calendar day: not a malformed string, nor one rolled over like Feb 30. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(at.valueOf()) && at.toISOString().slice(0, 10) === value;
}

/** The calendar day `days` after `day`. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The last day of `day`'s month. */
function lastDayOfMonth(day: string): string {
  const [year, month] = day.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * The dates an invoice's terms give (PT2): the day the days count from (the invoice date, or the last day of its month
 * for EOM), the discount deadline, the last day the discount applies, and the due date. Every calendar day is counted.
 */
export function termDates(invoiceDate: string, terms: PaymentTerms): { countFrom: string; discountDeadline: string | null; dueOn: string } {
  const countFrom = terms.endOfMonth ? lastDayOfMonth(invoiceDate) : invoiceDate;
  return {
    countFrom,
    discountDeadline: terms.discount ? addDays(countFrom, terms.discount.days) : null,
    dueOn: addDays(countFrom, terms.netDays),
  };
}

/** A figure as people write it, "1,250.00", "12 345" or "1.5%"; null when it is not one. Never negative. */
export function readFigure(text: string): number | null {
  const plain = text.trim().replace(/%$/, "").replace(/[,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(plain)) return null;
  return Number(plain);
}

/** A whole number of days, "30"; null when it is not one. */
export function readWholeNumber(text: string): number | null {
  const plain = text.trim();
  return /^\d+$/.test(plain) ? Number(plain) : null;
}

const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** An amount as the page shows it, with 2 decimals, "1,000.00", or with as many as `decimals` asks for. */
export function money(value: number, decimals = 2): string {
  if (decimals === 2) return MONEY.format(value);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

/** A yearly rate, a fraction, as a percent with one decimal: 0.37245 is "37.2%". */
export function percentWords(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** A figure in a formula, as short as it is exact: 98, 98.5. */
export function plainFigure(value: number): string {
  return String(Number(value.toFixed(6)));
}
