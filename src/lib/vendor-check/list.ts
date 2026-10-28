import { checkAddress, sharedWords, type AddressCheck, type KnownAddress, type SpecialAddress } from "../address-check";
import { headerKey } from "../bill-import/columns";
import { readTable, type Table, type TableRow } from "../bill-import/table";
import { addressKey, matchName, nameCompared, nonLatinWords, type ListedAddress, type NameIndex, type NameMatch } from "./match";

/**
 * A vendor list through the vendor check (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV6): its columns,
 * its rows, each row's name matched and its wallet checked (a 0x one with the address checker's rules, against OFAC's
 * addresses and the other rows' 0x wallets; any other looked up among OFAC's addresses alone), the counts, and the CSV
 * of the results. Pure, and run in the browser, so nothing pasted leaves the page. The list itself is read as the bill
 * import reads one (`readTable`, `decodeList`), past title lines, and with names that hold commas kept whole
 * (`readVendorList`, `vendorTable`).
 */

/** A vendor list as read (CV6): its rows from its column names on, and the title lines above them, left out. */
export interface VendorList extends Table {
  titles: string[];
}

/** At most this many title lines are read past above a list's column names (CV6). */
const TITLE_LINES_MAX = 5;

/**
 * A vendor list as rows of cells (CV6).
 * - Title lines: a report exported from an accounting tool can start with its title and dates, one cell a line, above
 *   its column names. When a row of more than one cell within the first lines names the columns
 *   (`looksLikeVendorHeader`), and each line above it is one cell, those lines are left out and named in `titles`.
 * - Names that hold commas: a spreadsheet copies one column without quoting a cell that holds a comma, so "Kadyrov,
 *   Ramzan" arrives cut in two. A comma list is read as one column, each row's cells joined back with ", ", when no row
 *   has more than two cells, no row of two names the columns, and either its first row is one cell or every comma in
 *   it is followed by a space, as in a name written so and never between a CSV's columns.
 */
export function readVendorList(text: string): VendorList {
  const table = readTable(text);
  const header = table.rows.slice(0, TITLE_LINES_MAX + 1).findIndex((row) => row.cells.length > 1 && looksLikeVendorHeader(row.cells));
  const titled = header > 0 && table.rows.slice(0, header).every((row) => filled(row.cells).length === 1);
  const rows = titled ? table.rows.slice(header) : table.rows;
  const titles = titled ? table.rows.slice(0, header).map((row) => filled(row.cells)[0]) : [];
  if (!namesHoldCommas(text, table.delimiter, rows)) return { delimiter: table.delimiter, rows, titles };
  return { delimiter: table.delimiter, rows: rows.map((row) => (row.cells.length > 1 ? { ...row, cells: [joinName(row.cells)] } : row)), titles };
}

const filled = (cells: readonly string[]) => cells.filter((cell) => cell !== "");

/**
 * Whether a comma list's rows are one column of names cut at their commas (`readVendorList`). A row of more than two
 * cells keeps the columns: joined, its other cells would become words of its name, and a listed name with a phone
 * number or a wallet joined to it can score below a possible match.
 */
function namesHoldCommas(text: string, delimiter: Table["delimiter"], rows: readonly TableRow[]): boolean {
  if (delimiter !== ",") return false;
  if (rows.some((row) => row.cells.length > 2 || (row.cells.length > 1 && looksLikeVendorHeader(row.cells)))) return false;
  return rows[0].cells.length === 1 || !/,(?! )/.test(text);
}

/** Cells a comma cut one name into, joined back. */
const joinName = (cells: readonly string[]) => filled(cells).join(", ");

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

/**
 * The list as checked (CV6). When the names are the last of the columns named in a comma list, a row with more cells
 * than there are column names has had its name cut at its commas: the cells from the name on are joined back into it.
 * The page counts, shows and writes back this table, so the columns and what each reads are what is checked. The
 * list itself when nothing is joined.
 */
export function vendorTable<T extends Table>(table: T, hasHeader: boolean, columns: VendorColumns): T {
  const width = hasHeader ? table.rows[0].cells.length : 0;
  if (table.delimiter !== "," || columns.name === undefined || columns.name !== width - 1) return table;
  if (table.rows.every((row) => row.cells.length <= width)) return table;
  const join = (row: TableRow) => (row.cells.length > width ? { ...row, cells: [...row.cells.slice(0, width - 1), joinName(row.cells.slice(width - 1))] } : row);
  return { ...table, rows: table.rows.map(join) };
}

