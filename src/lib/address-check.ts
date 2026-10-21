import { getAddress } from "viem";
import { NETWORKS } from "./network";

/**
 * The address lookalike checker's rules (docs/superpowers/specs/2026-10-21-address-checker-design.md AC1-AC5): what
 * the public page at /check-address says about an address someone is about to pay. Pure and run in the browser, so
 * nothing pasted leaves the page.
 */

export interface KnownAddress {
  label: string;
  /** Lowercase `0x` and 40 hex digits. */
  address: string;
}

export interface SanctionedEntry {
  address: string;
  name: string;
}

export type FormatProblem = "empty" | "invisible" | "lookalike_character" | "no_prefix" | "length" | "not_hex";

export interface AddressMatch {
  known: KnownAddress;
  /** `same`: the very address; `alike`: a different one made to look like it; `partial`: one sharing 4 digits at an end. */
  kind: "same" | "alike" | "partial";
  /** Hex digits after `0x` that agree from the start, and from the end, case ignored. */
  leading: number;
  trailing: number;
}

export type SpecialAddress = { kind: "zero" } | { kind: "burn" } | { kind: "system" } | { kind: "token"; label: string };

export type Verdict = "fix" | "stop" | "conflict" | "same" | "check";

export interface AddressCheck {
  /** Lowercase `0x` and 40 hex digits; null when the input is not one. */
  address: string | null;
  format: { ok: true } | { ok: false; problem: FormatProblem; message: string };
  /** EIP-55: `valid` or `invalid` for a mixed-case input, `none` for one in a single case, which carries no checksum. */
  checksum: "valid" | "invalid" | "none";
  /** The address with its EIP-55 checksum. */
  checksummed: string | null;
  sanctioned: SanctionedEntry | null;
  special: SpecialAddress | null;
  matches: AddressMatch[];
  verdict: Verdict;
}

const EVM = /^0x[0-9a-f]{40}$/;
const ADDRESS_IN_TEXT = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/;

/**
 * Characters nobody sees, or sees as a space, that a copy can carry: format characters (zero-width spaces and joiners,
 * direction marks and overrides, the byte-order mark, tags), spaces other than the plain one, combining marks and
 * variation selectors, and the blank fillers some scripts have. An override can show an address's characters in an
 * order other than the one that is pasted. Written as escapes, so none of them is hidden in this file.
 */
const INVISIBLE = /[\p{Cf}\p{Zs}\p{M}\u115f\u1160\u3164\uffa0\u2800]/u;

/** Letters from other scripts that look like the Latin ones an address uses, and the Latin ones that look like digits. */
const LOOKALIKE_CHARACTERS: Record<string, string> = {
  "\u0430": "a", // Cyrillic a
  "\u0441": "c", // Cyrillic es
  "\u0435": "e", // Cyrillic ie
  "\u0445": "x", // Cyrillic ha
  "\u0410": "A",
  "\u0412": "B",
  "\u0421": "C",
  "\u0415": "E",
  "\u0425": "X",
  "\u03b1": "a", // Greek alpha
  "\u03bf": "0", // Greek omicron
  "\u039f": "0",
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u03a7": "X",
  O: "0",
  o: "0",
  l: "1",
  I: "1",
};

/** The hex digits at each end two addresses must share to be called made to look alike (AC3). */
export const BOTH_ENDS_MIN = 3;
export const ONE_END_MIN = 5;
/** At one end, the digits that make a partial match: worth comparing the whole address, not a reason to stop (AC3). */
export const PARTIAL_MIN = 4;

const codePoint = (character: string) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

