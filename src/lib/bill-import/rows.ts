import { z } from "zod";
import { invoiceFormRefusal, invoiceInputSchema } from "../intake-validation";
import { nameKey } from "../invoice-document/match";
import type { InvoiceInput } from "../invoices/create";
import type { Network } from "../network";
import type { OriginalBill } from "../shadow-bills";
import { SHADOW_CURRENCIES } from "../shadow-currency";
import { decimalKey, decimalMarkOf, isCurrencyCode, readAmount, splitCurrency, symbolFits, type DecimalMark } from "./amounts";
import { billRows, columnNames, columnCount, detectMapping, FIELD_LABELS, IMPORT_FIELDS, looksLikeHeader, REQUIRED_FIELDS, type ColumnMapping, type ImportField } from "./columns";
import { dateOrderOf, readDate, type DateOrder } from "./dates";
import type { Table, TableRow } from "./table";

/**
 * A bill list's rows, read with the person's answers and given their fates (import design B3–B13): added, already in
 * Vestiarion, or not added and why. Browser-safe and pure: the panel asks its questions with it, and the server runs
 * it again for the check and the import, with the facts it reads in the workspace's scope.
 */

/** The most bills one import takes (B2). */
export const MAX_BILLS = 200;

/** The column the failed-rows download adds (B13): no field is known by its name, so the list comes back as it was. */
export const REASON_COLUMN = "Why it can't be added";

/** The person's answers: which column is which, and what the list itself cannot say. */
export const importSettingsSchema = z.object({
  hasHeader: z.boolean(),
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(500)),
  direction: z.enum(["payable", "receivable"]).nullable(),
  dateOrder: z.enum(["dmy", "mdy"]).nullable(),
  decimalMark: z.enum([".", ","]).nullable(),
  currency: z.string().regex(/^[A-Z]{3,4}$/).nullable(),
  goodsReceived: z.boolean(),
});

export type ImportSettings = z.infer<typeof importSettingsSchema>;

/** What the workspace takes: USDC and EURC, and in shadow mode the business's own currency (B7). */
export interface ImportWorkspace {
  shadowOn: boolean;
  /** The business's own currency in shadow mode; null when shadow mode is off or runs in USDC. */
  shadowCurrency: string | null;
  network: Network;
}

export function acceptedCurrencies(workspace: ImportWorkspace): string[] {
  return ["USDC", "EURC", ...(workspace.shadowCurrency ? [workspace.shadowCurrency] : [])];
}

const cellOf = (row: TableRow, mapping: ColumnMapping, field: ImportField): string => {
  const column = mapping[field];
  return column === undefined ? "" : (row.cells[column] ?? "").trim();
};

/** The currencies the amounts' symbols could be, one list per amount that has one. */
function amountSymbols(table: Table, settings: Pick<ImportSettings, "hasHeader" | "mapping">): string[][] {
  return billRows(table, settings.hasHeader).flatMap((row) => {
    const codes = splitCurrency(cellOf(row, settings.mapping, "amount")).codes;
    return codes ? [codes] : [];
  });
}

/** The list's currency to start at: the business's own in shadow mode, else the one the workspace takes that every symbol fits. */
function suggestedCurrency(table: Table, settings: Pick<ImportSettings, "hasHeader" | "mapping">, workspace: ImportWorkspace): string {
  if (workspace.shadowCurrency) return workspace.shadowCurrency;
  const symbols = amountSymbols(table, settings);
  if (symbols.length === 0) return "USDC";
  return acceptedCurrencies(workspace).find((currency) => symbols.every((codes) => symbolFits(codes, currency))) ?? "USDC";
}

/** The answers to start from: the first row read as column names when it looks like them, and nothing chosen for the person. */
export function startingSettings(table: Table, workspace: ImportWorkspace): ImportSettings {
  const hasHeader = looksLikeHeader(table.rows[0]?.cells ?? []);
  const mapping = hasHeader ? detectMapping(table.rows[0].cells) : {};
  return {
    hasHeader,
    mapping,
    direction: null,
    dateOrder: null,
    decimalMark: null,
    currency: suggestedCurrency(table, { hasHeader, mapping }, workspace),
    goodsReceived: false,
  };
}

