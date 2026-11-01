import {
  BOTH_ENDS_MIN,
  chanceWords,
  checkAddress,
  madeToLookAlike,
  ONE_END_MIN,
  PARTIAL_MIN,
  sharedEnds,
  sharedWords,
  specialAddress,
  TOKEN_CONTRACTS,
  type AddressCheck,
  type KnownAddress,
  type SanctionedEntry,
} from "../address-check";
import { vendorKeyOf } from "../bill-check/read";
import { currencyDigits, decimalKey, type DecimalMark } from "../bill-import/amounts";
import type { Table } from "../bill-import/table";
import { groupedDecimal } from "../connectors/crm";
import { isAddressName } from "../ens-words";
import { decimalOfMinor } from "../money/money";
import { evmPart, listWords, specialWords } from "../vendor-check/list";
import { answeredDecimalMark, blankTokenIsNative, payoutQuestions, payoutRows, readPayoutAmount, type PayoutAmount, type PayoutAnswers, type PayoutRow } from "./read";

/**
 * What the payout batch check finds in a batch (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP3-CP8):
 * each row's address with the address checker's rules, against OFAC's addresses and the ones someone has paid before;
 * every address against every other in the batch, through buckets of shared end digits so 5,000 rows stay fast; the
 * same address on several rows and one name with several addresses; each row's token and amount; the totals per token,
 * as exact decimals; and each row's verdict, with every finding in words the page and the CSV both say. Pure, and run
 * in the browser, so nothing pasted leaves the page.
 */

/** How much a finding weighs (CP8): `fix` cannot be sent as written, `stop` not until it is checked, `look` only after a look; a `note` is no finding. */
export type FindingLevel = "fix" | "stop" | "look" | "note";

export type FindingKind =
  | "no_address"
  | "not_address"
  | "sanctioned"
  | "special"
  | "checksum"
  | "alike_row"
  | "alike_known"
  | "partial_row"
  | "partial_known"
  | "same_address"
  | "name_addresses"
  | "ens"
  | "not_evm"
  | "amount"
  | "large_amount"
  | "token"
  | "token_checksum"
  | "token_alike"
  | "token_unknown"
  | "paid_before"
  | "read_as";

export interface PayoutFinding {
  level: FindingLevel;
  kind: FindingKind;
  /** A sentence or two, plain English, the same on the page and in the CSV. */
  text: string;
}

export type PayoutVerdict = "fix" | "stop" | "look" | "nothing_found";

/** Each verdict as the page and the CSV name it (CP8, CP10). Never "safe" or "verified": nothing found is all it says. */
export const VERDICT_WORDS: Record<PayoutVerdict, string> = { fix: "Fix", stop: "Stop", look: "Look", nothing_found: "Nothing found" };

/** A row's verdict (CP8): its weightiest finding; nothing found when none of the checks found anything. */
export function payoutVerdict(findings: readonly PayoutFinding[]): PayoutVerdict {
  for (const level of ["fix", "stop", "look"] as const) if (findings.some((finding) => finding.level === level)) return level;
  return "nothing_found";
}

// --- The address (CP3) ---

/**
 * A row's address as read (CP3): an EVM address with the address checker's verdict (`read` is the address when it is
 * part of the cell, after a chain prefix or in a payment link), a payment link that names no payee, an ENS name, which
 * is not looked up, or another currency's address, which is not checked.
 */
export type PayoutAddress =
  | { kind: "empty" }
  | { kind: "evm"; check: AddressCheck; read: string | null }
  | { kind: "no_payee" }
  | { kind: "ens"; name: string }
  | { kind: "other" };

const isAscii = (character: string) => character.codePointAt(0)! <= 127;
const hasNonAscii = (text: string) => [...text].some((character) => !isAscii(character));

/**
 * A hidden character, or a letter from another alphabet, in the part of a cell `evmPart` reads past (CP3): before its
 * `0x`, or in a `0x` whose x is not Latin, which leaves the cell taken for another currency's address. The cell is
 * checked up to the end of the address read from it, so a link's label after it is not judged, and with every plain
 * ASCII character set aside, so only a character outside ASCII is judged, at its place in the cell: the o of a
 * `polygon:` prefix, or the l of a link's `label=`, is never taken for a lookalike (payout check CP3). Null when the
 * cell has none.
 */
function hiddenInCell(cell: string, part: string | null): AddressCheck | null {
  if (!hasNonAscii(cell)) return null;
  const end = part ? cell.indexOf(part) + part.length : cell.length;
  const others = [...cell.slice(0, end)].map((character) => (isAscii(character) ? "_" : character)).join("");
  const check = checkAddress(others, [], []);
  return !check.format.ok && (check.format.problem === "invisible" || check.format.problem === "lookalike_character") ? check : null;
}

/**
 * A row's address cell, read as `/check-vendor` reads a wallet cell (`evmPart`) and checked with `checkAddress` (CP3).
 * A cell holding a character outside plain ASCII is first checked for one `evmPart` would read past (`hiddenInCell`).
 */
