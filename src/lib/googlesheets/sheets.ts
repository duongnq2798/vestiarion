import { CLOSE_PACK_COLUMNS, type ClosePackColumn } from "../close-pack/export";
import { DRIVE_API, GoogleError, SHEETS_API, apiInit, googleCall, jsonOf, type GoogleHttp } from "./http";
import { PAYMENTS_TAB, SPREADSHEET_ID, SUMMARY_TAB, columnLetter, type SheetCell } from "./table";

/**
 * The Drive and Sheets calls of an export (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS7, GS8,
 * GS10, GS12), each through `googleCall`: an address built from checked ids only, at most one retry, and a create, a
 * rename or a format never sent twice. A 401 is thrown for the export to refresh its token once.
 */

/** The `appProperties` key the month's file is tagged with; only this app can read it. */
export const MONTH_TAG_KEY = "vestiarionClosePack";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{4}-\d{2}$/;
/** The rows of one values request: 2,000 rows of 51 columns are about 3 MB, and Google asks for 2 MB or less. */
export const VALUES_ROWS_PER_REQUEST = 500;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** A spreadsheet id from Google's answer, checked before any path or link is built from it. */
function checkedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SPREADSHEET_ID.test(value)) throw new GoogleError("bad_response", `Google ${label}: not a spreadsheet id`);
  return value;
}

/**
 * The month's files (GS7): those carrying its tag and not trashed, the oldest first. The tag is built from the
 * workspace's id and a checked month, and checked again here, so nothing a person typed reaches the query.
 */
export async function findMonthFile(token: string, tag: string, deps: GoogleHttp = {}): Promise<Array<{ id: string; createdTime: string }>> {
  if (!TAG.test(tag)) throw new GoogleError("bad_response", "Google files.list: not a month's tag");
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", `appProperties has { key='${MONTH_TAG_KEY}' and value='${tag}' } and trashed = false`);
  url.searchParams.set("fields", "files(id,createdTime)");
  url.searchParams.set("orderBy", "createdTime");
  url.searchParams.set("pageSize", "10");
  const response = await googleCall({ url: url.toString(), init: apiInit(token, "GET"), label: "files.list", repeatable: true }, deps);
  const body = await jsonOf(response, "files.list");
  const files = isObject(body) && Array.isArray(body.files) ? body.files : null;
  if (!files) throw new GoogleError("bad_response", "Google files.list: no files");
  return files
    .map((file) => {
      const one = isObject(file) ? file : {};
      return { id: checkedId(one.id, "files.list"), createdTime: typeof one.createdTime === "string" ? one.createdTime : "" };
    })
    .sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
}

/** Makes the month's spreadsheet in the account's My Drive, named and tagged (GS7). Never sent twice. */
export async function createMonthFile(token: string, input: { name: string; tag: string }, deps: GoogleHttp = {}): Promise<string> {
  if (!TAG.test(input.tag)) throw new GoogleError("bad_response", "Google files.create: not a month's tag");
  const response = await googleCall(
    {
      url: `${DRIVE_API}/files?fields=id`,
      init: apiInit(token, "POST", { name: input.name, mimeType: SPREADSHEET_MIME, appProperties: { [MONTH_TAG_KEY]: input.tag } }),
      label: "files.create",
      repeatable: false,
    },
    deps
  );
  const body = await jsonOf(response, "files.create");
  return checkedId(isObject(body) ? body.id : undefined, "files.create");
}

async function updateFile(token: string, id: string, change: { name: string } | { trashed: true }, label: string, deps: GoogleHttp): Promise<void> {
  const response = await googleCall(
    { url: `${DRIVE_API}/files/${checkedId(id, label)}?fields=id`, init: apiInit(token, "PATCH", change), label, repeatable: false, onFile: true },
    deps
  );
  await response.body?.cancel().catch(() => {});
}

