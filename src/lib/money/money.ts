import { billDigits } from "../bill-amount";

/**
 * One money shape for every figure that is reported or planned (docs/superpowers/specs/2026-10-13-currency-provenance-
 * design.md M1): an integer of minor units in `bigint` and its currency, so a round trip and a total are exact, with no
 * float drift. Browser-safe and pure.
 *
 * Digits: none for the yen, the won and the other currencies without minor units (`billDigits`); six for USDC and EURC,
 * the tokens' own decimals on Arc, since what a transfer carried can hold a discount's micro-units; two for every
 * other currency. Rounding, where a value has more digits than its currency, is half away from zero, once.
 */

/** The tokens Vestiarion pays in on Arc. */
export const TOKENS = ["USDC", "EURC"] as const;
export type Token = (typeof TOKENS)[number];

/** The six currencies planning, import and reporting support (F15), besides the euro. */
export const SIX_CURRENCIES = ["USD", "SGD", "JPY", "KRW", "PHP", "MYR"] as const;

/** What a workspace may report in: the six, and the euro, which EURC is paid in. */
export const REPORTING_CURRENCIES = ["USD", "EUR", "SGD", "JPY", "KRW", "PHP", "MYR"] as const;
export type ReportingCurrency = (typeof REPORTING_CURRENCIES)[number];

export function isToken(currency: string): currency is Token {
  return (TOKENS as readonly string[]).includes(currency);
}

export function isReportingCurrency(currency: string): currency is ReportingCurrency {
  return (REPORTING_CURRENCIES as readonly string[]).includes(currency);
}

/** How many minor units' digits a currency keeps: 6 for a token, 0 for the yen or the won, 2 otherwise. */
export function moneyDigits(currency: string): 0 | 2 | 6 {
  const code = currency.trim().toUpperCase();
  return isToken(code) ? 6 : billDigits(code);
}

export interface Money {
  /** Minor units: cents for SGD, whole yen for JPY, millionths for USDC. */
  readonly minor: bigint;
  /** ISO 4217, or USDC or EURC; in capitals. */
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Two currencies cannot be added: ${a} and ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

const CODE = /^[A-Z]{3,4}$/;

function code(currency: string): string {
  const upper = currency.trim().toUpperCase();
  if (!CODE.test(upper)) throw new Error(`Not a currency code: ${currency}`);
  return upper;
}

export function pow10(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

/** `num / den`, rounded half away from zero; `den` must not be zero. */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === BigInt(0)) throw new Error("Division by zero");
  const negative = num < BigInt(0) !== den < BigInt(0);
  const n = num < BigInt(0) ? -num : num;
  const d = den < BigInt(0) ? -den : den;
  const quotient = n / d;
  const rounded = (n % d) * BigInt(2) >= d ? quotient + BigInt(1) : quotient;
  return negative ? -rounded : rounded;
}

/** An amount of minor units. A `number` must be a safe integer. */
export function money(minor: bigint | number, currency: string): Money {
  if (typeof minor === "number" && !Number.isSafeInteger(minor)) throw new Error(`Not a whole number of minor units: ${minor}`);
  return { minor: BigInt(minor), currency: code(currency) };
}