/** A row's currency as far as it can be told, and what is wrong with it, before its amount is read. */
function rowCurrency(
  row: TableRow,
  settings: ImportSettings,
  workspace: ImportWorkspace
): { currency: string | null; problem: string | null } {
  const cell = cellOf(row, settings.mapping, "currency");
  const symbol = splitCurrency(cellOf(row, settings.mapping, "amount"));
  const listCurrency = settings.currency;
  let currency: string | null;
  if (cell !== "") {
    const written = /^[A-Za-z]{3,4}$/.test(cell) ? null : splitCurrency(`${cell}1`);
    if (written === null) {
      currency = cell.toUpperCase();
      if (!isCurrencyCode(currency)) return { currency: null, problem: `${cell} is not a currency code.` };
    } else if (written.number !== "1" || !written.codes) {
      return { currency: null, problem: `${cell} is not a currency code.` };
    } else if (written.codes.length > 1) {
      // A symbol that names several, such as $ or ¥: the list's currency when it fits, never a guess.
      if (!listCurrency || !symbolFits(written.codes, listCurrency)) {
        return { currency: null, problem: `Currency “${cell}” could be several currencies: write its code, such as ${written.codes[0]}.` };
      }
      currency = listCurrency;
    } else {
      currency = written.codes[0];
    }
  } else if (listCurrency && symbolFits(symbol.codes, listCurrency)) {
    currency = listCurrency;
  } else if (symbol.codes && symbol.codes.length === 1) {
    currency = symbol.codes[0];
  } else if (symbol.codes) {
    return { currency: null, problem: `The amount's ${symbol.mark} could be several currencies: add a currency column, or write the code, such as ${symbol.codes[0]}.` };
  } else {
    return { currency: null, problem: "No currency: choose the list's currency." };
  }
  if (!symbolFits(symbol.codes, currency)) {
    return { currency, problem: `The amount is written in ${symbol.mark}, but the row's currency is ${currency}.` };
  }
  if (!acceptedCurrencies(workspace).includes(currency)) return { currency, problem: notTaken(currency, workspace) };
  return { currency, problem: null };
}

/** Why a currency is not taken, and how to add the bill anyway (B7). Never suggests shadow mode for a currency Settings does not offer. */
function notTaken(currency: string, workspace: ImportWorkspace): string {
  if (workspace.shadowOn && workspace.shadowCurrency) {
    return `This workspace's shadow mode takes bills in ${workspace.shadowCurrency}. Convert the amount to ${workspace.shadowCurrency} or USDC.`;
  }
  const offered = (SHADOW_CURRENCIES as readonly string[]).includes(currency);
  if (workspace.network === "arc-testnet" && !workspace.shadowOn && offered) {
    return `Bills in ${currency} are taken in shadow mode only. Turn it on for ${currency} in Settings, or convert the amount to USDC.`;
  }
  return "Vestiarion takes bills in USDC or EURC. Convert the amount to USDC.";
}

export interface ImportQuestions {
  /** The fields a row cannot be added without that have no column. */
  missing: ImportField[];
  /** The list has no direction column: the person says bills to pay or invoices to collect. */
  direction: boolean;
  dateOrder: { order: DateOrder | null; ask: boolean; mixed: boolean };
  decimalMark: { mark: DecimalMark | null; ask: boolean; mixed: boolean };
  /** The list has a currency column: the list's currency is only for its blank cells. */
  currencyColumn: boolean;
  /** The list has a goods-received column. */
  goodsColumn: boolean;
  bills: number;
}

