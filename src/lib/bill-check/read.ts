import { LATE_FEE_MAX_PERCENT, type LateFee } from "../agent/late-fee";
import { decimalMarkOf, isCurrencyCode, readAmount, splitCurrency, symbolFits, type DecimalMark } from "../bill-import/amounts";
import { billRows, detectMapping, FIELD_LABELS, IMPORT_FIELDS, looksLikeHeader, REQUIRED_FIELDS, type ColumnMapping, type ImportField } from "../bill-import/columns";
import { dateOrderOf, orderWords, readDate, type DateOrder, type DateOrderQuestion } from "../bill-import/dates";
import type { Table, TableRow } from "../bill-import/table";
import { nameKey } from "../invoice-document/match";

/**
 * A bill list read for the free bill list check (docs/superpowers/specs/2026-10-28-check-bills-design.md CB2–CB4): its
 * columns matched as the bill import matches them, the questions only the person can answer, and each bill read to what
 * the check compares, with what is wrong with it in words. Read-only and pure: it takes nothing from a workspace, adds
 * nothing, and runs in the browser.
 */

/** The most bills one check reads, so it stays fast in a browser (CB2). */
export const MAX_CHECK_BILLS = 5_000;

/** The import's fields the check reads. Whether a row is a bill or an invoice, and whether its goods came, it does not use (CB3). */
export const CHECK_FIELDS: readonly ImportField[] = IMPORT_FIELDS.filter((field) => field !== "direction" && field !== "goodsReceived");

/** The list's currency, for rows that do not say, is one of these: it labels amounts, and converts nothing (CB3). */
export const LIST_CURRENCIES: readonly string[] = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SGD", "JPY", "MXN", "USDC", "EURC"];

/** The person's answers: which column is which, and what the list itself cannot say. */
export interface CheckAnswers {
  hasHeader: boolean;
  mapping: ColumnMapping;
  dateOrder: DateOrder | null;
  decimalMark: DecimalMark | null;
  /** For rows that name no currency of their own. */
  currency: string | null;
}

/** Each field's column from the list's column names, as the import matches them, without the fields the check leaves out. */
export function checkMapping(headers: readonly string[]): ColumnMapping {
  const mapping = detectMapping(headers);
  const kept: ColumnMapping = {};
  for (const field of CHECK_FIELDS) if (mapping[field] !== undefined) kept[field] = mapping[field];
  return kept;
}

const cellOf = (row: TableRow, mapping: ColumnMapping, field: ImportField): string => {
  const column = mapping[field];
  return column === undefined ? "" : (row.cells[column] ?? "").trim();
};

/** The bills the check reads: every row after the column names, or every row when there are none, up to the cap. */
function checkedRows(table: Table, hasHeader: boolean): TableRow[] {
  return billRows(table, hasHeader).slice(0, MAX_CHECK_BILLS);
}

/**
 * The currency a row names itself: a code or symbol in the currency column, or the amount's own symbol when it means one
 * currency. `codes` when it names none, or only a symbol that could mean several ($, ¥): the list's currency is needed.
 */
type OwnCurrency = { kind: "named"; currency: string } | { kind: "unnamed"; codes: string[] | null; written: string } | { kind: "wrong"; problem: string };

function ownCurrency(row: TableRow, mapping: ColumnMapping): OwnCurrency {
  const cell = cellOf(row, mapping, "currency");
  if (cell !== "") {
    if (/^[A-Za-z]{3,4}$/.test(cell)) {
      const code = cell.toUpperCase();
      return isCurrencyCode(code) ? { kind: "named", currency: code } : { kind: "wrong", problem: `${cell} is not a currency code.` };
    }
    const written = splitCurrency(`${cell}1`);
    if (written.number !== "1" || !written.codes) return { kind: "wrong", problem: `${cell} is not a currency code.` };
    return written.codes.length === 1 ? { kind: "named", currency: written.codes[0] } : { kind: "unnamed", codes: written.codes, written: cell };
  }
  const symbol = splitCurrency(cellOf(row, mapping, "amount"));
  if (symbol.codes && symbol.codes.length === 1) return { kind: "named", currency: symbol.codes[0] };
  return { kind: "unnamed", codes: symbol.codes, written: symbol.mark ?? "" };
}

