/**
 * A due date as a bill list writes it (import design B5), read to `YYYY-MM-DD`, or the reason it cannot be. Day,
 * month or year first is the list's, decided from all its dates or asked of the person: never guessed. Browser-safe
 * and pure.
 */

/** Day first (15/10/2026), month first (10/15/2026), or a two-digit year first (26/10/15). */
export type DateOrder = "dmy" | "mdy" | "ymd";

/** The orders a date in numbers alone can be in, in the order the panel offers them. */
export const DATE_ORDERS: readonly DateOrder[] = ["dmy", "mdy", "ymd"];

const ORDER_WORDS: Record<DateOrder, string> = { dmy: "day first", mdy: "month first", ymd: "year first" };

/** The orders in words: "day first or month first". */
export function orderWords(orders: readonly DateOrder[]): string {
  const words = orders.map((order) => ORDER_WORDS[order]);
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

export type DateRead = { ok: true; iso: string } | { ok: false; reason: string };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Excel counts days from 1899-12-30; 20000 to 80000 are the years 1954 to 2119, so no plain amount is read as one. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

type Parts = readonly [string, string, string];

type Shape =
  | { kind: "date"; year: number; month: number; day: number }
  /** Three numbers in an order only the list can say: `15/10/2026`, `10/15/2026`, or with a two-digit year `26/10/15`. */
  | { kind: "parts"; parts: Parts }
  | { kind: "none" };

const fullYear = (text: string) => (text.length === 2 ? 2000 + Number(text) : Number(text));

function shapeOf(cell: string): Shape {
  const text = cell.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (match) return { kind: "date", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{4})[/.]\s?(\d{1,2})[/.]\s?(\d{1,2})\.?$/.exec(text);
  if (match) return { kind: "date", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]$/.exec(text);
  if (match) return { kind: "date", year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(text);
  if (match) return { kind: "parts", parts: [match[1], match[2], match[3]] };
  match = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4}|\d{2})$/.exec(text);
  if (match && MONTHS[match[2].toLowerCase()]) {
    return { kind: "date", year: fullYear(match[3]), month: MONTHS[match[2].toLowerCase()], day: Number(match[1]) };
  }
  match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(text);
  if (match && MONTHS[match[1].toLowerCase()]) {
    return { kind: "date", year: Number(match[3]), month: MONTHS[match[1].toLowerCase()], day: Number(match[2]) };
  }
  match = /^(\d{5})(?:\.0+)?$/.exec(text);
  if (match && Number(match[1]) >= 20_000 && Number(match[1]) <= 80_000) {
    const date = new Date(EXCEL_EPOCH + Number(match[1]) * DAY_MS);
    return { kind: "date", year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
  return { kind: "none" };
}

/** `YYYY-MM-DD` for a day that exists, or null: February 30 is no day. */
function realDay(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The parts read in an order, when it can be theirs: a month from 1 to 12 and a day from 1 to 31. Year first only for
 * a two-digit year written before two-digit month and day parts, the year last otherwise.
 */
function partsIn([first, second, third]: Parts, order: DateOrder): { year: number; month: number; day: number } | null {
  let date: { year: number; month: number; day: number };
  if (order === "ymd") {
    if (first.length !== 2 || third.length !== 2) return null;
    date = { year: 2000 + Number(first), month: Number(second), day: Number(third) };
  } else {
    const [day, month] = order === "dmy" ? [first, second] : [second, first];
    date = { year: fullYear(third), month: Number(month), day: Number(day) };
  }
  return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= 31 ? date : null;
}

/** The orders the parts can be in. A day that does not exist still says the order: 31/02 is day first. */
const ordersOf = (parts: Parts): DateOrder[] => DATE_ORDERS.filter((order) => partsIn(parts, order) !== null);

/** The parts' day in an order they can be in, or null for one that does not exist. */
function dayIn(parts: Parts, order: DateOrder): string | null {
  const date = partsIn(parts, order);
  return date ? realDay(date.year, date.month, date.day) : null;
}

const NOT_REAL: DateRead = { ok: false, reason: "is not a real day" };

export function readDate(cell: string, order: DateOrder | null): DateRead {
  if (cell.trim() === "") return { ok: false, reason: "is blank" };
  const shape = shapeOf(cell);
  if (shape.kind === "none") return { ok: false, reason: "is not a date" };
  if (shape.kind === "date") {
    const iso = realDay(shape.year, shape.month, shape.day);
    return iso ? { ok: true, iso } : NOT_REAL;
  }
  const { parts } = shape;
  const orders = ordersOf(parts);
  if (orders.length === 0) return NOT_REAL;
  if (order === null) {
    // Without the list's order, only a date that reads one way in each order it can be in: 03/03/2026, or 25/12/2026.
    const days = new Set(orders.map((candidate) => dayIn(parts, candidate)));
    if (days.size > 1) {
      return { ok: false, reason: `could be read ${days.size === 2 ? "two" : "three"} ways: say whether the list's dates are ${orderWords(orders)}` };
    }
    const [iso] = days;
    return iso ? { ok: true, iso } : NOT_REAL;
  }
  if (!orders.includes(order)) return { ok: false, reason: `does not fit the list's ${ORDER_WORDS[order].replace(" ", "-")} dates` };
  const iso = dayIn(parts, order);
  return iso ? { ok: true, iso } : NOT_REAL;
}

export interface DateOrderQuestion {
  /** The order to read the list's dates in, when the list settles it, or when every date reads the same in each order it allows. */
  order: DateOrder | null;
  ask: boolean;
  /** The list's dates are written in orders no one order fits. */
  mixed: boolean;
  /** The orders the person chooses from, when asked. */
  orders: DateOrder[];
}

/**
 * The list's order, from all its dates: the one order every date written in numbers can be in. A day above 12 rules
 * month first out (15/10/2026), a month above 12 day first (10/15/2026), a four-digit year last or a part above 31
 * rules out where a two-digit year is not. `ask` when the orders left read a date differently, among them; and when
 * no order fits every date (`mixed`), among every order a date can be in.
 */
export function dateOrderOf(cells: readonly string[]): DateOrderQuestion {
  const dated: Parts[] = [];
  const seen = new Set<DateOrder>();
  let common: DateOrder[] | null = null;
  for (const cell of cells) {
    const shape = shapeOf(cell);
    if (shape.kind !== "parts") continue;
    const orders = ordersOf(shape.parts);
    // A date that can be in no order is an error row whatever the list's order: it says nothing about it.
    if (orders.length === 0) continue;
    dated.push(shape.parts);
    for (const order of orders) seen.add(order);
    common = common === null ? orders : common.filter((order) => orders.includes(order));
  }
  if (common === null) return { order: null, ask: false, mixed: false, orders: [] };
  if (common.length === 0) return { order: null, ask: true, mixed: true, orders: DATE_ORDERS.filter((order) => seen.has(order)) };
  const left = common;
  if (left.length > 1 && dated.some((parts) => new Set(left.map((order) => dayIn(parts, order))).size > 1)) {
    return { order: null, ask: true, mixed: false, orders: left };
  }
  return { order: left[0], ask: false, mixed: false, orders: [] };
}
