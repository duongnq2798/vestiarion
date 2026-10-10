/**
 * A bill list as rows of cells (import design B2): a CSV file, or rows pasted from Excel or Google Sheets, which arrive
 * tab-separated. Browser-safe and pure: the panel reads the list with it to show the columns, and the server reads it
 * again, never trusting what the browser read.
 */

export type Delimiter = "," | ";" | "\t";

export interface TableRow {
  /** The row's number as the spreadsheet shows it, counting blank rows: the first row is 1. */
  line: number;
  cells: string[];
}

export interface Table {
  delimiter: Delimiter;
  rows: TableRow[];
}

/** A list that cannot be read at all, in words for the person who gave it. */
export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableError";
  }
}

/**
 * A file's text: UTF-8 when it is, else read as Windows-1252, the encoding Excel's plain "CSV" uses in the US and Europe,
 * with `legacy` set so the panel can say how to save it as UTF-8 if its names look wrong.
 */
export function decodeList(bytes: ArrayBuffer | Uint8Array): { text: string; legacy: boolean } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), legacy: false };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), legacy: true };
  }
}

/** Tab first: a pasted spreadsheet. Then semicolon: a European Excel's CSV, whose amounts hold commas. */
const PREFERENCE: readonly Delimiter[] = ["\t", ";", ","];

/** The delimiters on the first line, outside quotes. */
function firstLineCounts(text: string): Record<Delimiter, number> {
  const counts: Record<Delimiter, number> = { "\t": 0, ";": 0, ",": 0 };
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && (character === "\n" || character === "\r")) {
      break;
    } else if (!quoted && (character === "\t" || character === ";" || character === ",")) {
      counts[character] += 1;
    }
  }
  return counts;
}

function chooseDelimiter(text: string): Delimiter {
  const counts = firstLineCounts(text);
  let best: Delimiter = ",";
  let bestCount = 0;
  for (const delimiter of PREFERENCE) {
    if (counts[delimiter] > bestCount) {
      best = delimiter;
      bestCount = counts[delimiter];
    }
  }
  return best;
}

export function readTable(raw: string): Table {
  const text = raw.replace(/^﻿/, "");
  const delimiter = chooseDelimiter(text);
  const rows: TableRow[] = [];
  let line = 0;
  let cells: string[] = [];
  let field = "";
  let quoted = false;

  const endRecord = () => {
    cells.push(field);
    line += 1;
    const trimmed = cells.map((cell) => cell.trim());
    if (trimmed.some((cell) => cell !== "")) rows.push({ line, cells: trimmed });
    cells = [];
    field = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
    } else {
      field += character;
    }
  }
  if (quoted) throw new TableError("A quoted field is never closed. Check the list's quotes, then try again.");
  if (field !== "" || cells.length > 0) endRecord();
  if (rows.length === 0) throw new TableError("The list is empty.");
  return { delimiter, rows };
}