/** Names the month's file again, so "so far" drops once the month has ended (GS7); `gone` when it is out of reach. */
export async function renameFile(token: string, id: string, name: string, deps: GoogleHttp = {}): Promise<"ok" | "gone"> {
  try {
    await updateFile(token, id, { name }, "files.update", deps);
    return "ok";
  } catch (error) {
    if (error instanceof GoogleError && error.failure === "gone") return "gone";
    throw error;
  }
}

/** Trashes a duplicate this export made itself, after a race (GS7). Never a file it did not make. */
export async function trashFile(token: string, id: string, deps: GoogleHttp = {}): Promise<void> {
  await updateFile(token, id, { trashed: true }, "files.trash", deps);
}

/**
 * A tab of the spreadsheet: its id, its title, and its grid, which a rename leaves as it was. `frozenRowCount` is 0 when
 * Google leaves it out (nothing frozen); `columnCount` is null for a tab with no grid, such as a chart's.
 */
export interface SheetTab {
  sheetId: number;
  title: string;
  frozenRowCount: number;
  columnCount: number | null;
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** The spreadsheet's tabs, by id and title, with their grids. */
export async function sheetTabs(token: string, id: string, deps: GoogleHttp = {}): Promise<SheetTab[]> {
  const url = new URL(`${SHEETS_API}/spreadsheets/${checkedId(id, "spreadsheets.get")}`);
  url.searchParams.set("fields", "sheets.properties(sheetId,title,gridProperties)");
  const response = await googleCall({ url: url.toString(), init: apiInit(token, "GET"), label: "spreadsheets.get", repeatable: true, onFile: true }, deps);
  const body = await jsonOf(response, "spreadsheets.get");
  const sheets = isObject(body) && Array.isArray(body.sheets) ? body.sheets : null;
  if (!sheets) throw new GoogleError("bad_response", "Google spreadsheets.get: no sheets");
  return sheets.map((sheet) => {
    const properties = isObject(sheet) && isObject(sheet.properties) ? sheet.properties : {};
    const sheetId = properties.sheetId ?? 0;
    if (typeof sheetId !== "number" || !Number.isSafeInteger(sheetId) || sheetId < 0) throw new GoogleError("bad_response", "Google spreadsheets.get: a sheet id that does not read");
    const gridProperties = isObject(properties.gridProperties) ? properties.gridProperties : {};
    return {
      sheetId,
      title: typeof properties.title === "string" ? properties.title : "",
      frozenRowCount: count(gridProperties.frozenRowCount) ?? 0,
      columnCount: count(gridProperties.columnCount),
    };
  });
}

const PAYMENTS_WIDTH = CLOSE_PACK_COLUMNS.length;
const AMOUNT_FORMAT = "#,##0.00####";
const MONEY_COLUMNS: readonly ClosePackColumn[] = ["bill_amount", "amount_paid", "discount", "network_fee_usd", "route_fee_usdc"];
const PAYMENTS_COLUMN_PX = 160;
const SUMMARY_LABEL_PX = 220;
const SUMMARY_VALUE_PX = 720;

type SheetRequest = Record<string, unknown>;

const bold = (range: Json): SheetRequest => ({ repeatCell: { range, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } });
const wrap = (range: Json, strategy: "CLIP" | "WRAP"): SheetRequest => ({ repeatCell: { range, cell: { userEnteredFormat: { wrapStrategy: strategy } }, fields: "userEnteredFormat.wrapStrategy" } });
const numberFormat = (sheetId: number, column: number, pattern: string): SheetRequest => ({
  repeatCell: {
    range: { sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 },
    cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } },
    fields: "userEnteredFormat.numberFormat",
  },
});
const width = (sheetId: number, start: number, end: number, pixelSize: number): SheetRequest => ({
  updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: start, endIndex: end }, properties: { pixelSize }, fields: "pixelSize" },
});
const grid = (sheetId: number, rowCount: number, columnCount: number, frozenRowCount: number): SheetRequest => ({
  updateSheetProperties: {
    properties: { sheetId, gridProperties: { rowCount, columnCount, frozenRowCount } },
    fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount",
  },
});

