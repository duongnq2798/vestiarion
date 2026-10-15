#!/usr/bin/env node
/**
 * Draws the README's buttons into `docs/assets/readme/` as SVG: a dark rounded button, an icon, a small caption and a
 * label, the shape app stores use, so the README's first actions read as actions. Run `node scripts/readme-buttons.mjs`
 * after changing one and commit the SVGs. They hold no font of their own: GitHub shows an SVG as an image, with the
 * reader's system font.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "docs", "assets", "readme");
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const ICONS = {
  // A globe: the live app.
  web: `<g fill="none" stroke="#fff" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15"/></g>`,
  // A play button: the demo on YouTube.
  play: `<rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#FF0033"/><path d="M10 8.6v6.8l5.8-3.4z" fill="#fff"/>`,
  // Chrome's four colours, drawn as three arcs around a blue centre.
  chrome: `<circle cx="12" cy="12" r="10" fill="#EA4335"/>
    <path d="M12 12 3.34 7A10 10 0 0 0 7 20.66z" fill="#34A853"/>
    <path d="M12 12h10a10 10 0 0 1-15 8.66z" fill="#FBBC05"/>
    <circle cx="12" cy="12" r="4.6" fill="#fff"/><circle cx="12" cy="12" r="3.5" fill="#4285F4"/>`,
  // npm's red square and its letter.
  npm: `<rect x="2" y="2" width="20" height="20" rx="2" fill="#CB3837"/><path d="M6 6h12v12h-3V9h-3v9H6z" fill="#fff"/>`,
};

const BUTTONS = [
  { file: "open-the-app.svg", icon: "web", caption: "OPEN THE APP", label: "vestiarion.xyz" },
  { file: "watch-the-demo.svg", icon: "play", caption: "WATCH THE DEMO", label: "2:59 on YouTube" },
  { file: "add-to-chrome.svg", icon: "chrome", caption: "ADD TO CHROME", label: "Invoice Capture" },
  { file: "npm-sdk.svg", icon: "npm", caption: "INSTALL FROM NPM", label: "@vestiarion/sdk" },
];

const WIDTH = 162;
const HEIGHT = 48;

function button({ icon, caption, label }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${caption.toLowerCase()}: ${label}">
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="10" fill="#18181B" stroke="#3F3F46"/>
  <g transform="translate(12 12)">${ICONS[icon]}</g>
  <text x="44" y="19" fill="#A1A1AA" font-family="${FONT}" font-size="8" font-weight="600" letter-spacing="0.8">${caption}</text>
  <text x="44" y="35" fill="#FAFAFA" font-family="${FONT}" font-size="13.5" font-weight="700">${label.replace(/&/g, "&amp;")}</text>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
for (const spec of BUTTONS) writeFileSync(path.join(OUT, spec.file), button(spec));
console.log(`docs/assets/readme: ${BUTTONS.length} buttons`);