/** A row's currency, and what is wrong with it before its amount is read. */
function rowCurrency(row: TableRow, answers: CheckAnswers): { currency: string | null; problem: string | null } {
  const own = ownCurrency(row, answers.mapping);
  if (own.kind === "wrong") return { currency: null, problem: own.problem };
  let currency: string;
  if (own.kind === "named") currency = own.currency;
  else if (answers.currency && symbolFits(own.codes, answers.currency)) currency = answers.currency;
  else if (own.codes) return { currency: null, problem: `“${own.written}” could be several currencies: write its code, such as ${own.codes[0]}, or choose the list's currency.` };
  else return { currency: null, problem: "No currency: choose the list's currency." };
  const symbol = splitCurrency(cellOf(row, answers.mapping, "amount"));
  if (!symbolFits(symbol.codes, currency)) return { currency, problem: `The amount is written in ${symbol.mark}, but the row's currency is ${currency}.` };
  return { currency, problem: null };
}

/** The list's currency to start at: the first offered that every row naming none fits, by its symbol; null when none fits all. */
function suggestedCurrency(rows: readonly TableRow[], mapping: ColumnMapping): string | null {
  const unnamed = rows.flatMap((row) => {
    const own = ownCurrency(row, mapping);
    return own.kind === "unnamed" ? [own.codes] : [];
  });
  return LIST_CURRENCIES.find((currency) => unnamed.every((codes) => symbolFits(codes, currency))) ?? null;
}

/** The answers to start from: the first row read as column names when it looks like them, each field matched as the import does. */
export function startingAnswers(table: Table): CheckAnswers {
  const hasHeader = looksLikeHeader(table.rows[0]?.cells ?? []);
  const mapping = hasHeader ? checkMapping(table.rows[0].cells) : {};
  return { hasHeader, mapping, dateOrder: null, decimalMark: null, currency: suggestedCurrency(checkedRows(table, hasHeader), mapping) };
}

export interface CheckQuestions {
  /** The fields a bill cannot be checked without that have no column. */
  missing: ImportField[];
  dateOrder: DateOrderQuestion;
  decimalMark: { mark: DecimalMark | null; ask: boolean; mixed: boolean };
  /** A row names no currency of its own: the list's is needed. */
  currency: boolean;
  /** The bills the check reads, at most `MAX_CHECK_BILLS`. */
  bills: number;
  /** The bills past the cap, which are not checked. */
  leftOut: number;
}

export function questionsOf(table: Table, answers: CheckAnswers): CheckQuestions {
  const all = billRows(table, answers.hasHeader);
  const rows = all.slice(0, MAX_CHECK_BILLS);
  const dates = rows.flatMap((row) => [
    cellOf(row, answers.mapping, "dueDate"),
    cellOf(row, answers.mapping, "discountDeadline"),
    cellOf(row, answers.mapping, "lateFeeStartsOn"),
  ]);
  const owns = rows.map((row) => ownCurrency(row, answers.mapping));
  const amounts = rows.map((row, index) => {
    const own = owns[index];
    return { text: cellOf(row, answers.mapping, "amount"), currency: own.kind === "named" ? own.currency : (answers.currency ?? "USD") };
  });
  return {
    missing: REQUIRED_FIELDS.filter((field) => answers.mapping[field] === undefined),
    dateOrder: dateOrderOf(dates),
    decimalMark: decimalMarkOf(amounts),
    currency: owns.some((own) => own.kind === "unnamed"),
    bills: rows.length,
    leftOut: all.length - rows.length,
  };
}

/** The person's answer about dates, while the list asks it and offers that order; null otherwise. */
function answeredOrder(questions: CheckQuestions, answers: CheckAnswers): DateOrder | null {
  const { dateOrder } = answers;
  return questions.dateOrder.ask && dateOrder !== null && questions.dateOrder.orders.includes(dateOrder) ? dateOrder : null;
}