export function questionsFor(table: Table, settings: ImportSettings, workspace: ImportWorkspace): ImportQuestions {
  const rows = billRows(table, settings.hasHeader);
  const dates = rows.flatMap((row) => [cellOf(row, settings.mapping, "dueDate"), cellOf(row, settings.mapping, "discountDeadline")]);
  const amounts = rows.map((row) => ({
    text: cellOf(row, settings.mapping, "amount"),
    currency: rowCurrency(row, settings, workspace).currency ?? settings.currency ?? "USDC",
  }));
  return {
    missing: REQUIRED_FIELDS.filter((field) => settings.mapping[field] === undefined),
    direction: settings.mapping.direction === undefined,
    dateOrder: dateOrderOf(dates),
    decimalMark: decimalMarkOf(amounts),
    currencyColumn: settings.mapping.currency !== undefined,
    goodsColumn: settings.mapping.goodsReceived !== undefined,
    bills: rows.length,
  };
}

const listOf = (words: string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** What the person still has to answer before the rows can be checked, in words; null when nothing. */
export function unanswered(questions: ImportQuestions, settings: ImportSettings): string | null {
  if (questions.bills === 0) return "The list has no bills under its column names.";
  if (questions.bills > MAX_BILLS) return `Import at most ${MAX_BILLS} bills at a time. Split the list.`;
  if (questions.missing.length > 0) return `Choose the column for ${listOf(questions.missing.map((field) => FIELD_LABELS[field]))}.`;
  const columns = Object.values(settings.mapping);
  if (new Set(columns).size !== columns.length) return "Choose a different column for each field.";
  if (questions.direction && settings.direction === null) return "Choose whether the list holds bills to pay or invoices to collect.";
  if (questions.dateOrder.ask && settings.dateOrder === null) return "Choose whether the list's dates are day first or month first.";
  if (questions.decimalMark.ask && settings.decimalMark === null) return "Choose how the list writes its amounts: 1,234.50 or 1.234,50.";
  if (settings.currency === null) return "Choose the list's currency.";
  return null;
}

export interface ReadRow {
  line: number;
  cells: string[];
  /** What is wrong with the row as written, each a sentence. */
  problems: string[];
  /** The counterparty's name as written. */
  counterparty: string;
  direction: "payable" | "receivable" | null;
  /** The amount as an exact decimal, in `currency`. */
  amount: string | null;
  currency: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  poReference: string | null;
  /** The memo with the invoice number in front (B9). */
  memo: string | null;
  goodsReceived: boolean;
  discountPct: string | null;
  discountDeadline: string | null;
}

const PAYABLE = new Set(["payable", "ap", "bill", "bills", "pay", "topay", "billtopay", "purchase", "expense", "outgoing"]);
const RECEIVABLE = new Set(["receivable", "ar", "collect", "tocollect", "invoicetocollect", "sale", "sales", "income", "incoming"]);
const YES = new Set(["true", "yes", "y", "1", "received", "x", "✓", "✔"]);
const NO = new Set(["false", "no", "n", "0", "notreceived", "pending", "notyet"]);
const word = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, "");

/** A memo that starts with the bill's invoice number, unless it holds it already (B9). */
export function memoWithInvoiceNumber(invoiceNumber: string | null, memo: string | null): string | null {
  if (!invoiceNumber) return memo || null;
  if (memo && hasWord(memo, invoiceNumber)) return memo;
  return memo ? `Invoice ${invoiceNumber}: ${memo}` : `Invoice ${invoiceNumber}`;
}

