import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps every screen on the design system (spec §8): a new file that renders a
 * raw control, hard-codes a colour, invents a radius or brings back a removed
 * utility fails here, with the file and line of each offence.
 */

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const UI = path.join(SRC, "components", "ui") + path.sep;

function walk(dir: string, keep: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, keep) : keep.test(name) ? [full] : [];
  });
}

const TSX = walk(SRC, /\.tsx$/);
const OUTSIDE_UI = TSX.filter((file) => !file.startsWith(UI));
const STYLES = walk(SRC, /\.(tsx|ts|css)$/);

function offences(files: string[], pattern: RegExp, keep: (match: string, lineBefore: string) => boolean = () => true): string[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(pattern)]
      .filter((match) => {
        const index = match.index ?? 0;
        const lineStart = source.lastIndexOf("\n", index - 1) + 1;
        return keep(match[0], source.slice(lineStart, index));
      })
      .map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${path.relative(ROOT, file).replaceAll(path.sep, "/")}:${line}: ${match[0].replace(/\s+/g, " ").slice(0, 80)}`;
      });
  });
}

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
/** `border` also takes an optional axis/side/corner segment (`border-l`, `border-x`, `border-t`) before its colour. */
const COLOUR_UTILITY = "bg|text|border(?:-[xysetrbl])?|ring|fill|stroke|from|via|to|outline|decoration|divide|placeholder|caret|accent|shadow";

/** A raw `<button>`, `<select>` or `<textarea>` — the ui/ primitive replaces it. */
const RAW_CONTROL = /<(?:button|select|textarea)\b/g;

/**
 * A whole `<input …>` tag. `(?:=>|[^>])*` lets an arrow function's `=>` pass
 * through without closing the tag early — plain `[^>]*` stops at the first
 * `>`, including the one inside `=>`, which truncates the tag before a
 * trailing `type="hidden"` and so misreads a hidden input as visible.
 */
const INPUT_TAG = /<input\b(?:=>|[^>])*>/g;

/**
 * A hex literal in quotes or an arbitrary-value bracket, a colour function
 * call, a named colour in an SVG presentation attribute (`fill="white"`), or
 * a hex colour sitting inside a quoted CSS value (`"1px solid #ccc"`) —
 * while `href="#add-counterparty"` and similar hash references stay clear.
 */
const COLOUR_LITERAL =
  /["'`]#[0-9a-fA-F]{3,8}["'`]|-\[#[0-9a-fA-F]{3,8}\]|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(|\b(?:fill|stroke|stopColor|floodColor|lightingColor|color)=["'](?:white|black|red|green|blue|gr[ae]y|yellow|orange|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia)["']|["'`][^"'`\n]*[\s,(:]#[0-9a-fA-F]{3,8}\b/g;

/** A default-Tailwind-palette or white/black colour utility. */
const PALETTE_UTILITY = new RegExp(`(?<![\\w-])(?:${COLOUR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|white|black)(?![\\w-])`, "g");

/**
 * A `rounded` utility off the design system's radius scale — bare, an
 * arbitrary value, or corner-/side-prefixed (`rounded-t-sm`,
 * `rounded-tl-3xl`) — while leaving scale values like `rounded-t-lg`,
 * `rounded-tl-full` and `rounded-xl` alone. `-xs` and `-4xl` are Tailwind 4's
 * own off-scale steps.
 */
const OFF_SCALE_RADIUS = /(?<![\w-])rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es))?(?:-xs|-sm|-3xl|-4xl|-\[[^\]]*\])?(?![\w-])/g;

/**
 * The radius scan's rule: a match counts only when it sits inside a quoted string on its line (a `className` or a
 * `cva` entry) — an odd number of double quotes or backticks before it, not the English word in prose. Class
 * strings here are always double-quoted or templated, so an apostrophe in an earlier attribute or in a comment
 * does not flip the count.
 */
function insideQuotedString(lineBefore: string): boolean {
  return (lineBefore.match(/["`]/g)?.length ?? 0) % 2 === 1;
}

/** Mirrors the radius scan's combined rule (pattern match, then the quoted-string keep) against a single line, for probing without touching the filesystem. */
function radiusOffence(line: string): boolean {
  return [...line.matchAll(OFF_SCALE_RADIUS)].some((match) => insideQuotedString(line.slice(0, match.index ?? 0)));
}

/** One of the three shadow utilities Task 10 removed from globals.css. */
const REMOVED_UTILITY = /(?<![\w-])(?:surface-shadow|brand-shadow|logo-shadow)(?![\w-])/g;

describe("the design system holds", () => {
  it("renders no raw button, select or textarea outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, RAW_CONTROL)).toEqual([]);
  });

  it("renders no visible raw input outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, INPUT_TAG, (tag) => !/type="hidden"/.test(tag))).toEqual([]);
  });

  it("hard-codes no colour in a .tsx file", () => {
    expect(offences(TSX, COLOUR_LITERAL)).toEqual([]);
  });

  it("uses no default-palette or white/black colour utility", () => {
    expect(offences(TSX, PALETTE_UTILITY)).toEqual([]);
  });

  it("uses no radius off the scale outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, OFF_SCALE_RADIUS, (_match, lineBefore) => insideQuotedString(lineBefore))).toEqual([]);
  });

  it("brings back none of the removed shadow utilities", () => {
    expect(offences(STYLES, REMOVED_UTILITY)).toEqual([]);
  });
});