/** The list's rows with a name or a wallet, at most `VENDOR_ROWS_MAX`, and how many more there were (CV6). */
export function vendorRows(table: Table, hasHeader: boolean, columns: VendorColumns): { rows: VendorRow[]; more: number } {
  const cell = (cells: string[], column: number | undefined) => (column === undefined ? "" : (cells[column] ?? "").trim());
  const checked = vendorTable(table, hasHeader, columns);
  const rows: VendorRow[] = [];
  let more = 0;
  for (const row of hasHeader ? checked.rows.slice(1) : checked.rows) {
    const { cells } = row;
    const vendor = { line: row.line, cells, name: cell(cells, columns.name), country: cell(cells, columns.country), wallet: cell(cells, columns.wallet) };
    if (vendor.name === "" && vendor.wallet === "") continue;
    if (rows.length < VENDOR_ROWS_MAX) rows.push(vendor);
    else more += 1;
  }
  return { rows, more };
}

/**
 * A row's wallet, checked (CV6): an EVM address with the address checker's rules, against OFAC's EVM addresses and,
 * when it is a whole 0x address, the other rows' whole 0x addresses; any other, as written, against every address the
 * list gives and against no other row.
 */
export type VendorWallet =
  | {
      kind: "evm";
      check: AddressCheck;
      /** The other rows with this very address, by their vendor's name or row number. */
      same: string[];
      /** What was checked, when it is part of the cell: the address after a chain prefix or in a payment link. */
      read: string | null;
    }
  /** A payment link that calls a contract, such as a token's `transfer`, and gives no address to pay. */
  | { kind: "no_payee" }
  | { kind: "listed"; listed: ListedAddress }
  | { kind: "unlisted" };