export function payoutAddressOf(cell: string, known: readonly KnownAddress[], sanctioned: readonly SanctionedEntry[]): PayoutAddress {
  if (cell === "") return { kind: "empty" };
  const part = evmPart(cell);
  if (part === cell) return { kind: "evm", check: checkAddress(cell, known, sanctioned), read: null };
  const hidden = hiddenInCell(cell, part);
  if (hidden) return { kind: "evm", check: hidden, read: null };
  if (isAddressName(cell)) return { kind: "ens", name: cell };
  if (part === "") return { kind: "no_payee" };
  if (part !== null) return { kind: "evm", check: checkAddress(part, known, sanctioned), read: part };
  return { kind: "other" };
}

/** What the batch is compared by: a whole EVM address, lowercase; an ENS name, lowercase; another currency's as written. */
function addressKeyOf(address: PayoutAddress, cell: string): string | null {
  if (address.kind === "evm") return address.check.format.ok ? address.check.address : null;
  if (address.kind === "ens") return address.name.toLowerCase();
  return address.kind === "other" ? cell : null;
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** At most this many rows are named in a finding; past them, how many more there are. */
const LINES_NAMED = 6;

/**
 * Rows by their numbers: "row 7", "rows 7 and 9", "rows 2, 5, 7, 9, 11 and 3 more". `total` is how many there are when
 * `lines` holds only the first of them.
 */
export function rowWords(lines: readonly number[], total = lines.length): string {
  if (total === 1) return `row ${lines[0]}`;
  const shown = total > LINES_NAMED ? [...lines.slice(0, LINES_NAMED - 1).map(String), `${total - LINES_NAMED + 1} more`] : lines.map(String);
  return `rows ${listWords(shown)}`;
}

/** The first rows of some kind, as many as a finding names, and how many there are. */
interface SomeLines {
  lines: number[];
  total: number;
}

function addLine(some: SomeLines, line: number) {
  if (some.lines.length < LINES_NAMED) some.lines.push(line);
}

const named = (some: SomeLines) => some.lines.length >= Math.min(some.total, LINES_NAMED);

/** What a batch compares (CP4, CP5): its whole EVM addresses, each once, and the addresses paid before. */
export interface BatchScale {
  addresses: number;
  known: number;
}

/**
 * The most pairs a batch's comparisons may share a pair's digits by chance before the pair is no longer a stop (CP4,
 * CP5). Two unrelated addresses share their first 5 digits about once in a million, but a batch of 5,000 compares 12
 * million pairs and holds about a dozen that do. A pair made to look alike is a stop while a batch of its size would
 * hold one sharing as many digits by chance less than once in 100 batches; past that it is a look, saying how often
 * chance does it (payout check CP4).
 */
export const CHANCE_PAIRS_MAX = 0.01;

/** How many of `comparisons` pairs of unrelated addresses share as many digits as `ends`, in the same places, by chance. */
export function chancePairs(comparisons: number, ends: { leading: number; trailing: number }): number {
  return comparisons / 16 ** (ends.leading + ends.trailing);
}

/** The pairs among a batch's own addresses, and between them and the addresses paid before. */
const rowComparisons = (scale: BatchScale) => (scale.addresses * (scale.addresses - 1)) / 2;
const knownComparisons = (scale: BatchScale) => scale.addresses * scale.known;

const addressesWords = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "address" : "addresses"}`;

/** `chancePairs` in words: "about 12 pairs share that many digits by chance". */
function chancePairsWords(expected: number): string {
  if (expected >= 1.5) return `about ${Math.round(expected).toLocaleString("en-US")} pairs share that many digits by chance`;
  if (expected >= 2 / 3) return "about one pair shares that many digits by chance";
  return `a pair shares that many digits by chance about once in ${Math.round(1 / expected).toLocaleString("en-US")} batches`;
}

/** What the address checker found on a row's own address (CP3, CP5): its form, OFAC's list, a special address, its checksum, the known addresses. */
function addressFindings(address: PayoutAddress, scale: BatchScale): PayoutFinding[] {
  if (address.kind === "empty") return [{ level: "fix", kind: "no_address", text: "No address." }];
  if (address.kind === "no_payee") {
    return [{ level: "fix", kind: "not_address", text: "Not an address to pay: this payment link calls a contract and gives no pay-to address (address=)." }];
  }
  if (address.kind === "ens") {
    return [{ level: "look", kind: "ens", text: "Not checked: an ENS name is not looked up here. Check the address it points to on the day you pay." }];
  }
  if (address.kind === "other") return [{ level: "look", kind: "not_evm", text: "Not checked: only EVM addresses (0x) are checked." }];
  const { check } = address;
  const findings: PayoutFinding[] = address.read === null ? [] : [{ level: "note", kind: "read_as", text: `Read as ${address.read}.` }];
  if (!check.format.ok) return [{ level: "fix", kind: "not_address", text: `Not an address. ${check.format.message}` }, ...findings];
  if (check.sanctioned) findings.push({ level: "stop", kind: "sanctioned", text: `On OFAC's SDN list, under ${check.sanctioned.name}.` });
  if (check.special) findings.push({ level: "stop", kind: "special", text: capitalized(specialWords(check.special)) });
  if (check.checksum === "invalid") {
    findings.push({ level: "stop", kind: "checksum", text: "Its checksum does not match (EIP-55), so a character was mistyped or changed." });
  }
  const same = check.matches.find((match) => match.kind === "same");
  const alike = check.matches.filter((match) => match.kind === "alike");
  // Against the addresses paid before, a batch of thousands holds pairs sharing 5 digits by chance too (CP4, CP5).
  const rare = same ? alike : alike.filter((match) => chancePairs(knownComparisons(scale), match) < CHANCE_PAIRS_MAX);
  const common = alike.find((match) => !rare.includes(match));
  const partial = check.matches.find((match) => match.kind === "partial");
  if (rare.length > 0) {
    const [first] = rare;
    const more = rare.length > 1 ? ` It looks like ${rare.length - 1} more of them too.` : "";
    findings.push({
      level: "stop",
      kind: "alike_known",
      text: same
        ? `It is ${same.known.label}'s address as you have paid it, but ${first.known.label}'s, also among the addresses you have paid, is made to look like it: it shares ${sharedWords(first)}. One of the two is not the payee's.`
        : `Made to look like ${first.known.label}'s address, one you have paid before. It shares ${sharedWords(first)}, which a random address does about once in ${chanceWords(first.leading + first.trailing)}.${more}`,
    });
  } else if (common) {
    findings.push({
      level: "look",
      kind: "alike_known",
      text: `Shares ${sharedWords(common)} with ${common.known.label}'s address, one you have paid before: among ${addressesWords(scale.addresses)} and the ${addressesWords(scale.known)} you have paid before, ${chancePairsWords(chancePairs(knownComparisons(scale), common))}. Compare the whole address.`,
    });
  } else if (partial) {
    findings.push({ level: "look", kind: "partial_known", text: `Shares ${sharedWords(partial)} with ${partial.known.label}'s address, one you have paid before. Compare the whole address.` });
  }
  if (same) findings.push({ level: "note", kind: "paid_before", text: `Paid before as ${same.known.label}.` });
  return findings;
}

