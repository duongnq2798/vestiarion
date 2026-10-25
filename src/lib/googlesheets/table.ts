import { createHash } from "node:crypto";
import type { ClosePackColumn } from "../close-pack/export";
import type { ClosePackMonth } from "../close-pack/month";
import type { ClosePack, Decimal } from "../close-pack/types";
import { utcWords } from "../close-pack/words";

/**
 * The close pack as a spreadsheet (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS7-GS10): the
 * Payments tab's values, its SHA-256, the Summary tab's rows, the spreadsheet's name, its link and the month's tag. Pure:
 * `./sheets.ts` sends them, `./export.ts` runs an export. Every value is written RAW, so nothing here is a formula.
 */

export const PAYMENTS_TAB = "Payments";
export const SUMMARY_TAB = "Summary";

/** A Google spreadsheet's id: the only part of Google's answers a path or a link is built from. */
export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{25,100}$/;

/** The columns written as numbers, so a person can add them up (GS8): five amounts and a count. */
export const SHEET_NUMBER_COLUMNS: readonly ClosePackColumn[] = ["bill_amount", "amount_paid", "discount", "network_fee_usd", "route_fee_usdc", "earlier_attempts"];
const AMOUNT_COLUMNS: readonly ClosePackColumn[] = SHEET_NUMBER_COLUMNS.filter((column) => column !== "earlier_attempts");

export type SheetCell = string | number;

/** The Payments tab's width: the close pack's 51 columns. */
const WIDTH = 51;

const DECIMAL = /^\d{1,12}\.\d{6}$/;
const COUNT = /^\d{1,6}$/;

/** A six-place decimal as a number, only when the number gives the same six places back; else the text it is. */
function amountCell(value: Decimal): SheetCell {
  if (!DECIMAL.test(value)) return value;
  const number = Number(value);
  return number.toFixed(6) === value ? number : value;
}

/**
 * The Payments tab (GS8): the header, then one row per payment, each cell the text the table gave, but the six columns
 * that read as numbers and round trip. A cell starting `=`, `+`, `-` or `@` stays that text: it is written RAW.
 */
export function sheetValues(table: { columns: readonly ClosePackColumn[]; rows: string[][] }): SheetCell[][] {
  const amounts = new Set(table.columns.flatMap((column, index) => (AMOUNT_COLUMNS.includes(column) ? [index] : [])));
  const counts = new Set(table.columns.flatMap((column, index) => (column === "earlier_attempts" ? [index] : [])));
  return [
    [...table.columns],
    ...table.rows.map((row) =>
      row.map((cell, index): SheetCell => {
        if (amounts.has(index)) return amountCell(cell);
        if (counts.has(index) && COUNT.test(cell)) return Number(cell);
        return cell;
      })
    ),
  ];
}

/** Each row as wide as the header, empty cells as empty text: as written, and as a read back is once padded. */
function padded(values: readonly (readonly SheetCell[])[], width: number): SheetCell[][] {
  return values.map((row) => (row.length >= width ? [...row] : [...row, ...Array<SheetCell>(width - row.length).fill("")]));
}

/**
 * The Payments tab's SHA-256 (GS10): lowercase hex, of `JSON.stringify` of its rows in UTF-8, each padded with "" to 51
 * cells. Apps Script's `getDataRange().getValues()` gives the same rows, so anyone with the spreadsheet can check it.
 */
export function paymentsSha256(values: readonly (readonly SheetCell[])[], width: number = WIDTH): string {
  return createHash("sha256").update(JSON.stringify(padded(values, width)), "utf8").digest("hex");
}

/** Who exported, for the Summary (GS9): their email, or a member named by the first 8 characters of their id. */
export function exporterWords(user: { id: string; email: string | null }): string {
  return user.email ?? `a member (${user.id.slice(0, 8)})`;
}

const base = (origin: string) => origin.replace(/\/+$/, "");
const soFar = (pack: ClosePack) => (pack.ended ? "" : " so far");
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isZero = (value: Decimal) => !/[1-9]/.test(value);
const LISTED = "listed on the close pack page, not in this spreadsheet";

/** The close pack page of the month, on the deployment's origin. */
function pageUrl(pack: ClosePack, origin: string): string {
  return `${base(origin)}/o/${pack.workspace.slug}/evidence/close-pack?month=${pack.month.key}`;
}

/**
 * The Summary tab (GS9): two columns, label and value, in order, each value from the pack. Not-settled payments and
 * escrow moves are counted, not listed, as in the CSV. The last rows say how to check it, and that it is a copy.
 */
