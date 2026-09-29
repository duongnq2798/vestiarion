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

describe("the design system holds", () => {
  it("renders no raw button, select or textarea outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, /<(?:button|select|textarea)\b/g)).toEqual([]);
  });

  it("renders no visible raw input outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, /<input\b[^>]*>/g, (tag) => !/type="hidden"/.test(tag))).toEqual([]);
  });

  it("hard-codes no colour in a .tsx file", () => {
    expect(offences(TSX, /["'`]#[0-9a-fA-F]{3,8}["'`]|-\[#[0-9a-fA-F]{3,8}\]|\b(?:rgba?|hsla?|oklch|oklab|hwb)\(/g)).toEqual([]);
  });

  it("uses no default-palette or white/black colour utility", () => {
    const utility = new RegExp(`(?<![\\w-])(?:${COLOUR_UTILITY})-(?:(?:${PALETTE})-(?:50|[1-9]00|950)|white|black)(?![\\w-])`, "g");
    expect(offences(TSX, utility)).toEqual([]);
  });

  it("uses no radius off the scale outside src/components/ui", () => {
    expect(offences(OUTSIDE_UI, /(?<![\w-])rounded(?:-sm|-3xl|-\[[^\]]*\])?(?![\w-])/g)).toEqual([]);
  });

  it("brings back none of the removed shadow utilities", () => {
    expect(offences(STYLES, /(?<![\w-])(?:surface-shadow|brand-shadow|logo-shadow)(?![\w-])/g)).toEqual([]);
  });
});
