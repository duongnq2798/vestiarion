/**
 * A comma CSV read into rows, as the payments CSV reads it (docs/superpowers/specs/2026-10-10-actual-payments-design.md
 * A6). A bill list is read by `src/lib/bill-import/table.ts`, which also finds its delimiter.
 */

/** The rows of a CSV, quoted fields and doubled quotes read, blank rows left out: the payments CSV's. */
export function rowsFromCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

export function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]+/g, "_");
}