export function summaryValues(pack: ClosePack, input: { origin: string; sha256: string; exportedBy: string }): SheetCell[][] {
  const { totals } = pack;
  const rows: SheetCell[][] = [
    ["Vestiarion monthly close pack", ""],
    ["Workspace", `${pack.workspace.name} (${pack.workspace.slug})`],
    ["Network", pack.network.label],
    ["Month", `${pack.month.label}${soFar(pack)}, a calendar month in UTC`],
    ["Read at", utcWords(pack.readAt)],
    ["Exported by", input.exportedBy],
    ["Payments settled", pack.rows.length],
    ...totals.onChain.map((total): SheetCell[] => [`Paid in ${total.token}`, amountCell(total.amount)]),
    ...totals.onChain.filter((total) => !isZero(total.routeFeesUsdc)).map((total): SheetCell[] => [`Route fees in ${total.token}`, amountCell(total.routeFeesUsdc)]),
    ...totals.simulated.map((total): SheetCell[] => [`Simulated, in ${total.token}`, `${count(total.payments, "payment", "payments")}, ${total.amount}`]),
    ["Not settled in the month", `${pack.notSettled.length}: ${LISTED}`],
    ["Escrow moves", `${pack.escrow.length}: ${LISTED}`],
    ["Signed entries verified", `${totals.entries.verified} of ${totals.entries.cited}`],
    ["Ledger head", pack.ledgerHead ? `#${pack.ledgerHead.seq} ${pack.ledgerHead.hash}` : "None"],
    ["Signing keys", pack.keys.map((key) => key.id).join(", ")],
    ["Payments tab SHA-256", input.sha256],
    ["Close pack page", pageUrl(pack, input.origin)],
  ];
  if (pack.cut) rows.push(["Cut", "This month has more than 2,000 payments, so this spreadsheet holds the first 2,000. The audit export holds every entry."]);
  if (pack.unread.includes("members")) rows.push(["People", "Members could not be read just now, so people are named by the first 8 characters of their id."]);
  if (pack.unread.includes("screening")) rows.push(["Screening", "Some screening records could not be read just now. Those payments say so."]);
  rows.push(
    [
      "How to check it",
      "Each row of Payments names the signed ledger entry that records its payment: entry_seq, entry_hash, signature and signing_key_id. Download the month's signed JSON from the close pack page and check any entry with verifyLedgerEntry from @vestiarion/sdk, with the public keys in that file.",
    ],
    [
      "",
      "Vestiarion read the Payments tab back after writing it, and recorded this export in the workspace's ledger as close_pack_exported, with this spreadsheet's id and the SHA-256 above. Find it in the Audit log.",
    ],
    ["", "The SHA-256 is of the Payments tab as written: JSON.stringify of its rows, the header first, each row as wide as the header, with empty cells as empty text."],
    ["", "A change made in this spreadsheet after the export is not in the ledger. Export the month again to write it afresh."]
  );
  return rows;
}

/** The longest name a Drive file is given. */
const TITLE_CHARS = 200;

/**
 * The spreadsheet's name (GS7, GS16): "Vestiarion close pack · Pinecrest Studio · October 2026 so far · Arc testnet",
 * cut to 200 characters. The network is the profile's label, never written here, so Drive names it before the file is
 * opened.
 */
export function spreadsheetTitle(pack: ClosePack): string {
  return `Vestiarion close pack · ${pack.workspace.name} · ${pack.month.label}${soFar(pack)} · ${pack.network.label}`.slice(0, TITLE_CHARS);
}

/** The spreadsheet's link, from its checked id only; never an address Google returns (GS12). Throws on anything else. */
export function spreadsheetUrl(id: string): string {
  if (!SPREADSHEET_ID.test(id)) throw new Error("not a spreadsheet id");
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_KEY = /^\d{4}-\d{2}$/;

/**
 * The tag the month's file carries in its `appProperties` (GS7): the workspace's id and the month, "<uuid>:2026-10".
 * Both are checked, so nothing a person typed reaches the Drive query it is put in.
 */
export function monthTag(orgId: string, month: ClosePackMonth): string {
  if (!UUID.test(orgId) || !MONTH_KEY.test(month.key)) throw new Error("not a workspace id and a month");
  return `${orgId.toLowerCase()}:${month.key}`;
}

/** A column's letters, as Sheets names it: 1 is "A", 27 "AA", 51 "AY". */
export function columnLetter(index: number): string {
  let rest = Math.floor(index);
  let letters = "";
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    letters = String.fromCharCode(65 + digit) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
}
