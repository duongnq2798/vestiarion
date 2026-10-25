/**
 * The close pack's month (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP1): a calendar month in UTC,
 * from the 1st at 00:00 UTC up to the next month's 1st, not including it. No workspace has a time zone, and the
 * hand-off and Usage this month count UTC months too. The one parser of a month: `handoffPeriod` delegates here, so the
 * hand-off and the close pack never disagree on one. Pure and browser-safe.
 */

export interface ClosePackMonth {
  /** The first day, YYYY-MM-DD (UTC). */
  from: string;
  /** The next month's first day, YYYY-MM-DD: the month runs up to it, not including it. */
  to: string;
  /** "October 2026". */
  label: string;
  /** "2026-10". */
  key: string;
}

/** The first month a pack may be asked for. */
const FIRST_YEAR = 2020;
const MONTH = /^(\d{4})-(\d{2})$/;
/** Built by hand rather than with `Intl`, so a server render and the browser read the same words. */
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const day = (at: Date) => at.toISOString().slice(0, 10);

/** The month that starts in `year`, `index` (0 for January; out of range rolls into the year before or after). */
function monthAt(year: number, index: number): ClosePackMonth {
  const from = new Date(Date.UTC(year, index, 1));
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return { from: day(from), to: day(to), label: `${MONTH_NAMES[from.getUTCMonth()]} ${from.getUTCFullYear()}`, key: day(from).slice(0, 7) };
}

const startOf = (month: ClosePackMonth) => Date.parse(`${month.from}T00:00:00Z`);
const endOf = (month: ClosePackMonth) => Date.parse(`${month.to}T00:00:00Z`);

/** `YYYY-MM`, or the last full UTC month when null or ""; null for a month that does not read, before 2020, or to come. */
export function closePackMonth(month: string | null, now: Date = new Date()): ClosePackMonth | null {
  if (month === null || month === "") return monthAt(now.getUTCFullYear(), now.getUTCMonth() - 1);
  const match = MONTH.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11 || year < FIRST_YEAR) return null;
  const found = monthAt(year, index);
  // A month still to come has nothing in it yet; this month is allowed, and reads "so far".
  if (startOf(found) > now.getTime()) return null;
  return found;
}

/** Whether the month has ended at `now`; false for this month so far. */
export function monthEnded(month: ClosePackMonth, now: Date): boolean {
  return now.getTime() >= endOf(month);
}

/** The months either side; `next` is null when it is still to come, `previous` when it is before 2020. */
export function monthsBeside(month: ClosePackMonth, now: Date): { previous: ClosePackMonth | null; next: ClosePackMonth | null } {
  const start = new Date(startOf(month));
  const previous = monthAt(start.getUTCFullYear(), start.getUTCMonth() - 1);
  const next = monthAt(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return {
    previous: Number(previous.key.slice(0, 4)) < FIRST_YEAR ? null : previous,
    next: startOf(next) > now.getTime() ? null : next,
  };
}

/**
 * The page's month (CP11): `?month=` read once. A value given twice, or one that does not read, is last month and
 * `unreadable`, so the page says so; none at all is last month, said nowhere.
 */
export function closePackMonthFrom(query: Record<string, string | string[] | undefined>, now: Date): { month: ClosePackMonth; unreadable: boolean } {
  const lastMonth = closePackMonth(null, now) as ClosePackMonth;
  const value = query.month;
  if (Array.isArray(value)) return { month: lastMonth, unreadable: true };
  if (value === undefined || value === "") return { month: lastMonth, unreadable: false };
  const month = closePackMonth(value, now);
  return month ? { month, unreadable: false } : { month: lastMonth, unreadable: true };
}
