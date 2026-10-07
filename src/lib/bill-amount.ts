/**
 * A bill's amount as it is written on the bill, in its own currency (docs/superpowers/specs/2026-10-07-shadow-mode-
 * design.md S6), and the USDC it comes to at a rate. Browser-safe and pure.
 *
 * A currency without minor units, such as the dong or the yen, groups its thousands with dots, commas or spaces and
 * has no decimals: 2.500.000 VND is two and a half million. Any other takes at most two decimals, after a dot or a
 * comma, with its thousands grouped by the other mark or by spaces: 1,234.56 and 1.234,56 are the same amount.
 */

/** ISO 4217 currencies written without minor units. */
const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW", "CLP", "ISK", "PYG", "UGX", "XAF", "XOF", "XPF", "KMF", "GNF", "RWF", "VUV", "BIF", "DJF"]);

const GROUPED_WHOLE = /^\d{1,3}(?:([., ])\d{3})(?:\1\d{3})*$/;

function wholeAmount(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (GROUPED_WHOLE.test(text)) return Number(text.replace(/[., ]/g, ""));
  return null;
}

function decimalAmount(text: string): number | null {
  if (/^\d+(?:[.,]\d{1,2})?$/.test(text)) return Number(text.replace(",", "."));
  const commaThousands = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;
  if (commaThousands.test(text)) return Number(text.replace(/,/g, ""));
  const dotThousands = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/;
  if (dotThousands.test(text)) return Number(text.replace(/\./g, "").replace(",", "."));
  const spaceThousands = /^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/;
  if (spaceThousands.test(text)) return Number(text.replace(/ /g, "").replace(",", "."));
  return null;
}

/** How many decimals a currency writes: none for one without minor units, such as the yen; two otherwise. */
export function billDigits(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(currency.trim().toUpperCase()) ? 0 : 2;
}

/** The amount, or null when the text is not one a bill writes, or is not above zero. */
export function billAmount(typed: string, currency: string): number | null {
  const text = typed.trim();
  if (text === "") return null;
  const amount = ZERO_DECIMAL.has(currency.trim().toUpperCase()) ? wholeAmount(text) : decimalAmount(text);
  return amount !== null && Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** The USDC an amount comes to, at `perUsd` of its currency to the dollar, to the cent; null below a cent. */
export function usdcFor(amount: number, perUsd: number): number | null {
  const usdc = Math.round((amount / perUsd) * 100) / 100;
  return usdc >= 0.01 ? usdc : null;
}
