import { actualCurrency } from "../actual-payment-fields";
import { billDigits } from "../bill-amount";
import { findHeaderRow, NO_COLUMNS, ROLE_WORDS, ROLES, suggestColumns, type ColumnMapping, type Role } from "./columns";
import { readTable, StatementReadError, type Delimiter, type TableRecord } from "./table";
import { decideDateOrder, decideDecimalMark, looksLikeDate, readAmount, readDate, type DateOrder, type DecimalMark } from "./values";

/**
 * A bank statement's lines (docs/superpowers/specs/2026-10-10-bank-statement-design.md B3-B5, B9): each row read with
 * the columns, the date order and the decimal mark chosen for the whole file, signed (negative is money out) in its
 * currency's minor units; the rows that are not lines, each with why; the period; and the statement checked against its
 * own running balance. Pure and browser-safe: the browser reads it to show the person what was read at once, and the
 * server reads the same text with the same choices again before it matches or saves anything.
 */

export const STATEMENT_MAX_LINES = 2000;
export const STATEMENT_MAX_BYTES = 2_000_000;
export const ACCOUNT_MAX = 80;
/** What the card and the command say before migration 0094 runs (B11). */
export const STATEMENT_NOT_READY = "Importing a bank statement is not set up on this deployment yet.";
const DESCRIPTION_MAX = 500;
const PAYEE_MAX = 200;
const REFERENCE_MAX = 140;

/** What the person chose, or answered. Anything left out is found from the file. */
export interface StatementChoices {
  delimiter?: Delimiter | null;
  /** The header row, as an index into the records; -1 when the file has none. */
  headerRow?: number | null;
  columns?: ColumnMapping | null;
  /** How a single amount column writes money out: as a negative value (most banks), or as a positive one. */
  outIs?: "negative" | "positive";
  /** The answer when the dates read two ways. */
  dateOrder?: DateOrder | null;
  /** The answer when the amounts read two ways. */
  decimalMark?: DecimalMark | null;
  /** The account's currency, for a statement with no currency column. */
  currency?: string | null;
}

export type StatementQuestion =
  | { kind: "dateOrder"; example: string; readings: Array<{ order: DateOrder; day: string }> }
  | { kind: "decimalMark"; example: string };

export interface StatementLine {
  /** The line of the file the row starts on. */
  line: number;
  bookedOn: string;
  valueOn: string | null;
  /** Signed, in the currency's minor units: negative is money out. */
  minor: number;
  currency: string;
  description: string;
  payee: string;
  reference: string;
  /** The running balance after it, in minor units, when the statement prints one. */
  balance: number | null;
  /** Its place among the lines of the file that look exactly the same, balance and all: 0 for the first. */
  occurrence: number;
  /** Another line of the file has the same day, amount and text. */
  lookalike: boolean;
}

export interface SkippedRow {
  line: number;
  why: string;
}

/** The statement against its own running balance, per currency (B5). Amounts in minor units. */
export interface BalanceCheck {
  currency: string;
  status: "adds_up" | "mismatch" | "reversed";
  /** The balance before the first line, and after the last. */
  opening: number;
  closing: number;
  /** Money out and money in, each as a positive sum. */
  out: number;
  in: number;
  /** The first line that does not add up, and what its balance should have been. */
  mismatch: { line: number; expected: number; found: number } | null;
  /** The file lists the newest line first: it is checked the other way. */
  newestFirst: boolean;
}

export interface StatementRead {
  delimiter: Delimiter;
  /** The first records, for choosing the header row. */
  firstRecords: TableRecord[];
  headerRow: number;
  /** Each column's name: its header, or "Column N" with no header row. */
  headers: string[];
  /** Each column's first value under the header, for recognising it; blank when the column has none. */
  example: string[];
  columns: ColumnMapping;
  outIs: "negative" | "positive";
  dateOrder: DateOrder | null;
  decimalMark: DecimalMark | null;
  /** No column gives the currency, or a line leaves it blank: the account's is typed. */
  needsCurrency: boolean;
  /** What must be answered before the lines are read. */
  questions: StatementQuestion[];
  /** What stops the lines being read, in words. */
  problems: string[];
  lines: StatementLine[];
  skipped: SkippedRow[];
  period: { from: string; to: string } | null;
  balances: BalanceCheck[];
}