/**
 * The tab of this title, its case aside: Sheets refuses two tabs whose titles differ only in case, so a tab someone
 * renamed "payments" is taken back rather than a second added.
 */
function tabTitled<Tab extends Pick<SheetTab, "sheetId" | "title">>(tabs: Tab[], title: string): Tab | undefined {
  return tabs.find((tab) => tab.title === title) ?? tabs.find((tab) => tab.title.toLowerCase() === title.toLowerCase());
}

/**
 * The two tabs' properties and formats, in one `batchUpdate` before the values (GS8, GS9). Payments and Summary are
 * Vestiarion's: a spreadsheet never formatted (`fresh`) has its first tab renamed Payments; either tab missing is added,
 * one renamed by case is named again. Any other tab is left alone. Payments' grid is sized to the rows, which also
 * removes rows left from a longer export, its header frozen and bold, its money columns and the attempt count formatted
 * as numbers and its data rows clipped; Summary's label column is bold, both its columns wrapped. No value is cleared
 * here: the values write overwrites every row it keeps (`writeValues`), so a write that fails leaves the last export's
 * rows under its own Summary. Never sent twice.
 */
export async function formatTabs(
  token: string,
  id: string,
  input: { tabs: Array<Pick<SheetTab, "sheetId" | "title">>; fresh: boolean; rows: number; summaryRows: number },
  deps: GoogleHttp = {}
): Promise<void> {
  const requests: SheetRequest[] = [];
  let nextId = Math.max(0, ...input.tabs.map((tab) => tab.sheetId)) + 1;
  const place = (title: string, rowCount: number, columnCount: number, firstFree: boolean): number => {
    const found = tabTitled(input.tabs, title);
    if (found) {
      if (found.title !== title) requests.push({ updateSheetProperties: { properties: { sheetId: found.sheetId, title }, fields: "title" } });
      return found.sheetId;
    }
    const first = input.tabs[0];
    if (firstFree && first && !tabTitled([first], PAYMENTS_TAB) && !tabTitled([first], SUMMARY_TAB)) {
      requests.push({ updateSheetProperties: { properties: { sheetId: first.sheetId, title }, fields: "title" } });
      return first.sheetId;
    }
    const sheetId = nextId;
    nextId += 1;
    requests.push({ addSheet: { properties: { sheetId, title, gridProperties: { rowCount, columnCount } } } });
    return sheetId;
  };
  const paymentRows = Math.max(input.rows + 1, 2);
  const summaryRows = Math.max(input.summaryRows, 1);
  const payments = place(PAYMENTS_TAB, paymentRows, PAYMENTS_WIDTH, input.fresh);
  const summary = place(SUMMARY_TAB, summaryRows, 2, false);

  requests.push(
    grid(payments, paymentRows, PAYMENTS_WIDTH, 1),
    bold({ sheetId: payments, startRowIndex: 0, endRowIndex: 1 }),
    wrap({ sheetId: payments, startRowIndex: 1 }, "CLIP"),
    ...MONEY_COLUMNS.map((column) => numberFormat(payments, CLOSE_PACK_COLUMNS.indexOf(column), AMOUNT_FORMAT)),
    numberFormat(payments, CLOSE_PACK_COLUMNS.indexOf("earlier_attempts"), "0"),
    width(payments, 0, PAYMENTS_WIDTH, PAYMENTS_COLUMN_PX),
    grid(summary, summaryRows, 2, 0),
    bold({ sheetId: summary, startColumnIndex: 0, endColumnIndex: 1 }),
    wrap({ sheetId: summary }, "WRAP"),
    width(summary, 0, 1, SUMMARY_LABEL_PX),
    width(summary, 1, 2, SUMMARY_VALUE_PX)
  );
  const response = await googleCall(
    { url: `${SHEETS_API}/spreadsheets/${checkedId(id, "spreadsheets.batchUpdate")}:batchUpdate`, init: apiInit(token, "POST", { requests }), label: "spreadsheets.batchUpdate", repeatable: false, onFile: true },
    deps
  );
  await response.body?.cancel().catch(() => {});
}