const listOf = (words: string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** What the person still has to answer before the bills can be checked, in words; null when nothing. */
export function unansweredOf(questions: CheckQuestions, answers: CheckAnswers): string | null {
  if (questions.bills === 0) return "The list has no bills under its column names.";
  if (questions.missing.length > 0) return `Choose the column for ${listOf(questions.missing.map((field) => FIELD_LABELS[field]))}.`;
  const columns = Object.values(answers.mapping);
  if (new Set(columns).size !== columns.length) return "Choose a different column for each field.";
  if (questions.dateOrder.ask && answeredOrder(questions, answers) === null) return `Choose whether the list's dates are ${orderWords(questions.dateOrder.orders)}.`;
  if (questions.decimalMark.ask && answers.decimalMark === null) return "Choose how the list writes its amounts: 1,234.50 or 1.234,50.";
  if (questions.currency && answers.currency === null) return "Choose the list's currency.";
  return null;
}

/** A bill as the check reads it (CB4). */
export interface ListBill {
  /** The row's number as the spreadsheet shows it. */
  line: number;
  cells: string[];
  /** The counterparty's name as written. */
  vendor: string;
  /** The name bills are grouped by: without case, punctuation or a legal suffix (`vendorKeyOf`). */
  vendorKey: string;
  /** An exact decimal, in `currency`. */
  amount: string | null;
  currency: string | null;
  /** `YYYY-MM-DD` */
  dueDate: string | null;
  invoiceNumber: string | null;
  poReference: string | null;
  memo: string | null;
  /** An early-payment discount: its percent, and the last day it applies. */
  discount: { pct: number; deadline: string } | null;
  lateFee: LateFee | null;
  /** What is wrong with the row as written, each a sentence. */
  problems: string[];
  /** Read well enough to check: a counterparty, an amount in a currency and a due date. */
  checked: boolean;
}

/** A percent as a list writes it: "2", "1.5", "1,5" or "2%"; NaN for anything else. */
function percentOf(cell: string): number {
  const written = cell.replace(/\s*%$/, "");
  return /^\d+(?:[.,]\d+)?$/.test(written) ? Number(written.replace(",", ".")) : Number.NaN;
}

const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);

const latinWord = (word: string) => /^[a-z0-9]+$/.test(word);

/**
 * The name a vendor's bills are grouped by (CB4): `nameKey`, without case, punctuation or a legal suffix. `nameKey` keeps
 * a to z and 0 to 9 only, so a name with other letters keeps every word, a Latin legal suffix still left out: "東京 Design"
 * and "大阪 Design" stay two vendors, as "東京 Design Ltd." and "東京 Design" are one.
 */
export function vendorKeyOf(vendor: string): string {
  const words = vendor.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.every(latinWord)) return nameKey(vendor) || vendor.toLowerCase();
  return words.filter((word) => !latinWord(word) || nameKey(word) !== "").join(" ");
}