// --- Across the batch (CP4) ---

/** Another address in the batch that shares digits at an end with one: its place in the list compared, and the digits shared. */
export interface Neighbour {
  index: number;
  leading: number;
  trailing: number;
}

/** The addresses made to look like one (`madeToLookAlike`), and the ones sharing 4 digits at an end (`PARTIAL_MIN`), most digits shared first. */
export interface Neighbours {
  alike: Neighbour[];
  partial: Neighbour[];
}

/**
 * The most addresses kept of each kind for one: a batch where thousands share an address's ends is told about the
 * first of them, and stays fast. Every address with one still has it found.
 */
export const NEIGHBOURS_KEPT = 25;

/**
 * The buckets an address is found in (CP4). Two addresses made to look alike share their first 3 and last 3 digits,
 * their first 5, or their last 5; two sharing 4 digits at an end share their first 4 or their last 4. Each bucket
 * holds only addresses that share its digits, so every pair either rule catches shares a bucket, and only pairs in a
 * bucket are compared digit by digit.
 */
function bucketKeys(address: string): { alike: string[]; partial: string[] } {
  const digits = address.slice(2);
  return {
    alike: [`b${digits.slice(0, BOTH_ENDS_MIN)}${digits.slice(-BOTH_ENDS_MIN)}`, `f${digits.slice(0, ONE_END_MIN)}`, `l${digits.slice(-ONE_END_MIN)}`],
    partial: [`f${digits.slice(0, PARTIAL_MIN)}`, `l${digits.slice(-PARTIAL_MIN)}`],
  };
}

function addAt<T>(map: Map<string, T[]>, key: string, item: T) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

const byShared = (a: Neighbour, b: Neighbour) => b.leading + b.trailing - (a.leading + a.trailing) || a.index - b.index;

/**
 * Each address's neighbours in the batch (CP4): the others made to look like it, and the others sharing 4 digits at an
 * end with it, at most `NEIGHBOURS_KEPT` of each. `addresses` are whole 0x addresses, each once.
 *
 * The addresses made to look alike are looked for first, in their own buckets, every one of whose members is one, so a
 * bucket full of partial ones never hides one. Then the partial ones, in the buckets of 4 digits, past the lookalikes
 * already found. An address with fewer lookalikes than it keeps has them all found by then, so every other member of
 * those buckets is a partial one and the look stops once it has kept its fill. One with more, already a stop, is
 * looked past for its partial ones at most `NEIGHBOURS_KEPT` times 4 members a bucket, so a batch of thousands that
 * share their ends stays fast.
 */
export function lookalikeNeighbours(addresses: readonly string[]): Neighbours[] {
  const lower = addresses.map((address) => address.toLowerCase());
  const keys = lower.map(bucketKeys);
  const buckets = new Map<string, number[]>();
  keys.forEach((key, index) => {
    for (const bucket of [...key.alike, ...key.partial]) addAt(buckets, bucket, index);
  });
  return lower.map((address, index) => {
    const seen = new Set<number>([index]);
    const near = (kind: "alike" | "partial", looked: number) => {
      const found: Neighbour[] = [];
      for (const bucket of keys[index][kind]) {
        let tried = 0;
        for (const other of buckets.get(bucket) ?? []) {
          if (found.length >= NEIGHBOURS_KEPT || tried >= looked) break;
          if (seen.has(other) || lower[other] === address) continue;
          seen.add(other);
          tried += 1;
          const ends = sharedEnds(address, lower[other]);
          const alike = madeToLookAlike(ends);
          if (kind === "alike" ? alike : !alike && (ends.leading >= PARTIAL_MIN || ends.trailing >= PARTIAL_MIN)) found.push({ index: other, ...ends });
        }
      }
      return found.sort(byShared);
    };
    const alike = near("alike", Number.POSITIVE_INFINITY);
    return { alike, partial: near("partial", alike.length >= NEIGHBOURS_KEPT ? NEIGHBOURS_KEPT * 4 : Number.POSITIVE_INFINITY) };
  });
}

