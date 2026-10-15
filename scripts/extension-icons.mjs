/**
 * Renders the brand mark (src/app/icon.svg) into the Chrome extension's icons, in
 * extensions/chrome-invoice-capture/extension/icons/:
 *
 *   node scripts/extension-icons.mjs
 *
 *   icon-16.png    the toolbar at 1x: the simplified mark, as the 16 px favicon draws it
 *   icon-32.png    the toolbar at 2x
 *   icon-48.png    chrome://extensions
 *   icon-128.png   installing and the Chrome Web Store: the mark at 96 px inside
 *                  16 px of clear space, as the store asks
 *
 * Transparent, so the mark sits on light and dark toolbars alike. Re-run whenever
 * the icon changes, and commit the PNGs: the extension ships them as they are.
 * `sharp` comes with Next.js, as for scripts/build-icons.mjs.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = readFileSync(path.join(root, "src", "app", "icon.svg"), "utf8");
const out = path.join(root, "extensions", "chrome-invoice-capture", "extension", "icons");

function edit(svg, pattern, replacement, what) {
  if (!pattern.test(svg)) throw new Error(`icon.svg changed shape: could not find ${what}`);
  return svg.replace(pattern, replacement);
}

/** The mark for 16 px: tighter crop, heavier check, no proof dot, as the favicon's. */
function smallMark(svg) {
  let small = edit(svg, /viewBox="0 0 40 40"/, 'viewBox="2 2 36 36"', "the 40×40 viewBox");
  small = edit(small, /\s*<circle\b[^>]*\/>/, "", "the proof dot");
  return edit(small, /stroke-width="[\d.]+"/, 'stroke-width="4.6"', "the check's stroke width");
}

/** The mark at `art` pixels, centred on a transparent `size` square. */
async function render(svg, size, art) {
  const mark = await sharp(Buffer.from(svg), { density: 72 * (art / 40) * 2 })
    .resize(art, art)
    .png()
    .toBuffer();
  const pad = Math.round((size - art) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: pad, top: pad }])
    .png()
    .toBuffer();
}

mkdirSync(out, { recursive: true });
const icons = [
  ["icon-16.png", smallMark(source), 16, 16],
  ["icon-32.png", source, 32, 32],
  ["icon-48.png", source, 48, 48],
  ["icon-128.png", source, 128, 96],
];
for (const [name, svg, size, art] of icons) {
  await sharp(await render(svg, size, art)).toFile(path.join(out, name));
  console.log(`wrote ${path.relative(root, path.join(out, name))}`);
}
