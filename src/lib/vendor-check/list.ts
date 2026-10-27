import { checkAddress, sharedWords, type AddressCheck, type KnownAddress, type SpecialAddress } from "../address-check";
import { headerKey } from "../bill-import/columns";
import type { Table } from "../bill-import/table";
import { addressKey, matchName, type ListedAddress, type NameIndex, type NameMatch } from "./match";

/**
 * A vendor list through the vendor check (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV6): its columns,
 * its rows, each row's name matched and its wallet checked with the address checker's rules, the counts, and the CSV of
 * the results. Pure, and run in the browser, so nothing pasted leaves the page. The list itself is read as the bill
 * import reads one (`readTable`, `decodeList`).
 */

export const VENDOR_FIELDS = ["name", "country", "wallet"] as const;
export type VendorField = (typeof VENDOR_FIELDS)[number];

/** The column each field is read from, by its index; a field left out is not in the list. */
export type VendorColumns = Partial<Record<VendorField, number>>;

export const VENDOR_FIELD_LABELS: Record<VendorField, string> = { name: "Vendor name", country: "Country", wallet: "Wallet address" };

/** At most this many rows are checked (CV6). */
export const VENDOR_ROWS_MAX = 5000;
/** The largest file read. */
export const VENDOR_FILE_MAX_BYTES = 2_000_000;

/**
 * The names each column is known by, as `headerKey` reads them, most telling first (CV6). A bare "Address" is not a
 * wallet: a vendor list's "Address" is most often where the vendor is.
 */
const SYNONYMS: Record<VendorField, readonly string[]> = {
  name: [
    "vendor", "vendorname", "supplier", "suppliername", "payee", "payeename", "counterparty", "counterpartyname", "beneficiary",
    "beneficiaryname", "contractor", "contractorname", "company", "companyname", "legalname", "businessname", "name", "fullname",
  ],
  country: ["country", "countrycode", "nationality", "jurisdiction", "countryofincorporation", "countryofresidence", "residence"],
  wallet: [
    "wallet", "walletaddress", "payoutaddress", "paytoaddress", "paymentaddress", "payoutwallet", "cryptoaddress", "cryptowallet",
    "usdcaddress", "usdcwallet", "evmaddress", "ethaddress", "receivingaddress", "depositaddress", "blockchainaddress",
  ],
};

const KNOWN = new Set(Object.values(SYNONYMS).flat());

/** Whether a row reads as column names: one of its cells is a name a column is known by. */
export function looksLikeVendorHeader(cells: readonly string[]): boolean {
  return cells.some((cell) => KNOWN.has(headerKey(cell)));
}

