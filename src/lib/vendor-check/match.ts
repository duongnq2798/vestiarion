import type { SanctionedEntry } from "../address-check";
import type { SdnEntryType, SdnNameSnapshot } from "../sanctioned-wallets";

/**
 * The vendor check's name matcher (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV2-CV5): a name typed or
 * pasted against every name on OFAC's SDN list, each entry's other names included. Pure, and run in the browser on the
 * snapshot the page loads, so no name leaves the page.
 */

/**
 * A strong match: 0.85, the same cut-off the product's screening applies to its provider's score before it calls a
 * sanctions match high risk (`STRONG_SANCTIONS_MATCH_THRESHOLD`, `src/lib/screening/providers.ts`). The two scores are
 * not the same: this one is this matcher's, against the SDN snapshot. Kept here as a number so the browser does not
 * load the providers' code; the test holds the two to each other (CV4).
 */
export const STRONG_MATCH = 0.85;
/** A possible match: yente's default cut-off. Below it a name is not shown (CV4). */
export const POSSIBLE_MATCH = 0.7;
/** The entries shown for one name (CV4). */
export const MATCHES_SHOWN = 3;
/** A word in at most this many of the list's names is rare there (CV4). */
export const RARE_IN_NAMES = 10;

/** One SDN entry as the check shows it. */
export interface SdnEntry {
  /** The entry's number, which Treasury's search opens at `Details.aspx?id=<number>`. */
  number: number;
  name: string;
  type: SdnEntryType;
  programs: string[];
  otherNames: string[];
  countries: string[];
  /** As `<currency> <address>`, written as the list writes them. */
  addresses: string[];
}

/** How a typed word paired with a listed one (CV3). */
export type Closeness = "same" | "alike" | "close";

export interface WordPair {
  typed: string;
  listed: string;
  how: Closeness;
}

export type CountryAgreement =
  | { kind: "agrees"; country: string }
  | { kind: "differs"; listed: string[] }
  | { kind: "not_listed" }
  | { kind: "not_given" };

export interface NameMatch {
  entry: SdnEntry;
  /** From 0 to 1, to 3 decimals. */
  score: number;
  band: "strong" | "possible";
  /** The name that matched: the entry's own, or one of its other names. */
  matched: string;
  via: "name" | "other_name";
  /** The word pairs, in the order the words were typed. */
  pairs: WordPair[];
  /** Typed words with no pair, and the matched name's words with no pair. */
  typedOnly: string[];
  listedOnly: string[];
  /** The same letters, spaced another way ("Alqaida" and "AL QA'IDA"). */
  spacing: boolean;
  /** Every typed word is a rare word of the matched name, which makes it a possible match at least (CV4). */
  rare: boolean;
  country: CountryAgreement;
}

/** A listed digital-currency address and its entry. */
export interface ListedAddress {
  entry: SdnEntry;
  currency: string;
  address: string;
}

interface NameForm {
  entry: number;
  text: string;
  words: string[];
  own: boolean;
}

export interface NameIndex {
  readAt: string;
  entries: SdnEntry[];
  /** The EVM addresses on the list, lowercase, with their entry's name: what the address checker compares (AC4). */
  evmWallets: SanctionedEntry[];
  /** Every listed address, by `addressKey`. */
  addresses: ReadonlyMap<string, ListedAddress>;
  forms: NameForm[];
  /** The name forms each word is in. */
  postings: ReadonlyMap<string, number[]>;
  /** The name forms with each run of letters, spaces aside. */
  joined: ReadonlyMap<string, number[]>;
  /** The list's words of 4 letters or more, by the group of their first letter and by their sound key. */
  byFirst: ReadonlyMap<string, string[]>;
  bySound: ReadonlyMap<string, string[]>;
  /** Each word's weight (CV4), and each name form's words' weights summed. */
  weights: ReadonlyMap<string, number>;
  formWeights: Float64Array;
  /** The listed words close to each word already typed, kept while the page is open (CV3). */
  closeCache: Map<string, ReadonlyMap<string, { closeness: number; how: Closeness }>>;
  /** Room for one name's tally per name form, reused from one name to the next. */
  tally: Float64Array;
}