/**
 * The values, RAW so no cell is parsed (GS8): the Summary and the header with the first 500 rows in the first request,
 * then 500 rows a request. `USER_ENTERED` is never sent. Each request is idempotent, so a 5xx sends it once more. Every
 * row is 51 cells, so it overwrites whatever was in its row; a month with no payment also sends row 2, which the grid
 * keeps, as 51 empty cells (RAW "" empties a cell), so what was there goes with the header and the Summary, never ahead
 * of them. That blank row is sent only: the rows hashed and compared are the payments as given.
 */
export async function writeValues(token: string, id: string, input: { payments: SheetCell[][]; summary: SheetCell[][] }, deps: GoogleHttp = {}): Promise<void> {
  const spreadsheet = checkedId(id, "values.batchUpdate");
  const [header, ...rows] = input.payments;
  const last = columnLetter(PAYMENTS_WIDTH);
  const requests = Math.max(1, Math.ceil(rows.length / VALUES_ROWS_PER_REQUEST));
  const blank: SheetCell[][] = rows.length === 0 ? [Array<SheetCell>(PAYMENTS_WIDTH).fill("")] : [];
  for (let index = 0; index < requests; index += 1) {
    const chunk = rows.slice(index * VALUES_ROWS_PER_REQUEST, (index + 1) * VALUES_ROWS_PER_REQUEST);
    const values = index === 0 ? [header, ...chunk, ...blank] : chunk;
    const start = index === 0 ? 1 : 2 + index * VALUES_ROWS_PER_REQUEST;
    const data = [
      ...(index === 0 ? [{ range: `${SUMMARY_TAB}!A1:B${input.summary.length}`, majorDimension: "ROWS", values: input.summary }] : []),
      { range: `${PAYMENTS_TAB}!A${start}:${last}${start + values.length - 1}`, majorDimension: "ROWS", values },
    ];
    const response = await googleCall(
      { url: `${SHEETS_API}/spreadsheets/${spreadsheet}/values:batchUpdate`, init: apiInit(token, "POST", { valueInputOption: "RAW", data }), label: "values.batchUpdate", repeatable: true, onFile: true },
      deps
    );
    await response.body?.cancel().catch(() => {});
  }
}

/**
 * The Payments tab read back once, unformatted, by rows (GS10). Google drops trailing empty cells and rows; the export
 * pads and hashes them. A cell that is neither text nor a number is kept as JSON text, so it never matches.
 */
export async function readPayments(token: string, id: string, deps: GoogleHttp = {}): Promise<SheetCell[][]> {
  const range = encodeURIComponent(`${PAYMENTS_TAB}!A1:${columnLetter(PAYMENTS_WIDTH)}`);
  const url = new URL(`${SHEETS_API}/spreadsheets/${checkedId(id, "values.get")}/values/${range}`);
  url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
  url.searchParams.set("majorDimension", "ROWS");
  const response = await googleCall({ url: url.toString(), init: apiInit(token, "GET"), label: "values.get", repeatable: true, onFile: true }, deps);
  const body = await jsonOf(response, "values.get");
  if (!isObject(body)) throw new GoogleError("bad_response", "Google values.get: an answer that does not read");
  const rows = body.values === undefined ? [] : body.values;
  if (!Array.isArray(rows)) throw new GoogleError("bad_response", "Google values.get: no rows");
  return rows.map((row) => (Array.isArray(row) ? row : [row]).map((cell): SheetCell => (typeof cell === "string" || typeof cell === "number" ? cell : JSON.stringify(cell))));
}
