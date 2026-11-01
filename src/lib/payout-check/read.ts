import { decimalMarkOf, isNegativeAmount, readAmount, splitCurrency, type DecimalMark } from "../bill-import/amounts";
import { billRows, headerKey } from "../bill-import/columns";
import { readTable, type Table, type TableRow } from "../bill-import/table";
import { isAddressName } from "../ens-words";
import { evmPart } from "../vendor-check/list";

/**
 * A payout batch read for the payout batch check (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP2, CP6):
 * the file or the pasted rows as rows of cells, a Disperse list among them, its columns found by their names, the rows
 * the check reads, the one question only the person can answer (how the amounts are written), and each amount read to
 * an exact decimal with what is wrong with it in words. Pure, and run in the browser, so nothing pasted leaves the page.
 */

/** The largest file read (CP2). */
export const PAYOUT_FILE_MAX_BYTES = 2_000_000;
/** At most this many rows are checked (CP2). */
export const PAYOUT_ROWS_MAX = 5000;

/** A batch as read (CP2): its rows, and whether they were read as a Disperse list, which has no column names. */
export interface PayoutBatch extends Table {
  disperse: boolean;
}

/**
 * A line of a Disperse list: an address and an amount, separated by spaces, a comma or `=` (CP2). The address is
 * anything without a space, a comma, a semicolon, `=` or a quote, so a cut or mistyped one, or one with a hidden
 * character, is still read and gets the address checker's reason. A minus is read, so the amount gets its own. After a
 * comma the amount holds no comma of its own: `0x…,100,8453` is a CSV of three columns, and `0x…,100,` one of an empty
 * third, never an amount of 100,8453 or 100, (payout check CP2).
 */
