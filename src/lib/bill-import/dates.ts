/**
 * A due date as a bill list writes it (import design B5), read to `YYYY-MM-DD`, or the reason it cannot be. Day or
 * month first is the list's, decided from all its dates or asked of the person: never guessed. Browser-safe and pure.
 */

export type DateOrder = "dmy" | "mdy";

export type DateRead = { ok: true; iso: string } | { ok: false; reason: string };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Excel counts days from 1899-12-30; 20000 to 80000 are the years 1954 to 2119, so no plain amount is read as one. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

type Shape =
  | { kind: "date"; year: number; month: number; day: number }
  /** Day and month in an order only the list can say: `first/second/year`. */
  | { kind: "pair"; first: number; second: number; year: number }
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
  if (match) return { kind: "pair", first: Number(match[1]), second: Number(match[2]), year: fullYear(match[3]) };
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

const NOT_REAL: DateRead = { ok: false, reason: "is not a real day" };

export function readDate(cell: string, order: DateOrder | null): DateRead {
  if (cell.trim() === "") return { ok: false, reason: "is blank" };
  const shape = shapeOf(cell);
  if (shape.kind === "none") return { ok: false, reason: "is not a date" };
  if (shape.kind === "date") {
    const iso = realDay(shape.year, shape.month, shape.day);
    return iso ? { ok: true, iso } : NOT_REAL;
  }
  const { first, second, year } = shape;
  if (order === null) {
    // Without the list's order, only a date that reads one way: 03/03, or a part above 12.
    if (first === second || first > 12 || second > 12) {
      const iso = first > 12 ? realDay(year, second, first) : realDay(year, first, second);
      return iso ? { ok: true, iso } : NOT_REAL;
    }
    return { ok: false, reason: "could be read two ways: say whether the list's dates are day first or month first" };
  }
  const [day, month] = order === "dmy" ? [first, second] : [second, first];
  if (month > 12 && day <= 12) {
    return { ok: false, reason: `does not fit the list's ${order === "dmy" ? "day-first" : "month-first"} dates` };
  }
  const iso = realDay(year, month, day);
  return iso ? { ok: true, iso } : NOT_REAL;
}

/**
 * The list's order, from all its dates: day first when a first part is above 12 anywhere, month first when a second
 * part is. `ask` when nothing settles it and a date reads two ways, or when the list holds both (`mixed`).
 */
export function dateOrderOf(cells: readonly string[]): { order: DateOrder | null; ask: boolean; mixed: boolean } {
  let dayFirst = false;
  let monthFirst = false;
  let twoWays = false;
  for (const cell of cells) {
    const shape = shapeOf(cell);
    if (shape.kind !== "pair") continue;
    if (shape.first > 12 && shape.second <= 12) dayFirst = true;
    else if (shape.second > 12 && shape.first <= 12) monthFirst = true;
    else if (shape.first <= 12 && shape.second <= 12 && shape.first !== shape.second) twoWays = true;
  }
  if (dayFirst && monthFirst) return { order: null, ask: true, mixed: true };
  if (dayFirst) return { order: "dmy", ask: false, mixed: false };
  if (monthFirst) return { order: "mdy", ask: false, mixed: false };
  return { order: null, ask: twoWays, mixed: false };
}
