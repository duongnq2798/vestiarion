import { totalLineFigures } from "../invoice-document/extract";
import { nameKey } from "../invoice-document/match";
import { normalizeExtraction, rawExtractionSchema, type RawExtraction } from "../invoice-document/normalize";
import { emailDomainOf, readerNoteWords } from "./rules";
import { TOP_LEVEL_DOMAINS } from "./top-level-domains";

/**
 * Comparing a vendor's document with its bill (docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md DK4,
 * DK5): the model reads the document, never seeing the bill; code compares. Pure: the cycle's document checks stage
 * (src/lib/agent/document-checks.ts) hands it the document's text and both readings, and signs what it returns.
 *
 * Every value a reader gives is checked against the text first (`normalizeExtraction`, as for an invoice read from a
 * document). The vendor is found by code in the text, never taken from the model, since on a purchase order the issuer
 * is the buyer. The total and the purchase order must be the same for both readers, and a document that states two
 * different totals has none. Then, in order: the vendor, the currency, the amount to its last decimal, the purchase
 * order, the address it asks to be paid to, and the model's flag. The first that fails gives the reason, in Vestiarion's
 * own words: only the counterparty's name, a purchase order as the document or the vendor wrote it, decimal figures and
 * 0x hex go into a sentence, never other text from the document.
 *
 * The model's note, when it set one, is the one thing of its reading kept as it wrote it (DK4, amended 2026-10-26): a
 * person must see what it saw. It is model text about an untrusted document, so it is cleaned (`readerNoteOf`) and
 * quoted after the sentence as the reader's (`readerNoteWords`), never in Vestiarion's own words.
 */

/** The bill as the check compares it, read when it is checked. */
export interface CheckBill {
  /** The counterparty's name now: a renamed one is compared by its current name. */
  vendorName: string;
  /** Its billing email, whose domain names it when its name does not. */
  billingEmail: string | null;
  /** The bill's amount, as the database gives it. */
  amount: string | number;
  currency: "USDC" | "EURC";
  /** Its invoice number: evidence, never a reason to refuse. */
  memo: string | null;
  /** The purchase order on file, null when it has none. */
  poReference: string | null;
  /** Whether its counterparty needs a purchase order (three-way match M2). */
  purchaseOrderRequired: boolean;
  /** The counterparty's payment address on file. */
  addressOnFile: string | null;
}

/** What was read of the document. */
export interface DocumentReading {
  /** The document's text, as `readDocument` read it. */
  text: string;
  /** The model's reading, or the rule-based reader's with no model. */
  raw: RawExtraction;
  /** The rule-based reader's reading of the same text, which `decide()` always computes. */
  reference: RawExtraction;
  /** The purchase order the vendor typed beside the file: null for none, and for a member's attachment. */
  typedPo: string | null;
}

export type DocumentCheckName = "vendor" | "currency" | "amount" | "purchase_order" | "pay_to" | "invoice_number";

/** One check, as `document_checked` signs it: never the document's text, only the values compared. */
export interface DocumentCheck {
  check: DocumentCheckName;
  result: "match" | "mismatch" | "absent";
  /** What the document says: "name" or the domain found for the vendor; a plain decimal; a purchase order as written; an address. */
  document: string | null;
  /** What the bill says. */
  bill: string | null;
  /** The other reading, when a second one differs: the rule-based reader's, or another total or purchase order the text states. */
  alsoRead?: string;
}

export interface DocumentComparison {
  outcome: "matched" | "mismatched";
  /** The first failing check's sentence, with the reader's note quoted after it, within 300 characters; null when it matched. */
  reason: string | null;
  /**
   * That sentence whole, before any note: as `reason` begins, but naming the purchase orders where `reason` says it
   * shortly so the note fits in 300 characters (`Step.shortFailure`). For the ledger's summary and the decision trail,
   * which show the note apart. Null when it matched.
   */
  sentence: string | null;
  checks: DocumentCheck[];
  /** The purchase order the document names, as it writes it; null when it names none. */
  poReference: string | null;
  /** Whether a purchase order was compared: the bill lacked one, or has one. Not for a counterparty that needs none. */
  poCompared: boolean;
  /** The model set its note: something needs a person. */
  readerFlagged: boolean;
  /** That note, cleaned (`readerNoteOf`); null when the model set none, or one with nothing left once cleaned. */
  readerNote: string | null;
}