function formatOf(raw: string): AddressCheck["format"] {
  const input = raw.trim();
  if (input === "") return { ok: false, problem: "empty", message: "Paste the address you are about to pay." };
  const invisible = [...input].find((character) => character !== " " && INVISIBLE.test(character));
  if (invisible) {
    return {
      ok: false,
      problem: "invisible",
      message: `It contains a character you cannot see, or that shows as a space (${codePoint(invisible)}). A copy can carry one, and some reorder what is shown. Copy the address again from where you got it, or ask for it again.`,
    };
  }
  const characters = [...input];
  const lookalike = characters.findIndex((character) => character in LOOKALIKE_CHARACTERS || character !== character.normalize("NFKC"));
  if (lookalike >= 0) {
    const character = characters[lookalike];
    const like = LOOKALIKE_CHARACTERS[character] ?? character.normalize("NFKC");
    return {
      ok: false,
      problem: "lookalike_character",
      message: `Character ${lookalike + 1}, “${character}” (${codePoint(character)}), only looks like “${like}”. An address has only 0–9 and a–f after 0x.`,
    };
  }
  if (input.startsWith("0X")) {
    return { ok: false, problem: "no_prefix", message: "An address starts with 0x, with a small x. This one starts with 0X, which wallets refuse." };
  }
  if (!input.startsWith("0x")) {
    return { ok: false, problem: "no_prefix", message: /^[0-9a-fA-F]{40}$/.test(input) ? "An address starts with 0x: this one has its 40 digits without it." : "An address starts with 0x." };
  }
  const digits = input.slice(2);
  const wrong = [...digits].findIndex((character) => !/[0-9a-fA-F]/.test(character));
  if (wrong >= 0) {
    return { ok: false, problem: "not_hex", message: `Character ${wrong + 3}, “${[...digits][wrong]}”, is not 0–9 or a–f.` };
  }
  if (digits.length !== 40) {
    return { ok: false, problem: "length", message: `It has ${digits.length} characters after 0x; an address has 40. One may have been lost or added in the copy.` };
  }
  return { ok: true };
}

function checksumOf(input: string, address: string): { checksum: AddressCheck["checksum"]; checksummed: string } {
  const checksummed = getAddress(address);
  const digits = input.slice(2);
  if (digits === digits.toLowerCase() || digits === digits.toUpperCase()) return { checksum: "none", checksummed };
  return { checksum: `0x${digits}` === checksummed ? "valid" : "invalid", checksummed };
}

/** Hex digits after `0x` that two addresses share from the start and from the end. */
export function sharedEnds(a: string, b: string): { leading: number; trailing: number } {
  const x = a.toLowerCase().slice(2);
  const y = b.toLowerCase().slice(2);
  let leading = 0;
  while (leading < x.length && x[leading] === y[leading]) leading += 1;
  let trailing = 0;
  while (trailing < x.length && x[x.length - 1 - trailing] === y[y.length - 1 - trailing]) trailing += 1;
  return { leading, trailing };
}

/**
 * Whether two different addresses are made to look alike (AC3): at least 3 hex digits shared at each end, or 5 at one.
 * Wallets show an address's ends, and address poisoning makes an address with the same ends as one the victim pays. By
 * chance, two unrelated addresses share 3 at each end about once in 17 million, and 5 at one end or the other about
 * once in 524 thousand.
 */
export function madeToLookAlike(ends: { leading: number; trailing: number }): boolean {
  return (ends.leading >= BOTH_ENDS_MIN && ends.trailing >= BOTH_ENDS_MIN) || ends.leading >= ONE_END_MIN || ends.trailing >= ONE_END_MIN;
}

/** Which digits two addresses share, in words: "its first 4 and last 4 digits", "its last 5 digits". */
export function sharedWords(ends: { leading: number; trailing: number }): string {
  if (ends.leading > 0 && ends.trailing > 0) return `its first ${ends.leading} and last ${ends.trailing} digits`;
  return ends.leading > 0 ? `its first ${ends.leading} digits` : `its last ${ends.trailing} digits`;
}

/** How rarely a random address shares `digits` hex digits in given places with another: "4.3 billion". */
export function chanceWords(digits: number): string {
  const odds = 16 ** digits;
  const scales: [number, string][] = [
    [1e12, "trillion"],
    [1e9, "billion"],
    [1e6, "million"],
    [1e3, "thousand"],
  ];
  for (const [scale, word] of scales) {
    if (odds >= scale) {
      const value = odds / scale;
      return `${value >= 100 ? Math.round(value) : Number(value.toPrecision(2))} ${word}`;
    }
  }
  return String(odds);
}

/** Addresses no payee should give: where USDC is burned or held by a contract, not a person's wallet (AC4). */
const SPECIAL: ReadonlyMap<string, SpecialAddress> = (() => {
  const special = new Map<string, SpecialAddress>([
    [`0x${"0".repeat(40)}`, { kind: "zero" }],
    ["0x000000000000000000000000000000000000dead", { kind: "burn" }],
  ]);
  // Mainnet first, so an address both networks share takes its mainnet name.
  for (const profile of Object.values(NETWORKS).sort((a, b) => Number(b.id === "arc-mainnet") - Number(a.id === "arc-mainnet"))) {
    const add = (address: string, label: string) => {
      const key = address.toLowerCase();
      if (!special.has(key)) special.set(key, { kind: "token", label });
    };
    add(profile.tokens.USDC, "USDC on Arc");
    add(profile.tokens.EURC, `EURC on ${profile.label}`);
    for (const chain of profile.payeeChains) {
      add(chain.usdc, `USDC on ${chain.label}`);
      if ("nativeUsdc" in chain && typeof chain.nativeUsdc === "string" && !special.has(chain.nativeUsdc.toLowerCase())) {
        special.set(chain.nativeUsdc.toLowerCase(), { kind: "system" });
      }
    }
    for (const source of profile.inbound?.sources ?? []) add(source.usdc, `USDC on ${source.label}`);
  }
  return special;
})();

