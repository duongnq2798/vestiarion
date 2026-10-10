/**
 * A bank statement's dates and amounts (docs/superpowers/specs/2026-10-10-bank-statement-design.md B4). The order of a
 * date and the decimal mark are decided from every value of the file together, and asked when the values allow two
 * readings: a statement is never read by a guess. Amounts come back in the currency's minor units. Pure and browser-safe.
 */

export type DateOrder = "ymd" | "dmy" | "mdy";
export const DATE_ORDERS: readonly DateOrder[] = ["ymd", "dmy", "mdy"];

export type DecimalMark = "." | ",";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** The day, YYYY-MM-DD, when it is a real one from 1990 on; null otherwise. */
function realDay(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.toISOString().slice(0, 10);
}

/** A two-digit year is this century's. */
const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

const NAMED_DAY_FIRST = /^(\d{1,2})[\s./-]+([A-Za-z]{3,9})\.?[\s./,-]+(\d{4}|\d{2})(?:$|[\sT])/;
const NAMED_MONTH_FIRST = /^([A-Za-z]{3,9})\.?[\s./-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s./-]+(\d{4}|\d{2})(?:$|[\sT])/;
const NUMERIC = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})(?:$|[\sT])/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * The day a value names, read in `order`; null when it is not a real day in that order. A month written in English
 * reads the same in every order. A time after the date is dropped; a two-digit year is 20xx.
 */
export function readDate(value: string, order: DateOrder): string | null {
  const text = value.trim();
  const named = NAMED_DAY_FIRST.exec(text);
  if (named && MONTHS[named[2].toLowerCase()]) return realDay(fullYear(named[3]), MONTHS[named[2].toLowerCase()], Number(named[1]));
  const monthFirst = NAMED_MONTH_FIRST.exec(text);
  if (monthFirst && MONTHS[monthFirst[1].toLowerCase()]) return realDay(fullYear(monthFirst[3]), MONTHS[monthFirst[1].toLowerCase()], Number(monthFirst[2]));
  const compact = COMPACT.exec(text);
  if (compact) return order === "ymd" ? realDay(Number(compact[1]), Number(compact[2]), Number(compact[3])) : null;
  const numeric = NUMERIC.exec(text);
  if (!numeric) return null;
  const [, a, b, c] = numeric;
  if (order === "ymd") return a.length === 4 && c.length <= 2 ? realDay(Number(a), Number(b), Number(c)) : null;
  if (a.length > 2 || (c.length !== 2 && c.length !== 4)) return null;
  return order === "dmy" ? realDay(fullYear(c), Number(b), Number(a)) : realDay(fullYear(c), Number(a), Number(b));
}

/** Whether a cell reads as a day in any order. */
export function looksLikeDate(value: string): boolean {
  return DATE_ORDERS.some((order) => readDate(value, order) !== null);
}

export type DateDecision =
  | { order: DateOrder }
  | { ask: DateOrder[]; example: string }
  | { unreadable: string }
  /** No value with a digit in it: no date at all. */
  | { none: true };

/**
 * The order the dates are read in: the one that reads every value with a digit in it. When two do and some value reads
 * as two different days (03/04/2026), the person is asked, shown that value. A value with no digit, such as a footer's
 * "Closing balance", is no date and is not counted.
 */
export function decideDateOrder(values: readonly string[]): DateDecision {
  const dated = values.map((value) => value.trim()).filter((value) => /\d/.test(value));
  if (dated.length === 0) return { none: true };
  const orders = DATE_ORDERS.filter((order) => dated.every((value) => readDate(value, order) !== null));
  if (orders.length === 0) {
    const best = [...DATE_ORDERS].sort((x, y) => dated.filter((v) => readDate(v, y)).length - dated.filter((v) => readDate(v, x)).length)[0];
    return { unreadable: dated.find((value) => readDate(value, best) === null) ?? dated[0] };
  }
  const twoWays = dated.find((value) => new Set(orders.map((order) => readDate(value, order))).size > 1);
  return twoWays ? { ask: orders, example: twoWays } : { order: orders[0] };
}