/** Legal forms of more than one word, dropped before the words are split (CV2). */
const LEGAL_PHRASES = [
  "limited liability company",
  "limited liability partnership",
  "public joint stock company",
  "open joint stock company",
  "closed joint stock company",
  "joint stock company",
  "public limited company",
  "private limited company",
  "obshchestvo s ogranichennoi otvetstvennostyu",
  "obshchestvo s ogranichennoy otvetstvennostyu",
  "otkrytoe aktsionernoe obshchestvo",
  "zakrytoe aktsionernoe obshchestvo",
  "publichnoe aktsionernoe obshchestvo",
  "aktsionernoe obshchestvo",
  "sociedad anonima",
  "societe anonyme",
  "sdn bhd",
];

/** Legal forms of one word, dropped wherever they stand (CV2). */
const LEGAL_WORDS = new Set(
  (
    "llc lc ltd limited inc incorporated corp corporation co company plc gmbh mbh ag sa sas sarl srl spa bv nv ab oy asa " +
    "aps kg kgaa llp lp pllc pte pty jsc ojsc cjsc pjsc ooo oao zao pao tov fze fzco fzc fzllc dmcc bhd ltda sl slu sau " +
    "lda kft zrt sro"
  ).split(" ")
);

/** A string with its accents dropped, in lower case, `&` read as "and". */
function folded(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ");
}

/** A letter outside the Latin script. OFAC's list writes every name in Latin letters (CV2). */
const NON_LATIN = /(?!\p{Script=Latin})\p{L}/u;

/**
 * Apostrophes, dropped from a name (CV2): `'`, its curly form and the backtick, and the modifier letters some Latin
 * spellings write one as, from U+02B9 to U+02BF and U+02C8: the Hawaiian okina (U+02BB), the modifier apostrophe
 * (U+02BC) of names such as Hizb'allah, and the half rings (U+02BE, U+02BF) of Arabic transliterations. They are
 * letters of no script, so kept, they would make a Latin word read as one in another script.
 */
const APOSTROPHES = /['\u2019`\u02b9-\u02bf\u02c8]/g;

/**
 * The words of a name, as written, with a letter outside the Latin script: a word in Cyrillic or Chinese letters, or a
 * Latin-looking word with one Cyrillic letter in it. No name on the list is written so, so they are left out of the
 * comparison, and the page says which (CV2).
 */
export function nonLatinWords(name: string): string[] {
  return name.split(/[^\p{L}\p{M}\p{N}]+/u).filter((word) => NON_LATIN.test(folded(word).replace(APOSTROPHES, "")));
}

/** A name's words in Latin letters, and of those the ones that are not legal forms (CV2). */
function splitName(name: string): { all: string[]; kept: string[] } {
  const all = folded(name)
    .replace(APOSTROPHES, "")
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "" && !NON_LATIN.test(word));
  let text = ` ${all.join(" ")} `;
  for (const phrase of LEGAL_PHRASES) text = text.replaceAll(` ${phrase} `, " ");
  return { all, kept: text.split(" ").filter((word) => word !== "" && !LEGAL_WORDS.has(word)) };
}

/**
 * A name's words as compared (CV2): accents and case dropped, dots and apostrophes dropped (`S.A.` is `sa`), any other
 * punctuation a space, words not in Latin letters left out, and legal forms dropped wherever they stand, unless the
 * name is nothing else.
 */
export function nameWords(name: string): string[] {
  const { all, kept } = splitName(name);
  return kept.length > 0 ? kept : all;
}

/**
 * Whether a name is compared at all (CV2). A name all in Latin letters always is. One with words in another script is
 * compared only when a word of it in Latin letters says who the vendor is: one that is not a legal form or a number.
 * A Russian bank's name in Cyrillic followed by PJSC, or a Chinese company's in Chinese followed by Co., Ltd., would be
 * compared on PJSC, or on Co and Ltd, which pair with nothing on the list, and get "No match" for a name never compared.
 */
export function nameCompared(name: string): boolean {
  return nonLatinWords(name).length === 0 || splitName(name).kept.some((word) => !/^\p{N}+$/u.test(word));
}

