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

/** The file name in a screenshot's public path, `/docs/guides/<shot>.png`; null for any other path. */
function shotFileName(src: string): string | null {
  return /^\/docs\/guides\/([a-z0-9-]+\.png)$/.exec(src)?.[1] ?? null;
}

/**
 * A screenshot's size, so the page reserves its space before it loads. The
 * guides are prerendered at build, where `public/` is on disk; a render with
 * no file to read (a missing PNG, or a server without `public/`) leaves the
 * size out rather than fail the page. The docs tests hold every PNG present.
 *
 * The read names `public/docs/guides/` itself, so the build traces only the
 * guides' PNGs into the docs routes. Given a path built elsewhere, Turbopack
 * cannot tell what is read and traces the whole project into each of them.
 */
export function screenshotSize(src: string): { width: number; height: number } | null {
  const name = shotFileName(src);
  if (!name) return null;
  try {
    return pngSize(readFileSync(path.join(process.cwd(), "public", "docs", "guides", name)));
  } catch {
    return null;
  }
}