/** Another row's address beside a row's, for the page to mark the digits they share (CP9). */
export interface AddressPair {
  /** The other address, lowercase. */
  address: string;
  /** The rows that give it, and the first one's name. */
  lines: number[];
  name: string;
  leading: number;
  trailing: number;
  alike: boolean;
}

// --- Tokens (CP7) ---

/**
 * A row's token as read (CP7): none named; the chain's own coin (Safe's `native`, or a blank `token_address`); a symbol
 * as written; a contract, with the name of the USDC or EURC contract it is, or the one it is made to look like; or a
 * cell that cannot be read. An NFT row (Safe's `nft`) names its contract, and its amount is not read.
 */
export type PayoutToken =
  | { kind: "none" }
  | { kind: "native" }
  | { kind: "symbol"; symbol: string }
  | {
      kind: "contract";
      address: string;
      checksummed: string;
      checksum: AddressCheck["checksum"];
      /** "USDC on Base", when it is a token contract Vestiarion knows. */
      known: string | null;
      /** The known token contract it is made to look like, and the digits they share. */
      like: { label: string; leading: number; trailing: number } | null;
      nft: boolean;
    }
  | { kind: "unreadable"; written: string; problem: string };

const SAFE_TYPES = new Set(["erc20", "native", "nft", "erc721", "erc1155"]);
const NFT_TYPES = new Set(["nft", "erc721", "erc1155"]);
/** Symbols of a chain's own coin, 18 decimals each. */
const NATIVE_SYMBOLS = new Set(["ETH", "POL", "MATIC", "AVAX", "BNB"]);
const NATIVE_DIGITS = 18;

/** Whether a row is an NFT's (Safe's `nft` type), whose amount is a count, or nothing, and is not read. */
export const isNftRow = (row: Pick<PayoutRow, "tokenType">) => NFT_TYPES.has(row.tokenType.trim().toLowerCase());

/**
 * A row's token (CP7), from its token cell and Safe's token type; `blankIsNative` under Safe's `token_address`
 * (`blankTokenIsNative`). Outside Safe's form, a contract is read as the address column reads one (`evmPart`): after a
 * chain prefix (`base:0x…`), as a payment link's target, or as 40 hex digits without their `0x`, so a fake token's
 * contract is never taken for a symbol (payout check CP7). A link's function and parameters are left off first: its
 * `address=` is the payee, not the token.
 */
export function tokenOf(cell: string, type: string, blankIsNative: boolean): PayoutToken {
  const written = cell.trim();
  const kind = type.trim().toLowerCase();
  const unreadable = (problem: string): PayoutToken => ({ kind: "unreadable", written: written || type.trim(), problem });
  if (kind !== "" && !SAFE_TYPES.has(kind)) return unreadable(`Token type “${type.trim()}” is not one Safe reads: erc20, native or nft.`);
  if (kind === "native" || written.toUpperCase() === "NATIVE") return { kind: "native" };
  const nft = NFT_TYPES.has(kind);
  if (written === "") {
    if (kind === "erc20") return unreadable("An erc20 row needs its token's contract address.");
    if (nft) return unreadable("An NFT row needs its contract's address.");
    return blankIsNative ? { kind: "native" } : { kind: "none" };
  }
  const safeType = nft || kind === "erc20";
  const part = safeType ? written : evmPart(written.replace(/[/?].*$/, ""));
  if (part === null && !hasNonAscii(written)) return { kind: "symbol", symbol: written };
  const check = checkAddress(part ?? written, [], []);
  if (!check.format.ok) return unreadable(`The token contract is not an address. ${check.format.message}`);
  const address = check.address!;
  const special = specialAddress(address);
  const known = special?.kind === "token" ? special.label : null;
  let like: { label: string; leading: number; trailing: number } | null = null;
  if (known === null) {
    for (const token of TOKEN_CONTRACTS) {
      const ends = sharedEnds(address, token.address);
      if (madeToLookAlike(ends) && (like === null || ends.leading + ends.trailing > like.leading + like.trailing)) like = { label: token.label, ...ends };
    }
  }
  return { kind: "contract", address, checksummed: check.checksummed!, checksum: check.checksum, known, like, nft };
}

/** What rows of one token share: their totals and their median are counted apart from another token's. */
export function tokenKey(token: PayoutToken): string {
  if (token.kind === "symbol") return `symbol ${token.symbol.toUpperCase()}`;
  if (token.kind === "contract") return `contract ${token.address}`;
  if (token.kind === "unreadable") return `unreadable ${token.written}`;
  return token.kind;
}

/** A token as the batch names it (CP6, CP7): "USDC on Base", "USDC", "native coin", a contract; empty when it names none. */
export function tokenLabel(token: PayoutToken): string {
  if (token.kind === "none") return "";
  if (token.kind === "native") return "native coin";
  if (token.kind === "symbol") return token.symbol;
  if (token.kind === "contract") return token.known ?? token.checksummed;
  return token.written;
}