/** Jaro-Winkler similarity, from 0 to 1, with the usual prefix scale of 0.1 over at most 4 letters. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a === "" || b === "") return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const end = Math.min(i + range + 1, b.length);
    for (let j = Math.max(0, i - range); j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transposed = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transposed += 1;
    k += 1;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transposed / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * A word's sound key (CV3): `y` as a vowel, doubled letters once, and each run of vowels as one `a`. Transliterations
 * of one name often share it: "hezbollah" and "hizballah", "osama" and "usama", "mohamed" and "muhammad".
 */
export function soundKey(word: string): string {
  return word
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1")
    .replace(/[aeiou]+/g, "a")
    .replace(/(.)\1+/g, "$1");
}

/** The least Jaro-Winkler for a close spelling, and for two words of one sound key to count as spelled another way. */
const CLOSE_MIN = 0.88;
const ALIKE_MIN = 0.8;
/** Words this short count only when they are the same. */
const SHORT = 3;

/** How close two words are (CV3): the same, spelled another way, close, or not at all (null). */
export function wordCloseness(typed: string, listed: string): { closeness: number; how: Closeness } | null {
  if (typed === listed) return { closeness: 1, how: "same" };
  if (typed.length <= SHORT || listed.length <= SHORT) return null;
  const similarity = jaroWinkler(typed, listed);
  if (similarity >= ALIKE_MIN && soundKey(typed) === soundKey(listed)) return { closeness: 0.9, how: "alike" };
  if (similarity >= CLOSE_MIN) return { closeness: 0.5 + ((similarity - CLOSE_MIN) / (1 - CLOSE_MIN)) * 0.4, how: "close" };
  return null;
}

/** The group a word's first letter falls in, for the words a typed one is compared with: vowels; c, k, q and g; or itself. */
function letterGroup(word: string): string {
  const first = word[0] ?? "";
  if ("aeiouy".includes(first)) return "a";
  if ("ckqg".includes(first)) return "k";
  return first;
}

