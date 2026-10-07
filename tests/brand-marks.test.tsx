import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { BrandMark, isWordmark, type Brand } from "@/components/vx/BrandMarks";

/**
 * The marks of the services Vestiarion integrates with
 * (docs/superpowers/specs/2026-10-07-brand-marks-design.md): only those the code
 * integrates with, in one colour, beside their names, and never worded as an
 * endorsement.
 */

const BRANDS: Brand[] = ["arc", "circle", "slack", "telegram", "npm"];

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("a brand mark", () => {
  it("is drawn in the page's ink, hidden from assistive technology", () => {
    for (const brand of BRANDS) {
      const markup = renderToStaticMarkup(<BrandMark brand={brand} />);
      expect(markup).toMatch(/^<svg aria-hidden="true" focusable="false" viewBox="[\d. ]+" fill="currentColor"/);
      expect(markup).toContain(`data-brand="${brand}"`);
      // One colour: no brand colour, gradient or embedded image travels with a mark.
      expect(markup).not.toMatch(/#[0-9a-f]{3,6}\b|gradient|<image|<style|url\(/i);
    }
  });

  it("exists only for services the code integrates with: no Gmail, whose inbox is reached by forwarding", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/vx/BrandMarks.tsx"), "utf8");
    const declared = [...source.matchAll(/^ {2}(\w+): \{$/gm)].map((match) => match[1]);
    expect(declared).toEqual(BRANDS);
    expect(source).not.toMatch(/gmail|google/i);
  });

  it("is used nowhere without its name beside it", () => {
    // Every file that draws a mark also writes the brand's name.
    const NAMES: Record<Brand, string> = { arc: "Arc", circle: "Circle", slack: "Slack", telegram: "Telegram", npm: "npm" };
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    const users = walk(path.join(process.cwd(), "src")).filter((file) => file.endsWith(".tsx") && !file.endsWith("BrandMarks.tsx"));
    for (const file of users) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<BrandMark brand="(\w+)"/g)) expect(source, file).toContain(NAMES[match[1] as Brand]);
    }
  });

  it("knows npm's mark spells its name", () => {
    expect(BRANDS.filter(isWordmark)).toEqual(["npm"]);
  });
});

describe("the landing page's built on and works with", () => {
  const markup = renderToStaticMarkup(<BuiltWith />);

  it("names each service beside its mark, and links to the evidence", () => {
    const page = text(markup);
    for (const name of ["Arc", "Circle", "Slack", "Telegram", "npm"]) expect(page).toContain(name);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([
      "/open",
      "https://github.com/duongnq2798/vestiarion/blob/main/src/lib/circle/liveProvider.ts",
      "/docs/guides/slack",
      "/docs/guides/telegram",
      "/docs/get-started/sdk",
    ]);
    expect([...markup.matchAll(/data-brand="(\w+)"/g)].map((match) => match[1])).toEqual(["arc", "circle", "slack", "telegram", "npm"]);
    // npm's mark is its name, so the written name is for screen readers.
    expect(markup).toContain('<span class="sr-only">npm</span>');
  });

  it("says built on and works with, never that a service vouches for Vestiarion", () => {
    const page = text(markup).toLowerCase();
    expect(page).toContain("built on, and works with");
    for (const claim of ["partner", "trusted by", "powered by", "endorsed", "certified", "gmail"]) expect(page).not.toContain(claim);
  });
});