/** The account as the person named it, spaces collapsed; null when blank or longer than 80 characters. */
export function statementAccount(typed: string): string | null {
  const account = typed.trim().replace(/\s+/g, " ");
  return account === "" || account.length > ACCOUNT_MAX ? null : account;
}

/**
 * What makes a line itself, for its key (B9): the account (lower case, spaces collapsed), the day, the amount, the
 * currency, the text, the balance, and its place among the lines of the file that look the same. The server hashes it.
 */
export function lineIdentity(account: string, line: StatementLine): string {
  const named = account.trim().replace(/\s+/g, " ").toLowerCase();
  return JSON.stringify([named, line.bookedOn, line.minor, line.currency, line.description, line.payee, line.reference, line.balance, line.occurrence]);
}

const text = (value: string | undefined, max: number) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cellOf = (record: TableRecord, column: number | null) => (column === null ? "" : (record.cells[column] ?? "").trim());
const DAY_MS = 86_400_000;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** The columns as chosen, each within the table; the problems that stop the lines being read. */
function checkColumns(columns: ColumnMapping, width: number): { columns: ColumnMapping; problems: string[] } {
  const inTable = Object.fromEntries(ROLES.map((role) => [role, columns[role] !== null && columns[role]! >= 0 && columns[role]! < width ? columns[role] : null])) as ColumnMapping;
  const problems: string[] = [];
  const taken = new Map<number, Role>();
  for (const role of ROLES) {
    const column = inTable[role];
    if (column === null) continue;
    const first = taken.get(column);
    if (first) problems.push(`One column is chosen for both ${ROLE_WORDS[first]} and ${ROLE_WORDS[role]}.`);
    else taken.set(column, role);
  }
  if (inTable.bookingDate === null) problems.push("Choose the column with the booking date.");
  if (inTable.description === null) problems.push("Choose the column with the description.");
  const twoColumns = inTable.moneyOut !== null || inTable.moneyIn !== null;
  if (inTable.amount === null && !twoColumns) problems.push("Choose the amount column, or the money out and money in columns.");
  if (inTable.amount !== null && twoColumns) problems.push("Choose either one amount column, or money out and money in, not both.");
  return { columns: inTable, problems };
}

type Entry = { line: number; bookedOn: string; minor: number; balance: number | null };

/** Walks the entries with each movement times `sign`: the first whose balance does not follow, or null. */
function walk(entries: readonly Entry[], sign: 1 | -1): { line: number; expected: number; found: number } | null {
  let known: number | null = null;
  let since = 0;
  for (const entry of entries) {
    since += sign * entry.minor;
    if (entry.balance === null) continue;
    if (known !== null && known + since !== entry.balance) return { line: entry.line, expected: known + since, found: entry.balance };
    known = entry.balance;
    since = 0;
  }
  return null;
}

