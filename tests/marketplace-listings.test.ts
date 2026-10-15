import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASANA_SCOPES } from "@/lib/asana/settings";
import { PIPEDRIVE_SCOPES } from "@/lib/pipedrive/settings";

/**
 * The Pipedrive Marketplace and Asana App Directory submissions (docs/distribution/pipedrive-marketplace.md,
 * asana-app-directory.md): their text within each directory's own limits, their scope tables the code's, and their
 * images the sizes each directory takes.
 */

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "docs", "distribution");
const read = (file: string) => readFileSync(path.join(DIST, file), "utf8").replace(/\r\n/g, "\n");

/** The lines under a heading, up to the next heading of any level. */
function linesUnder(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.replace(/^#+\s*/, "") === heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The text under a heading as it reads: a wrapped line joined to the one before; list items, rows and paragraphs kept apart. */
function section(markdown: string, heading: string): string {
  return linesUnder(markdown, heading)
    .join("\n")
    .trim()
    .replace(/\n(?!\n|\s*[-\d|])/g, " ");
}

/** The scopes a table names, in backticks in its first column. */
function scopesIn(markdown: string, heading: string): string[] {
  return linesUnder(markdown, heading)
    .map((line) => /^\| `([a-z:-]+)` \|/.exec(line.trim())?.[1])
    .filter((scope): scope is string => Boolean(scope));
}

/** A PNG's width and height, from its header. */
function pngSize(file: string): [number, number] {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString("latin1"), file).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("the Pipedrive Marketplace listing", () => {
  const listing = read("pipedrive-marketplace.md");

  it("keeps each field within Developer Hub's limits", () => {
    expect(section(listing, "Short summary (150 characters at most)").length).toBeLessThanOrEqual(150);
    expect(section(listing, "Full description (1500 characters at most)").length).toBeLessThanOrEqual(1500);
    expect(section(listing, "Instructions for users (1500 characters at most)").length).toBeLessThanOrEqual(1500);
    expect(section(listing, "Use case (350 characters at most, for the reviewer only)").length).toBeLessThanOrEqual(350);
  });

  it("asks only for the scopes the code uses: the registered ones but the two the listing says to remove", () => {
    const listed = scopesIn(listing, "OAuth & access scopes");
    expect(listed).toEqual(PIPEDRIVE_SCOPES.filter((scope) => scope !== "users:read" && scope !== "recents:read"));
    expect(section(listing, "Before you submit")).toContain("remove `users:read` and `recents:read`");
  });

  it("names the callback, installation and legal pages that exist", () => {
    for (const url of [
      "https://www.vestiarion.xyz/api/integrations/pipedrive/callback",
      "https://www.vestiarion.xyz/integrations/pipedrive/connect",
      "https://www.vestiarion.xyz/terms",
      "https://www.vestiarion.xyz/privacy",
    ]) {
      expect(listing, url).toContain(url);
    }
  });

  it("has one to five listing images at a size Developer Hub takes, and a square icon of at least 256 pixels", () => {
    const folder = path.join(DIST, "assets", "pipedrive");
    const images = readdirSync(folder).filter((file) => /^\d-.+\.png$/.test(file));
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images.length).toBeLessThanOrEqual(5);
    for (const image of images) {
      expect([[1280, 800], [1440, 900], [2560, 1600], [2880, 1800]], image).toContainEqual(pngSize(path.join(folder, image)));
      expect(listing, image).toContain(image);
    }
    const [width, height] = pngSize(path.join(folder, "icon-512.png"));
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(256);
  });
});

describe("the Asana App Directory listing", () => {
  const listing = read("asana-app-directory.md");

  it("follows Asana's listing guidelines", () => {
    // The app's name must not include Asana's.
    expect(section(listing, "App listing details")).toContain("| App name | Vestiarion |");
    const short = section(listing, "Short description (about 100 characters, starting with a verb)");
    expect(short.length).toBeLessThanOrEqual(110);
    expect(short).toMatch(/^[A-Z][a-z]+ /);
    expect(section(listing, "Long description (at least 250 characters)").length).toBeGreaterThanOrEqual(250);
    expect(section(listing, "Setup instructions")).toMatch(/^1\. /);
  });

  it("lists exactly the scopes the app asks Asana for", () => {
    expect(scopesIn(listing, "Scopes")).toEqual([...ASANA_SCOPES]);
  });

  it("has a 128-pixel icon and listing images, each named in the listing", () => {
    const folder = path.join(DIST, "assets", "asana");
    expect(pngSize(path.join(folder, "icon-128.png"))).toEqual([128, 128]);
    const images = readdirSync(folder).filter((file) => /^\d-.+\.png$/.test(file));
    expect(images.length).toBeGreaterThanOrEqual(1);
    for (const image of images) expect(listing, image).toContain(image);
  });
});
