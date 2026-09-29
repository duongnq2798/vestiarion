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

function offences(files: string[], pattern: RegExp, keep: (match: string) => boolean = () => true): string[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(pattern)]
      .filter((match) => keep(match[0]))
      .map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${path.relative(ROOT, file).replaceAll(path.sep, "/")}:${line}: ${match[0].replace(/\s+/g, " ").slice(0, 80)}`;
      });
  });
}

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOUR_UTILITY = "bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|divide|placeholder|caret|accent|shadow";

/** A raw `<button>`, `<select>` or `<textarea>` — the ui/ primitive replaces it. */
const RAW_CONTROL = /<(?:button|select|textarea)\b/g;

/**
 * A whole `<input …>` tag. `(?:=>|[^>])*` lets an arrow function's `=>` pass
 * through without closing the tag early — plain `[^>]*` stops at the first
 * `>`, including the one inside `=>`, which truncates the tag before a
 * trailing `type="hidden"` and so misreads a hidden input as visible.
 */
const INPUT_TAG = /<input\b(?:=>|[^>])*>/g;

/** A hex literal in quotes or an arbitrary-value bracket, or a colour function call. */
const COLOUR_LITERAL = /["'`]#[0-9a-fA-F]{3,8}["'`]|-\[#[0-9a-fA-F]{3,8}\]|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(/g;

/** A default-Tailwind-palette or white/black colour utility. */
const PALETTE_UTILITY = new RegExp(`(?<![\\w-])(?:${COLOUR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|white|black)(?![\\w-])`, "g");

/**
 * A `rounded` utility off the design system's radius scale — bare, an
 * arbitrary value, or corner-/side-prefixed (`rounded-t-sm`,
 * `rounded-tl-3xl`) — while leaving scale values like `rounded-t-lg`,
 * `rounded-tl-full` and `rounded-xl` alone.
 */
const OFF_SCALE_RADIUS = /(?<![\w-])rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es))?(?:-sm|-3xl|-\[[^\]]*\])?(?![\w-])/g;

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
    expect(offences(OUTSIDE_UI, OFF_SCALE_RADIUS)).toEqual([]);
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

  it("PALETTE_UTILITY catches a default-palette or white/black utility, and leaves the brand shadow tokens alone", () => {
    expect("text-blue-500".match(PALETTE_UTILITY)).not.toBeNull();
    expect("hover:bg-white".match(PALETTE_UTILITY)).not.toBeNull();
    expect("border-black/10".match(PALETTE_UTILITY)).not.toBeNull();

    expect("shadow-surface".match(PALETTE_UTILITY)).toBeNull();
    expect("bg-surface".match(PALETTE_UTILITY)).toBeNull();
  });

  it("OFF_SCALE_RADIUS catches a bare, arbitrary or corner-prefixed off-scale radius, and leaves the scale alone", () => {
    expect("rounded".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-sm".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("sm:rounded-3xl".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-[10px]".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-t-[4px]".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-t-sm".match(OFF_SCALE_RADIUS)).not.toBeNull();
    expect("rounded-tl-3xl".match(OFF_SCALE_RADIUS)).not.toBeNull();

    expect("rounded-t-lg".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-t-2xl".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-tl-full".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-full".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-l-full".match(OFF_SCALE_RADIUS)).toBeNull();
    expect("rounded-xl".match(OFF_SCALE_RADIUS)).toBeNull();
  });

  it("REMOVED_UTILITY catches a removed shadow utility, and leaves its replacement tokens alone", () => {
    expect("surface-shadow".match(REMOVED_UTILITY)).not.toBeNull();
    expect("brand-shadow".match(REMOVED_UTILITY)).not.toBeNull();
    expect("logo-shadow".match(REMOVED_UTILITY)).not.toBeNull();

    expect("drop-shadow-logo".match(REMOVED_UTILITY)).toBeNull();
    expect("shadow-brand".match(REMOVED_UTILITY)).toBeNull();
  });
});
