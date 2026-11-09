/**
 * Text someone outside the workspace wrote, as a page shows it (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL12): a counterparty's name, a lookalike's name, a milestone's title, an invoice's number and memo, a document request's
 * note and purchase order number, a captured draft's fields. Pure. The character classes are shared with the reader's note of a document check
 * (src/lib/document-requests/check.ts), so both drop the same characters. Each is global: use it with `replace`.
 */

/**
 * Removed: format characters (bidi controls such as U+202E, zero-width ones, U+FEFF), other default-ignorable ones
 * (variation selectors, U+034F, Hangul fillers, tag characters), the blank U+2800, private-use and unassigned code
 * points, and half a surrogate pair. None shows, so text spelled in them would reach a program reading it and never the
 * person reading the page, and a bidi control would turn the words around it.
 */
export const NOTE_INVISIBLE = new RegExp(`[${/\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}/u.source}${String.fromCodePoint(0x2800)}]`, "gu");
/** A line break, a tab or another control character: one space. */
export const NOTE_BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/** More than two marks on one letter, which stack above or below its line and paint over the text around it: two kept. */
export const NOTE_MARKS = /(\p{M}{2})\p{M}+/gu;

/**
 * CL12: the text with nothing invisible in it (`NOTE_INVISIBLE`), its breaks as spaces (`NOTE_BREAK`), at most two marks
 * on a letter (`NOTE_MARKS`), each run of spaces as one, trimmed, and at most `max` characters, cut with "…". Empty when
 * nothing visible is left.
 */
export function visibleText(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return cut(text.replace(NOTE_INVISIBLE, "").replace(NOTE_MARKS, "$1").replace(NOTE_BREAK, " ").replace(/\s+/g, " ").trim(), max);
}

/** A line break: `\n`, `\r\n` or `\r`, or a line or paragraph separator (U+2028, U+2029). */
const LINE_END = /\r\n?|[\n\p{Zl}\p{Zp}]/u;

/**
 * CL12: text that keeps its lines, such as the note a vendor typed beside a document: each line as `visibleText` leaves
 * it, a line with nothing visible left out, the lines joined by `\n`, and at most `max` characters in all, cut with "…".
 * Only a line break (`LINE_END`) ends a line; any other control character, a tab among them, is a space within it.
 * Empty when nothing visible is left.
 */
export function visibleLines(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return cut(
    text
      .split(LINE_END)
      .map((line) => visibleText(line, Number.POSITIVE_INFINITY))
      .filter(Boolean)
      .join("\n"),
    max
  );
}

/** At most `max` whole characters, the last of them "…" when the text is longer. */
function cut(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  return `${characters.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}
