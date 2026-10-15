#!/usr/bin/env node
/**
 * Draws the Pipedrive Marketplace and Asana App Directory listing images and icons into
 * `docs/distribution/assets/` (docs/distribution/pipedrive-marketplace.md, asana-app-directory.md).
 *
 *   node scripts/marketplace-images.mjs --base http://localhost:3000
 *
 * The base is a server built and started with DOCS_SCREENSHOTS=1, as `npm run docs:screenshots` does, so the
 * `/docs-shots/pipedrive/*` and `/docs-shots/asana/*` screens answer with their fixtures: no workspace, no real data.
 * Each image is 1280 x 800 drawn at twice the pixels (2560 x 1600, a size both directories take): the annotation on the
 * left, as Pipedrive asks, and the screen in a card on the right. No other company's logo is drawn: Asana's guidelines
 * forbid one without permission, and the screens name the integration in words. The icons are the brand mark of
 * `src/app/icon.svg` on a dark tile, which reads on Pipedrive's dark background. Headless Edge draws each one from a
 * page written to a throwaway folder, with a throwaway profile; look at every PNG before committing it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "distribution", "assets");
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = (() => {
  const at = process.argv.indexOf("--base");
  return at > 0 ? process.argv[at + 1].replace(/\/$/, "") : "http://localhost:3000";
})();

const FONT = "'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";
const MARK = readFileSync(path.join(ROOT, "src", "app", "icon.svg"), "utf8");

/** Each listing image: where it goes, the screen it shows (drawn `width` wide, `height` of it shown), and its annotation. */
const IMAGES = [
  {
    file: "pipedrive/1-deals.png",
    shot: "pipedrive/deals",
    width: 1100,
    height: 760,
    kicker: "Vestiarion for Pipedrive",
    title: "Won deals from Pipedrive, waiting to be planned",
    body: "Every deal you win comes in with its organization. Nothing is planned until you plan it, and a deal that changed in Pipedrive says so.",
  },
  {
    file: "pipedrive/2-plan.png",
    shot: "pipedrive/plan",
    width: 1280,
    height: 1174,
    kicker: "Vestiarion for Pipedrive",
    title: "Plan a won deal's collections",
    body: "A deposit and the balance, milestones or a retainer, filled in from the deal. Each line becomes an invoice your customer pays in USDC on Arc.",
  },
  {
    file: "pipedrive/3-receipts.png",
    shot: "pipedrive/receipts",
    width: 1280,
    height: 960,
    kicker: "Vestiarion for Pipedrive",
    title: "Collected and still owed, written back to the deal",
    body: "Once you allow it, what was collected, what is still owed and the last receipt go to the deal's Vestiarion fields, and are read back.",
  },
  {
    file: "pipedrive/4-changed.png",
    shot: "pipedrive/changed",
    width: 1280,
    height: 1174,
    kicker: "Vestiarion for Pipedrive",
    title: "A deal changed in Pipedrive after it was planned",
    body: "Vestiarion says what changed, and you change the plan or keep it. Nothing invoiced or paid is ever rewritten.",
  },
  {
    file: "asana/1-link.png",
    shot: "asana/link",
    width: 1000,
    height: 700,
    kicker: "Vestiarion with Asana",
    title: "Link a milestone to the task its work is delivered in",
    body: "Paste the task's link, or pick it from your workspaces and projects. One task verifies one milestone.",
  },
  {
    file: "asana/2-ready.png",
    shot: "asana/ready",
    width: 1000,
    height: 900,
    kicker: "Vestiarion with Asana",
    title: "Completed in Asana: ready for acceptance",
    body: "The deliverables from the task, beside the criteria from the agreement. A completed task is never by itself a reason to pay.",
  },
  {
    file: "asana/3-accepted.png",
    shot: "asana/accepted",
    width: 1000,
    height: 680,
    kicker: "Vestiarion with Asana",
    title: "A person accepts the work, then the agent decides the payment",
    body: "In USDC on Arc, under every limit you set. If the task is reopened or its deliverables change, the acceptance is taken back.",
  },
];

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function listingPage({ shot, width, height, kicker, title, body }) {
  // The screen is drawn `width` wide and shown in a card 768 wide, `height` of it at most 704 tall, in the middle.
  const scale = 768 / width;
  const card = Math.min(704, Math.round(height * scale));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:800px;overflow:hidden;background:#f3f0e8;font-family:${FONT}}
  .text{position:absolute;left:56px;top:0;width:376px;height:800px;display:flex;flex-direction:column;justify-content:center}
  .kicker{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#3048c9;margin-bottom:18px}
  h1{margin:0 0 18px;font-size:38px;line-height:1.15;font-weight:700;letter-spacing:-.02em;color:#16181d}
  p{margin:0;font-size:18px;line-height:1.55;color:#4a4f5a}
  .brand{position:absolute;left:56px;bottom:48px;display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:#16181d;letter-spacing:.02em}
  .brand svg{width:28px;height:28px}
  .card{position:absolute;left:472px;top:${Math.round((800 - card) / 2)}px;width:768px;height:${card}px;border-radius:18px;overflow:hidden;background:#f3f0e8;
    box-shadow:0 24px 60px rgba(22,24,29,.16),0 2px 6px rgba(22,24,29,.08);border:1px solid #e3ddd0}
  iframe{border:0;width:${width}px;height:${Math.ceil(card / scale)}px;transform:scale(${scale});transform-origin:0 0}
  </style></head><body>
  <div class="text"><div class="kicker">${escape(kicker)}</div><h1>${escape(title)}</h1><p>${escape(body)}</p></div>
  <div class="brand">${MARK}<span>VESTIARION</span></div>
  <div class="card"><iframe src="${BASE}/docs-shots/${shot}" scrolling="no"></iframe></div>
  </body></html>`;
}

function iconPage(size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:#16181d}
  .tile{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center}
  .tile svg{width:${Math.round(size * 0.66)}px;height:${Math.round(size * 0.66)}px}
  </style></head><body><div class="tile">${MARK}</div></body></html>`;
}

function draw(html, width, height, scale, out) {
  const dir = mkdtempSync(path.join(tmpdir(), "vx-listing-"));
  try {
    const page = path.join(dir, "page.html");
    writeFileSync(page, html);
    mkdirSync(path.dirname(out), { recursive: true });
    const run = spawnSync(
      EDGE,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--user-data-dir=${path.join(dir, "profile")}`,
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        "--virtual-time-budget=8000",
        `--screenshot=${out}`,
        pathToFileURL(page).href,
      ],
      { stdio: "ignore", timeout: 120_000 }
    );
    if (run.status !== 0) throw new Error(`Edge could not draw ${path.relative(ROOT, out)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const image of IMAGES) {
  draw(listingPage(image), 1280, 800, 2, path.join(OUT, image.file));
  console.log(`${image.file}: 2560 x 1600`);
}
draw(iconPage(512), 512, 512, 1, path.join(OUT, "pipedrive", "icon-512.png"));
draw(iconPage(128), 128, 128, 1, path.join(OUT, "asana", "icon-128.png"));
console.log("pipedrive/icon-512.png, asana/icon-128.png");