/** Whether `text` holds `word` whole, without regard to case: "INV-7" is in "Invoice INV-7: Hosting", not in "INV-77". */
function hasWord(text: string, needle: string): boolean {
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped !== "" && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function readRows(table: Table, settings: ImportSettings, workspace: ImportWorkspace): ReadRow[] {
  const questions = questionsFor(table, settings, workspace);
  const order = settings.dateOrder ?? questions.dateOrder.order;
  const mark = settings.decimalMark ?? questions.decimalMark.mark;
  return billRows(table, settings.hasHeader).map((row) => {
    const cell = (field: ImportField) => cellOf(row, settings.mapping, field);
    const problems: string[] = [];

    const counterparty = cell("counterparty");
    if (counterparty === "") problems.push("No counterparty name.");

    let direction: ReadRow["direction"] = settings.direction;
    if (settings.mapping.direction !== undefined) {
      const written = cell("direction");
      if (PAYABLE.has(word(written))) direction = "payable";
      else if (RECEIVABLE.has(word(written))) direction = "receivable";
      else if (written !== "") {
        direction = null;
        problems.push(`${FIELD_LABELS.direction} “${written}” is not one Vestiarion knows: write payable or receivable.`);
      } else if (direction === null) {
        problems.push("No direction: write payable or receivable.");
      }
    }

    let amount: string | null = null;
    const { currency, problem } = rowCurrency(row, settings, workspace);
    const amountCell = cell("amount");
    if (amountCell === "") problems.push("No amount.");
    else if (problem) problems.push(problem);
    else if (currency) {
      const read = readAmount(splitCurrency(amountCell).number, mark, currency);
      if (read.ok) amount = read.value;
      else problems.push(`Amount “${amountCell}” ${read.reason}.`);
    }

    const dateOf = (field: "dueDate" | "discountDeadline", label: string): string | null => {
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
    const discountDeadline = dateOf("discountDeadline", "Discount deadline");

    let goodsReceived = settings.goodsReceived;
    if (settings.mapping.goodsReceived !== undefined) {
      const written = cell("goodsReceived");
      if (YES.has(word(written))) goodsReceived = true;
      else if (NO.has(word(written)) || written === "") goodsReceived = false;
      else problems.push(`Goods received “${written}” is not yes or no.`);
    }

    const invoiceNumber = cell("invoiceNumber") || null;
    if (invoiceNumber && invoiceNumber.length > 100) problems.push("The invoice number is longer than 100 characters.");
    const memo = memoWithInvoiceNumber(invoiceNumber, cell("memo") || null);
    if (memo && memo.length > 280) problems.push("The memo, with the invoice number, is longer than 280 characters.");
    const discountPct = cell("discountPct").replace(/\s*%$/, "") || null;

    return {
      line: row.line,
      cells: row.cells,
      problems,
      counterparty,
      direction,
      amount,
      currency,
      dueDate,
      invoiceNumber,
      poReference: cell("poReference") || null,
      memo,
      goodsReceived,
      discountPct,
      discountDeadline,
    };
  });
}

/** A bill in the business's own currency at its USDC amount, as the shadow path worked it out (B15), or why it could not be. */
export type Conversion = { ok: true; usdc: number; original: OriginalBill } | { ok: false; reason: string };

export const conversionKey = (currency: string, amount: string) => `${currency} ${amount}`;

const PAID_AS_IS = new Set(["USDC", "EURC"]);

/** The bills in the business's own currency the server converts before their fates are given. */
export function conversionsNeeded(rows: readonly ReadRow[]): Array<{ currency: string; amount: string }> {
  const seen = new Map<string, { currency: string; amount: string }>();
  for (const row of rows) {
    if (row.problems.length > 0 || !row.currency || !row.amount || PAID_AS_IS.has(row.currency)) continue;
    seen.set(conversionKey(row.currency, row.amount), { currency: row.currency, amount: row.amount });
  }
  return [...seen.values()];
}

/** An invoice already in the workspace that a row could repeat (B10). */
export interface ExistingInvoice {
  id: string;
  counterpartyId: string;
  /** `YYYY-MM-DD` */
  dueDate: string;
  amount: string;
  currency: string;
  originalAmount: string | null;
  originalCurrency: string | null;
  poReference: string | null;
  memo: string | null;
}

export interface ImportFacts {
  counterparties: ReadonlyArray<{ id: string; name: string }>;
  existing: readonly ExistingInvoice[];
  conversions: ReadonlyMap<string, Conversion>;
}

export interface FateBase {
  line: number;
  /** The counterparty's name: the workspace's, once matched; as written otherwise. */
  counterparty: string;
  amount: string | null;
  currency: string | null;
  dueDate: string | null;
  /** The invoice number, or the purchase order. */
  reference: string | null;
  /** The USDC a bill in the business's own currency is added at. */
  usdc: string | null;
}

export type RowFate =
  | (FateBase & { status: "add"; counterpartyId: string; invoice: InvoiceInput; original: OriginalBill | null; invoiceNumber: string | null })
  | (FateBase & { status: "duplicate"; reason: string; invoiceId: string | null; sameAsLine: number | null })
  | (FateBase & { status: "error"; reason: string });

const UNREADABLE_RATE = "The day's rate could not be read. Try again in a moment.";
const same = (a: string | null, b: string | null) => a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The counterparty a name means: by its name, or failing that by its name without punctuation and legal suffixes (B8). */
function counterpartyFor(name: string, counterparties: ImportFacts["counterparties"]): { id: string; name: string } | string {
  const plain = name.trim().toLowerCase();
  let found = counterparties.filter((counterparty) => counterparty.name.trim().toLowerCase() === plain);
  if (found.length === 0) {
    const key = nameKey(name);
    found = key ? counterparties.filter((counterparty) => nameKey(counterparty.name) === key) : [];
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) return `“${name}” matches more than one counterparty in this workspace. Add this bill with the invoice form.`;
  return `No counterparty named “${name}” in this workspace. Add it in Counterparties, then import this row again.`;
}

/** The bill's own amount, compared exactly: its original figure for one converted in shadow mode (B10). */
const billKey = (currency: string, amount: string | number) => `${currency.toUpperCase()} ${decimalKey(amount)}`;

interface Candidate {
  counterpartyId: string;
  dueDate: string;
  bill: string;
  invoiceNumber: string | null;
  poReference: string | null;
}

/** Whether an earlier bill has the row's reference: its invoice number in the memo or as the purchase order, else its purchase order (B10). */
function sameReference(row: Candidate, other: { memo: string | null; poReference: string | null }): boolean {
  if (row.invoiceNumber && ((other.memo !== null && hasWord(other.memo, row.invoiceNumber)) || same(other.poReference, row.invoiceNumber))) return true;
  if (row.poReference && same(other.poReference, row.poReference)) return true;
  return !row.invoiceNumber && !row.poReference && !other.poReference;
}

export function fatesOf(rows: readonly ReadRow[], facts: ImportFacts): RowFate[] {
  const added: Array<{ line: number; candidate: Candidate; memo: string | null }> = [];
  return rows.map((row): RowFate => {
    const problems = [...row.problems];
    const base: FateBase = {
      line: row.line,
      counterparty: row.counterparty,
      amount: row.amount,
      currency: row.currency,
      dueDate: row.dueDate,
      reference: row.invoiceNumber ?? row.poReference,
      usdc: null,
    };
    let counterparty: { id: string; name: string } | null = null;
    if (row.counterparty !== "") {
      const match = counterpartyFor(row.counterparty, facts.counterparties);
      if (typeof match === "string") problems.unshift(match);
      else {
        counterparty = match;
        base.counterparty = match.name;
      }
    }
    let original: OriginalBill | null = null;
    let usdcAmount = row.amount;
    let paidIn = row.currency;
    if (problems.length === 0 && row.currency && row.amount && !PAID_AS_IS.has(row.currency)) {
      const conversion = facts.conversions.get(conversionKey(row.currency, row.amount));
      if (!conversion) problems.push(UNREADABLE_RATE);
      else if (!conversion.ok) problems.push(conversion.reason);
      else {
        original = conversion.original;
        usdcAmount = String(conversion.usdc);
        paidIn = "USDC";
        base.usdc = usdcAmount;
      }
    }
    if (problems.length > 0 || !counterparty || !row.direction || !row.dueDate || !usdcAmount || !paidIn || !row.currency || !row.amount) {
      return { ...base, status: "error", reason: problems.join(" ") || "This row could not be read." };
    }

    const parsed = invoiceInputSchema.safeParse({
      direction: row.direction,
      counterpartyId: counterparty.id,
      amount: usdcAmount,
      currency: paidIn,
      memo: row.memo ?? "",
      poReference: row.poReference ?? "",
      goodsReceived: row.goodsReceived,
      dueDate: row.dueDate,
      earlyPayDiscountPct: row.discountPct ?? "",
      discountDeadline: row.discountDeadline ?? "",
    });
    if (!parsed.success) return { ...base, status: "error", reason: invoiceFormRefusal(parsed.error).message };

    const candidate: Candidate = {
      counterpartyId: counterparty.id,
      dueDate: row.dueDate,
      bill: billKey(row.currency, row.amount),
      invoiceNumber: row.invoiceNumber,
      poReference: row.poReference,
    };
    const existing = facts.existing.find(
      (invoice) =>
        invoice.counterpartyId === candidate.counterpartyId &&
        invoice.dueDate === candidate.dueDate &&
        (invoice.originalCurrency && invoice.originalAmount !== null
          ? billKey(invoice.originalCurrency, invoice.originalAmount)
          : billKey(invoice.currency, invoice.amount)) === candidate.bill &&
        sameReference(candidate, invoice)
    );
    if (existing) {
      return { ...base, status: "duplicate", reason: "Already in Vestiarion: same counterparty, amount, due date and reference.", invoiceId: existing.id, sameAsLine: null };
    }
    const earlier = added.find(
      (other) =>
        other.candidate.counterpartyId === candidate.counterpartyId &&
        other.candidate.dueDate === candidate.dueDate &&
        other.candidate.bill === candidate.bill &&
        sameReference(candidate, { memo: other.memo, poReference: other.candidate.poReference })
    );
    if (earlier) {
      return { ...base, status: "duplicate", reason: `Same as row ${earlier.line} of this list.`, invoiceId: null, sameAsLine: earlier.line };
    }
    added.push({ line: row.line, candidate, memo: row.memo });
    return { ...base, status: "add", counterpartyId: counterparty.id, invoice: parsed.data, original, invoiceNumber: row.invoiceNumber };
  });
}

/** What every fate shows of its row, whatever happened to it. */
export function baseOf(fate: RowFate): FateBase {
  const { line, counterparty, amount, currency, dueDate, reference, usdc } = fate;
  return { line, counterparty, amount, currency, dueDate, reference, usdc };
}

/** A row after the import: added, with the invoice it became; already in Vestiarion; or not added, and why (B12). */
export type ImportedFate =
  | (FateBase & { status: "added"; invoiceId: string })
  | Extract<RowFate, { status: "duplicate" }>
  | Extract<RowFate, { status: "error" }>;

export function countFates(fates: readonly RowFate[]): { add: number; duplicate: number; error: number } {
  return {
    add: fates.filter((fate) => fate.status === "add").length,
    duplicate: fates.filter((fate) => fate.status === "duplicate").length,
    error: fates.filter((fate) => fate.status === "error").length,
  };
}

function csvCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The rows that could not be added, as the list wrote them, with the reason in a last column (I08): a CSV in the list's
 * own delimiter (a pasted list becomes a comma one), with a byte-order mark so a spreadsheet reads its names right.
 * Empty when every row could be added.
 */
export function failedRowsCsv(table: Table, settings: Pick<ImportSettings, "hasHeader">, fates: readonly RowFate[]): string {
  const failed = new Map(fates.flatMap((fate) => (fate.status === "error" ? [[fate.line, fate.reason] as const] : [])));
  if (failed.size === 0) return "";
  const delimiter = table.delimiter === ";" ? ";" : ",";
  const width = columnCount(table);
  const padded = (cells: readonly string[]) => Array.from({ length: width }, (_, index) => cells[index] ?? "");
  const lines: string[][] = [];
  if (settings.hasHeader) lines.push([...padded(columnNames(table, true)), REASON_COLUMN]);
  for (const row of billRows(table, settings.hasHeader)) {
    const reason = failed.get(row.line);
    if (reason !== undefined) lines.push([...padded(row.cells), reason]);
  }
  return `﻿${lines.map((cells) => cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)).join("\r\n")}\r\n`;
}
