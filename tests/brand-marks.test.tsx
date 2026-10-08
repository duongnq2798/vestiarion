import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuiltWith } from "@/components/landing/BuiltWith";
import { BRAND_FILES, BrandMark, isWordmark, type Brand } from "@/components/vx/BrandMarks";

/**
 * The marks of the services Vestiarion integrates with
 * (docs/superpowers/specs/2026-10-07-brand-marks-design.md): only those the code
 * integrates with, each its owner's file unaltered, beside its name, and never
 * worded as an endorsement.
 */

const BRANDS: Brand[] = ["arc", "circle", "slack", "telegram", "npm"];

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The owners' files, byte for byte as their brand kits publish them: a change
 * here is a recoloured, cropped or redrawn mark, which their guidelines forbid.
 */
const OFFICIAL_SHA256: Record<Brand, string> = {
  arc: "4f5bed3cc8c8ebb91a855e74b4d02d72d66e311b0080d0b94cd8a9900669f60f",
  circle: "3cd2066548be9f3c9a4f3e65fa577afd6cb00595311b1ca507e3358a92b60697",
  slack: "3b4e08eefa709e2a6209f116a0493c323da6a3a73713666fb524ccb91a95e8dd",
  telegram: "d8ea6a30260ef60f3a68c7bd994e5a3ed5740431128a854e2f5003beafda58bd",
  npm: "bdb2b11ee23be03be4dd31264e336f952c0ffe61699a237c511dc5d9afc6d77e",
};

describe("a brand mark", () => {
  it("is its owner's file, unaltered, served from public/brands", () => {
    expect(Object.keys(BRAND_FILES)).toEqual(BRANDS);
    for (const brand of BRANDS) {
      expect(BRAND_FILES[brand]).toMatch(new RegExp(`^/brands/${brand}\\.(svg|jpeg)$`));
      const bytes = readFileSync(path.join(process.cwd(), "public", BRAND_FILES[brand]));
      expect(createHash("sha256").update(bytes).digest("hex"), brand).toBe(OFFICIAL_SHA256[brand]);
    }
  });

  it("is decoration beside a name: an empty alt, hidden from assistive technology, never recoloured", () => {
    for (const brand of BRANDS) {
      const markup = renderToStaticMarkup(<BrandMark brand={brand} />);
      // React may add a preload <link> for the image ahead of it; the <img> itself is what matters.
      expect(markup).toMatch(new RegExp(`<img src="${BRAND_FILES[brand].replace(".", "\\.")}" alt="" aria-hidden="true"`));
      expect(markup).toContain(`data-brand="${brand}"`);
      expect(markup).not.toMatch(/filter|opacity|mix-blend|grayscale|text-ink/);
    }
  });

  it("shows Slack's mark at the others' height without cutting its clear space", () => {
    // 16 px tall: the file is drawn larger and pulled in by its clear space on every side.
    const slack = renderToStaticMarkup(<BrandMark brand="slack" />);
    expect(slack).toMatch(/width="35" height="35"/);
    expect(slack).toMatch(/style="margin:-9\.\d+px"/);
    expect(renderToStaticMarkup(<BrandMark brand="circle" />)).toMatch(/width="16" height="16"(?![^>]*style)/);
    expect(renderToStaticMarkup(<BrandMark brand="npm" />)).toMatch(/width="41" height="16"/);
  });

  it("exists only for services the code integrates with: no Gmail, whose inbox is reached by forwarding", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/vx/BrandMarks.tsx"), "utf8");
    expect(source).not.toMatch(/gmail|google/i);
    expect(readdirSync(path.join(process.cwd(), "public/brands")).sort()).toEqual(["arc.jpeg", "circle.svg", "npm.svg", "slack.svg", "telegram.svg"]);
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

  it("names each service beside its mark, and links to the evidence, Arc and Circle to their own sites as well", () => {
    const page = text(markup);
    for (const name of ["Arc", "Circle", "Slack", "Telegram", "npm"]) expect(page).toContain(name);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([
      "/open",
      "https://www.arc.io",
      "https://github.com/duongnq2798/vestiarion/blob/main/src/lib/circle/liveProvider.ts",
      "https://www.circle.com",
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
    for (const claim of ["partner", "trusted by", "powered by", "endorsed by", "certified", "gmail"]) expect(page).not.toContain(claim);
    // The trademark notice npm's policy asks for, and that the marks are not an endorsement.
    expect(page).toContain("npm is a registered trademark of npm, inc.");
    expect(page).toContain("not an endorsement");
  });
});