/** The decimals a token has (CP6): 6 for USDC and EURC, 18 for a native coin; null for one the page does not know. */
export function tokenDigits(token: PayoutToken): number | null {
  if (token.kind === "native") return NATIVE_DIGITS;
  if (token.kind === "contract") return token.known !== null && !token.nft ? currencyDigits(token.known.split(" ")[0]) : null;
  if (token.kind !== "symbol") return null;
  const symbol = token.symbol.toUpperCase();
  if (symbol === "USDC" || symbol === "EURC") return currencyDigits(symbol);
  return NATIVE_SYMBOLS.has(symbol) ? NATIVE_DIGITS : null;
}

/** A token in a sentence: "USDC on Base", "the native coin". */
const tokenWords = (token: PayoutToken) => (token.kind === "native" ? "the native coin" : tokenLabel(token) || "the token");

/** What a token says about every row that pays it (CP7), once per token; null when nothing. */
export function tokenFinding(token: PayoutToken): PayoutFinding | null {
  if (token.kind === "unreadable") return { level: "fix", kind: "token", text: token.problem };
  if (token.kind !== "contract") return null;
  if (token.checksum === "invalid") {
    return { level: "stop", kind: "token_checksum", text: "The token contract's checksum does not match (EIP-55), so a character was mistyped or changed." };
  }
  if (token.known !== null) return null;
  if (token.like) {
    return {
      level: "stop",
      kind: "token_alike",
      text: `The token contract is made to look like ${token.like.label}'s: it shares ${sharedWords(token.like)}. Fake tokens with a real token's ends are sent to wallets' histories so a copied row pays the wrong contract.`,
    };
  }
  return { level: "look", kind: "token_unknown", text: "A token this page does not know: check its contract before you send it." };
}

// --- Amounts (CP6) ---

const scaleOf = (values: readonly string[]) => values.reduce((most, value) => Math.max(most, value.split(".")[1]?.length ?? 0), 0);

/** A decimal as a whole number of `10^-scale` units. */
function unitsOf(value: string, scale: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
}

const decimalOfUnits = (units: bigint, scale: number) => decimalKey(decimalOfMinor(units, scale));

/** The sum of exact decimals, exactly (CP6): "0.1" and "0.2" are "0.3", at any number of decimals; never through a float. */
export function sumDecimals(values: readonly string[]): string {
  const scale = scaleOf(values);
  return decimalOfUnits(
    values.reduce((sum, value) => sum + unitsOf(value, scale), BigInt(0)),
    scale
  );
}

/** How many times the median of the batch's other amounts of one token makes an amount worth a look (CP6). */
export const MEDIAN_TIMES = 100;

/**
 * The rows of one token whose amount is at least `MEDIAN_TIMES` the median of the token's other amounts (CP6), each with
 * that median, compared exactly: twice the median is the sum of the two middle amounts, or twice the middle one.
 */
function largeAmounts(entries: ReadonlyArray<{ index: number; value: string }>): Map<number, string> {
  const large = new Map<number, string>();
  if (entries.length < 2) return large;
  const scale = scaleOf(entries.map((entry) => entry.value));
  const sorted = entries.map((entry) => ({ index: entry.index, units: unitsOf(entry.value, scale) })).sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : 0));
  const others = sorted.length - 1;
  const two = BigInt(2);
  sorted.forEach(({ index, units }, at) => {
    const other = (place: number) => sorted[place < at ? place : place + 1].units;
    const twiceMedian = others % 2 === 1 ? other((others - 1) / 2) * two : other(others / 2 - 1) + other(others / 2);
    if (units * two >= BigInt(MEDIAN_TIMES) * twiceMedian) large.set(index, decimalOfUnits(twiceMedian * BigInt(5), scale + 1));
  });
  return large;
}

/** A sum of one token's amounts (CP6), labelled with the token as the batch names it. */
export interface PayoutTotal {
  key: string;
  token: PayoutToken;
  /** Empty when the batch names no token. */
  label: string;
  rows: number;
  /** An exact decimal. */
  sum: string;
}

/** A token the batch uses, with the rows that use it and what it says about them, so the page says it once (CP7). */
export interface PayoutTokenUse {
  key: string;
  token: PayoutToken;
  label: string;
  lines: number[];
  finding: PayoutFinding | null;
}

// --- The check ---

export interface PayoutResult {
  row: PayoutRow;
  address: PayoutAddress;
  token: PayoutToken;
  /** Null when the batch has no amount column, or for an NFT row. */
  amount: PayoutAmount | null;
  /** The other rows' addresses made to look like this row's or sharing 4 digits at an end with it, most digits shared first (CP4). */
  pairs: AddressPair[];
  /** Weightiest first: fix, stop, look, then notes. */
  findings: PayoutFinding[];
  verdict: PayoutVerdict;
}

export interface PayoutCheck {
  results: PayoutResult[];
  /** Rows past `PAYOUT_ROWS_MAX`, not checked. */
  leftOut: number;
  counts: { rows: number; fix: number; stop: number; look: number; nothingFound: number };
  /** Whether the batch has an amount column: without one, its addresses alone were checked (CP6). */
  amounts: boolean;
  /** One per token, in the order each first appears (CP6). */
  totals: PayoutTotal[];
  /** Rows left out of the totals: an amount to fix, or a token that cannot be read (CP6). */
  notTotalled: number;
  /** NFT rows, whose amount is not read, so not totalled either; 0 when the batch has no amount column (CP6). */
  nftRows: number;
  tokens: PayoutTokenUse[];
  /** The known addresses each row was compared with; 0 when the batch was compared only with itself (CP5). */
  known: number;
}

