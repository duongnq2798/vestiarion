import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readerNoteOf } from "@/lib/document-requests/check";
import { NOTE_BREAK, NOTE_INVISIBLE, NOTE_MARKS, visibleText } from "@/lib/visible-text";

/**
 * Text someone outside the workspace wrote, as a page shows it (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL12): nothing invisible, one line, at most two marks on a letter, cut to fit. The document check's reader note drops the
 * same characters, from the same classes. Every character below is written by its code point, so none hides in this file.
 */

const at = (...codes: number[]) => String.fromCodePoint(...codes);

describe("visibleText", () => {
  it("CL12: drops format characters: bidi controls, zero-width ones and the byte order mark", () => {
    for (const code of [0x202e, 0x202a, 0x2066, 0x2069, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x00ad]) {
      expect(visibleText(`Acme${at(code)} Ltd`, 80), code.toString(16)).toBe("Acme Ltd");
    }
  });

  it("CL12: drops other default-ignorable characters: variation selectors, the combining grapheme joiner, Hangul fillers, tags", () => {
    for (const code of [0xfe0f, 0x034f, 0x115f, 0x3164, 0xffa0, 0xe0041, 0xe007f]) {
      expect(visibleText(`Acme${at(code)}`, 80), code.toString(16)).toBe("Acme");
    }
  });

  it("CL12: drops the blank U+2800, private-use and unassigned code points, and half a surrogate pair", () => {
    expect(visibleText(`Ac${at(0x2800)}me`, 80)).toBe("Acme");
    expect(visibleText(`Ac${at(0xe000)}me${at(0xf8ff)}${at(0x10fffd)}`, 80)).toBe("Acme");
    expect(visibleText(`Ac${at(0x0378)}me${at(0xfffe)}`, 80)).toBe("Acme");
    expect(visibleText(`Ac${String.fromCharCode(0xd800)}me${String.fromCharCode(0xdc00)}`, 80)).toBe("Acme");
  });

  it("CL12: turns line breaks, tabs and other control characters into spaces, one line", () => {
    expect(visibleText("Acme\nLtd", 80)).toBe("Acme Ltd");
    expect(visibleText("Acme\r\n\tLtd", 80)).toBe("Acme Ltd");
    expect(visibleText(`Acme${at(0x2028)}Ltd${at(0x2029)}Inc`, 80)).toBe("Acme Ltd Inc");
    expect(visibleText(`Acme${at(0x0007)}${at(0x007f)}${at(0x0085)}Ltd`, 80)).toBe("Acme Ltd");
    expect(visibleText("  Acme   Ltd  ", 80)).toBe("Acme Ltd");
  });

  it("CL12: keeps at most two combining marks in a row", () => {
    const acute = at(0x0301);
    const below = at(0x0323);
    expect(visibleText(`e${acute}`, 80)).toBe(`e${acute}`);
    expect(visibleText(`e${acute}${below}`, 80)).toBe(`e${acute}${below}`);
    expect(visibleText(`e${acute}${below}${acute}${below}${acute} Ltd`, 80)).toBe(`e${acute}${below} Ltd`);
    // A hidden character between marks does not let more through.
    expect(visibleText(`e${acute}${at(0x200b)}${below}${at(0x200b)}${acute}`, 80)).toBe(`e${acute}${below}`);
  });

  it("CL12: keeps what a person sees: letters of any script, accents, emoji, a middle dot", () => {
    expect(visibleText("Société Générale · Zürich", 80)).toBe("Société Générale · Zürich");
    expect(visibleText(`${at(0x6771, 0x4eac)} ${at(0x0645, 0x0631, 0x062d, 0x0628, 0x0627)}`, 80)).toBe(`${at(0x6771, 0x4eac)} ${at(0x0645, 0x0631, 0x062d, 0x0628, 0x0627)}`);
    expect(visibleText(`Bakery ${at(0x1f950)}`, 80)).toBe(`Bakery ${at(0x1f950)}`);
  });

  it("CL12: cuts at max characters with an ellipsis, by whole characters", () => {
    expect(visibleText("Northwind Traders", 17)).toBe("Northwind Traders");
    expect(visibleText("Northwind Traders", 10)).toBe("Northwind…");
    expect(Array.from(visibleText("Northwind Traders", 10))).toHaveLength(10);
    // No space before the ellipsis, and an emoji is never cut in half.
    expect(visibleText("Northwind Traders", 11)).toBe("Northwind…");
    expect(visibleText(`${at(0x1f950).repeat(5)}`, 3)).toBe(`${at(0x1f950).repeat(2)}…`);
    // The cut counts what is left once the hidden characters are gone.
    expect(visibleText(`Acme${at(0x200b).repeat(100)} Ltd`, 8)).toBe("Acme Ltd");
  });

  it("CL12: is empty for no text, or for text with nothing visible in it", () => {
    expect(visibleText(null, 80)).toBe("");
    expect(visibleText(undefined, 80)).toBe("");
    expect(visibleText("", 80)).toBe("");
    expect(visibleText(`${at(0x202e)}${at(0x200b)}\n ${at(0x2800)}`, 80)).toBe("");
  });

  it("CL12: the classes are global, for replace, and match what they name", () => {
    for (const pattern of [NOTE_INVISIBLE, NOTE_BREAK, NOTE_MARKS]) expect(pattern.flags).toBe("gu");
    expect(`a${at(0x202e)}b`.replace(NOTE_INVISIBLE, "")).toBe("ab");
    expect("a\nb".replace(NOTE_BREAK, " ")).toBe("a b");
  });
});

describe("the document check's reader note", () => {
  it("CL12: uses the shared classes rather than its own copy", () => {
    const check = readFileSync("src/lib/document-requests/check.ts", "utf8");
    expect(check).toContain('import { NOTE_BREAK, NOTE_INVISIBLE, NOTE_MARKS } from "../visible-text";');
    expect(check).not.toMatch(/const NOTE_(?:INVISIBLE|BREAK|MARKS)\b/);
  });

  it("CL12: still drops what the classes drop from a reader's note", () => {
    const acute = at(0x0301);
    expect(readerNoteOf(`Amount ${at(0x202e)}differs${at(0x2800)}\nfrom the bill${at(0xe000)}`)).toBe("Amount differs from the bill");
    // An x takes no accent of its own in NFKC, so its marks stay marks.
    expect(readerNoteOf(`Tax${acute}${acute}${acute} total`)).toBe(`Tax${acute}${acute} total`);
  });
});