/** Spaces of every width and apostrophes group thousands; they say nothing about the decimal mark. */
const GROUPING = /[\s\u00A0\u202F']/g;

type Vote = DecimalMark | "three" | null;

/** What a value says about the decimal mark: a mark, "three" (one mark with three digits after it), or nothing. */
function voteOf(value: string): Vote {
  const text = value.replace(GROUPING, "").replace(/[^\d.,]/g, "");
  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  if (dots > 0 && commas > 0) return text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
  if (dots > 1) return ",";
  if (commas > 1) return ".";
  const mark = dots === 1 ? "." : commas === 1 ? "," : null;
  if (!mark) return null;
  const after = text.length - text.indexOf(mark) - 1;
  if (after === 1 || after === 2) return mark;
  return after === 3 ? "three" : null;
}

export type MarkDecision = { mark: DecimalMark } | { ask: true; example: string } | { conflict: [string, string] };

/**
 * The decimal mark of every amount and balance in the file, together. A value with both marks, a mark repeated, or one
 * mark followed by one or two digits decides it; two values deciding differently are refused, both shown. When none
 * decides and some value has three digits after its only mark (1,500), the person is asked. Whole numbers need no answer.
 */
export function decideDecimalMark(values: readonly string[]): MarkDecision {
  let decided: { mark: DecimalMark; value: string } | null = null;
  let three: string | null = null;
  for (const raw of values) {
    const value = raw.trim();
    if (value === "") continue;
    const vote = voteOf(value);
    if (vote === "three") {
      three ??= value;
    } else if (vote) {
      if (decided && decided.mark !== vote) return { conflict: [decided.value, value] };
      decided ??= { mark: vote, value };
    }
  }
  if (decided) return { mark: decided.mark };
  return three ? { ask: true, example: three } : { mark: "." };
}

export interface ReadAmountResult {
  /** In the currency's minor units, negative when the value says so: a minus before or after it, or parentheses. */
  minor: number;
  /** `DR` or `CR` after the value: money out or money in. */
  marked: "out" | "in" | null;
}

const SHAPE = /^([+-])?\s*(?:[A-Za-z]{3}|[A-Za-z]{0,2}\p{Sc})?\s*([+-])?\s*(\d[\d.,]*)\s*(-)?\s*(?:[A-Za-z]{3}|\p{Sc})?$/u;

/**
 * An amount in minor units, with the decimal mark decided for the file and the currency's digits (0 or 2). Grouping by
 * the other mark, spaces or apostrophes is read; a currency symbol or code beside it is dropped. Decimals beyond the
 * currency's are refused unless they are zeros. Null when it is not an amount.
 */
export function readAmount(value: string, mark: DecimalMark, digits: 0 | 2): ReadAmountResult | null {
  let text = value.trim();
  let marked: ReadAmountResult["marked"] = null;
  // DR or CR after the value, not the end of a word such as a currency code (XDR).
  const side = /(DR|CR)\.?$/i.exec(text);
  if (side && !/[A-Za-z]$/.test(text.slice(0, side.index))) {
    marked = side[1].toUpperCase() === "DR" ? "out" : "in";
    text = text.slice(0, side.index).trim();
  }
  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(text);
  if (bracketed) {
    negative = true;
    text = bracketed[1].trim();
  }
  const shape = SHAPE.exec(text.replace(/[\u00A0\u202F']/g, " ").replace(/(\d) (?=\d)/g, "$1"));
  if (!shape) return null;
  if (shape[1] === "-" || shape[2] === "-" || shape[4] === "-") negative = true;
  const number = shape[3];
  const thousands = mark === "." ? "," : ".";
  const grouped = new RegExp(`^\\d{1,3}(?:\\${thousands}\\d{3})+(?:\\${mark}\\d+)?$`);
  const plain = new RegExp(`^\\d+(?:\\${mark}\\d+)?$`);
  if (!grouped.test(number) && !plain.test(number)) return null;
  const [whole, fraction = ""] = number.split(thousands).join("").split(mark);
  if (fraction.length > digits && !/^0*$/.test(fraction.slice(digits))) return null;
  const minor = Number(whole) * 10 ** digits + Number((fraction.slice(0, digits) || "0").padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) return null;
  return { minor: negative ? -minor : minor, marked };
}
