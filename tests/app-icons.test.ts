import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

/**
 * The icons the site serves, rendered from src/app/icon.svg by
 * `scripts/build-icons.mjs`. Browsers, bookmarks and crawlers ask for
 * /favicon.ico by name whatever a page declares, and for a long time that file
 * was the framework's placeholder while every page declared the brand's SVG.
 */

const ROOT = process.cwd();
const PNG_SIGNATURE = "89504e470d0a1a0a";

interface PngHeader {
  width: number;
  height: number;
  /** IHDR colour type: 2 is RGB, 6 is RGB with alpha. */
  colourType: number;
}

function pngHeader(data: Buffer): PngHeader {
  expect(data.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data.readUInt8(25) };
}

function icoImages(data: Buffer): Array<{ size: number; png: PngHeader }> {
  expect(data.readUInt16LE(0)).toBe(0);
  expect(data.readUInt16LE(2)).toBe(1);
  return Array.from({ length: data.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const length = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    return { size: data.readUInt8(entry) || 256, png: pngHeader(data.subarray(offset, offset + length)) };
  });
}

function read(...segments: string[]): Buffer {
  return readFileSync(path.join(ROOT, ...segments));
}

describe("favicon.ico", () => {
  const images = icoImages(read("src", "app", "favicon.ico"));

  it("holds the brand mark at 16, 32 and 48 px", () => {
    expect(images.map((image) => image.size)).toEqual([16, 32, 48]);
    for (const image of images) expect(image.png).toMatchObject({ width: image.size, height: image.size });
  });
});

describe("apple-icon.png", () => {
  it("is 180 px and opaque, since iOS paints transparency black", () => {
    expect(pngHeader(read("src", "app", "apple-icon.png"))).toEqual({ width: 180, height: 180, colourType: 2 });
  });
});

describe("the web manifest", () => {
  const app = manifest();

  it("names the product and opens where a signed-in person lands", () => {
    expect(app.short_name).toBe("Vestiarion");
    expect(app.start_url).toBe("/onboarding");
    // Sign-in is an emailed link; a standalone iOS app would keep a session of its own that the link never reaches.
    expect(app.display).toBe("minimal-ui");
  });

  it.each((app.icons ?? []).filter((icon) => icon.type === "image/png").map((icon) => [icon.src, icon]))(
    "%s exists at the size it declares",
    (src, icon) => {
      const file = path.join(ROOT, "public", src);
      expect(existsSync(file)).toBe(true);
      const [width, height] = String(icon.sizes).split("x").map(Number);
      const header = pngHeader(readFileSync(file));
      expect(header).toMatchObject({ width, height });
      // A maskable icon is cropped to any shape, so its corners must be painted, not transparent.
      if (icon.purpose === "maskable") expect(header.colourType).toBe(2);
    }
  );

  it("points its vector icon at the app icon", () => {
    expect(app.icons).toContainEqual(expect.objectContaining({ src: "/icon.svg", type: "image/svg+xml" }));
    expect(existsSync(path.join(ROOT, "src", "app", "icon.svg"))).toBe(true);
  });
});