export interface VendorResult {
  row: VendorRow;
  /** Null when the row has no name. */
  matches: NameMatch[] | null;
  /** The name's words not in Latin letters, left out of the comparison (CV2). */
  notLatin: string[];
  wallet: VendorWallet | null;
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
/**
 * A wallet with its chain before it, `eth:0x…` or `base:0x…` (EIP-3770), or a payment link, `ethereum:0x…@1` (EIP-681):
 * its address, the contract function a link calls (`/transfer`), and the link's parameters.
 */
const CHAIN_PREFIXED = /^[a-z][a-z0-9-]*:(?:pay-)?(0x[^@/?]*)(?:@[^/?]*)?(\/[^?]+)?(?:\?(.*))?$/i;
/** `0x` starting a word. Inside a word, it is part of another currency's address, as bech32 ones can hold it. */
const HEX_START = /(?<![0-9a-z])0x/i;
/**
 * What separates the words of another currency's wallet cell: as OFAC writes one (`XBT <address>`), with its currency
 * after it (`<address> (BTC)`), or in a payment link (`bitcoin:<address>?amount=0.1`, BIP 21).
 */
const WALLET_WORDS = /[\s,;:()[\]{}<>?&="']+/;

/**
 * The part of a wallet cell the address checker's rules read (CV6): the cell, when it starts with `0x` or is 40 hex
 * digits; the address after a chain prefix; a payment link's own address, or, when the link calls a contract function
 * (`/transfer`), its pay-to `address=` and nothing else, since the link's own address is then the token's contract:
 * empty when it has none; else the cell from a `0x` that starts a word, so a cut or mistyped address gets the checker's
 * reason. Null for another currency's address.
 */
export function evmPart(wallet: string): string | null {
  if (/^0x/i.test(wallet) || /^[0-9a-fA-F]{40}$/.test(wallet)) return wallet;
  const prefixed = CHAIN_PREFIXED.exec(wallet);
  if (prefixed) {
    const [, target, call, parameters = ""] = prefixed;
    return call ? (/(?:^|&)address=([^&]*)/i.exec(parameters)?.[1] ?? "") : target;
  }
  const at = wallet.search(HEX_START);
  return at >= 0 ? wallet.slice(at) : null;
}

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
 * Checks one row at a time, against every whole 0x address in the list, so a long list can show how far it has got.
 * Each other address is compared once, under the first row that has it; rows with the very same address are counted
 * apart. A wallet in another format, or a 0x one that is not a whole address, is compared with no other row (CV6).
 */
export function vendorRowChecker(index: NameIndex, rows: readonly VendorRow[]): (row: VendorRow) => VendorResult {
  const rowsOf = new Map<string, VendorRow[]>();
  const book = new Map<string, KnownAddress[]>();
  for (const row of rows) {
    const part = evmPart(row.wallet);
    if (part === null || !EVM.test(part)) continue;
    const address = part.toLowerCase();
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
    const part = evmPart(row.wallet);
    if (part === "") return { kind: "no_payee" };
    if (part !== null) {
      const own = part.toLowerCase();
      const known = new Map<string, KnownAddress>();
      if (EVM.test(part)) {
        for (const key of lookalikeKeys(own)) for (const other of book.get(key) ?? []) if (other.address !== own) known.set(other.address, other);
      }
      const same = (rowsOf.get(own) ?? []).filter((other) => other.line !== row.line).map(labelOf);
      return { kind: "evm", check: checkAddress(part, [...known.values()], index.evmWallets), same, read: part === row.wallet ? null : part };
    }
    // The cell as written, then each of its words: a listed address with its currency or in a payment link stops too.
    for (const key of [row.wallet, ...row.wallet.split(WALLET_WORDS)]) {
      const listed = key === "" ? undefined : index.addresses.get(addressKey(key));
      if (listed) return { kind: "listed", listed };
    }
    return { kind: "unlisted" };
  };
  return (row) => ({
    row,
    matches: row.name === "" ? null : matchName(index, row.name, row.country),
    notLatin: row.name === "" ? [] : nonLatinWords(row.name),
    wallet: wallet(row),
  });
}

/**
 * Whether a row's name was not compared at all (CV2, `nameCompared`): it has no word in Latin letters, or none but
 * legal forms and numbers beside words in another script.
 */
export function nameNotCompared(result: VendorResult): boolean {
  return result.matches !== null && !nameCompared(result.row.name);
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
  if (wallet.kind === "no_payee") return { tone: "stop", text: "Not an address to pay: this payment link calls a contract and gives no pay-to address (address=)." };
  const words = evmWords(wallet);
  return wallet.read === null ? words : { ...words, text: `Read as ${wallet.read}. ${words.text}` };
}

function evmWords(wallet: Extract<VendorWallet, { kind: "evm" }>): { tone: "stop" | "note" | "fine"; text: string } {
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
  /** Rows with a name, and of those, by their best match, or not compared for having no word in Latin letters. */
  names: number;
  strong: number;
  possible: number;
  noMatch: number;
  notCompared: number;
  /** Rows with a wallet, and of those, the ones that say do not pay and the ones to look at. */
  wallets: number;
  walletStops: number;
  walletNotes: number;
}

/** The list's counts (CV6). */
export function vendorSummary(results: readonly VendorResult[]): VendorSummary {
  const summary: VendorSummary = { rows: results.length, names: 0, strong: 0, possible: 0, noMatch: 0, notCompared: 0, wallets: 0, walletStops: 0, walletNotes: 0 };
  for (const result of results) {
    if (result.matches) {
      summary.names += 1;
      const band = result.matches[0]?.band;
      if (band === "strong") summary.strong += 1;
      else if (band === "possible") summary.possible += 1;
      else if (nameNotCompared(result)) summary.notCompared += 1;
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

/** Whether a row has something to look at: a match, words of its name not compared, or a wallet that is not fine. */
export function needsALook(result: VendorResult): boolean {
  return (result.matches?.length ?? 0) > 0 || result.notLatin.length > 0 || (result.wallet !== null && walletWords(result.wallet).tone !== "fine");
}

/** A row's name result, as the CSV says it, with any words left out for not being in Latin letters. */
export function sdnResultWords(result: VendorResult): string {
  if (!result.matches) return "";
  if (nameNotCompared(result)) return "Not compared: not in Latin letters";
  const band = result.matches[0]?.band;
  const words = band === "strong" ? "Strong match" : band === "possible" ? "Possible match" : "No match";
  return result.notLatin.length > 0 ? `${words} (left out, not in Latin letters: ${result.notLatin.join(" ")})` : words;
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
