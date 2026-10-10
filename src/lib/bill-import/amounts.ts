import { billDigits } from "../bill-amount";

/**
 * An amount as a bill list writes it (import design B6, B7): its currency symbol or code taken off, its number read in
 * the list's own format, to an exact decimal string. Nothing passes through a float. Browser-safe and pure.
 */

export type DecimalMark = "." | ",";

export type AmountRead = { ok: true; value: string } | { ok: false; reason: string };

/** Decimals an amount may have in its currency (I07): USDC and EURC 6, none for the yen or the won, 2 for the rest. */
export function currencyDigits(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (code === "USDC" || code === "EURC") return 6;
  return billDigits(code);
}

const DOLLARS = ["USD", "SGD", "AUD", "CAD", "HKD", "NZD", "TWD", "MXN"];

/** Symbols, longest first so `US$` is not read as `$`, with the currencies each can mean. */
const SYMBOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["US$", ["USD"]], ["AU$", ["AUD"]], ["CA$", ["CAD"]], ["HK$", ["HKD"]], ["NZ$", ["NZD"]],
  ["S$", ["SGD"]], ["A$", ["AUD"]], ["C$", ["CAD"]], ["RM", ["MYR"]], ["Rp", ["IDR"]],
  ["$", DOLLARS], ["€", ["EUR"]], ["£", ["GBP"]], ["¥", ["JPY", "CNY"]], ["￥", ["JPY", "CNY"]], ["円", ["JPY"]],
  ["₩", ["KRW"]], ["원", ["KRW"]], ["₱", ["PHP"]], ["₹", ["INR"]], ["฿", ["THB"]], ["₫", ["VND"]],
];

const NUMBER_START = /^[-(]?\s*[\d.,]/;
const NUMBER_END = /[\d.,)]\s*$/;

/**
 * The cell's number, and the symbol or code written with it and the currencies that can mean; `null` for none. A code
 * is three letters, or USDC and EURC, before or after the number.
 */
export function splitCurrency(cell: string): { number: string; mark: string | null; codes: string[] | null } {
  const text = cell.trim();
  for (const [symbol, codes] of SYMBOLS) {
    if (text.startsWith(symbol) && NUMBER_START.test(text.slice(symbol.length).trim())) {
      return { number: text.slice(symbol.length).trim(), mark: symbol, codes: [...codes] };
    }
    if (text.endsWith(symbol) && NUMBER_END.test(text.slice(0, -symbol.length))) {
      return { number: text.slice(0, -symbol.length).trim(), mark: symbol, codes: [...codes] };
    }
  }
  const before = /^([A-Za-z]{3,4})\s*(.+)$/.exec(text);
  if (before && NUMBER_START.test(before[2])) return { number: before[2].trim(), mark: before[1].toUpperCase(), codes: [before[1].toUpperCase()] };
  const after = /^(.+?)\s*([A-Za-z]{3,4})$/.exec(text);
  if (after && NUMBER_END.test(after[1])) return { number: after[1].trim(), mark: after[2].toUpperCase(), codes: [after[2].toUpperCase()] };
  return { number: text, mark: null, codes: null };
}

/** Whether a symbol fits a currency: it may mean it, a dollar sign fits USDC, a euro sign EURC. No symbol fits anything. */
export function symbolFits(codes: readonly string[] | null, currency: string): boolean {
  if (codes === null) return true;
  const code = currency.toUpperCase();
  return codes.includes(code) || (code === "USDC" && codes.includes("USD")) || (code === "EURC" && codes.includes("EUR"));
}

let knownCodes: Set<string> | null | undefined;