export interface PayoutCheckOptions {
  sanctioned: readonly SanctionedEntry[];
  known: readonly KnownAddress[];
  /** The decimal mark amounts are read in (`answeredDecimalMark`). */
  decimalMark: DecimalMark | null;
  /** Whether the batch has an amount column. */
  amounts: boolean;
  /** A blank token cell is the chain's own coin (`blankTokenIsNative`). */
  blankTokenIsNative: boolean;
  /** Rows past `PAYOUT_ROWS_MAX`. */
  leftOut: number;
}

const LEVELS: Record<FindingLevel, number> = { fix: 0, stop: 1, look: 2, note: 3 };

/** A row as read, with what the batch compares it by. */
interface ReadRow {
  row: PayoutRow;
  address: PayoutAddress;
  token: PayoutToken;
  tokenKey: string;
  amount: PayoutAmount | null;
  /** Its token and amount as two rows are compared: the amount read, or as written when it cannot be. */
  amountKey: string;
  addressKey: string | null;
  nameKey: string;
}

function countBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const each = key(item);
    counts.set(each, (counts.get(each) ?? 0) + 1);
  }
  return counts;
}

function memo<T>(make: (key: string) => T): (key: string) => T {
  const made = new Map<string, T>();
  return (key) => {
    if (!made.has(key)) made.set(key, make(key));
    return made.get(key)!;
  };
}

/**
 * Every row checked (CP3-CP8), each against the others, the known addresses and OFAC's list. What rows share, an
 * address or a name, is counted once for the group, and each finding names at most its first rows and how many more,
 * so 5,000 rows of one address or one name stay as fast as 5,000 of different ones.
 */
export function checkPayoutRows(rows: readonly PayoutRow[], options: PayoutCheckOptions): PayoutCheck {
  // Each token once: a batch of thousands of rows names a few.
  const tokens = memo((type) => memo((cell) => tokenOf(cell, type, options.blankTokenIsNative)));
  const read: ReadRow[] = rows.map((row) => {
    const token = tokens(row.tokenType)(row.token);
    const key = tokenKey(token);
    const address = payoutAddressOf(row.address, options.known, options.sanctioned);
    const amount = !options.amounts || isNftRow(row) ? null : readPayoutAmount(row.amount, options.decimalMark, tokenDigits(token), tokenWords(token));
    return {
      row,
      address,
      token,
      tokenKey: key,
      amount,
      amountKey: `${key}\n${amount?.ok ? amount.value : row.amount}`,
      addressKey: addressKeyOf(address, row.address),
      nameKey: vendorKeyOf(row.name),
    };
  });

  const byAddress = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  read.forEach((each, index) => {
    if (each.addressKey !== null) addAt(byAddress, each.addressKey, index);
    if (each.nameKey !== "" && each.addressKey !== null) addAt(byName, each.nameKey, index);
  });
  const evm = [...byAddress.keys()].filter((key) => read[byAddress.get(key)![0]].address.kind === "evm");
  const scale: BatchScale = { addresses: evm.length, known: options.known.length };
  const nearOf = new Map(lookalikeNeighbours(evm).map((near, index) => [evm[index], near] as const));
  const linesOf = memo((key) => byAddress.get(key)!.map((index) => read[index].row.line));
  const pairOf = (near: Neighbour, alike: boolean): AddressPair => {
    const key = evm[near.index];
    return { address: key, lines: linesOf(key), name: read[byAddress.get(key)![0]].row.name, leading: near.leading, trailing: near.trailing, alike };
  };
  // An address's neighbours and their words, once for the address, however many rows give it.
  const neighboursOf = memo((key) => {
    const near = nearOf.get(key);
    const pairs = near ? [...near.alike.map((each) => pairOf(each, true)), ...near.partial.map((each) => pairOf(each, false))] : [];
    return { pairs, findings: neighbourFindings(pairs, scale) };
  });
  const addressCounts = memo((key) => {
    const holders = byAddress.get(key)!;
    return { names: countBy(holders, (index) => read[index].nameKey), both: countBy(holders, (index) => `${read[index].nameKey}\n${read[index].amountKey}`) };
  });
  const nameCounts = memo((key) => countBy(byName.get(key)!, (index) => read[index].addressKey!));

  // Amounts by token: the median rule and the totals count only amounts read, of a token read.
  const byToken = new Map<string, { token: PayoutToken; entries: Array<{ index: number; value: string }>; first: number }>();
  let notTotalled = 0;
  read.forEach((each, index) => {
    if (each.amount === null) return;
    if (!each.amount.ok || each.token.kind === "unreadable") {
      notTotalled += 1;
      return;
    }
    const group = byToken.get(each.tokenKey) ?? { token: each.token, entries: [], first: index };
    group.entries.push({ index, value: each.amount.value });
    byToken.set(each.tokenKey, group);
  });
  const large = new Map<number, string>();
  for (const group of byToken.values()) for (const [index, median] of largeAmounts(group.entries)) large.set(index, median);

  const tokenUses = new Map<string, PayoutTokenUse>();
  for (const each of read) {
    const use = tokenUses.get(each.tokenKey);
    if (use) use.lines.push(each.row.line);
    else tokenUses.set(each.tokenKey, { key: each.tokenKey, token: each.token, label: tokenLabel(each.token), lines: [each.row.line], finding: tokenFinding(each.token) });
  }

  const results = read.map((each, index): PayoutResult => {
    const findings = addressFindings(each.address, scale);
    let pairs: AddressPair[] = [];
    if (each.addressKey !== null) {
      const near = neighboursOf(each.addressKey);
      pairs = near.pairs;
      findings.push(...near.findings);
      findings.push(...sameAddressFindings(read, index, byAddress.get(each.addressKey)!, addressCounts(each.addressKey), options.amounts));
      const name = each.nameKey === "" ? null : nameFinding(read, index, byName.get(each.nameKey)!, nameCounts(each.nameKey));
      if (name) findings.push(name);
    }
    const tokenSays = tokenUses.get(each.tokenKey)!.finding;
    if (tokenSays) findings.push(tokenSays);
    if (each.amount && !each.amount.ok) findings.push({ level: "fix", kind: "amount", text: each.amount.reason });
    const median = large.get(index);
    if (median !== undefined) {
      const label = tokenLabel(each.token);
      findings.push({
        level: "look",
        kind: "large_amount",
        text: `At least ${MEDIAN_TIMES} times the median of the other ${label ? `${label} ` : ""}amounts in the batch, ${groupedDecimal(median)}: a decimal point may have moved, or the amount is written in base units.`,
      });
    }
    findings.sort((a, b) => LEVELS[a.level] - LEVELS[b.level]);
    return { row: each.row, address: each.address, token: each.token, amount: each.amount, pairs, findings, verdict: payoutVerdict(findings) };
  });

  const count = (verdict: PayoutVerdict) => results.filter((result) => result.verdict === verdict).length;
  const totals = [...byToken.values()]
    .sort((a, b) => a.first - b.first)
    .map(({ token, entries }) => ({ key: tokenKey(token), token, label: tokenLabel(token), rows: entries.length, sum: sumDecimals(entries.map((entry) => entry.value)) }));
  return {
    results,
    leftOut: options.leftOut,
    counts: { rows: results.length, fix: count("fix"), stop: count("stop"), look: count("look"), nothingFound: count("nothing_found") },
    amounts: options.amounts,
    totals,
    notTotalled,
    nftRows: options.amounts ? read.filter((each) => isNftRow(each.row)).length : 0,
    tokens: [...tokenUses.values()],
    known: options.known.length,
  };
}

