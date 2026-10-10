/**
 * A bank statement's table (docs/superpowers/specs/2026-10-10-bank-statement-design.md B2): the delimiter, quoted fields,
 * and the line of the file each record starts on, as a spreadsheet numbers it. Pure and browser-safe: the browser reads
 * the table to show the columns, and the server reads the same text again before it matches or saves anything.
 */

export type Delimiter = "," | ";" | "\t" | "|";
export const DELIMITERS: readonly Delimiter[] = [",", ";", "\t", "|"];

/** Each delimiter in words, for the person choosing one. */
export const DELIMITER_WORDS: Record<Delimiter, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" };

export interface TableRecord {
  /** The line of the file the record starts on, the first being 1. */
  line: number;
  cells: string[];
}

export interface StatementTable {
  delimiter: Delimiter;
  records: TableRecord[];
}

/** A statement that cannot be read, in words to show the person who chose it. */
export class StatementReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementReadError";
  }
}

/**
 * The records of a delimited text. A field that starts with a quote may hold the delimiter, a doubled quote or a line
 * break; a quote anywhere else is kept as it is. Records with no text in any cell are left out.
 */
export function splitRecords(text: string, delimiter: Delimiter): TableRecord[] {
  const records: TableRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(field);
    if (cells.some((cell) => cell.trim() !== "")) records.push({ line: recordLine, cells });
    cells = [];
    field = "";
    fieldStart = true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (character === "\n") line += 1;
        field += character;
      }
      continue;
    }
    if (character === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (character === delimiter) {
      cells.push(field);
      field = "";
      fieldStart = true;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += character;
      // Spaces before an opening quote are allowed, as spreadsheets write them.
      if (character !== " ") fieldStart = false;
    }
  }
  if (quoted) throw new StatementReadError("The statement has a quoted field that is never closed.");
  endRecord();
  return records;
}

const SAMPLE_RECORDS = 30;

/**
 * The delimiter that splits the first records into the same number of columns most often, more than one; on a tie, the
 * one giving more columns. Comma when none splits anything.
 */
export function detectDelimiter(text: string): Delimiter {
  let best: { delimiter: Delimiter; often: number; columns: number } = { delimiter: ",", often: 0, columns: 0 };
  for (const delimiter of DELIMITERS) {
    let records: TableRecord[];
    try {
      records = splitRecords(text, delimiter).slice(0, SAMPLE_RECORDS);
    } catch {
      continue;
    }
    const counts = new Map<number, number>();
    for (const record of records) if (record.cells.length > 1) counts.set(record.cells.length, (counts.get(record.cells.length) ?? 0) + 1);
    for (const [columns, often] of counts) {
      if (often > best.often || (often === best.often && columns > best.columns)) best = { delimiter, often, columns };
    }
  }
  return best.delimiter;
}

/** The statement's table, with the delimiter the person chose, the one a first line `sep=` names, or the one detected. */
export function readTable(text: string, delimiter?: Delimiter): StatementTable {
  let body = text.replace(/^﻿/, "");
  let named: Delimiter | undefined;
  const sep = /^sep=(.)\r?\n/i.exec(body);
  if (sep && (DELIMITERS as readonly string[]).includes(sep[1])) {
    named = sep[1] as Delimiter;
    // The records keep their lines in the file: the `sep=` line is line 1.
    body = `\n${body.slice(sep[0].length)}`;
  }
  const chosen = delimiter ?? named ?? detectDelimiter(body);
  const records = splitRecords(body, chosen);
  if (records.length === 0) throw new StatementReadError("The statement is empty.");
  return { delimiter: chosen, records };
}