/** How an address is looked up: hex and single-case forms (bech32) in lower case, mixed-case ones (base58) as written. */
export function addressKey(address: string): string {
  const trimmed = address.trim();
  return /^0x[0-9a-f]+$/i.test(trimmed) || trimmed === trimmed.toLowerCase() || trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Entries, then listed words, read between two pauses when the index is built in steps (CV7). */
const ENTRIES_PER_STEP = 1000;
const WORDS_PER_STEP = 5000;

/** The index's build, which stops (`yield`) every few thousand entries and words, so a caller can let the page draw. */
function* indexSteps(snapshot: SdnNameSnapshot): Generator<undefined, NameIndex, undefined> {
  const entries: SdnEntry[] = snapshot.entries.map(([number, name, type, programs, otherNames, countries, addresses]) => ({
    number,
    name,
    type,
    programs,
    otherNames,
    countries,
    addresses,
  }));
  const forms: NameForm[] = [];
  const postings = new Map<string, number[]>();
  const joined = new Map<string, number[]>();
  const evmWallets: SanctionedEntry[] = [];
  const addresses = new Map<string, ListedAddress>();
  for (let at = 0; at < entries.length; at += 1) {
    if (at > 0 && at % ENTRIES_PER_STEP === 0) yield;
    const entry = entries[at];
    [entry.name, ...entry.otherNames].forEach((text, which) => {
      const words = [...new Set(nameWords(text))];
      if (words.length === 0) return;
      const id = forms.length;
      forms.push({ entry: at, text, words, own: which === 0 });
      for (const word of words) push(postings, word, id);
      push(joined, words.join(""), id);
    });
    for (const listed of entry.addresses) {
      const [currency, address] = listed.split(" ");
      if (!address) continue;
      const key = addressKey(address);
      if (!addresses.has(key)) addresses.set(key, { entry, currency, address });
      if (/^0x[0-9a-fA-F]{40}$/.test(address) && !evmWallets.some((wallet) => wallet.address === key)) evmWallets.push({ address: key, name: entry.name });
    }
  }
  const byFirst = new Map<string, string[]>();
  const bySound = new Map<string, string[]>();
  const weights = new Map<string, number>();
  let read = 0;
  for (const [word, names] of postings) {
    read += 1;
    if (read % WORDS_PER_STEP === 0) yield;
    weights.set(word, Math.log(1 + forms.length / names.length));
    if (word.length <= SHORT) continue;
    push(byFirst, letterGroup(word), word);
    push(bySound, soundKey(word), word);
  }
  const formWeights = Float64Array.from(forms, (form) => form.words.reduce((sum, word) => sum + weights.get(word)!, 0));
  return {
    readAt: snapshot.readAt,
    entries,
    evmWallets,
    addresses,
    forms,
    postings,
    joined,
    byFirst,
    bySound,
    weights,
    formWeights,
    closeCache: new Map(),
    tally: new Float64Array(forms.length),
  };
}

/** The index the check matches against, built at once from the snapshot. */
export function buildNameIndex(snapshot: SdnNameSnapshot): NameIndex {
  const steps = indexSteps(snapshot);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * The same index, built in steps with `pause` awaited between them (CV7): the page builds it when the first check runs,
 * and a build at once would hold the page still for most of a second on a laptop, longer on a phone.
 */
export async function buildNameIndexInSteps(snapshot: SdnNameSnapshot, pause: () => Promise<void>): Promise<NameIndex> {
  const steps = indexSteps(snapshot);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}

/** The listed words a typed word pairs with, and how closely (CV3). */
function closeWords(index: NameIndex, typed: string): ReadonlyMap<string, { closeness: number; how: Closeness }> {
  const cached = index.closeCache.get(typed);
  if (cached) return cached;
  const close = new Map<string, { closeness: number; how: Closeness }>();
  if (index.postings.has(typed)) close.set(typed, { closeness: 1, how: "same" });
  if (typed.length > SHORT) {
    const slack = Math.max(2, Math.floor(typed.length / 3));
    const consider = (listed: string) => {
      if (close.has(listed)) return;
      const found = wordCloseness(typed, listed);
      if (found) close.set(listed, found);
    };
    for (const listed of index.bySound.get(soundKey(typed)) ?? []) consider(listed);
    for (const listed of index.byFirst.get(letterGroup(typed)) ?? []) {
      if (Math.abs(listed.length - typed.length) <= slack) consider(listed);
    }
  }
  index.closeCache.set(typed, close);
  return close;
}

/** How much a word counts: the rarer among the list's names, the more (CV4). A word in no name counts as the rarest. */
function weightOf(index: NameIndex, word: string): number {
  return index.weights.get(word) ?? Math.log(1 + index.forms.length);
}

/** Whether a word is rare on the list (CV4): longer than 3 letters, and in 1 to `RARE_IN_NAMES` of its names. */
function rareWord(index: NameIndex, word: string): boolean {
  const names = index.postings.get(word)?.length ?? 0;
  return word.length > SHORT && names > 0 && names <= RARE_IN_NAMES;
}

interface Scored {
  form: NameForm;
  score: number;
  pairs: WordPair[];
  typedOnly: string[];
  listedOnly: string[];
  spacing: boolean;
  rare: boolean;
  sameOrder: boolean;
}

/**
 * One name form's score against the typed words (CV4): the closest pairs paired first; then the sum over pairs of
 * closeness times twice the listed word's weight, over the sum of each pair's full twice-the-weight and the weight of
 * every word on either side with no pair. When every typed word is a rare word on the list (`rare`) and this name holds
 * them all, it is a possible match at least, however many more words the name has.
 */
function scoreForm(
  index: NameIndex,
  typed: string[],
  close: ReadonlyArray<ReadonlyMap<string, { closeness: number; how: Closeness }>>,
  form: NameForm,
  rare: boolean
): Scored {
  const candidates: Array<{ t: number; l: number; closeness: number; how: Closeness }> = [];
  typed.forEach((_, t) => {
    form.words.forEach((listed, l) => {
      const found = close[t].get(listed);
      if (found) candidates.push({ t, l, ...found });
    });
  });
  candidates.sort((a, b) => b.closeness - a.closeness || a.t - b.t);
  const typedPaired = new Set<number>();
  const listedPaired = new Set<number>();
  const paired: typeof candidates = [];
  for (const candidate of candidates) {
    if (typedPaired.has(candidate.t) || listedPaired.has(candidate.l)) continue;
    typedPaired.add(candidate.t);
    listedPaired.add(candidate.l);
    paired.push(candidate);
  }
  let matched = 0;
  let total = 0;
  for (const pair of paired) {
    const weight = 2 * weightOf(index, form.words[pair.l]);
    matched += pair.closeness * weight;
    total += weight;
  }
  typed.forEach((word, t) => {
    if (!typedPaired.has(t)) total += weightOf(index, word);
  });
  form.words.forEach((word, l) => {
    if (!listedPaired.has(l)) total += weightOf(index, word);
  });
  let score = total === 0 ? 0 : matched / total;
  const held = rare && score < POSSIBLE_MATCH && typed.every((word) => form.words.includes(word));
  if (held) score = POSSIBLE_MATCH;
  const spacing = score < 0.95 && typed.join("") === form.words.join("");
  if (spacing) score = 0.95;
  return {
    form,
    score: Math.round(score * 1000) / 1000,
    pairs: paired.sort((a, b) => a.t - b.t).map((pair) => ({ typed: typed[pair.t], listed: form.words[pair.l], how: pair.how })),
    typedOnly: typed.filter((_, t) => !typedPaired.has(t)),
    listedOnly: form.words.filter((_, l) => !listedPaired.has(l)),
    spacing,
    rare: held,
    sameOrder: typed.join(" ") === form.words.join(" "),
  };
}

/** Whether one scored name form beats another for the same entry: higher, then the entry's own name, then in order. */
function better(a: Scored, b: Scored): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.form.own !== b.form.own) return a.form.own;
  return a.sameOrder && !b.sameOrder;
}