function checkBalance(currency: string, inFile: readonly Entry[]): BalanceCheck | null {
  if (inFile.filter((entry) => entry.balance !== null).length < 2) return null;
  const first = inFile[0].bookedOn;
  const last = inFile[inFile.length - 1].bookedOn;
  // Listed newest first, it is read the other way; all on one day, whichever way adds up.
  let newestFirst = first > last;
  let entries = newestFirst ? [...inFile].reverse() : [...inFile];
  let mismatch = walk(entries, 1);
  if (mismatch && first === last && !walk([...inFile].reverse(), 1)) {
    newestFirst = true;
    entries = [...inFile].reverse();
    mismatch = null;
  }
  const reversed = mismatch !== null && walk(entries, -1) === null;
  const firstKnown = entries.findIndex((entry) => entry.balance !== null);
  const lastKnown = entries.length - 1 - [...entries].reverse().findIndex((entry) => entry.balance !== null);
  const sum = (from: number, to: number) => entries.slice(from, to).reduce((total, entry) => total + entry.minor, 0);
  return {
    currency,
    status: mismatch === null ? "adds_up" : reversed ? "reversed" : "mismatch",
    opening: entries[firstKnown].balance! - sum(0, firstKnown + 1),
    closing: entries[lastKnown].balance! + sum(lastKnown + 1, entries.length),
    out: -entries.reduce((total, entry) => total + Math.min(entry.minor, 0), 0),
    in: entries.reduce((total, entry) => total + Math.max(entry.minor, 0), 0),
    mismatch: reversed ? null : mismatch,
    newestFirst,
  };
}

/**
 * The statement read with the person's choices: the table, the header row and the columns (found when not chosen),
 * the questions still open and the problems that stop it, and once there are none, its lines, the rows skipped with
 * why, the period and the balance check. Throws `StatementReadError` for a file that is no table at all.
 */