/** Why a document could not be read, as the card and the ledger say it (DK3). */
export const UNREADABLE_REASONS = {
  image: "It is an image. Only a PDF with its text is checked.",
  scan: "It is a PDF with no text to read, such as a scan.",
  too_large: "It is larger than 4 MB, the most Vestiarion reads.",
  unreadable: "This PDF could not be read.",
  changed: "The file kept is not the one received.",
  gone: "The file is no longer in storage.",
} as const;

/** Why a document was not checked at all (DK7, DK12). */
export const SKIPPED_REASONS = {
  not_waiting: "It was not checked: the bill no longer waited for a document.",
  same_file: "It was not checked: it is the same file as one already checked for this bill.",
  bill_moved: "It was not checked: the bill changed before the purchase order could be added.",
} as const;

/** The longest reason 0144's check_document_request takes. */
export const MAX_CHECK_REASON = 300;

/** The flag's own sentence, when no other check failed: as every flag recorded before the note was kept says it. */
export const READER_FLAGGED = "The reader flagged something in it for a person to check.";

/** The longest reader's note kept: after the flag's own sentence, a reason always quotes it whole. */
export const MAX_READER_NOTE = 200;

/**
 * The least of a note a reason quotes after a long sentence: with less room than this, the reason says the failing check's
 * short sentence instead (`Step.shortFailure`), after which the whole note fits.
 */
const MIN_NOTE_IN_REASON = 40;

const EMPTY: RawExtraction = rawExtractionSchema.parse({});
const MILLION = BigInt(1_000_000);
/** Part 1's purchase order rules (readDocumentFields): no control or format character, no line break, no link. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSEEN_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LINK = /:\/\/|www\./i;
const MAX_PO = 100;
/** A vendor's own name in a sentence; a longer one is called "the vendor", so no sentence passes 300 characters. */
const MAX_NAME_IN_REASON = 100;
/** Every 0x address the text writes: 40 hex digits, standing alone, so a transaction hash is not one. */
const ADDRESS = /(?<![0-9A-Za-z])0[xX][0-9a-fA-F]{40}(?![0-9A-Za-z])/g;

/**
 * Email providers anyone can have an address at: their domain names no vendor, so only a vendor's own domain counts.
 * Its name, matched first, is unaffected.
 */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "yandex.com",
  "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "naver.com",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A plain decimal of at most 6 places, or the database's number, as millionths; null for anything else. */
function microsOf(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const written = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? value.toFixed(6) : "") : value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(written);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(6))) return null;
  return BigInt(match[1]) * MILLION + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
}

/** Millionths as a plain decimal with 2 to 6 places, as `document_checked` records them: "5.00", "5.000001", "1250.50". */
function plainDecimal(micros: bigint): string {
  const fraction = (micros % MILLION).toString().padStart(6, "0").replace(/0+$/, "");
  return `${(micros / MILLION).toString()}.${fraction.padEnd(2, "0")}`;
}

/** Millionths as the app writes an amount, grouped, with 2 to 6 places: "1,250.50". */
function appAmount(micros: bigint): string {
  const [whole, fraction] = plainDecimal(micros).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

type Currency = "USDC" | "EURC";

/** A reader's currency as Vestiarion pays in it, by `normalizeExtraction`'s mapping: "foreign" for another, null for none. */
function currencyOf(value: string | null, text: string): Currency | "foreign" | null {
  if (value === null) return null;
  return normalizeExtraction({ ...EMPTY, currency: value }, text).fields.currency ?? "foreign";
}

/** A currency as `document_checked` records it: its code, or, for one Vestiarion does not pay in, a code of 3 or 4 letters only. */
function currencyRecord(read: Currency | "foreign" | null, written: string | null): string | null {
  if (read !== "foreign") return read;
  return written && /^[A-Za-z]{3,4}$/.test(written) ? written.toUpperCase() : null;
}

/** Where the text writes `value` standing alone, ignoring case: as the text spells it, or null. */
function standingAlone(text: string, value: string): string | null {
  const found = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, "i").exec(text);
  return found ? found[0] : null;
}