/**
 * The SDN entries a name may be (CV4, CV5): every name form sharing a close word with it, its letters, or all its rare
 * words, scored, each entry by its best; those at `POSSIBLE_MATCH` or more, at most `MATCHES_SHOWN`, highest first. On
 * a tie: the country agreeing, then the entry's own name, then the lower number. The country never changes a score.
 * Words not in Latin letters are left out (`nonLatinWords`): a name not compared (`nameCompared`) finds nothing.
 */
export function matchName(index: NameIndex, name: string, country = ""): NameMatch[] {
  const typed = [...new Set(nameWords(name))];
  if (typed.length === 0 || !nameCompared(name)) return [];
  const close = typed.map((word) => closeWords(index, word));
  // Each name form's weight that a typed word could pair with. A form's score is at most 2h / (h + its weight + the
  // weight of the typed words close to nothing), with every pair the same word: below POSSIBLE_MATCH, it is not scored.
  const { tally, formWeights } = index;
  const touched: number[] = [];
  let lonely = 0;
  typed.forEach((word, t) => {
    if (close[t].size === 0) lonely += weightOf(index, word);
    for (const listed of close[t].keys()) {
      const weight = weightOf(index, listed);
      for (const id of index.postings.get(listed) ?? []) {
        if (tally[id] === 0) touched.push(id);
        tally[id] += weight;
      }
    }
  });
  const candidates = new Set<number>(index.joined.get(typed.join("")) ?? []);
  for (const id of touched) {
    const hit = Math.min(tally[id], formWeights[id]);
    tally[id] = 0;
    if ((2 * hit) / (hit + formWeights[id] + lonely) >= POSSIBLE_MATCH) candidates.add(id);
  }
  // A name made only of rare words is a possible match to every name form holding them all, whatever the bound says.
  const rare = typed.every((word) => rareWord(index, word));
  if (rare) {
    for (const id of index.postings.get(typed[0]) ?? []) if (typed.every((word) => index.forms[id].words.includes(word))) candidates.add(id);
  }
  const best = new Map<number, Scored>();
  for (const id of candidates) {
    const scored = scoreForm(index, typed, close, index.forms[id], rare);
    if (scored.score < POSSIBLE_MATCH) continue;
    const prior = best.get(scored.form.entry);
    if (!prior || better(scored, prior)) best.set(scored.form.entry, scored);
  }
  const matches = [...best.values()].map((scored): NameMatch => {
    const entry = index.entries[scored.form.entry];
    return {
      entry,
      score: scored.score,
      band: scored.score >= STRONG_MATCH ? "strong" : "possible",
      matched: scored.form.text,
      via: scored.form.own ? "name" : "other_name",
      pairs: scored.pairs,
      typedOnly: scored.typedOnly,
      listedOnly: scored.listedOnly,
      spacing: scored.spacing,
      rare: scored.rare,
      country: countryAgreement(country, entry.countries),
    };
  });
  return matches
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.country.kind === "agrees") - Number(a.country.kind === "agrees") ||
        Number(b.via === "name") - Number(a.via === "name") ||
        a.entry.number - b.entry.number
    )
    .slice(0, MATCHES_SHOWN);
}

