/**
 * Renders the app icon (src/app/icon.svg) to every raster icon the site serves.
 *
 *   node scripts/build-icons.mjs
 *
 *   src/app/favicon.ico              16, 32 and 48 px, for browsers, bookmarks and
 *                                    crawlers that ask for /favicon.ico by name
 *   src/app/apple-icon.png           180 px on an opaque ground, since iOS paints
 *                                    transparency black on the home screen
 *   public/icons/icon-192.png        web manifest, purpose "any"
 *   public/icons/icon-512.png        web manifest, purpose "any"
 *   public/icons/icon-maskable-512.png  web manifest, purpose "maskable": the
 *                                    mark sits inside the central safe zone that
 *                                    Android's adaptive masks never crop
 *
 * Browsers that support SVG favicons use icon.svg itself. The 16 px favicon is
 * drawn from a simplified mark — tighter crop, heavier check, no proof dot —
 * because at sixteen pixels the dot renders as a smudge on the hexagon's edge.
 * Re-run whenever the icon changes.
 *
 * `sharp` is not a declared dependency; it arrives with Next.js for image
 * optimisation, which is enough for a script run by hand.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = readFileSync(path.join(root, "src", "app", "icon.svg"), "utf8");

// The warm paper of the product's ground (globals.css --color-surface → --color-ground).
const PAPER_TOP = "#fffefa";
const PAPER_BOTTOM = "#f3f0e7";

/** Applies one edit to the icon's markup, failing loudly if the icon no longer has what it edits. */
function edit(svg, pattern, replacement, what) {
  if (!pattern.test(svg)) throw new Error(`icon.svg changed shape: could not find ${what}`);
  return svg.replace(pattern, replacement);
}

function smallMark(svg) {
  let small = edit(svg, /viewBox="0 0 40 40"/, 'viewBox="2 2 36 36"', "the 40×40 viewBox");
  small = edit(small, /\s*<circle\b[^>]*\/>/, "", "the proof dot");
  return edit(small, /stroke-width="[\d.]+"/, 'stroke-width="4.6"', "the check's stroke width");
}

/** The mark's inner markup, to be placed on a ground of our own. */
function markBody(svg) {
  const match = /<svg\b[^>]*>([\s\S]*)<\/svg>/.exec(svg);
  if (!match) throw new Error("icon.svg changed shape: no <svg> element");
  return match[1];
}

/** The 40-unit mark centred on a square paper ground, `scale` pixels per unit. */
function onPaper(size, scale) {
  const offset = size / 2 - 20 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PAPER_TOP}"/><stop offset="1" stop-color="${PAPER_BOTTOM}"/></linearGradient></defs>
  <rect width="${size}" height="${size}" fill="url(#paper)"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${markBody(source)}</g>
</svg>`;
}

async function png(svg, size, { opaque = false } = {}) {
  const image = sharp(Buffer.from(svg), { density: 1200 }).resize(size, size);
  return (opaque ? image.removeAlpha() : image).png({ compressionLevel: 9 }).toBuffer();
}

/** An .ico holding PNG-encoded images, which every browser since IE on Vista reads. */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

function write(relative, data) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`wrote ${relative} — ${data.length} bytes`);
}

write(
  "src/app/favicon.ico",
  ico([
    { size: 16, data: await png(smallMark(source), 16) },
    { size: 32, data: await png(source, 32) },
    { size: 48, data: await png(source, 48) },
  ])
);
// 3.1 px per unit: the hexagon spans about 60% of the tile, the proportion iOS's own icons keep.
write("src/app/apple-icon.png", await png(onPaper(180, 3.1), 180, { opaque: true }));
write("public/icons/icon-192.png", await png(source, 192));
write("public/icons/icon-512.png", await png(source, 512));
// 8 px per unit keeps the hexagon's corners within the 40%-radius circle a mask may keep.
write("public/icons/icon-maskable-512.png", await png(onPaper(512, 8), 512, { opaque: true }));
