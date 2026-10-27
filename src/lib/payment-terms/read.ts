/**
 * Payment terms written as text (docs/superpowers/specs/2026-10-28-payment-terms-design.md PT1): "2/10 net 30", a percent
 * off within a number of days and the full amount in a number of days, or "net 30" alone. The one reader both the
 * invoice reader without a model (`ruleBasedExtraction`, src/lib/invoice-document/extract.ts) and the payment terms
 * calculator use. Pure and browser-safe.
 */

/** Terms as an invoice writes them. */
export interface WrittenTerms {
  /** The percent off as written ("2", "1.5"), and the days it lasts from the invoice date; null for net terms alone. */
  discount: { pct: string; days: number } | null;
  /** The days from the invoice date to the due date. */
  netDays: number;
}

const DISCOUNT_TERMS = /(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*,?\s*net\s*(\d+)/i;
const NET_TERMS = /\bnet\s*(\d+)\b/i;

/** The first "d/D net N" anywhere in the text, else the first "net N"; null when it has neither. */
export function readWrittenTerms(text: string): WrittenTerms | null {
  const discount = text.match(DISCOUNT_TERMS);
  if (discount) return { discount: { pct: discount[1], days: Number(discount[2]) }, netDays: Number(discount[3]) };
  const net = text.match(NET_TERMS);
  return net ? { discount: null, netDays: Number(net[1]) } : null;
}