export function readBills(table: Table, answers: CheckAnswers): ListBill[] {
  const questions = questionsOf(table, answers);
  // An answer counts only while its question is asked, as in the import: once the list settles it, the list's own does.
  const order = questions.dateOrder.ask ? answeredOrder(questions, answers) : questions.dateOrder.order;
  const mark = questions.decimalMark.ask ? answers.decimalMark : questions.decimalMark.mark;
  return checkedRows(table, answers.hasHeader).map((row) => {
    const cell = (field: ImportField) => cellOf(row, answers.mapping, field);
    const problems: string[] = [];

    const vendor = cell("counterparty");
    if (vendor === "") problems.push("No counterparty name.");

    let amount: string | null = null;
    const { currency, problem } = rowCurrency(row, answers);
    const amountCell = cell("amount");
    if (amountCell === "") problems.push("No amount.");
    else if (problem) problems.push(problem);
    else if (currency) {
      const read = readAmount(splitCurrency(amountCell).number, mark, currency);
      if (read.ok) amount = read.value;
      else problems.push(`Amount “${amountCell}” ${read.reason}.`);
    }

    const dateOf = (field: "dueDate" | "discountDeadline" | "lateFeeStartsOn", label: string): string | null => {
      const written = cell(field);
      if (written === "") {
        if (field === "dueDate") problems.push("No due date.");
        return null;
      }
      const read = readDate(written, order);
      if (read.ok) return read.iso;
      problems.push(`${label} “${written}” ${read.reason}.`);
      return null;
    };
    const dueDate = dateOf("dueDate", "Due date");
    const deadline = dateOf("discountDeadline", "Discount deadline");
    const startsOn = dateOf("lateFeeStartsOn", "Late fee start");

    return {
      line: row.line,
      cells: row.cells,
      vendor,
      vendorKey: vendorKeyOf(vendor),
      amount,
      currency,
      dueDate,
      invoiceNumber: cell("invoiceNumber") || null,
      poReference: cell("poReference") || null,
      memo: cell("memo") || null,
      discount: discountOf(cell("discountPct"), cell("discountDeadline") !== "", deadline, dueDate, problems),
      lateFee: lateFeeOf(cell("lateFeePercent"), cell("lateFeeAmount"), cell("lateFeeStartsOn") !== "", startsOn, { dueDate, mark, currency, problems }),
      problems,
      checked: vendor !== "" && amount !== null && currency !== null && dueDate !== null,
    };
  });
}

/** A row's early-payment discount: a percent above 0 and below 100, and its deadline, on or before the due date. */
function discountOf(pctCell: string, deadlineWritten: boolean, deadline: string | null, dueDate: string | null, problems: string[]): ListBill["discount"] {
  if (pctCell === "") return null;
  const pct = percentOf(pctCell);
  if (!(pct > 0 && pct < 100)) {
    problems.push(`Early-payment discount “${pctCell}” is not a percent above 0 and below 100.`);
    return null;
  }
  if (!deadline) {
    // A deadline that could not be read has said why already.
    if (!deadlineWritten) problems.push("An early-payment discount needs its deadline: it is left out.");
    return null;
  }
  if (dueDate && deadline > dueDate) {
    problems.push("The discount deadline is after the due date: the discount is left out.");
    return null;
  }
  return { pct, deadline };
}

/**
 * A row's late fee: a percent a month, at most `LATE_FEE_MAX_PERCENT`, or a fixed amount read as the amount is, and its
 * first day. A fee without one starts the day after the due date, as Vestiarion reads it (late fees LF1).
 */
function lateFeeOf(
  percentCell: string,
  amountCell: string,
  startWritten: boolean,
  startsOn: string | null,
  row: { dueDate: string | null; mark: DecimalMark | null; currency: string | null; problems: string[] }
): LateFee | null {
  if (percentCell !== "" && amountCell !== "") {
    row.problems.push("Give a late fee as a percent a month or a fixed amount, not both.");
    return null;
  }
  let fee: Pick<LateFee, "kind" | "value">;
  if (percentCell !== "") {
    const percent = percentOf(percentCell);
    if (!(percent > 0 && percent <= LATE_FEE_MAX_PERCENT)) {
      row.problems.push(`Late fee “${percentCell}” is not a percent above 0 and at most ${LATE_FEE_MAX_PERCENT} a month.`);
      return null;
    }
    fee = { kind: "percent_month", value: percent };
  } else if (amountCell !== "") {
    if (!row.currency) return null;
    const read = readAmount(splitCurrency(amountCell).number, row.mark, row.currency);
    if (!read.ok) {
      row.problems.push(`Late fee “${amountCell}” ${read.reason}.`);
      return null;
    }
    fee = { kind: "fixed", value: Number(read.value) };
  } else {
    if (startWritten) row.problems.push("A late fee start needs the fee beside it: it is left out.");
    return null;
  }
  if (!row.dueDate || (startWritten && !startsOn)) return null;
  const first = startsOn ?? dayAfter(row.dueDate);
  if (first < row.dueDate) {
    row.problems.push("The late fee cannot start before the due date.");
    return null;
  }
  return { ...fee, startsOn: first };
}