/**
 * An address's neighbours in words (CP4): made to look like another row's address, a stop, while a batch of its size
 * would rarely hold such a pair by chance (`CHANCE_PAIRS_MAX`), else a look saying how often chance does it; 4 digits
 * shared at an end, a look.
 */
function neighbourFindings(pairs: readonly AddressPair[], scale: BatchScale): PayoutFinding[] {
  const findings: PayoutFinding[] = [];
  const onRows = (pair: AddressPair) => `the address on ${rowWords(pair.lines)}${pair.name ? ` (${pair.name})` : ""}`;
  const restLines = (rest: readonly AddressPair[]) => rest.flatMap((pair) => pair.lines).sort((a, b) => a - b);
  const alike = pairs.filter((pair) => pair.alike);
  const chance = (pair: AddressPair) => chancePairs(rowComparisons(scale), pair);
  const rare = alike.filter((pair) => chance(pair) < CHANCE_PAIRS_MAX);
  const common = alike.filter((pair) => chance(pair) >= CHANCE_PAIRS_MAX);
  if (rare.length > 0) {
    const [first, ...rest] = rare;
    const lines = restLines(rest);
    const more = lines.length === 0 ? "" : ` ${capitalized(rowWords(lines))} ${lines.length === 1 ? "has an address" : "have addresses"} made to look like it too.`;
    findings.push({
      level: "stop",
      kind: "alike_row",
      text: `Made to look like ${onRows(first)}. It shares ${sharedWords(first)}, which a random address does about once in ${chanceWords(first.leading + first.trailing)}: one of the two is very likely not the payee's.${more}`,
    });
  }
  if (common.length > 0) {
    const [first, ...rest] = common;
    const lines = restLines(rest);
    const more = lines.length === 0 ? "" : ` ${capitalized(rowWords(lines))} ${lines.length === 1 ? "has an address" : "have addresses"} like it too.`;
    findings.push({
      level: "look",
      kind: "alike_row",
      text: `Shares ${sharedWords(first)} with ${onRows(first)}: in a batch of ${addressesWords(scale.addresses)}, ${chancePairsWords(chance(first))}. Compare the whole address.${more}`,
    });
  }
  const partial = pairs.filter((pair) => !pair.alike);
  if (partial.length > 0) {
    const [first, ...rest] = partial;
    const lines = restLines(rest);
    const more = lines.length === 0 ? "" : ` ${capitalized(rowWords(lines))} ${lines.length === 1 ? "shares" : "share"} 4 digits at an end with it too.`;
    findings.push({ level: "look", kind: "partial_row", text: `Shares ${sharedWords(first)} with ${onRows(first)}. Compare the whole address.${more}` });
  }
  return findings;
}