/**
 * A purchase order a reader gave or the vendor typed, as the document writes it: one that reads as a purchase order and
 * stands alone in the text (`normalizeExtraction`'s check, so "PO-104" is not in "PO-1042"), of at most 100 characters,
 * within part 1's rules. Null for anything else.
 */
function poInText(value: string | null, text: string): string | null {
  if (value === null || value.length > MAX_PO) return null;
  if (normalizeExtraction({ ...EMPTY, poReference: value }, text).fields.poReference === null) return null;
  const written = standingAlone(text, value);
  return written && !UNSEEN.test(written) && !LINK.test(written) ? written : null;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How the text names the vendor: "name", its billing domain, or null when it does not. */
function vendorNamed(bill: CheckBill, text: string): string | null {
  const key = nameKey(bill.vendorName);
  if (key.length >= 3 && ` ${nameKey(text)} `.includes(` ${key} `)) return "name";
  const domain = bill.billingEmail ? emailDomainOf(bill.billingEmail) : null;
  if (!domain || FREE_MAIL.has(domain)) return null;
  // The domain or one under it, as a whole word: not evil-cobaltcloud.example, nor cobaltcloud.example.evil.test.
  return new RegExp(`(?<![a-z0-9-])${escapeRegExp(domain)}(?![a-z0-9-]|\\.[a-z0-9])`).test(text.toLowerCase()) ? domain : null;
}

/** The vendor as a sentence names it: its own name, without a control or format character, or "the vendor" when very long. */
function vendorWords(name: string): string {
  const clean = name.replace(UNSEEN_ALL, "").replace(/\s+/g, " ").trim();
  return clean && Array.from(clean).length <= MAX_NAME_IN_REASON ? clean : "the vendor";
}

/** Characters, by code point, for a character class. */
const anyOf = (codes: number[]) => codes.map((code) => String.fromCodePoint(code)).join("");

/**
 * Removed from a reader's note: format characters (bidi controls such as U+202E, zero-width ones, U+FEFF), other
 * default-ignorable ones (variation selectors, U+034F, Hangul fillers, tag characters), the blank U+2800, private-use and
 * unassigned code points, and half a surrogate pair. None shows, so text spelled in them would reach a program reading
 * the note and never the person reading the card.
 */
const NOTE_INVISIBLE = new RegExp(`[${/\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}/u.source}${anyOf([0x2800])}]`, "gu");
/** A line or a tab in a reader's note: one space. */
const NOTE_BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/** More than two marks on one letter, which stack above or below its line and paint over the text around it: two kept. */
const NOTE_MARKS = /(\p{M}{2})\p{M}+/gu;
const LINK_REMOVED = "(link removed)";
/**
 * An HTML character reference, which a Markdown or HTML reader turns into its character: `&#58;` and `&colon;` into ":",
 * so `https&#58;//` opens as `https://`. A named one only with its ";", so R&D, AT&T and Q&A stay.
 */
const NOTE_ENTITY = /&(?:#\d+;?|#x[0-9a-f]+;?|[a-z][a-z0-9]*;)/gi;
/**
 * A Markdown link or image, whatever its destination (`//host`, `ethereum:`, `ms-msdt:`, an IPv6 address), and an
 * autolink in angle brackets with any scheme. With no closing parenthesis too, so a link the note's length cut still goes.
 */
const NOTE_MARKDOWN_LINK = /!?\[[^\]]*\]\([^)]*\)?|<[a-z][a-z0-9+.-]{1,31}:[^\s<>]*>/gi;
/**
 * A link a person might open from the card, or a chat tool a note is sent to would: one with a scheme (`https://`, one
 * such as `javascript:` or `ethereum:` written without slashes, `data:` before a media type and `file:` before a path),
 * one starting `//`, as a Markdown reader opens it, or one starting `www.`, up to the next space, less the punctuation
 * that ends a sentence after it.
 */
