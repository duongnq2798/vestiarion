import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The guides' step screenshots: PNGs under `public/docs/guides/`, written by
 * `npm run docs:screenshots` (scripts/docs-screenshots.mjs) from the app's own
 * components with sample data (src/app/docs-shots). A `<Screenshot>` names one
 * by its public path, `/docs/guides/<shot>.png`.
 */

export const SCREENSHOT_DIR = "/docs/guides/";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size in pixels, from its IHDR chunk; null for anything that is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Where a public path such as `/docs/guides/x.png` is on disk; null for a path that leaves `public/`. */
export function publicFile(src: string): string | null {
  if (!src.startsWith("/") || src.startsWith("//")) return null;
  const root = path.join(process.cwd(), "public");
  const file = path.join(root, ...src.slice(1).split("/"));
  return file.startsWith(root + path.sep) ? file : null;
}

/**
 * A screenshot's size, so the page reserves its space before it loads. The
 * guides are prerendered at build, where `public/` is on disk; a render with
 * no file to read (a missing PNG, or a server without `public/`) leaves the
 * size out rather than fail the page. The docs tests hold every PNG present.
 */
export function screenshotSize(src: string): { width: number; height: number } | null {
  const file = publicFile(src);
  if (!file) return null;
  try {
    return pngSize(readFileSync(file));
  } catch {
    return null;
  }
}
