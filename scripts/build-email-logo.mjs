/**
 * Renders the app icon (src/app/icon.svg) to the PNG the auth emails use.
 *
 *   node scripts/build-email-logo.mjs
 *
 * Email clients do not render SVG — Gmail strips it — so the emails load
 * {{ .SiteURL }}/email/logo.png instead. 96×96 displayed at 48×48 stays sharp
 * on high-density screens. Re-run whenever the icon changes.
 *
 * `sharp` is not a declared dependency; it arrives with Next.js for image
 * optimisation, which is enough for a script run by hand.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = path.join(root, "src", "app", "icon.svg");
const target = path.join(root, "public", "email", "logo.png");

mkdirSync(path.dirname(target), { recursive: true });
const info = await sharp(readFileSync(source), { density: 384 })
  .resize(96, 96)
  .png({ compressionLevel: 9 })
  .toFile(target);

console.log(`wrote ${path.relative(root, target)} — ${info.width}×${info.height}, ${info.size} bytes`);