const DISPERSE_LINE = /^([^ \t,;="]+)(?:[ \t]*=[ \t]*|[ \t]*,[ \t]*(?=-?[\d.]+$)|[ \t]+)(-?(?:\d[\d.,]*|\.\d+))$/;

/**
 * A batch as rows of cells (CP2). A list in Disperse's form, each non-empty line an address and an amount with no
 * column names, is read as two columns, since its spaces cut no CSV; only when every non-empty line has that form, so
 * a sheet whose first line names its columns is never read so. Anything else is read as the bill import reads a list
 * (`readTable`): a CSV, a semicolon CSV or rows pasted from a sheet. Line numbers count blank lines, as there.
 */
export function readPayoutBatch(raw: string): PayoutBatch {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const rows: TableRow[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    const disperse = DISPERSE_LINE.exec(line);
    if (!disperse) return { ...readTable(text), disperse: false };
    rows.push({ line: index + 1, cells: [disperse[1], disperse[2]] });
  }
  return rows.length > 0 ? { delimiter: ",", rows, disperse: true } : { ...readTable(text), disperse: false };
}

export const PAYOUT_FIELDS = ["address", "name", "amount", "token", "tokenType"] as const;
export type PayoutField = (typeof PAYOUT_FIELDS)[number];

/** The column each field is read from, by its index; a field left out is not in the batch. */
export type PayoutColumns = Partial<Record<PayoutField, number>>;

export const PAYOUT_FIELD_LABELS: Record<PayoutField, string> = {
  address: "Address",
  name: "Name",
  amount: "Amount",
  token: "Token",
  tokenType: "Token type",
};

/**
 * The names each column is known by, as `headerKey` reads them, most telling first (CP2). Safe's CSV Airdrop names its
 * columns `token_type`, `token_address`, `receiver`, `amount` and `id`, and its older form the middle three: both map
 * with nothing to change. A bare "Type" is not the token type: a sheet's "Type" is most often a category. "Recipient"
 * and "Receiver" end the names too: a sheet whose wallet column holds the addresses often gives the payee's name under
 * one of them.
 */
const SYNONYMS: Record<PayoutField, readonly string[]> = {
  address: [
    "receiver", "recipient", "address", "walletaddress", "wallet", "to", "toaddress", "payoutaddress", "paytoaddress",
    "destination", "destinationaddress", "recipientaddress", "receiveraddress", "receivingaddress", "beneficiaryaddress",
    "paymentaddress", "payoutwallet", "evmaddress", "ethaddress", "usdcaddress", "depositaddress", "cryptoaddress",
  ],
  name: [
    "name", "payee", "payeename", "recipientname", "receivername", "vendor", "vendorname", "contractor", "contractorname",
    "label", "beneficiary", "beneficiaryname", "fullname", "employee", "employeename", "supplier", "suppliername",
    "company", "companyname", "freelancer", "recipient", "receiver",
  ],
  amount: [
    "amount", "value", "quantity", "qty", "tokenamount", "payoutamount", "paymentamount", "amounttosend", "amountusdc",
    "usdcamount", "amounteurc", "eurcamount",
  ],
  token: ["tokenaddress", "token", "tokencontract", "asset", "currency", "symbol", "tokensymbol", "coin", "ccy"],
  tokenType: ["tokentype"],
};

const KNOWN = new Set(Object.values(SYNONYMS).flat());

/** Whether a row reads as column names: one of its cells names a column the check knows (CP2). */
export function looksLikePayoutHeader(cells: readonly string[]): boolean {
  return cells.some((cell) => KNOWN.has(headerKey(cell)));
}

/** At most this many rows are looked at to find the columns of a batch without column names. */
const SAMPLED_ROWS = 20;

/** A cell that reads as a number, once its currency is taken off: 1,250.00, 0.5, -3, (12). */
const NUMBER_LIKE = /^[-(]?\s*(?:\d[\d.,' ]*|\.\d+)\)?$/;

/**
 * Each field's column (CP2): from the batch's column names, each column to one field, the first in `PAYOUT_FIELDS`;
 * without them, from what the first rows hold: the column with the most addresses (a `0x` one, one with a chain prefix,
 * or an ENS name), else the first; and the first other column of numbers as the amount. A Disperse list is so read as
 * its address and its amount.
 *
 * With column names, the address is the column named as one whose first rows hold the most addresses, the most telling
 * name first on a tie: a sheet's "Recipient" may hold the payees' names and its "Wallet" their addresses, and is then
 * the name (payout check CP2).
 */
export function detectPayoutColumns(table: Table, hasHeader: boolean): PayoutColumns {
  const sample = table.rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + SAMPLED_ROWS);
  const count = (column: number, test: (cell: string) => boolean) => sample.filter((row) => (row.cells[column] ?? "") !== "" && test(row.cells[column])).length;
  const addressesIn = (column: number) => count(column, (cell) => evmPart(cell) !== null || isAddressName(cell));
  if (hasHeader) {
    const keys = (table.rows[0]?.cells ?? []).map(headerKey);
    const taken = new Set<number>();
    const columns: PayoutColumns = {};
    let most = -1;
    for (const synonym of SYNONYMS.address) {
      keys.forEach((key, column) => {
        if (key !== synonym) return;
        const addresses = addressesIn(column);
        if (addresses > most) {
          columns.address = column;
          most = addresses;
        }
      });
    }
    if (columns.address !== undefined) taken.add(columns.address);
    for (const field of PAYOUT_FIELDS) {
      if (field === "address") continue;
      for (const synonym of SYNONYMS[field]) {
        const index = keys.findIndex((key, column) => key === synonym && !taken.has(column));
        if (index >= 0) {
          columns[field] = index;
          taken.add(index);
          break;
        }
      }
    }
    return columns;
  }
  const width = sample.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
  const filled = (column: number) => count(column, () => true);
  let address = 0;
  let most = 0;
  for (let column = 0; column < width; column += 1) {
    const addresses = addressesIn(column);
    if (addresses > most) {
      address = column;
      most = addresses;
    }
  }
  const columns: PayoutColumns = { address };
  for (let column = 0; column < width; column += 1) {
    if (column === address) continue;
    const numbers = count(column, (cell) => NUMBER_LIKE.test(splitCurrency(cell).number));
    if (numbers > 0 && numbers * 2 >= filled(column)) {
      columns.amount = column;
      break;
    }
  }
  return columns;
}

/** A row of the batch as the check reads it (CP2): each field's cell as written, without the spaces at its ends. */
export interface PayoutRow {
  /** The row's number as the spreadsheet shows it. */
  line: number;
  cells: string[];
  address: string;
  name: string;
  amount: string;
  token: string;
  tokenType: string;
}

const cellOf = (cells: readonly string[], column: number | undefined) => (column === undefined ? "" : (cells[column] ?? "").trim());

/** Whether a row is a payout the check reads: it has an address or an amount (CP2). */
export function isPayoutRow(cells: readonly string[], columns: PayoutColumns): boolean {
  return cellOf(cells, columns.address) !== "" || cellOf(cells, columns.amount) !== "";
}

/** The batch's rows with an address or an amount, at most `PAYOUT_ROWS_MAX`, and how many more there were (CP2). */
export function payoutRows(table: Table, hasHeader: boolean, columns: PayoutColumns): { rows: PayoutRow[]; more: number } {
  const rows: PayoutRow[] = [];
  let more = 0;
  for (const { line, cells } of billRows(table, hasHeader)) {
    if (!isPayoutRow(cells, columns)) continue;
    if (rows.length >= PAYOUT_ROWS_MAX) {
      more += 1;
      continue;
    }
    rows.push({
      line,
      cells,
      address: cellOf(cells, columns.address),
      name: cellOf(cells, columns.name),
      amount: cellOf(cells, columns.amount),
      token: cellOf(cells, columns.token),
      tokenType: cellOf(cells, columns.tokenType),
    });
  }
  return { rows, more };
}

/**
 * Safe's CSV Airdrop leaves `token_address` blank for the chain's own coin (CP7): a blank under a column so named is
 * that coin. Under any other token column, a blank names no token.
 */
export function blankTokenIsNative(table: Table, answers: Pick<PayoutAnswers, "hasHeader" | "columns">): boolean {
  const column = answers.columns.token;
  return answers.hasHeader && column !== undefined && headerKey(table.rows[0]?.cells[column] ?? "") === "tokenaddress";
}

/**
 * How the batch writes its amounts (CP6), from all of them, as the bill check asks it (`decimalMarkOf`): `ask` when
 * none settles it and one reads both ways, `1,000` as one thousand or as one, or when they disagree. Each amount is
 * weighed as one of a token with decimals: only a currency without them settles `1,000` by itself.
 */
export function payoutDecimalMark(rows: readonly PayoutRow[]): { mark: DecimalMark | null; ask: boolean; mixed: boolean } {
  return decimalMarkOf(rows.flatMap((row) => (row.amount === "" ? [] : [{ text: row.amount, currency: "USDC" }])));
}

/** An amount as read: an exact decimal string, or what is wrong with it, a sentence. */
export type PayoutAmount = { ok: true; value: string } | { ok: false; reason: string };

/**
 * A row's amount (CP6), read as the bill import reads one (`readAmount`) in the batch's decimal mark, its currency
 * symbol or code taken off. To fix when it is blank, not a number, zero or below zero, or has more decimals than its
 * token has (`digits`: 6 for USDC and EURC, 18 for a native coin, null for a token the page does not know, whose
 * decimals are not checked). `token` names the token in the sentence. Never too large: an airdrop of a token with a
 * large supply may send 10^15 of it, and an amount written in base units is the median rule's to find (payout check CP6).
 */
export function readPayoutAmount(cell: string, mark: DecimalMark | null, digits: number | null, token: string): PayoutAmount {
  const written = cell.trim();
  if (written === "") return { ok: false, reason: "No amount." };
  const { number } = splitCurrency(written);
  if (isNegativeAmount(number)) return { ok: false, reason: `Amount “${written}” is below zero.` };
  const read = readAmount(number, mark, "", { digits: Number.POSITIVE_INFINITY, wholeDigits: Number.POSITIVE_INFINITY });
  if (!read.ok) return { ok: false, reason: `Amount “${written}” ${read.reason}.` };
  const decimals = read.value.split(".")[1]?.length ?? 0;
  if (digits !== null && decimals > digits) {
    return { ok: false, reason: `Amount “${written}” has ${decimals} decimals, and ${token} has ${digits}.` };
  }
  return { ok: true, value: read.value };
}

/** The person's answers: whether the first row names the columns, which column is which, and how amounts are written. */
export interface PayoutAnswers {
  hasHeader: boolean;
  columns: PayoutColumns;
  decimalMark: DecimalMark | null;
}

/** The answers to start from (CP2): the first row read as column names when it looks like them, each column found. */
export function startingPayoutAnswers(table: Table): PayoutAnswers {
  const hasHeader = looksLikePayoutHeader(table.rows[0]?.cells ?? []);
  return { hasHeader, columns: detectPayoutColumns(table, hasHeader), decimalMark: null };
}

export interface PayoutQuestions {
  /** The rows the check reads, at most `PAYOUT_ROWS_MAX`. */
  rows: number;
  /** The rows past the cap, which are not checked. */
  leftOut: number;
  /** No column is the address. */
  noAddress: boolean;
  /** How the amounts are written; never asked of a batch without an amount column. */
  decimalMark: { mark: DecimalMark | null; ask: boolean; mixed: boolean };
}

export function payoutQuestions(table: Table, answers: PayoutAnswers): PayoutQuestions {
  const { rows, more } = payoutRows(table, answers.hasHeader, answers.columns);
  return {
    rows: rows.length,
    leftOut: more,
    noAddress: answers.columns.address === undefined,
    decimalMark: answers.columns.amount === undefined ? { mark: null, ask: false, mixed: false } : payoutDecimalMark(rows),
  };
}

/** What the person still has to answer before the batch can be checked, in words; null when nothing. */
export function unansweredPayout(questions: PayoutQuestions, answers: PayoutAnswers): string | null {
  if (questions.noAddress) return `Choose the column for ${PAYOUT_FIELD_LABELS.address}.`;
  const columns = Object.values(answers.columns);
  if (new Set(columns).size !== columns.length) return "Choose a different column for each field.";
  if (questions.rows === 0) return "The batch has no row with an address or an amount under its column names.";
  if (questions.decimalMark.ask && answers.decimalMark === null) return "Choose how the batch writes its amounts: 1,234.50 or 1.234,50.";
  return null;
}

/** The decimal mark amounts are read in: the person's answer while the batch asks it, else the one the batch settles. */
export function answeredDecimalMark(questions: PayoutQuestions, answers: PayoutAnswers): DecimalMark | null {
  return questions.decimalMark.ask ? answers.decimalMark : questions.decimalMark.mark;
}