/**
 * The same address on more than one row (CP4), to look at: with the same name and amount, the row may be in the batch
 * twice; under another name, one address is given for two payees; for another amount, the address is paid more than
 * once. `counts` are the address's rows by name, and by name and amount, so each kind's rows are counted without
 * walking them, and the walk stops once each kind has the rows it names.
 */
function sameAddressFindings(
  read: readonly ReadRow[],
  index: number,
  holders: readonly number[],
  counts: { names: Map<string, number>; both: Map<string, number> },
  amounts: boolean
): PayoutFinding[] {
  const own = read[index];
  const sameName = counts.names.get(own.nameKey)!;
  const sameBoth = counts.both.get(`${own.nameKey}\n${own.amountKey}`)!;
  const unnamedTotal = own.nameKey === "" ? 0 : (counts.names.get("") ?? 0);
  const twice: SomeLines = { lines: [], total: sameBoth - 1 };
  const again: SomeLines = { lines: [], total: sameName - sameBoth };
  const unnamed: SomeLines = { lines: [], total: unnamedTotal };
  const payees: SomeLines = { lines: [], total: holders.length - sameName - unnamedTotal };
  const names = new Map<string, string>();
  for (const other of holders) {
    if (named(twice) && named(again) && named(unnamed) && named(payees)) break;
    if (other === index) continue;
    const each = read[other];
    if (each.nameKey === own.nameKey) addLine(each.amountKey === own.amountKey ? twice : again, each.row.line);
    else if (each.nameKey === "") addLine(unnamed, each.row.line);
    else if (!named(payees)) {
      addLine(payees, each.row.line);
      if (!names.has(each.nameKey)) names.set(each.nameKey, each.row.name);
    }
  }
  const findings: PayoutFinding[] = [];
  if (twice.total > 0) {
    const same = listWords(["address", ...(own.row.name ? ["name"] : []), ...(amounts ? ["amount"] : [])]);
    findings.push({ level: "look", kind: "same_address", text: `The same ${same} as ${rowWords(twice.lines, twice.total)}: this payment may be in the batch twice.` });
  }
  if (payees.total > 0) {
    const shown = [...names.values()];
    const who = payees.total > payees.lines.length ? `${shown.join(", ")} and others` : listWords(shown);
    findings.push({ level: "look", kind: "same_address", text: `The same address as ${rowWords(payees.lines, payees.total)}, given there for ${who}: one address for two payees.` });
  }
  if (unnamed.total > 0) {
    findings.push({ level: "look", kind: "same_address", text: `The same address as ${rowWords(unnamed.lines, unnamed.total)}, with no name there: check one address is meant for both.` });
  }
  if (again.total > 0) {
    findings.push({ level: "look", kind: "same_address", text: `The same address as ${rowWords(again.lines, again.total)}, for another amount: it is paid more than once in the batch.` });
  }
  return findings;
}

/**
 * One name with two or more addresses (CP4), names compared as the bill check groups vendors (`vendorKeyOf`, built on
 * `nameKey`): to look at, naming the rows with another address. `counts` are the name's rows by address.
 */
function nameFinding(read: readonly ReadRow[], index: number, group: readonly number[], counts: Map<string, number>): PayoutFinding | null {
  const own = read[index];
  const others: SomeLines = { lines: [], total: group.length - counts.get(own.addressKey!)! };
  if (others.total === 0) return null;
  for (const other of group) {
    if (named(others)) break;
    if (read[other].addressKey !== own.addressKey) addLine(others, read[other].row.line);
  }
  return {
    level: "look",
    kind: "name_addresses",
    text: `${own.row.name} is given another address on ${rowWords(others.lines, others.total)}. Check which one is theirs.`,
  };
}

/** The batch checked with the person's answers (CP2-CP8): its rows read, then `checkPayoutRows`. */
export function checkPayouts(
  table: Table,
  answers: PayoutAnswers,
  lists: { sanctioned: readonly SanctionedEntry[]; known?: readonly KnownAddress[] }
): PayoutCheck {
  const questions = payoutQuestions(table, answers);
  return checkPayoutRows(payoutRows(table, answers.hasHeader, answers.columns).rows, {
    sanctioned: lists.sanctioned,
    known: lists.known ?? [],
    decimalMark: answeredDecimalMark(questions, answers),
    amounts: answers.columns.amount !== undefined,
    blankTokenIsNative: blankTokenIsNative(table, answers),
    leftOut: questions.leftOut,
  });
}

/**
 * A row's verdict and findings in one cell (CP10): "Fix: …", "Stop: …", "Look: …", each level that has a finding, then
 * any note; "Nothing found" when there is none.
 */
export function payoutCheckWords(result: Pick<PayoutResult, "findings">): string {
  const parts = (["fix", "stop", "look"] as const).flatMap((level) => {
    const texts = result.findings.filter((finding) => finding.level === level).map((finding) => finding.text);
    return texts.length > 0 ? [`${VERDICT_WORDS[level]}: ${texts.join(" ")}`] : [];
  });
  const notes = result.findings.filter((finding) => finding.level === "note").map((finding) => finding.text);
  if (parts.length === 0) return notes.length > 0 ? `${VERDICT_WORDS.nothing_found}. ${notes.join(" ")}` : VERDICT_WORDS.nothing_found;
  return [...parts, ...notes].join(" ");
}
