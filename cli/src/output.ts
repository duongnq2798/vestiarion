/** Text for a person: aligned tables and label-value lines. `--json` bypasses all of it. */

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Longer cells are cut, ending in an ellipsis. */
  max?: number;
}

function cut(text: string, max: number | undefined): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return max !== undefined && flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function table<T>(rows: T[], columns: Column<T>[]): string {
  const cells = rows.map((row) => columns.map((column) => cut(column.value(row), column.max)));
  const widths = columns.map((column, i) => Math.max(column.header.length, ...cells.map((line) => line[i].length)));
  const line = (parts: string[]) => parts.map((part, i) => (i === parts.length - 1 ? part : part.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(columns.map((column) => column.header)), ...cells.map(line)].join("\n") + "\n";
}

/** Label-value lines, the values aligned. A null or empty value is left out. */
export function pairs(entries: Array<[string, string | null | undefined]>): string {
  const kept = entries.filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== "");
  const width = Math.max(0, ...kept.map(([label]) => label.length));
  return kept.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n") + "\n";
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A paragraph, wrapped at `width` and indented. */
export function wrap(text: string, indent = "  ", width = 100): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + 1 + word.length > width - indent.length) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines.map((text) => `${indent}${text}`).join("\n") + "\n";
}

export const orDash = (value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? "-" : String(value));

/** `2026-10-31T00:00:00+00:00` as `2026-10-31`. */
export const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");

export const amountOf = (amount: number | null | undefined, currency = "USDC") => (amount === null || amount === undefined ? "-" : `${amount} ${currency}`);
