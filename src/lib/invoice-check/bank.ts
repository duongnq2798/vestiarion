/**
 * The bank details an invoice gives, read as the invoice details check reads them
 * (docs/superpowers/specs/2026-11-05-check-invoice-design.md IC3): an IBAN's country, length and check digits, a US
 * routing number's check digit, a UK sort code, a SWIFT / BIC's form, and an account number or phone number as the
 * characters that matter. Pure and run in the browser, so nothing typed leaves the page.
 */

/** A character nobody sees that a copy can carry: a format character, such as a zero-width space or a direction mark. */
const HIDDEN = /\p{Cf}/u;

const codePoint = (character: string) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** The first hidden character in `text`, as "U+200B", or null. */
export function hiddenCharacter(text: string): string | null {
  const found = [...text].find((character) => HIDDEN.test(character));
  return found ? codePoint(found) : null;
}

/** Each country's IBAN length, from the SWIFT IBAN registry. */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22,
  GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30,
  KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20,
  MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

export type Read<T> = { ok: true; value: T; note?: string } | { ok: false; message: string };

/** Spaces, hyphens and dashes a printed IBAN, account or code is written with, removed, in capitals. */
const compact = (text: string) => text.replace(/[\s\p{Zs}\p{Pd}]+/gu, "").toUpperCase();

/** A label typed before the value, as a record or an invoice writes it: "Sort code: 12-34-56", "ABA 021000021". */
const LABEL =
  /^\s*(?:iban|sort\s*code|routing(?:\s*(?:number|no\.?|#))?|aba(?:\s*(?:number|no\.?|#))?|account(?:\s*(?:number|no\.?|#))?|acct(?:\s*(?:no\.?|#))?|a\/c(?:\s*no\.?)?|swift(?:\s*(?:code|\/\s*bic))?|bic(?:\s*code)?)\s*(?:[:#.]\s*|\s+)/i;

/** A value with its label, if any, taken off. */
const unlabelled = (text: string) => text.trim().replace(LABEL, "");

/** ISO 7064 mod 97-10 over an IBAN moved to put its first four characters last, letters as 10 to 35. */
function mod97(iban: string): number {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const character of moved) {
    const value = character >= "A" ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest;
}

export interface Iban {
  /** Without spaces, in capitals. */
  iban: string;
  country: string;
}

/** An IBAN as typed, with or without spaces and an "IBAN" before it (IC3). */
export function readIban(raw: string): Read<Iban> {
  const hidden = hiddenCharacter(raw);
  if (hidden) return { ok: false, message: `It contains a character you cannot see (${hidden}). Copy it again from where you got it.` };
  const iban = compact(unlabelled(raw));
  if (!/^[A-Z]{2}/.test(iban)) return { ok: false, message: "An IBAN starts with its country's two letters, such as DE or GB." };
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    return { ok: false, message: "An IBAN is its country's two letters, two check digits, then letters and digits only." };
  }
  const country = iban.slice(0, 2);
  const length = IBAN_LENGTHS[country];
  if (length !== undefined && iban.length !== length) {
    return { ok: false, message: `An IBAN from ${country} has ${length} characters; this one has ${iban.length}. One may have been lost or added.` };
  }
  if (length === undefined && (iban.length < 15 || iban.length > 34)) {
    return { ok: false, message: `An IBAN has 15 to 34 characters; this one has ${iban.length}.` };
  }
  if (mod97(iban) !== 1) return { ok: false, message: "Its check digits do not match the rest, so a character was mistyped or changed." };
  return { ok: true, value: { iban, country }, note: length === undefined ? `Its length is not checked for ${country}.` : undefined };
}

/** An IBAN written in groups of four, as banks print it. */
export function groupIban(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, "$1 ");
}

export type RoutingCode = { kind: "aba"; code: string } | { kind: "sort"; code: string } | { kind: "other"; code: string };

/** The ABA check digit: 3, 7 and 1 times the digits in turn add up to a multiple of 10. */
function abaValid(digits: string): boolean {
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return [...digits].reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) % 10 === 0;
}

/** A routing number, a sort code or another bank code (IC3). */
export function readRoutingCode(raw: string): Read<RoutingCode> {
  const hidden = hiddenCharacter(raw);
  if (hidden) return { ok: false, message: `It contains a character you cannot see (${hidden}). Copy it again from where you got it.` };
  const code = compact(unlabelled(raw));
  if (/^[0-9]{9}$/.test(code)) {
    if (!abaValid(code)) return { ok: false, message: "As a US routing number, its check digit does not match, so a digit was mistyped or changed." };
    return { ok: true, value: { kind: "aba", code } };
  }
  if (/^[0-9]{6}$/.test(code)) return { ok: true, value: { kind: "sort", code: `${code.slice(0, 2)}-${code.slice(2, 4)}-${code.slice(4)}` } };
  if (code === "") return { ok: false, message: "It has no letters or digits." };
  return { ok: true, value: { kind: "other", code } };
}

export interface Bic {
  bic: string;
  bank: string;
  country: string;
}

/** A SWIFT / BIC code: 4 letters for the bank, 2 for the country, 2 for the place, and 3 for a branch if any (IC3). */
export function readBic(raw: string): Read<Bic> {
  const hidden = hiddenCharacter(raw);
  if (hidden) return { ok: false, message: `It contains a character you cannot see (${hidden}). Copy it again from where you got it.` };
  const bic = compact(unlabelled(raw));
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic)) {
    return { ok: false, message: "A SWIFT / BIC code has 8 or 11 characters: 4 letters for the bank, 2 for its country, then 2 and maybe 3 more." };
  }
  return { ok: true, value: { bic, bank: bic.slice(0, 4), country: bic.slice(4, 6) } };
}

/** Whether two BICs name one branch: an 8-character code is its bank's head office, written XXX as 11. */
export function sameBic(a: Bic, b: Bic): boolean {
  const full = (bic: string) => (bic.length === 8 ? `${bic}XXX` : bic);
  return full(a.bic) === full(b.bic);
}

/** An account number as its letters and digits (IC3). */
export function readAccount(raw: string): Read<string> {
  const hidden = hiddenCharacter(raw);
  if (hidden) return { ok: false, message: `It contains a character you cannot see (${hidden}). Copy it again from where you got it.` };
  const account = compact(unlabelled(raw)).replace(/[^A-Z0-9]/g, "");
  if (account === "") return { ok: false, message: "It has no letters or digits." };
  return { ok: true, value: account };
}

/** A phone number's digits. */
export function phoneDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

/**
 * Whether two phone numbers are one (IC3): the same digits, or, when both have at least 9, the same last 9, so
 * "+44 20 7946 0958" and "020 7946 0958" are one number written with and without its country code.
 */
export function samePhone(a: string, b: string): boolean {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (x === y) return true;
  return x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9);
}
