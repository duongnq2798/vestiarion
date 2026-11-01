import { csvCell } from "../bill-check/csv";
import { billRows, columnCount, columnNames } from "../bill-import/columns";
import { savedListName, type Table } from "../bill-import/table";
import { payoutCheckWords, type PayoutCheck } from "./findings";
import { isPayoutRow, PAYOUT_ROWS_MAX, type PayoutAnswers } from "./read";

/**
 * The batch back with what the check found (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP10): every
 * row as the batch wrote it, and one column added saying the row's verdict and why, made in the browser as the bill
 * check gives back its list (`checkedCsv`). No list of rows to send: the page does not pick what to pay.
 */

/** The column the check adds: no field is known by its name, so the batch can be checked again as it comes back. */
export const PAYOUT_CHECK_COLUMN = "Payout check";

const LEFT_OUT = `Not checked: only the first ${PAYOUT_ROWS_MAX.toLocaleString("en-US")} rows are checked.`;

/**
 * The batch as a CSV, its column names first when it has them, with `PAYOUT_CHECK_COLUMN` last and a byte-order mark
 * so a spreadsheet reads its names right. A semicolon batch keeps its semicolons; any other, pasted, tab-separated or a
 * Disperse list, comes back with commas. A row with no address and no amount, which the check skips, has the column
 * empty; a row past the first `PAYOUT_ROWS_MAX` says it was not checked.
 */
export function checkedPayoutCsv(table: Table, answers: Pick<PayoutAnswers, "hasHeader" | "columns">, check: PayoutCheck): string {
  const words = new Map(check.results.map((result) => [result.row.line, payoutCheckWords(result)] as const));
  const delimiter = table.delimiter === ";" ? ";" : ",";
  const width = columnCount(table);
  const padded = (cells: readonly string[]) => Array.from({ length: width }, (_, index) => cells[index] ?? "");
  const lines: string[][] = [];
  if (answers.hasHeader) lines.push([...padded(columnNames(table, true)), PAYOUT_CHECK_COLUMN]);
  for (const row of billRows(table, answers.hasHeader)) {
    const found = words.get(row.line) ?? (isPayoutRow(row.cells, answers.columns) ? LEFT_OUT : "");
    lines.push([...padded(row.cells), found]);
  }
  return `${String.fromCharCode(0xfeff)}${lines.map((cells) => cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)).join("\r\n")}\r\n`;
}

/** The name the batch is saved under: its own, said to be checked, as the bill check names its list. */
export function checkedPayoutFileName(source: string): string {
  return savedListName(source, "checked");
}