/** Other names for a country, each as `countryKey` reads it, to the one the list's own name reads as (CV5). */
const COUNTRY_NAMES: Record<string, string> = {
  us: "unitedstates",
  usa: "unitedstates",
  unitedstatesofamerica: "unitedstates",
  america: "unitedstates",
  uk: "unitedkingdom",
  greatbritain: "unitedkingdom",
  britain: "unitedkingdom",
  england: "unitedkingdom",
  scotland: "unitedkingdom",
  wales: "unitedkingdom",
  northernireland: "unitedkingdom",
  uae: "unitedarabemirates",
  emirates: "unitedarabemirates",
  dprk: "northkorea",
  democraticpeoplesrepublicofkorea: "northkorea",
  republicofkorea: "southkorea",
  myanmar: "burma",
  myanmarburma: "burma",
  russianfederation: "russia",
  turkiye: "turkey",
  czechia: "czechrepublic",
  islamicrepublicofiran: "iran",
  syrianarabrepublic: "syria",
  drc: "democraticrepublicofthecongo",
  drcongo: "democraticrepublicofthecongo",
  congokinshasa: "democraticrepublicofthecongo",
  congobrazzaville: "republicofthecongo",
  hongkongsarchina: "hongkong",
  macao: "macau",
  macaosarchina: "macau",
  ivorycoast: "cotedivoire",
  republicofnorthmacedonia: "northmacedonia",
  capeverde: "caboverde",
  stkittsandnevis: "saintkittsandnevis",
  stvincentandgrenadines: "saintvincentandthegrenadines",
};

/** A region's English name from its two-letter code, as the browser knows it, or null. */
function regionName(code: string): string | null {
  try {
    const found = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(code.toUpperCase());
    return found ?? null;
  } catch {
    return null;
  }
}

/**
 * A country as compared (CV5): letters only, accents and case dropped, an inverted name read the usual way ("Korea,
 * North" is north korea), a leading "the" dropped, a two-letter code read as its country, and the other names in
 * `COUNTRY_NAMES`.
 */
export function countryKey(text: string, code = true): string {
  let key = folded(text).trim().replace(/^region:\s*/, "");
  const inverted = /^([^,]+),\s*(.+)$/.exec(key);
  if (inverted) key = `${inverted[2]} ${inverted[1]}`;
  const letters = key.replace(/^the\s+/, "").replace(/[^a-z]/g, "");
  if (COUNTRY_NAMES[letters]) return COUNTRY_NAMES[letters];
  if (code && /^[a-z]{2}$/.test(letters)) {
    const region = regionName(letters);
    if (region) return countryKey(region, false);
  }
  return letters;
}

/** Whether a country given agrees with an entry's countries (CV5). */
export function countryAgreement(given: string, listed: readonly string[]): CountryAgreement {
  if (given.trim() === "") return { kind: "not_given" };
  if (listed.length === 0) return { kind: "not_listed" };
  const key = countryKey(given);
  const found = listed.find((country) => countryKey(country) === key);
  return found ? { kind: "agrees", country: found } : { kind: "differs", listed: [...listed] };
}