const NOTE_LINK =
  /(?:[a-z][a-z0-9+.-]*:\/\/|(?<![\w:\/])\/\/(?=[^\s\/])|\b(?:javascript|vbscript|blob|mailto|tel|sms|intent|ethereum|bitcoin):(?=\S)|\bdata:(?=[a-z]+\/[\w.+-]+[;,]|,)|\bfile:(?=\/)|www\.)(?:\S*[^\s.,;:!?'"])?/gi;
/** A domain name's dot: ".", or an ideographic full stop (U+3002, U+FF61), which a browser reads as one. */
const SEP = `[${anyOf([0x2e, 0x3002, 0xff61])}]`;
const NOTE_EMAIL = new RegExp(`[^\\s@]+@[^\\s@]+${SEP}[^\\s@]+`, "gu");
/** A domain name's label, in any script. */
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_-]*[\p{L}\p{N}\p{M}])?`;
/**
 * A name's last label as a top-level domain might be written: in ASCII (xn--p1ai) or in letters of a script that spaces
 * its words. Not in Han, kana, Thai, Lao, Khmer or Myanmar, written without spaces, where a full stop before a word
 * would read every Japanese or Chinese sentence as a domain.
 */
const TLD = String.raw`xn--[a-z0-9-]{1,59}|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}])[\p{L}\p{M}]){2,63}`;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
/**
 * A link written without a scheme, which a chat tool or a browser links all the same: a name of two or more labels in
 * any script, with fullwidth or ideographic dots too (NFKC, then `SEP`), or an IPv4 address, with any port and path.
 * Found wherever it does not follow a letter, a digit or a mark, so a "-", "/", ".", "@" or "_" before it is no
 * shelter, and ends before another label, a letter or a digit. A name is a link only when a label of it is a top-level
 * domain (`withoutHost`), so St.Louis and receipt.tiff stay; an amount such as 1.234.567,00 or 999.999.999.999 is no
 * address. After `NOTE_EMAIL`, so an email address is replaced whole.
 */
const NOTE_BARE_HOST = new RegExp(
  String.raw`(?<![\p{L}\p{N}\p{M}])(?:(?<host>(?:${LABEL}${SEP})+(?:${TLD}))|${OCTET}(?:${SEP}${OCTET}){3}(?!,\d))(?![\p{L}\p{N}\p{M}]|[-_][\p{L}\p{N}]|${SEP}[\p{L}\p{N}])(?::\d{1,5})?(?:\/(?:\S*[^\s.,;:!?'"])?)?`,
  "giu"
);
const LABEL_SEP = new RegExp(SEP, "u");
/**
 * A token: 32 or more letters, digits, "_", "-", "+", "/" or "=" in a row, such as a link's token or an API key; never
 * 0x hex alone, an address or a transaction hash, which a note may name.
 */
const NOTE_TOKEN = /(?<![\w+\/=-])(?!0[xX][0-9a-fA-F]+(?![\w+\/=-]))[\w+\/=-]{32,}(?![\w+\/=-])/g;
/**
 * Every character that reads as a double quotation mark, so a note could close its quote with it: straight, curly,
 * low and angle quotation marks, double, triple and quadruple primes and modifier double primes, the diaeresis and the
 * double acute, the ditto marks, gershayim, the Yiddish double yod, ornaments, fullwidth. Each becomes "'" on its own.
 */
const NOTE_DOUBLE_LIKE = [
  0x22, 0xa8, 0xab, 0xbb, 0x2ba, 0x2dd, 0x2ee, 0x2f5, 0x2f6, 0x30b, 0x5f2, 0x5f4, 0x1cd3, 0x201c, 0x201d, 0x201e, 0x201f,
  0x2033, 0x2034, 0x2036, 0x2037, 0x2057, 0x275d, 0x275e, 0x2760, 0x2e42, 0x3003, 0x301d, 0x301e, 0x301f, 0xff02, 0x1f676,
  0x1f677, 0x1f678,
];
/**
 * Characters that read as a single quotation mark, an apostrophe or a prime, beside every quotation mark Unicode names:
 * the backtick and the acute accent, modifier primes and apostrophes, the Greek, Armenian, NKo, runic and Hebrew ones
 * (geresh), primes, heavy ornaments, the saltillo, fullwidth. One alone stays, as an apostrophe in a word does.
 */
const NOTE_SINGLE_LIKE = [
  0x60, 0xb4, 0x2b9, 0x2bb, 0x2bc, 0x2bd, 0x2c8, 0x2ca, 0x2cb, 0x374, 0x384, 0x55a, 0x5f3, 0x7f4, 0x7f5, 0x16cc, 0x1fbd,
  0x1fbf, 0x1fef, 0x1ffd, 0x1ffe, 0x2032, 0x2035, 0x275b, 0x275c, 0x275f, 0xa78b, 0xa78c, 0xff40,
];
const NOTE_DOUBLE_QUOTE = new RegExp(`[${anyOf(NOTE_DOUBLE_LIKE)}]`, "gu");
/**
 * Two or more quote-like or prime-like characters in a row, of any kind and mixed, which read together as a double
 * quotation mark: one "'".
 */
const NOTE_SINGLE_RUN = new RegExp(`[\\p{Quotation_Mark}${anyOf([...NOTE_SINGLE_LIKE, ...NOTE_DOUBLE_LIKE])}]{2,}`, "gu");

/** No character of a note that reads as a double quotation mark: each one, and each run of single ones, as "'". */
const withoutDoubleQuotes = (value: string) => value.replace(NOTE_DOUBLE_QUOTE, "'").replace(NOTE_SINGLE_RUN, "'");

/** Whether a label is a top-level domain of the root zone, written in ASCII or in its own script (as xn--p1ai is). */
function isTopLevelDomain(label: string): boolean {
  const lower = label.toLowerCase();
  if (TOP_LEVEL_DOMAINS.has(lower)) return true;
  if (/^[a-z0-9-]*$/.test(lower)) return false;
  try {
    // Its ASCII form, as a browser's address bar gives it.
    return TOP_LEVEL_DOMAINS.has(new URL(`http://${lower}/`).hostname);
  } catch {
    return false;
  }
}

/**
 * A name `NOTE_BARE_HOST` found, as the note keeps it: "(link removed)" when its last label is a top-level domain, or an
 * IPv4 address. When its last label is none, as in evil.com.Thanks, the name up to its last label that is one is
 * removed and the rest kept; with none, it is kept whole. What it keeps is looked at again, so Mr.Smith/evil.com loses
 * evil.com.
 */
function withoutHost(found: string, ...rest: unknown[]): string {
  const host = (rest[rest.length - 1] as { host?: string }).host;
  if (host === undefined) return LINK_REMOVED;
  const labels = host.split(LABEL_SEP);
  if (isTopLevelDomain(labels[labels.length - 1])) return LINK_REMOVED;
  const restOf = (end: number) => found.slice(end).replace(NOTE_BARE_HOST, withoutHost);
  for (let index = labels.length - 2; index >= 1; index -= 1) {
    // Each dot is one UTF-16 unit, so the labels and their dots give where the name ends.
    if (isTopLevelDomain(labels[index])) return `${LINK_REMOVED}${restOf(labels.slice(0, index + 1).join(".").length)}`;
  }
  return `${host}${restOf(host.length)}`;
}

/** At most `max` characters, cut by whole characters with "..." when longer. */
function capped(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : `${characters.slice(0, max - 3).join("").trimEnd()}...`;
}

/**
 * The model's note as the card, the ledger and 0144 keep it (DK4, amended 2026-10-26), stricter than **From a document**'s
 * `modelNote`: no format, default-ignorable, private-use or unassigned character (`NOTE_INVISIBLE`, first, so nothing
 * hidden splits a link or a token); no double quotation mark or character that reads as one, nor a run of quote-like or
 * prime-like characters (each becomes "'"); in NFKC, so fullwidth letters and dots read as a browser reads them; at most
 * two marks on a letter; control characters and line breaks as spaces, one line; HTML character references as spaces; a
 * link (`NOTE_MARKDOWN_LINK`, `NOTE_LINK`, then `NOTE_BARE_HOST`: in Markdown, with a scheme, from // or www., a domain
 * name or an IPv4 address), an email address and a token replaced; whitespace collapsed; at most 200 characters. Null
 * when nothing is left.
 */
export function readerNoteOf(notes: string | null): string | null {
  if (notes === null) return null;
  // The quotation marks before NFKC, which turns an acute accent or a diaeresis into a space and a mark.
  const visible = withoutDoubleQuotes(notes.replace(NOTE_INVISIBLE, ""))
    .normalize("NFKC")
    .replace(NOTE_INVISIBLE, "")
    .replace(NOTE_MARKS, "$1")
    .replace(NOTE_BREAK, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Far more than is kept, and little enough that no pattern below takes long on a model's longest answer.
  const clean = withoutDoubleQuotes(
    Array.from(visible)
      .slice(0, 10 * MAX_READER_NOTE)
      .join("")
      .replace(NOTE_ENTITY, " ")
      .replace(NOTE_MARKDOWN_LINK, LINK_REMOVED)
      .replace(NOTE_LINK, LINK_REMOVED)
      .replace(NOTE_EMAIL, "(email address removed)")
      .replace(NOTE_BARE_HOST, withoutHost)
      .replace(NOTE_TOKEN, "(token removed)")
  )
    .replace(/\s+/g, " ")
    .trim();
  return clean ? capped(clean, MAX_READER_NOTE) : null;
}

/**
 * A reason with the reader's note quoted after its sentence, within 300 characters: whole when it fits, cut to fit with
 * "..." when at least 40 characters of it do, else after the failing check's `short` sentence, which names no purchase
 * order or name and leaves room for the whole note. So a reason that quotes a note always shows it on the card.
 */
function withReaderNote(sentence: string, short: string, note: string | null): string {
  if (note === null) return sentence;
  const roomAfter = (lead: string) => MAX_CHECK_REASON - Array.from(lead).length - Array.from(` ${readerNoteWords("")}`).length;
  const fits = (lead: string) => Array.from(note).length <= roomAfter(lead) || roomAfter(lead) >= MIN_NOTE_IN_REASON;
  const lead = fits(sentence) ? sentence : short;
  // Every sentence leaves 40 characters or has a short one under 80; should one ever not, the reason stays within 300.
  if (!fits(lead)) return sentence;
  return `${lead} ${readerNoteWords(capped(note, roomAfter(lead)))}`;
}

/** A reason as 0144 takes it: no control or format character, at most 300 characters. */
export function checkReasonOf(reason: string): string {
  return Array.from(reason.replace(UNSEEN_ALL, " ").replace(/\s+/g, " ").trim()).slice(0, MAX_CHECK_REASON).join("");
}

interface Step {
  record: DocumentCheck;
  /** The sentence when this check fails; null when it passes. */
  failure: string | null;
  /**
   * The same failure said shortly, naming no purchase order or name, for a reason whose sentence leaves too little room
   * for the reader's note (`withReaderNote`); the values stay in `record`. Only for a sentence that can run long.
   */
  shortFailure?: string;
}

/** The purchase order checks' short sentences: each sentence of theirs names up to two purchase orders of 100 characters. */
const PO_SHORT = {
  typed: "The purchase order the vendor typed is not in the document.",
  several: "The document names more than one purchase order.",
  other: "The document names another purchase order than the bill's.",
} as const;

function vendorCheck(bill: CheckBill, text: string, vendor: string): Step {
  const named = vendorNamed(bill, text);
  return {
    record: { check: "vendor", result: named ? "match" : "absent", document: named, bill: bill.vendorName },
    failure: named ? null : `The document does not name ${vendor}.`,
  };
}

function currencyCheck(bill: CheckBill, reading: DocumentReading): Step & { read: Currency | null } {
  const { text, raw, reference } = reading;
  const model = currencyOf(raw.currency, text);
  const rule = currencyOf(reference.currency, text);
  const read = model ?? rule;
  const written = model !== null ? raw.currency : reference.currency;
  // A second reader that names another currency: the document does not say one clearly.
  const other = model !== null && rule !== null && rule !== model ? rule : null;
  const record: DocumentCheck = {
    check: "currency",
    result: read === null ? "absent" : read === bill.currency && other === null ? "match" : "mismatch",
    document: currencyRecord(read, written),
    bill: bill.currency,
    ...(other !== null ? { alsoRead: currencyRecord(other, reference.currency) ?? "other" } : {}),
  };
  const sentence = (currency: Currency | "foreign") =>
    currency === "foreign" ? "The document's total is not in USDC or EURC." : `The document's total is in ${currency}; the bill is in ${bill.currency}.`;
  const failure =
    read === null
      ? "The document does not say which currency its total is in."
      : read !== bill.currency
        ? sentence(read)
        : other !== null
          ? sentence(other)
          : null;
  return { record, failure, read: read === "USDC" || read === "EURC" ? read : null };
}

function amountCheck(bill: CheckBill, reading: DocumentReading, currency: Currency | null): Step {
  const { text, raw, reference } = reading;
  const model = microsOf(normalizeExtraction(raw, text).fields.amount);
  const rule = microsOf(normalizeExtraction(reference, text).fields.amount);
  // Each line that states what is due, read the way the rule-based reader reads one: two different ones leave no clear
  // total, whichever a reader took, so a total slipped in after the real one cannot pass for it.
  const stated = totalLineFigures(text)
    .map((figure) => microsOf(normalizeExtraction({ ...EMPTY, amount: figure }, text).fields.amount))
    .filter((figure): figure is bigint => figure !== null);
  const total = model ?? rule;
  const billAmount = microsOf(bill.amount);
  const other = total === null ? null : ([rule, ...stated].find((figure) => figure !== null && figure !== total) ?? null);
  const record: DocumentCheck = {
    check: "amount",
    result: total === null ? "absent" : other === null && billAmount !== null && total === billAmount ? "match" : "mismatch",
    document: total === null ? null : plainDecimal(total),
    bill: billAmount === null ? null : plainDecimal(billAmount),
    ...(other !== null ? { alsoRead: plainDecimal(other) } : {}),
  };
  if (total === null) return { record, failure: "The document does not state a total." };
  if (other !== null) return { record, failure: `The document's total is unclear: it reads both ${appAmount(total)} and ${appAmount(other)}.` };
  if (billAmount === null || total !== billAmount) {
    const billWords = billAmount === null ? "another amount" : appAmount(billAmount);
    return { record, failure: `The document says ${appAmount(total)} ${currency ?? bill.currency}; the bill says ${billWords} ${bill.currency}.` };
  }
  return { record, failure: null };
}

function purchaseOrderCheck(bill: CheckBill, reading: DocumentReading, vendor: string): { step: Step | null; poReference: string | null } {
  const { text, raw, reference, typedPo } = reading;
  const model = poInText(raw.poReference, text);
  const rule = poInText(reference.poReference, text);
  const read = model ?? rule;
  const onFile = bill.poReference?.trim() || null;

  // The bill has one on file: the document may name none, as a delivery note may, but never another.
  if (onFile !== null) {
    const differs = [model, rule].find((po): po is string => po !== null && !same(po, onFile)) ?? null;
    return {
      poReference: differs ?? read,
      step: {
        record: { check: "purchase_order", result: differs ? "mismatch" : read ? "match" : "absent", document: differs ?? read, bill: onFile },
        failure: differs ? `The document names purchase order ${differs}; the bill's is ${onFile}.` : null,
        shortFailure: PO_SHORT.other,
      },
    };
  }
  // A counterparty that needs none: what the document names is recorded, and nothing is compared.
  if (!bill.purchaseOrderRequired) return { poReference: read, step: null };

  // The bill lacks one. The vendor's own, when it typed one, must be in the document, and be the one the model read.
  const typed = typedPo?.trim() || null;
  if (typed !== null) {
    const written = poInText(typed, text);
    if (!written) {
      return {
        poReference: read,
        step: {
          record: { check: "purchase_order", result: "mismatch", document: read, bill: null },
          failure: `The purchase order ${vendor} typed, ${typed}, is not in the document.`,
          shortFailure: PO_SHORT.typed,
        },
      };
    }
    if (model !== null && !same(model, written)) {
      return {
        poReference: written,
        step: {
          record: { check: "purchase_order", result: "mismatch", document: written, bill: null, alsoRead: model },
          failure: `The document names more than one purchase order: ${written} and ${model}.`,
          shortFailure: PO_SHORT.several,
        },
      };
    }
    return { poReference: written, step: { record: { check: "purchase_order", result: "match", document: written, bill: null }, failure: null } };
  }
  if (model !== null && rule !== null && !same(model, rule)) {
    return {
      poReference: model,
      step: {
        record: { check: "purchase_order", result: "mismatch", document: model, bill: null, alsoRead: rule },
        failure: `The document names more than one purchase order: ${model} and ${rule}.`,
        shortFailure: PO_SHORT.several,
      },
    };
  }
  if (read === null) {
    return { poReference: null, step: { record: { check: "purchase_order", result: "absent", document: null, bill: null }, failure: "The document does not name a purchase order." } };
  }
  return { poReference: read, step: { record: { check: "purchase_order", result: "match", document: read, bill: null }, failure: null } };
}

function payToCheck(bill: CheckBill, text: string): Step {
  const onFile = bill.addressOnFile;
  const written = [...text.matchAll(ADDRESS)].map(([address]) => address);
  const elsewhere = written.find((address) => onFile === null || address.toLowerCase() !== onFile.toLowerCase()) ?? null;
  return {
    record: { check: "pay_to", result: written.length === 0 ? "absent" : elsewhere ? "mismatch" : "match", document: elsewhere ?? written[0] ?? null, bill: onFile },
    failure: elsewhere
      ? onFile
        ? `The document asks to be paid to ${elsewhere}, not the address on file.`
        : `The document asks to be paid to ${elsewhere}, and there is no address on file.`
      : null,
  };
}

function invoiceNumberCheck(bill: CheckBill, text: string): DocumentCheck {
  const memo = bill.memo?.trim() || null;
  const written = memo ? standingAlone(text, memo) : null;
  return { check: "invoice_number", result: written ? "match" : "absent", document: written, bill: memo };
}

/** The comparison (DK4, DK5): see the module comment. */
export function compareDocument(bill: CheckBill, reading: DocumentReading): DocumentComparison {
  const vendor = vendorWords(bill.vendorName);
  const vendorStep = vendorCheck(bill, reading.text, vendor);
  const currencyStep = currencyCheck(bill, reading);
  const amountStep = amountCheck(bill, reading, currencyStep.read);
  const po = purchaseOrderCheck(bill, reading, vendor);
  const payToStep = payToCheck(bill, reading.text);
  // Set only when something needs a person: figures that do not add up, a changed address, or instructions to the reader.
  const readerFlagged = reading.raw.notes !== null;
  const readerNote = readerNoteOf(reading.raw.notes);
  const steps = [vendorStep, currencyStep, amountStep, ...(po.step ? [po.step] : []), payToStep];
  const failed = steps.find((step) => step.failure !== null);
  const failure = failed?.failure ?? (readerFlagged ? READER_FLAGGED : null);
  return {
    outcome: failure === null ? "matched" : "mismatched",
    // Vestiarion's sentence, then what the reader noted, quoted as the reader's.
    reason: failure === null ? null : withReaderNote(checkReasonOf(failure), checkReasonOf(failed?.shortFailure ?? failure), readerNote),
    sentence: failure === null ? null : checkReasonOf(failure),
    checks: [...steps.map((step) => step.record), invoiceNumberCheck(bill, reading.text)],
    poReference: po.poReference,
    poCompared: po.step !== null,
    readerFlagged,
    readerNote,
  };
}