/** An ISO 4217 code this runtime knows, or USDC or EURC. A runtime that lists none takes any three capital letters. */
export function isCurrencyCode(code: string): boolean {
  if (code === "USDC" || code === "EURC") return true;
  if (!/^[A-Z]{3}$/.test(code)) return false;
  if (knownCodes === undefined) {
    try {
      knownCodes = new Set((Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("currency"));
    } catch {
      knownCodes = null;
    }
  }
  return knownCodes === null || knownCodes.has(code);
}

/** Spaces, no-break spaces and apostrophes only ever group thousands. */
const GROUPING = /[\s  '’]/g;

/** What a cell says about the decimal mark: `.` or `,`, `either` when it reads both ways, null when it says nothing. */
function markEvidence(text: string, digits: number): DecimalMark | "either" | null {
  const plain = text.replace(GROUPING, "").replace(/^[-(]|\)$/g, "");
  const dot = plain.lastIndexOf(".");
  const comma = plain.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) return dot > comma ? "." : ",";
  const mark: DecimalMark | null = dot >= 0 ? "." : comma >= 0 ? "," : null;
  if (mark === null) return null;
  const other: DecimalMark = mark === "." ? "," : ".";
  if (plain.indexOf(mark) !== plain.lastIndexOf(mark)) return other;
  const [whole, fraction] = plain.split(mark);
  if (fraction.length !== 3 || /^0*$/.test(whole)) return mark;
  // A currency without decimals never writes three of them: the mark groups thousands.
  return digits === 0 ? other : "either";
}

/** The list's decimal mark, from all its amounts; `ask` when none settles it and one reads both ways, or they disagree. */
export function decimalMarkOf(cells: ReadonlyArray<{ text: string; currency: string }>): { mark: DecimalMark | null; ask: boolean; mixed: boolean } {
  const seen = new Set<DecimalMark>();
  let either = false;
  for (const cell of cells) {
    const evidence = markEvidence(splitCurrency(cell.text).number, currencyDigits(cell.currency));
    if (evidence === "either") either = true;
    else if (evidence) seen.add(evidence);
  }
  if (seen.size === 2) return { mark: null, ask: true, mixed: true };
  if (seen.size === 1) return { mark: [...seen][0], ask: false, mixed: false };
  return { mark: null, ask: either, mixed: false };
}

/** A decimal written without grouping, leading zeros or trailing zeros: `0010.50` is `10.5`. */
function canonical(whole: string, fraction: string): string {
  const integer = whole.replace(/^0+(?=\d)/, "") || "0";
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${integer}.${decimals}` : integer;
}

/** An amount compared as an exact decimal, as the list wrote it or as the database returned it. */
export function decimalKey(value: string | number): string {
  let text = typeof value === "number" ? String(value) : value.trim();
  if (/e/i.test(text)) text = Number(text).toFixed(6);
  const [whole, fraction = ""] = text.split(".");
  return canonical(whole, fraction);
}

/** The most digits before the decimal mark an invoice's amount holds (`numeric(20, 6)`). */
const MAX_WHOLE_DIGITS = 14;

/**
 * The number, in the list's decimal mark (or the one the cell settles itself when the list has none), as an exact
 * decimal string within the currency's decimals; or the reason it cannot be, to follow the cell in a sentence.
 */
export function readAmount(number: string, listMark: DecimalMark | null, currency: string): AmountRead {
  const text = number.trim();
  if (text === "") return { ok: false, reason: "is blank" };
  if (/^-|^\(.*\)$|-$/.test(text)) return { ok: false, reason: "is negative: a credit note is not a bill" };
  const digits = currencyDigits(currency);
  const evidence = markEvidence(text, digits);
  let mark = listMark;
  if (mark === null) {
    if (evidence === "either") return { ok: false, reason: "could be read two ways: say how the list writes its amounts" };
    mark = evidence ?? ".";
  } else if (evidence !== null && evidence !== "either" && evidence !== mark) {
    return { ok: false, reason: `does not fit the list's amounts, written like ${mark === "." ? "1,234.50" : "1.234,50"}` };
  }
  const group = mark === "." ? "," : ".";
  const plain = text.replace(GROUPING, "");
  const [whole, fraction = "", extra] = plain.split(mark);
  if (extra !== undefined || !/^\d*$/.test(fraction)) return { ok: false, reason: "is not a number" };
  const grouped = new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})+$`);
  if (!/^\d+$/.test(whole) && !grouped.test(whole)) return { ok: false, reason: "is not a number" };
  const integer = whole.split(group).join("");
  if (integer.replace(/^0+/, "").length > MAX_WHOLE_DIGITS) return { ok: false, reason: "is too large" };
  const decimals = fraction.replace(/0+$/, "");
  const code = currency.toUpperCase();
  if (decimals.length > digits) {
    return {
      ok: false,
      reason: digits === 0 ? `has decimals, and ${code} amounts are whole numbers` : `has more than ${digits} decimals, the most ${code} takes`,
    };
  }
  const value = canonical(integer, decimals);
  if (/^0(?:\.0*)?$/.test(value)) return { ok: false, reason: "is not above zero" };
  return { ok: true, value };
}