/** Each field's column, from the list's column names; without them, the names are in the first column. */
export function detectVendorColumns(headers: readonly string[], hasHeader: boolean): VendorColumns {
  if (!hasHeader) return { name: 0 };
  const keys = headers.map(headerKey);
  const taken = new Set<number>();
  const columns: VendorColumns = {};
  for (const field of VENDOR_FIELDS) {
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

export interface VendorRow {
  /** The row's number as the spreadsheet shows it. */
  line: number;
  cells: string[];
  name: string;
  country: string;
  wallet: string;
}

/** The list's rows with a name or a wallet, at most `VENDOR_ROWS_MAX`, and how many more there were (CV6). */
export function vendorRows(table: Table, hasHeader: boolean, columns: VendorColumns): { rows: VendorRow[]; more: number } {
  const cell = (cells: string[], column: number | undefined) => (column === undefined ? "" : (cells[column] ?? "").trim());
  const rows: VendorRow[] = [];
  let more = 0;
  for (const row of hasHeader ? table.rows.slice(1) : table.rows) {
    const vendor = { line: row.line, cells: row.cells, name: cell(row.cells, columns.name), country: cell(row.cells, columns.country), wallet: cell(row.cells, columns.wallet) };
    if (vendor.name === "" && vendor.wallet === "") continue;
    if (rows.length < VENDOR_ROWS_MAX) rows.push(vendor);
    else more += 1;
  }
  return { rows, more };
}

/**
 * A row's wallet, checked (CV6): an EVM address with the address checker's rules, against OFAC's EVM addresses and the
 * other rows' addresses; any other, as written, against every address the list gives.
 */
export type VendorWallet =
  | {
      kind: "evm";
      check: AddressCheck;
      /** The other rows with this very address, by their vendor's name or row number. */
      same: string[];
    }
  | { kind: "listed"; listed: ListedAddress }
  | { kind: "unlisted" };

export interface VendorResult {
  row: VendorRow;
  /** Null when the row has no name. */
  matches: NameMatch[] | null;
  wallet: VendorWallet | null;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;

/** What a row's wallet is called in another row's result: its vendor's name, or its row number. */
const labelOf = (row: VendorRow) => row.name || `row ${row.line}`;

/**
 * The keys two addresses share when one is made to look like the other (AC3): their first 3 and last 3 digits, their
 * first 5, or their last 5. Only rows sharing a key are compared, so a long list stays fast.
 */
function lookalikeKeys(address: string): string[] {
  const digits = address.slice(2);
  return [`b${digits.slice(0, 3)}${digits.slice(-3)}`, `f${digits.slice(0, 5)}`, `l${digits.slice(-5)}`];
}

/**
 * Checks one row at a time, against the whole list's wallets, so a long list can show how far it has got. Each other
 * address is compared once, under the first row that has it; rows with the very same address are counted apart.
 */
export function vendorRowChecker(index: NameIndex, rows: readonly VendorRow[]): (row: VendorRow) => VendorResult {
  const rowsOf = new Map<string, VendorRow[]>();
  const book = new Map<string, KnownAddress[]>();
  for (const row of rows) {
    if (!EVM.test(row.wallet)) continue;
    const address = row.wallet.toLowerCase();
    const holders = rowsOf.get(address);
    if (holders) {
      holders.push(row);
      continue;
    }
    rowsOf.set(address, [row]);
    for (const key of lookalikeKeys(address)) {
      const list = book.get(key);
      if (list) list.push({ label: labelOf(row), address });
      else book.set(key, [{ label: labelOf(row), address }]);
    }
  }
  const wallet = (row: VendorRow): VendorWallet | null => {
    if (row.wallet === "") return null;
    if (/^0x/i.test(row.wallet) || /^[0-9a-fA-F]{40}$/.test(row.wallet)) {
      const own = row.wallet.toLowerCase();
      const known = new Map<string, KnownAddress>();
      if (EVM.test(row.wallet)) {
        for (const key of lookalikeKeys(own)) for (const other of book.get(key) ?? []) if (other.address !== own) known.set(other.address, other);
      }
      const same = (rowsOf.get(own) ?? []).filter((other) => other.line !== row.line).map(labelOf);
      return { kind: "evm", check: checkAddress(row.wallet, [...known.values()], index.evmWallets), same };
    }
    const listed = index.addresses.get(addressKey(row.wallet));
    return listed ? { kind: "listed", listed } : { kind: "unlisted" };
  };
  return (row) => ({ row, matches: row.name === "" ? null : matchName(index, row.name, row.country), wallet: wallet(row) });
}

/** Every row checked at once. */
export function checkVendorRows(index: NameIndex, rows: readonly VendorRow[]): VendorResult[] {
  const check = vendorRowChecker(index, rows);
  return rows.map(check);
}

/** "A", "A and B", "A, B and C". */
export function listWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function specialWords(special: SpecialAddress): string {
  if (special.kind === "zero") return "this is the zero address: anything sent to it is lost.";
  if (special.kind === "burn") return "this is a burn address: anything sent to it is lost.";
  if (special.kind === "system") return "this is Arc's USDC system address, not a wallet.";
  return `this is the ${special.label} token contract, not a wallet.`;
}

/**
 * What a row's wallet result says (CV6), and its tone: `stop` for do not pay, `note` for something to look at, `fine`
 * when nothing checked says it is wrong. The page and the CSV say the same sentence.
 */
export function walletWords(wallet: VendorWallet): { tone: "stop" | "note" | "fine"; text: string } {
  if (wallet.kind === "listed") return { tone: "stop", text: `Do not pay: on OFAC's SDN list, under ${wallet.listed.entry.name} (${wallet.listed.currency}).` };
  if (wallet.kind === "unlisted") return { tone: "fine", text: "Not among the addresses on OFAC's SDN list. It is not an EVM address, so nothing else was checked." };
  const { check } = wallet;
  if (!check.format.ok) return { tone: "stop", text: `Not an address. ${check.format.message}` };
  if (check.sanctioned) return { tone: "stop", text: `Do not pay: on OFAC's SDN list, under ${check.sanctioned.name}.` };
  if (check.special) return { tone: "stop", text: `Do not pay: ${specialWords(check.special)}` };
  if (check.checksum === "invalid") return { tone: "stop", text: "Do not pay: its checksum does not match (EIP-55), so a character was mistyped or changed." };
  const alike = check.matches.filter((match) => match.kind === "alike");
  const same = sameWords(wallet.same);
  if (alike.length > 0) {
    const more = alike.length > 1 ? ` It looks like ${alike.length - 1} more in the list too.` : "";
    const also = same ? ` It is also the very address of ${same}.` : "";
    return { tone: "stop", text: `Do not pay: made to look like ${alike[0].known.label}'s address. It shares ${sharedWords(alike[0])}.${more}${also}` };
  }
  if (same) return { tone: "note", text: `The same address as ${same}. Check one wallet is meant for both.` };
  return { tone: "fine", text: "Nothing here says it is wrong." };
}

/** The other rows with the same address, in words: "Northwind Design's", "row 3's and row 7's", or a count past three. */
function sameWords(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length <= 3) return listWords(labels.map((label) => `${label}'s`));
  return `${labels.length} other rows', among them ${listWords(labels.slice(0, 3).map((label) => `${label}'s`))}`;
}

export interface VendorSummary {
  rows: number;
  /** Rows with a name, and of those, by their best match. */
  names: number;
  strong: number;
  possible: number;
  noMatch: number;
  /** Rows with a wallet, and of those, the ones that say do not pay and the ones to look at. */
  wallets: number;
  walletStops: number;
  walletNotes: number;
}

/** The list's counts (CV6). */
export function vendorSummary(results: readonly VendorResult[]): VendorSummary {
  const summary: VendorSummary = { rows: results.length, names: 0, strong: 0, possible: 0, noMatch: 0, wallets: 0, walletStops: 0, walletNotes: 0 };
  for (const result of results) {
    if (result.matches) {
      summary.names += 1;
      const band = result.matches[0]?.band;
      if (band === "strong") summary.strong += 1;
      else if (band === "possible") summary.possible += 1;
      else summary.noMatch += 1;
    }
    if (result.wallet) {
      summary.wallets += 1;
      const tone = walletWords(result.wallet).tone;
      if (tone === "stop") summary.walletStops += 1;
      if (tone === "note") summary.walletNotes += 1;
    }
  }
  return summary;
}

/** Whether a row has something to look at: a match, or a wallet that is not fine. */
export function needsALook(result: VendorResult): boolean {
  return (result.matches?.length ?? 0) > 0 || (result.wallet !== null && walletWords(result.wallet).tone !== "fine");
}

/** A row's name result, as the CSV says it. */
export function sdnResultWords(result: VendorResult): string {
  if (!result.matches) return "";
  const band = result.matches[0]?.band;
  return band === "strong" ? "Strong match" : band === "possible" ? "Possible match" : "No match";
}

/** One cell: quoted when it holds a comma, a quote or a line break, and with an apostrophe first when a spreadsheet would run it. */
function csvCell(value: string): string {
  const cell = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * The results as a CSV (CV6): the list as read, under its own column names, with "OFAC SDN result", "Possible
 * matches", "Wallet result" and "SDN list as of" added. It starts with a byte-order mark, so Excel reads it as UTF-8.
 */
export function vendorResultsCsv(header: readonly string[], results: readonly VendorResult[], listDay: string): string {
  const width = Math.max(header.length, ...results.map((result) => result.row.cells.length));
  const pad = (cells: readonly string[]) => Array.from({ length: width }, (_, at) => cells[at] ?? "");
  const lines = [[...pad(header), "OFAC SDN result", "Possible matches", "Wallet result", "SDN list as of"]];
  for (const result of results) {
    const matches = (result.matches ?? [])
      .map((match) => `${match.entry.name} (entry ${match.entry.number}, score ${match.score.toFixed(2)}, ${match.entry.programs.join("; ")})`)
      .join(" | ");
    lines.push([...pad(result.row.cells), sdnResultWords(result), matches, result.wallet ? walletWords(result.wallet).text : "", listDay]);
  }
  return `${String.fromCharCode(0xfeff)}${lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Made up for the example: one name on OFAC's list, and a wallet with Northwind Design's first 4 and last 4 digits. */
export const EXAMPLE_LIST = [
  "Vendor,Country,Wallet",
  "Northwind Design,US,0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d",
  "Harbor Print Co,GB,",
  "Bank Melli Iran,IR,",
  "Lumen Freight Ltd,AE,0x7a2d8f06c3e1b9a457d02c6e8f1b3a9d4e7ce10d",
  "Riverbank Coffee Roasters,US,",
].join("\n");
