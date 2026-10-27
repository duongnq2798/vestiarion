/**
 * The memo an imported bill is added with (import design B9): its invoice number in front, so the number stays with the
 * bill. Pure: the import writes it, and the free bill list check compares bills by it as the agent would once they are
 * added (docs/superpowers/specs/2026-10-28-check-bills-design.md CB5).
 */

/** A memo that starts with the bill's invoice number, unless it holds it already (B9). */
export function memoWithInvoiceNumber(invoiceNumber: string | null, memo: string | null): string | null {
  if (!invoiceNumber) return memo || null;
  if (memo && hasWord(memo, invoiceNumber)) return memo;
  return memo ? `Invoice ${invoiceNumber}: ${memo}` : `Invoice ${invoiceNumber}`;
}

/** A letter or a digit in any script, at the end of the text before a match, or at the start of the text after it. */
const WORD_BEFORE = /[\p{L}\p{N}]$/u;
const WORD_AFTER = /^[\p{L}\p{N}]/u;

/**
 * Whether `text` holds `word` whole, without regard to case: "INV-7" is in "Invoice INV-7: Hosting", not in "INV-77".
 * Every place the word starts is looked at, overlapping ones too. The letter classes are built once: a pattern built for
 * each call with them in it takes most of a millisecond, too slow for the free bill list check's 5,000 bills (CB5).
 */
export function hasWord(text: string, needle: string): boolean {
  const escaped = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (escaped === "") return false;
  for (const match of text.matchAll(new RegExp(`(?=(${escaped}))`, "giu"))) {
    if (!WORD_BEFORE.test(text.slice(0, match.index)) && !WORD_AFTER.test(text.slice(match.index + match[1].length))) return true;
  }
  return false;
}
