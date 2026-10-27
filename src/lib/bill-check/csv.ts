import { billRows, columnCount, columnNames } from "../bill-import/columns";
import type { Table } from "../bill-import/table";
import { dayWords, moneyWords, type BillCheck } from "./findings";
import { MAX_CHECK_BILLS, type CheckAnswers } from "./read";

/**
 * The list back with what the check found (docs/superpowers/specs/2026-10-28-check-bills-design.md CB8): every row as
 * the list wrote it, and a last column saying what was found on it, made in the browser, as the import gives back the
 * rows it could not add.
 */

/** The column the check adds: no field is known by its name, so the list can be checked again as it comes back. */
export const FLAG_COLUMN = "Bill check";

const LEFT_OUT = `Not checked: only the first ${MAX_CHECK_BILLS.toLocaleString("en-US")} bills are checked.`;

/** What the check found on each row, by its line, in words a spreadsheet cell holds. */
export function flagsOf(check: BillCheck): Map<number, string[]> {
  const flags = new Map<number, string[]>();
  const add = (line: number, flag: string) => flags.set(line, [...(flags.get(line) ?? []), flag]);
  for (const vendor of check.duplicates) {
    for (const finding of vendor.findings) {
      add(finding.bill.line, `Likely duplicate of row ${finding.other.line} (confidence ${finding.confidence.toFixed(2)})`);
      add(finding.other.line, `Row ${finding.bill.line} may be a duplicate of this bill`);
    }
  }
  for (const run of check.monthApart) {
    const lines = run.bills.map((bill) => bill.line).join(", ");
    for (const bill of run.bills) add(bill.line, `Same amount about a month apart: rows ${lines}`);
  }
  for (const deadline of check.deadlines) {
    const worth = moneyWords(deadline.worth.amount, deadline.worth.currency);
    if (deadline.kind === "discount") add(deadline.bill.line, `Discount ends ${dayWords(deadline.lastDay)}: ${worth}`);
    else add(deadline.bill.line, `Late fee from ${dayWords(deadline.bill.lateFee!.startsOn)}: ${worth}${deadline.bill.lateFee!.kind === "fixed" ? "" : " a month"}`);
  }
  for (const bill of check.bills) {
    if (bill.problems.length === 0) continue;
    add(bill.line, bill.checked ? bill.problems.join(" ") : `Not checked: ${bill.problems.join(" ")}`);
  }
  return flags;
}

function csvCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The list as a CSV in its own delimiter (a pasted list becomes a comma one), its column names first when it has them,
 * with `FLAG_COLUMN` last and a byte-order mark so a spreadsheet reads its names right.
 */
export function checkedCsv(table: Table, answers: Pick<CheckAnswers, "hasHeader">, check: BillCheck): string {
  const flags = flagsOf(check);
  const delimiter = table.delimiter === ";" ? ";" : ",";
  const width = columnCount(table);
  const padded = (cells: readonly string[]) => Array.from({ length: width }, (_, index) => cells[index] ?? "");
  const lines: string[][] = [];
  if (answers.hasHeader) lines.push([...padded(columnNames(table, true)), FLAG_COLUMN]);
  billRows(table, answers.hasHeader).forEach((row, index) => {
    const found = index < MAX_CHECK_BILLS ? (flags.get(row.line) ?? []) : [LEFT_OUT];
    lines.push([...padded(row.cells), found.join("; ")]);
  });
  return `${String.fromCharCode(0xfeff)}${lines.map((cells) => cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)).join("\r\n")}\r\n`;
}

/** The name the list is saved under: its own, said to be checked. */
export function checkedFileName(source: string): string {
  const base = source.replace(/\.(csv|tsv|txt)$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "bills";
  return `${base}-checked.csv`;
}