export function readStatement(source: string, choices: StatementChoices, today: string): StatementRead {
  if (source.length > STATEMENT_MAX_BYTES) throw new StatementReadError("Choose a statement smaller than 2 MB.");
  const table = readTable(source, choices.delimiter ?? undefined);
  const records = table.records;
  // Not Math.max(...records): a file of many short rows would overflow the call stack.
  const width = records.reduce((widest, record) => Math.max(widest, record.cells.length), 0);
  const found = findHeaderRow(records);
  const headerRow = choices.headerRow != null && choices.headerRow >= -1 && choices.headerRow < records.length ? choices.headerRow : found;
  const headers = Array.from({ length: width }, (_, index) => (headerRow >= 0 ? text(records[headerRow].cells[index], 60) : "") || `Column ${index + 1}`);
  const rows = records.slice(headerRow + 1);
  const suggested = headerRow >= 0 ? suggestColumns(records[headerRow].cells) : NO_COLUMNS;
  const { columns, problems } = checkColumns(choices.columns ?? suggested, width);
  const outIs = choices.outIs === "positive" ? "positive" : "negative";
  // A currency column with a blank cell on a dated row needs the account's currency too, for that row.
  const blankCurrency = columns.currency !== null && rows.some((row) => looksLikeDate(cellOf(row, columns.bookingDate)) && cellOf(row, columns.currency) === "");

  const base = {
    delimiter: table.delimiter,
    firstRecords: records.slice(0, 30),
    headerRow,
    headers,
    example: Array.from({ length: width }, (_, index) => {
      const first = rows.find((row) => cellOf(row, index) !== "");
      return first ? cellOf(first, index) : "";
    }),
    columns,
    outIs,
    needsCurrency: columns.currency === null || blankCurrency,
  } as const;
  const stop = (questions: StatementQuestion[], more: string[], marks: { dateOrder?: DateOrder | null; decimalMark?: DecimalMark | null } = {}): StatementRead => ({
    ...base,
    dateOrder: marks.dateOrder ?? null,
    decimalMark: marks.decimalMark ?? null,
    questions,
    problems: [...problems, ...more],
    lines: [],
    skipped: [],
    period: null,
    balances: [],
  });

  const typedCurrency = choices.currency ? actualCurrency(choices.currency) : null;
  if (columns.currency === null && !typedCurrency) problems.push("Type the account's currency, such as SGD, EUR or USDC.");
  if (problems.length > 0) return stop([], []);

  // The dates: every booking and value date that looks like one, read in each order (B4).
  const dated = rows.filter((row) => looksLikeDate(cellOf(row, columns.bookingDate)));
  const dateValues = dated.flatMap((row) => [cellOf(row, columns.bookingDate), cellOf(row, columns.valueDate)]).filter(looksLikeDate);
  const questions: StatementQuestion[] = [];
  const more: string[] = [];
  let dateOrder: DateOrder | null = null;
  const dates = decideDateOrder(dateValues);
  if ("order" in dates) dateOrder = dates.order;
  else if ("ask" in dates) {
    if (choices.dateOrder && dates.ask.includes(choices.dateOrder)) dateOrder = choices.dateOrder;
    else questions.push({ kind: "dateOrder", example: dates.example, readings: dates.ask.map((order) => ({ order, day: readDate(dates.example, order)! })) });
  } else if ("unreadable" in dates) {
    const at = dated.find((row) => cellOf(row, columns.bookingDate) === dates.unreadable || cellOf(row, columns.valueDate) === dates.unreadable);
    more.push(`"${dates.unreadable}" on line ${at?.line ?? "?"} is not a date in the order the other dates are written.`);
  }

  // The decimal mark: every amount and balance together. A file in currencies with no minor units has no decimals to ask about.
  const currencies = columns.currency === null ? [typedCurrency!] : dated.map((row) => actualCurrency(cellOf(row, columns.currency)) ?? typedCurrency).filter((code): code is string => code !== null);
  const amountValues = dated.flatMap((row) => [columns.amount, columns.moneyOut, columns.moneyIn, columns.balance].map((column) => cellOf(row, column)));
  let decimalMark: DecimalMark | null = null;
  const marks = decideDecimalMark(amountValues);
  if ("mark" in marks) decimalMark = marks.mark;
  else if ("conflict" in marks) more.push(`"${marks.conflict[0]}" and "${marks.conflict[1]}" are written with different decimal marks.`);
  else if (currencies.length > 0 && currencies.every((code) => billDigits(code) === 0)) decimalMark = marks.example.includes(",") ? "." : ",";
  else if (choices.decimalMark) decimalMark = choices.decimalMark;
  else questions.push({ kind: "decimalMark", example: marks.example });

  if (questions.length > 0 || more.length > 0 || !dateOrder || !decimalMark) return stop(questions, more, { dateOrder, decimalMark });

  const lines: Array<Omit<StatementLine, "occurrence" | "lookalike">> = [];
  const skipped: SkippedRow[] = [];
  const checkpoints: Array<Entry & { currency: string }> = [];
  const latest = nextDay(today);
  for (const row of rows) {
    const skip = (why: string) => skipped.push({ line: row.line, why });
    const dateCell = cellOf(row, columns.bookingDate);
    if (!/\d/.test(dateCell)) {
      skip("No date: not a line of the statement.");
      continue;
    }
    const bookedOn = readDate(dateCell, dateOrder);
    if (!bookedOn) {
      skip(`"${dateCell}" is not a date.`);
      continue;
    }
    if (bookedOn > latest) {
      skip("Dated after tomorrow.");
      continue;
    }
    const currencyCell = cellOf(row, columns.currency);
    const currency = (currencyCell ? actualCurrency(currencyCell) : null) ?? (currencyCell === "" ? typedCurrency : null);
    if (!currency) {
      skip(currencyCell ? `"${currencyCell}" is not a currency code.` : "No currency: type the account's currency.");
      continue;
    }
    const digits = billDigits(currency);
    const read = (value: string) => (value === "" ? null : readAmount(value, decimalMark, digits));
    const notAmount = (value: string) => skip(`"${value}" is not an amount in ${currency}.`);

    const balanceCell = cellOf(row, columns.balance);
    const balanceRead = read(balanceCell);
    if (balanceCell !== "" && !balanceRead) {
      notAmount(balanceCell);
      continue;
    }
    const balance = balanceRead ? (balanceRead.marked === "out" ? -Math.abs(balanceRead.minor) : balanceRead.marked === "in" ? Math.abs(balanceRead.minor) : balanceRead.minor) : null;

    let minor = 0;
    if (columns.amount !== null) {
      const cell = cellOf(row, columns.amount);
      const amount = read(cell);
      if (cell !== "" && !amount) {
        notAmount(cell);
        continue;
      }
      if (amount) {
        if (amount.marked) minor = amount.marked === "out" ? -Math.abs(amount.minor) : Math.abs(amount.minor);
        else minor = outIs === "negative" ? amount.minor : -amount.minor;
      }
    } else {
      // Two columns: the column says the direction, and a value's own sign is ignored.
      const outCell = cellOf(row, columns.moneyOut);
      const inCell = cellOf(row, columns.moneyIn);
      const out = read(outCell);
      const into = read(inCell);
      if (outCell !== "" && !out) {
        notAmount(outCell);
        continue;
      }
      if (inCell !== "" && !into) {
        notAmount(inCell);
        continue;
      }
      const outMinor = Math.abs(out?.minor ?? 0);
      const inMinor = Math.abs(into?.minor ?? 0);
      if (outMinor !== 0 && inMinor !== 0) {
        skip("Both money out and money in are filled in.");
        continue;
      }
      minor = outMinor !== 0 ? -outMinor : inMinor;
    }
    if (minor === 0) {
      if (balance !== null) {
        checkpoints.push({ line: row.line, bookedOn, minor: 0, balance, currency });
        skip("A balance with no amount: used only for the balance check.");
      } else skip("No amount.");
      continue;
    }
    const valueCell = cellOf(row, columns.valueDate);
    lines.push({
      line: row.line,
      bookedOn,
      valueOn: valueCell ? readDate(valueCell, dateOrder) : null,
      minor,
      currency,
      description: text(cellOf(row, columns.description), DESCRIPTION_MAX),
      payee: text(cellOf(row, columns.payee), PAYEE_MAX),
      reference: text(cellOf(row, columns.reference), REFERENCE_MAX),
      balance,
    });
    // One line past the limit is enough to refuse the statement: the rest is not read.
    if (lines.length > STATEMENT_MAX_LINES) break;
  }
  if (lines.length > STATEMENT_MAX_LINES) return stop([], [`The statement has more than ${STATEMENT_MAX_LINES.toLocaleString("en-US")} lines. Import a shorter period.`], { dateOrder, decimalMark });

  // Identical lines stay two lines: each keeps its place among those that look exactly the same.
  const seen = new Map<string, number>();
  const looks = new Map<string, number>();
  const look = (line: (typeof lines)[number]) => JSON.stringify([line.bookedOn, line.minor, line.currency, line.description, line.payee, line.reference]);
  for (const line of lines) looks.set(look(line), (looks.get(look(line)) ?? 0) + 1);
  const keyed: StatementLine[] = lines.map((line) => {
    const same = JSON.stringify([look(line), line.balance]);
    const occurrence = seen.get(same) ?? 0;
    seen.set(same, occurrence + 1);
    return { ...line, occurrence, lookalike: (looks.get(look(line)) ?? 0) > 1 };
  });

  const byCurrency = new Map<string, Entry[]>();
  const entries = [...keyed.map((line) => ({ line: line.line, bookedOn: line.bookedOn, minor: line.minor, balance: line.balance, currency: line.currency })), ...checkpoints].sort((a, b) => a.line - b.line);
  for (const entry of entries) {
    const list = byCurrency.get(entry.currency);
    if (list) list.push(entry);
    else byCurrency.set(entry.currency, [entry]);
  }
  const balances = columns.balance === null ? [] : [...byCurrency].flatMap(([currency, list]) => checkBalance(currency, list) ?? []);

  const days = keyed.map((line) => line.bookedOn).sort();
  return {
    ...base,
    dateOrder,
    decimalMark,
    questions: [],
    problems: [],
    lines: keyed,
    skipped,
    period: days.length > 0 ? { from: days[0], to: days[days.length - 1] } : null,
    balances,
  };
}