describe("the patterns themselves", () => {
  it("RAW_CONTROL catches every raw control, even split across lines", () => {
    expect('<button type="submit">'.match(RAW_CONTROL)).not.toBeNull();
    expect('<button\n  className="x">'.match(RAW_CONTROL)).not.toBeNull();
    expect('<select name="x">'.match(RAW_CONTROL)).not.toBeNull();
    expect("<textarea/>".match(RAW_CONTROL)).not.toBeNull();
  });

  it("INPUT_TAG plus the hidden check flags a visible input and spares a hidden one", () => {
    const flagged = (probe: string) => (probe.match(INPUT_TAG) ?? []).some((tag) => !/type="hidden"/.test(tag));

    expect(flagged('<input type="text" />')).toBe(true);
    expect(flagged('<input\n  type="email"\n/>')).toBe(true);
    expect(flagged('<input value={x} onChange={(e) => set(e.target.value)} type="hidden" />')).toBe(false);
  });

  it("COLOUR_LITERAL catches a hex or colour-function literal, and leaves hash references alone", () => {
    expect('style={{ color: "#1a2b3c" }}'.match(COLOUR_LITERAL)).not.toBeNull();
    expect('className="bg-[#fff]"'.match(COLOUR_LITERAL)).not.toBeNull();
    expect('fill="#FFF"'.match(COLOUR_LITERAL)).not.toBeNull();
    expect("rgb(0 0 0 / 0.5)".match(COLOUR_LITERAL)).not.toBeNull();

    expect('href="#main"'.match(COLOUR_LITERAL)).toBeNull();
    expect(">#0001<".match(COLOUR_LITERAL)).toBeNull();
    expect("&#9670;".match(COLOUR_LITERAL)).toBeNull();
  });

  it("COLOUR_LITERAL also catches a named colour on an SVG presentation attribute and a hex buried in a quoted CSS value", () => {
    expect('fill="white"'.match(COLOUR_LITERAL)).not.toBeNull();
    expect('stroke="black"'.match(COLOUR_LITERAL)).not.toBeNull();
    expect('stopColor="red"'.match(COLOUR_LITERAL)).not.toBeNull();
    expect('style={{ background: "linear-gradient(135deg, #3048c9, #fff)" }}'.match(COLOUR_LITERAL)).not.toBeNull();
    expect('className="1px solid #ccc"'.match(COLOUR_LITERAL)).not.toBeNull();

    expect('fill="none"'.match(COLOUR_LITERAL)).toBeNull();
    expect('fill="currentColor"'.match(COLOUR_LITERAL)).toBeNull();
    expect('stroke="transparent"'.match(COLOUR_LITERAL)).toBeNull();
    expect('fill="url(#g)"'.match(COLOUR_LITERAL)).toBeNull();
    expect('href="#add-counterparty"'.match(COLOUR_LITERAL)).toBeNull();
  });

  it("PALETTE_UTILITY catches a default-palette or white/black utility, and leaves the brand shadow tokens alone", () => {
    expect("text-blue-500".match(PALETTE_UTILITY)).not.toBeNull();
    expect("hover:bg-white".match(PALETTE_UTILITY)).not.toBeNull();
    expect("border-black/10".match(PALETTE_UTILITY)).not.toBeNull();

    expect("shadow-surface".match(PALETTE_UTILITY)).toBeNull();
    expect("bg-surface".match(PALETTE_UTILITY)).toBeNull();
  });

  it("PALETTE_UTILITY also catches a side-prefixed border utility, and leaves the line token alone", () => {
    expect("border-l-red-500".match(PALETTE_UTILITY)).not.toBeNull();
    expect("border-t-white".match(PALETTE_UTILITY)).not.toBeNull();
    expect("border-x-gray-200".match(PALETTE_UTILITY)).not.toBeNull();

    expect("border-line".match(PALETTE_UTILITY)).toBeNull();
    expect("border-l-line".match(PALETTE_UTILITY)).toBeNull();
  });

  it("OFF_SCALE_RADIUS catches a bare, arbitrary or corner-prefixed off-scale radius, and leaves the scale alone", () => {
    expect("rounded".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-sm".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("sm:rounded-3xl".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-[10px]".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-t-[4px]".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-t-sm".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-tl-3xl".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-xs".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-4xl".match(OFF_SCALE_RADIUS)).not.toBeNull();

    expect("rounded-t-lg".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-t-2xl".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-tl-full".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-full".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-l-full".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-xl".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-2xl".match(OFF_SCALE_RADIUS)).toBeNull();
  });

  it("the radius scan keeps a match only when it sits inside a quoted string, sparing the English word in prose", () => {
    expect(radiusOffence(">Figures are rounded to the cent<")).toBe(false);
    expect(radiusOffence('className="rounded p-2"')).toBe(true);
    expect(radiusOffence('cn("rounded-sm")')).toBe(true);
    expect(radiusOffence(`<button title="Editor's picks" className="rounded">Save</button>`)).toBe(true);
    expect(radiusOffence("// A borrower's payment is rounded to the cent.")).toBe(false);
  });

  it("REMOVED_UTILITY catches a removed shadow utility, and leaves its replacement tokens alone", () => {
    expect("surface-shadow".match(REMOVED_UTILITY)).not.toBeNull();
    expect("brand-shadow".match(REMOVED_UTILITY)).not.toBeNull();
    expect("logo-shadow".match(REMOVED_UTILITY)).not.toBeNull();

    expect("drop-shadow-logo".match(REMOVED_UTILITY)).toBeNull();
    expect("shadow-brand".match(REMOVED_UTILITY)).toBeNull();
  });
});
