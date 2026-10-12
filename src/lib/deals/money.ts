import { billAmount, billDigits } from "../bill-amount";

/**
 * A deal's money (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D2, D3), kept in minor units: cents for
 * USDC, EURC and two-decimal currencies, whole units for a currency without minor units, such as the yen or the won.
 * Integers throughout, so the lines of a schedule add up to its total exactly. Browser-safe and pure.
 */

/** The largest total a deal takes, in minor units: well inside a safe integer, and `bigint` in the database. */
export const MAX_TOTAL_MINOR = 1_000_000_000_000_000;

/** The currencies paid on Arc. Any other is taken in shadow mode only, and converted when a line is released. */
export const ARC_CURRENCIES = ["USDC", "EURC"] as const;

/** How many decimals a deal's currency writes: two for USDC and EURC, the currency's own otherwise. */
export function dealDigits(currency: string): 0 | 2 {
  return billDigits(currency);
}

/**
 * The deal's currency as typed, in capitals: USDC or EURC anywhere; any other three-letter code only in shadow mode, as
 * the invoice form takes a bill in the business's own currency. Never VND: crypto is no means of payment in Vietnam.
 * Null otherwise.
 */
export function dealCurrency(typed: string, workspace: { shadowOn: boolean }): string | null {
  const code = typed.trim().toUpperCase();
  if ((ARC_CURRENCIES as readonly string[]).includes(code)) return code;
  if (!/^[A-Z]{3}$/.test(code) || code === "VND") return null;
  return workspace.shadowOn ? code : null;
}

const ARC_AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;

/** Whether a currency is one Arc pays in, so a line released in it needs no conversion. */
export function paidOnArc(currency: string): boolean {
  return (ARC_CURRENCIES as readonly string[]).includes(currency);
}

/**
 * An amount as written (`1,250.50`, `1.250,50`, `1000000`) in minor units, or null when it is not one the currency
 * writes, not above zero (zero too, with `allowZero`), or over `MAX_TOTAL_MINOR`.
 */
export function parseMinor(typed: string, currency: string, options: { allowZero?: boolean } = {}): number | null {
  const text = typed.trim();
  if (options.allowZero && /^0+(?:[.,]0{1,2})?$/.test(text)) return 0;
  // USDC and EURC as the invoice form takes them: a dot before the cents, commas grouping thousands. A bill's own
  // currency as the bill writes it, either mark (`billAmount`).
  const amount = paidOnArc(currency.trim().toUpperCase())
    ? ARC_AMOUNT.test(text)
      ? Number(text.replace(/,/g, ""))
      : null
    : billAmount(text, currency);
  if (amount === null) return null;
  const minor = Math.round(amount * 10 ** dealDigits(currency));
  return Number.isSafeInteger(minor) && minor > 0 && minor <= MAX_TOTAL_MINOR ? minor : null;
}

/** Minor units as the decimal an invoice takes: `125050` at 2 digits is `1250.50`. */
export function minorToDecimal(minor: number, digits: number): string {
  const sign = minor < 0 ? "-" : "";
  const text = String(Math.abs(minor)).padStart(digits + 1, "0");
  return digits === 0 ? `${sign}${text}` : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Minor units for a person to read: `1,250.50`, `1,000,000`. */
export function formatMinor(minor: number, digits: number): string {
  const [whole, fraction] = minorToDecimal(Math.abs(minor), digits).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${minor < 0 ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** Minor units as a number of the currency, for the figures that add amounts as numbers (cash outlook, plan). */
export function minorToNumber(minor: number, digits: number): number {
  return Number(minorToDecimal(minor, digits));
}