/** The special address `address` is, if any. */
export function specialAddress(address: string): SpecialAddress | null {
  return SPECIAL.get(address.toLowerCase()) ?? null;
}

/** At most this many known addresses are read. */
export const KNOWN_MAX = 200;

export interface KnownAddresses {
  known: KnownAddress[];
  /** Lines that seem to hold an address that could not be read, with why, so none is left out unnoticed. */
  unread: Array<{ line: number; message: string }>;
  /** Whether addresses past the first `KNOWN_MAX` were left out. */
  more: boolean;
}

/** A word on a line that seems meant as an address: it has `0x`, or a long run of hex digits. */
const ADDRESS_LIKE = /0x|[0-9a-f]{30,}/i;

/**
 * The addresses in what someone pasted as the ones they know (AC5), one or more a line, each with the rest of its line as
 * its name ("Northwind, 0x…"), or "Address 2" without one. The same address twice is kept once, and at most 200. A line
 * that seems to hold an address that is not one is listed with what is wrong with it.
 */
export function readKnownAddresses(text: string): KnownAddresses {
  const known = new Map<string, KnownAddress>();
  const unread: KnownAddresses["unread"] = [];
  let more = false;
  text.split(/\r?\n/).forEach((line, index) => {
    const pattern = new RegExp(ADDRESS_IN_TEXT.source, "g");
    const found = line.match(pattern) ?? [];
    if (found.length === 0) {
      const candidate = line.split(/[\s,;|]+/).find((word) => ADDRESS_LIKE.test(word));
      if (candidate) {
        const format = formatOf(candidate.replace(/^[^0-9a-zA-Z]+|[.:)\]]+$/g, ""));
        unread.push({ line: index + 1, message: format.ok ? "Put a space or a comma between the address and its name." : format.message });
      }
      return;
    }
    const rest = line.replace(pattern, " ").replace(/[\s,;:|\-–—]+/g, " ").trim().slice(0, 60);
    for (const address of found) {
      const key = address.toLowerCase();
      if (known.has(key)) continue;
      if (known.size >= KNOWN_MAX) {
        more = true;
        continue;
      }
      known.set(key, { label: rest || `Address ${known.size + 1}`, address: key });
    }
  });
  return { known: [...known.values()], unread, more };
}

/** What the page says about `raw`, against the addresses someone knows and OFAC's list (AC1-AC5). */
export function checkAddress(raw: string, known: readonly KnownAddress[], sanctioned: readonly SanctionedEntry[]): AddressCheck {
  const format = formatOf(raw);
  if (!format.ok) return { address: null, format, checksum: "none", checksummed: null, sanctioned: null, special: null, matches: [], verdict: "fix" };
  const input = raw.trim();
  const address = input.toLowerCase();
  const { checksum, checksummed } = checksumOf(input, address);
  const listed = sanctioned.find((entry) => entry.address.toLowerCase() === address) ?? null;
  const special = specialAddress(address);
  const matches: AddressMatch[] = [];
  for (const entry of known) {
    if (!EVM.test(entry.address)) continue;
    const ends = sharedEnds(address, entry.address);
    if (entry.address === address) matches.push({ known: entry, kind: "same", ...ends });
    else if (madeToLookAlike(ends)) matches.push({ known: entry, kind: "alike", ...ends });
    else if (ends.leading >= PARTIAL_MIN || ends.trailing >= PARTIAL_MIN) matches.push({ known: entry, kind: "partial", ...ends });
  }
  // Lookalikes first, then the very address, then partial matches; within each, most digits shared first.
  const rank = { alike: 0, same: 1, partial: 2 } as const;
  matches.sort((a, b) => rank[a.kind] - rank[b.kind] || b.leading + b.trailing - (a.leading + a.trailing));
  const alike = matches.some((match) => match.kind === "alike");
  const same = matches.some((match) => match.kind === "same");
  // An address in the list that another in the list is made to look like: one of the two is not the payee's.
  const verdict: Verdict =
    listed !== null || special !== null || checksum === "invalid" ? "stop" : alike && same ? "conflict" : alike ? "stop" : same ? "same" : "check";
  return { address, format, checksum, checksummed, sanctioned: listed, special, matches, verdict };
}
