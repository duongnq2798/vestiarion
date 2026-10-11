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

const BREAKS = "\r\n";

interface Scanned {
  /** Each record's fields, and the delimiters that cut them apart. */
  records: Array<{ cells: string[]; separators: string }>;
  /** A quoted field runs on to the end of the text. */
  open: boolean;
}

/**
 * The text's records, its fields cut at any of `delimiters`.
 *
 * A quote opens a quoted field only as the field's first character, spaces aside. Inside one, two quotes are a quote,
 * and a quote followed, past any spaces, by a delimiter, a line break or the end closes it. Anywhere else a quote is a
 * character, so an inch mark (`Pipe 12" PVC`, `Bolt 6"`) never opens or closes a field, and never joins rows.
 *
 * A quote inside a quoted field that does neither means the field may never have been quoted. A spreadsheet pastes a
 * cell as it is, quoted only when it holds a line break, so a pasted cell such as `"Rush" order` only starts with a
 * quote: it is read again from its start, its quotes as characters. In a CSV file the quote may be one its writer forgot
 * to double: it is kept as a character when a quote that closes the field follows on its line, and otherwise the cell
 * is read again as above. A quoted field that already holds a line break is a quoted one, and keeps such a quote.
 */
function scan(text: string, delimiters: string, firstOnly = false): Scanned {
  const records: Scanned["records"] = [];
  const pasted = delimiters.includes("\t");
  let cells: string[] = [];
  let separators = "";
  let field = "";
  /** Where the field starts in the text, to read it again from. */
  let start = 0;
  let quoted = false;
  /** The field is read again, its quotes as characters. */
  let plain = false;
  /** The quoted field holds a line break. */
  let multiline = false;
  /** Where a quote that closes the quoted field was found ahead, on its line. */
  let closeAhead = -1;

  /** Whether a quote just before `at` closes a quoted field: spaces, then a delimiter, a line break or the end. */
  const closesBefore = (at: number) => {
    let index = at;
    while (text[index] === " ") index += 1;
    return index >= text.length || BREAKS.includes(text[index]) || delimiters.includes(text[index]);
  };
  /** Where a quote that closes the quoted field follows `at` on its line, or -1. */
  const closingAfter = (at: number) => {
    for (let index = at; index < text.length && !BREAKS.includes(text[index]); index += 1) {
      if (text[index] !== '"') continue;
      if (text[index + 1] === '"') index += 1;
      else if (closesBefore(index + 1)) return index;
    }
    return -1;
  };
  const endField = (next: number) => {
    cells.push(field);
    field = "";
    start = next;
    quoted = false;
    plain = false;
    multiline = false;
    closeAhead = -1;
  };
  const endRecord = (next: number) => {
    endField(next);
    records.push({ cells, separators });
    cells = [];
    separators = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') {
        if (BREAKS.includes(character)) multiline = true;
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (closesBefore(index + 1)) {
        quoted = false;
      } else if (multiline || index < closeAhead || (!pasted && (closeAhead = closingAfter(index + 1)) >= 0)) {
        field += '"';
      } else {
        // The cell only started with a quote: read it again from its start, its quotes as characters.
        field = "";
        quoted = false;
        plain = true;
        index = start - 1;
      }
    } else if (character === '"' && !plain && field.trim() === "") {
      quoted = true;
    } else if (delimiters.includes(character)) {
      separators += character;
      endField(index + 1);
    } else if (BREAKS.includes(character)) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endRecord(index + 1);
      if (firstOnly) break;
    } else {
      field += character;
    }
  }
  if (quoted) return { records, open: true };
  if (field !== "" || cells.length > 0) endRecord(text.length);
  return { records, open: false };
}

/** The delimiter that cuts the first line, outside quoted fields, into the most columns. */
function chooseDelimiter(text: string): Delimiter {
  const separators = scan(text, PREFERENCE.join(""), true).records[0]?.separators ?? "";
  let best: Delimiter = ",";
  let bestCount = 0;
  for (const delimiter of PREFERENCE) {
    const count = separators.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export function readTable(raw: string): Table {
  const text = raw.replace(/^﻿/, "");
  const delimiter = chooseDelimiter(text);
  const { records, open } = scan(text, delimiter);
  if (open) throw new TableError("A quoted field is never closed. Check the list's quotes, then try again.");
  const rows: TableRow[] = [];
  records.forEach((record, index) => {
    const cells = record.cells.map((cell) => cell.trim());
    if (cells.some((cell) => cell !== "")) rows.push({ line: index + 1, cells });
  });
  if (rows.length === 0) throw new TableError("The list is empty.");
  return { delimiter, rows };
}