export function zero(currency: string): Money {
  return money(BigInt(0), currency);
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A decimal written plainly (`1250.5`, `-3`, `0.000001`), exactly; null when it is not one, or when it has more decimals
 * than the currency keeps. Thousands separators and the comma as a decimal mark are the bill reader's (`billAmount`).
 */
export function moneyOf(decimal: string, currency: string): Money | null {
  const match = DECIMAL.exec(decimal.trim());
  if (!match) return null;
  const digits = moneyDigits(currency);
  const fraction = match[3] ?? "";
  if (fraction.length > digits) return null;
  const minor = BigInt(`${match[2]}${fraction.padEnd(digits, "0")}`);
  return money(match[1] === "-" ? -minor : minor, currency);
}

/** The plain decimal text of a number, never in exponent notation: the shortest text that reads back as it. */
function plain(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite amount: ${value}`);
  const text = String(value);
  if (!/e/i.test(text)) return text;
  // 1e-7 or 1.5e+21: written out in full. Exact for the integers and the short decimals money holds.
  const [mantissa, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  const written = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${negative ? "-" : ""}${written}`;
}

/**
 * A value read from the database or a number a module kept (`numeric(20,6)` comes back from PostgREST as a JSON
 * number), rounded half away from zero to the currency's digits. A number goes through its shortest decimal text, so
 * 1250.5 is 1250.50 and never 1250.4999…; a string is read exactly.
 */
export function roundedMoney(value: number | string, currency: string): Money {
  const text = typeof value === "number" ? plain(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`Not an amount: ${value}`);
  const digits = moneyDigits(currency);
  const fraction = match[3] ?? "";
  const units = BigInt(`${match[2]}${fraction}`);
  const minor = fraction.length <= digits ? units * pow10(digits - fraction.length) : divRound(units, pow10(fraction.length - digits));
  return money(match[1] === "-" ? -minor : minor, currency);
}

/** Minor units written as a plain decimal at `digits`: `125050` at 2 is `1250.50`. */
export function decimalOfMinor(minor: bigint, digits: number): string {
  const negative = minor < BigInt(0);
  const text = (negative ? -minor : minor).toString().padStart(digits + 1, "0");
  const body = digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  return `${negative ? "-" : ""}${body}`;
}

/** The amount as a plain decimal with all its currency's digits: `1250.50`, `1000` for yen, `1000.000000` for USDC. */
export function decimalOf(amount: Money): string {
  return decimalOfMinor(amount.minor, moneyDigits(amount.currency));
}

/** A number of the currency, for the modules that still add numbers; exact for any amount below 2^53 minor units. */
export function numberOf(amount: Money): number {
  return Number(decimalOf(amount));
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * The amount for a person to read, with its code: `1,250.50 SGD`, `150,000 JPY`, `1,000.00 USDC`, `1,209.8786 USDC`.
 * A token shows at least two decimals and only the micro-units it has beyond them.
 */
export function formatMoney(amount: Money, options: { code?: boolean; sign?: boolean } = {}): string {
  const digits = moneyDigits(amount.currency);
  const negative = amount.minor < BigInt(0);
  const [whole, fraction = ""] = decimalOfMinor(negative ? -amount.minor : amount.minor, digits).split(".");
  const shown = isToken(amount.currency) ? fraction.replace(/0+$/, "").padEnd(2, "0") : fraction;
  const sign = negative ? "-" : options.sign && amount.minor > BigInt(0) ? "+" : "";
  const number = `${sign}${group(whole)}${shown ? `.${shown}` : ""}`;
  return options.code === false ? number : `${number} ${amount.currency}`;
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function addMoney(a: Money, b: Money): Money {
  same(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  same(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function negate(amount: Money): Money {
  return { minor: -amount.minor, currency: amount.currency };
}

/** The sum of amounts in one currency; any other currency throws. */
export function sumMoney(currency: string, amounts: Iterable<Money>): Money {
  let total = zero(currency);
  for (const amount of amounts) total = addMoney(total, amount);
  return total;
}

/** One total per currency, in currency order: amounts in two currencies are never added. */
export function totalsByCurrency(amounts: Iterable<Money>): Array<{ total: Money; count: number }> {
  const totals = new Map<string, { total: Money; count: number }>();
  for (const amount of amounts) {
    const entry = totals.get(amount.currency);
    totals.set(amount.currency, entry ? { total: addMoney(entry.total, amount), count: entry.count + 1 } : { total: amount, count: 1 });
  }
  return [...totals.values()].sort((a, b) => a.total.currency.localeCompare(b.total.currency));
}

/** The same amount at other digits: exact when gaining digits, rounded half away from zero when losing them. */
export function atDigits(minor: bigint, from: number, to: number): bigint {
  return to >= from ? minor * pow10(to - from) : divRound(minor, pow10(from - to));
}
