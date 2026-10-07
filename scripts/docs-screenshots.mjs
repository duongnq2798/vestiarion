#!/usr/bin/env node
/**
 * Photographs the user guides' step screenshots into public/docs/guides/
 * (workspace-delete-footer-screenshots design S2).
 *
 *   npm run docs:screenshots                 build, serve, photograph every shot
 *   npm run docs:screenshots -- --skip-build reuse the build already in .next
 *   npm run docs:screenshots -- go-live-fund photograph only the shots named
 *
 * Run it by hand after changing a screen a guide shows: the Go live panel, the
 * counterparty or invoice form, a decision or approval card, the audit log.
 * Then look at each PNG before committing it.
 *
 * What it does:
 * 1. `next build` with DOCS_SCREENSHOTS=1, then `next start` with the flag on
 *    a free port. The flag is what lets /docs-shots/<name> answer; everywhere
 *    else that route is a 404 (src/app/docs-shots/[shot]/page.tsx).
 * 2. Starts headless Edge with a throwaway profile (never the user's own) and
 *    drives it over the DevTools protocol: a fixed 1200 px viewport, reduced
 *    motion, analytics blocked, and a stand-in browser wallet that answers
 *    nothing, so the own-wallet steps show as they do where a wallet is
 *    installed (but for the passkey choice, shown as a browser with none
 *    sees it). Each shot is loaded, prepared (a disclosure opened, a form
 *    filled, a dialog opened, Verify answered), and clipped to its frame,
 *    `[data-docs-shot]`.
 * 3. Stops the server and Edge it started, and nothing else, then deletes
 *    .next/types so tsc does not read the build's route types.
 *
 * The build it leaves in .next does not serve the shots: the route reads the
 * flag per request (it is `force-dynamic`), so a server started without the
 * flag answers 404, whatever the build saw. Vercel builds and runs without
 * the flag, so production never serves /docs-shots either way.
 *
 * No npm package: Node's global WebSocket and fetch speak to Edge directly.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "docs", "guides");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** The viewport's width in CSS pixels; each frame is 760 px wide inside it. */
const VIEWPORT_WIDTH = 1200;
/** Pixels per CSS pixel: sharp on a high-density screen, and each PNG stays small. */
const SCALE = 2;
/** Room above and below the frame, so a dialog opened over it sits in the middle. */
const MARGIN = 40;

/**
 * Every shot src/app/docs-shots/shots.tsx renders, with what to do before the
 * picture. `tests/docs-screenshots.test.ts` holds this list to that one.
 */
const SHOTS = {
  "go-live-checklist": async () => {},
  "go-live-choose": async () => {},
  "go-live-own-account": async (page) => {
    await page.click(`[...document.querySelectorAll("summary")].find((s) => s.textContent.trim() === "Connect your own Circle account")`);
  },
  "go-live-create-wallets": async () => {},
  "go-live-fund": async () => {},
  "go-live-confirm": async (page) => {
    await page.click(`[...document.querySelectorAll("[data-docs-shot] button")].find((b) => b.textContent.trim() === "Go live")`);
    await page.waitFor(`document.querySelector("[role=alertdialog]")?.textContent.includes("Take this workspace live?")`);
  },
  "go-live-own-wallet": async () => {},
  "go-live-wallet-deploy": async (page) => {
    await page.fill({ "wallet-treasury-daily": "50", "wallet-treasury-weekly": "200" });
  },
  "go-live-wallet-ready": async () => {},
  "go-live-passkey-choice": async () => {},
  "go-live-passkey-fund": async () => {},
  "go-live-passkey-setup": async (page) => {
    await page.fill({ "passkey-treasury-daily": "50", "passkey-treasury-weekly": "200" });
  },
  "go-live-passkey-recovery": async () => {},
  "go-live-wallet-controls": async () => {},
  "go-live-passkey-phone": async (page) => {
    await page.waitFor(`document.querySelector("details[open] svg[role=img]")`);
  },
  "go-live-live": async () => {},
  "go-live-usyc": async () => {},
  "first-payment-counterparty": async (page) => {
    await page.fill({
      "cp-name": "Northstar Studio",
      "cp-limit": "50.00",
      "cp-address": `0x${"c0ffee00".repeat(5)}`,
      "cp-jurisdiction": "US",
      "cp-notice-email": "accounts@northstar.example",
    });
  },
  "first-payment-address": async () => {},
  "first-payment-invoice": async (page) => {
    await page.click(`document.getElementById("invoice-counterparty")`);
    await page.waitFor(`[...document.querySelectorAll("[role=option]")].some((o) => o.textContent.includes("Northstar Studio"))`);
    await page.click(`[...document.querySelectorAll("[role=option]")].find((o) => o.textContent.includes("Northstar Studio"))`);
    await page.waitFor(`!document.querySelector("[role=listbox]")`);
    await page.fill({ "invoice-amount": "12.50", "invoice-due": "2026-10-15", "invoice-memo": "October design retainer", "invoice-po": "PO-2207" });
    await page.click(`document.getElementById([...document.querySelectorAll("label")].find((l) => l.textContent.trim() === "Goods or services received").htmlFor)`);
  },
  "first-payment-document": async () => {},
  "first-payment-decision": async () => {},
  "first-payment-trail": async () => {},
  "first-payment-reminders": async () => {},
  "first-payment-needs-you": async () => {},
  "first-payment-stopped": async () => {},
  "first-payment-approval": async () => {},
  "first-payment-approval-own": async () => {},
  "first-payment-approval-yours": async () => {},
  "first-payment-add-details": async (page) => {
    await page.click(`[...document.querySelectorAll("[data-docs-shot] button")].find((b) => b.textContent.trim() === "Add details")`);
    await page.waitFor(`document.querySelector("[role=dialog]")?.textContent.includes("Add details to Bluebird Logistics")`);
    await page.fill({ "details-po-00000000-0000-4000-8000-0000000000e3": "PO-2213" });
    await page.click(`document.querySelector("[role=dialog] [role=checkbox]")`);
    await page.waitFor(`document.querySelector("[role=dialog] [role=checkbox]")?.dataset.state === "checked"`);
  },
  "first-payment-onchain-limit": async () => {},
  "first-payment-audit": async (page) => {
    // Verify asks /api/ledger/verify, which needs a signed-in member and a ledger. The frame carries the
    // answer this chain would get; the page's fetch is answered with it, and the component does the rest.
    await page.evaluate(`(() => {
      const answer = document.querySelector("[data-docs-shot]").dataset.verifyResponse;
      const real = window.fetch.bind(window);
      window.fetch = (input, init) =>
        String(input instanceof Request ? input.url : input).includes("/api/ledger/verify")
          ? Promise.resolve(new Response(answer, { status: 200, headers: { "content-type": "application/json" } }))
          : real(input, init);
    })()`);
    await page.click(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Verify hash chain")`);
    await page.waitFor(`document.querySelector("[data-docs-shot]").textContent.includes("Chain intact")`);
  },
  "pay-freelancer": async (page) => {
    await page.fill({
      "freelancer-name": "Linh Tran",
      "freelancer-email": "linh@example.com",
      "freelancer-work": "10 social posts for October",
      "freelancer-amount": "25.00",
      "freelancer-evidence": "https://www.canva.com/design/october-posts/view",
    });
  },
  "held-milestone": async () => {},
  "get-paid-address": async (page) => {
    await page.fill({ "payee-address": `0x${"5a1e".repeat(10)}` });
  },
  "get-paid-check": async (page) => {
    await page.fill({ "payee-address": `0x${"5a1e".repeat(10)}` });
    await page.click(`[...document.querySelectorAll("[data-docs-shot] button")].find((b) => b.textContent.trim() === "Continue")`);
    await page.waitFor(`document.querySelector("[data-docs-shot]").textContent.includes("Check your address")`);
    await page.click(`document.querySelectorAll("[data-docs-shot] [role=checkbox]")[0]`);
    await page.click(`document.querySelectorAll("[data-docs-shot] [role=checkbox]")[1]`);
    await page.click(`document.querySelectorAll("[data-docs-shot] [role=checkbox]")[2]`);
    await page.waitFor(`[...document.querySelectorAll("[data-docs-shot] button")].some((b) => b.textContent.trim() === "Send my address" && !b.disabled)`);
  },
  "get-paid-confirming": async () => {},
  "get-paid-paid": async () => {},
  "telegram-connect": async () => {},
  "slack-settings": async () => {},
  "email-inbox-settings": async () => {},
  "email-inbox-ap": async () => {},
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Stops a process this script started, with its children, and nothing else. */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function run(args, env) {
  const result = spawnSync(process.execPath, [NEXT_BIN, ...args], { cwd: ROOT, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`next ${args.join(" ")} exited with ${result.status}`);
}

async function waitForHttp(url, ok, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (ok(response)) return response;
    } catch {}
    if (Date.now() > deadline) throw new Error(`${what} did not answer at ${url}`);
    await sleep(300);
  }
}

/** A small DevTools-protocol client for one page. */
async function connect(cdpPort) {
  const version = await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, (r) => r.ok, "Edge", 20000);
  await version.json();
  let target;
  for (let i = 0; i < 40 && !target; i += 1) {
    target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === "page");
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("Edge opened no page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`in the page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n${expression}`);
    return result.result.value;
  };

  const waitFor = async (expression, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate(`Boolean(${expression})`))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
      await sleep(100);
    }
  };

  const settle = async () => {
    // Finish any transition at once, so the picture is of where it ends.
    await evaluate(`document.getAnimations().forEach((a) => { try { a.finish(); } catch {} })`);
    await sleep(150);
  };

  /** A real click, pointer events and all (Radix opens on pointerdown), at the middle of the element `expression` finds. */
  const click = async (expression) => {
    await waitFor(expression);
    const point = await evaluate(`(() => {
      const el = ${expression};
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    await sleep(250);
    await settle();
  };

  /** Types values into inputs by id, as a person would leave them: no focus ring, no caret. */
  const fill = async (values) => {
    await evaluate(`(() => {
      const values = ${JSON.stringify(values)};
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      for (const [id, value] of Object.entries(values)) {
        const input = document.getElementById(id);
        if (!input) throw new Error("no input #" + id);
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    })()`);
  };

  return { send, evaluate, waitFor, settle, click, fill, close: () => ws.close() };
}

async function photograph(page, base, name, prepare) {
  await page.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT_WIDTH, height: 900, deviceScaleFactor: SCALE, mobile: false });
  await page.send("Page.navigate", { url: `${base}/docs-shots/${name}` });
  await page.waitFor(`document.readyState === "complete" && document.querySelector("[data-docs-shot]")`, 30000);
  await page.evaluate(`document.fonts.ready.then(() => true)`);
  await sleep(300);

  // The viewport is as tall as the frame and its margins, so nothing scrolls and a dialog centres over the frame.
  const height = await page.evaluate(`Math.ceil(document.querySelector("[data-docs-shot]").getBoundingClientRect().bottom + ${MARGIN})`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT_WIDTH, height, deviceScaleFactor: SCALE, mobile: false });
  await sleep(200);

  await prepare(page);
  await page.evaluate(`(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await page.settle();

  const rect = await page.evaluate(`(() => {
    const r = document.querySelector("[data-docs-shot]").getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  })()`);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  const file = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return { file, bytes: Buffer.byteLength(data, "base64") };
}

/**
 * What this run started, at module scope so a signal handler reaches it:
 * main records each process as it spawns it, and the Edge profile it made.
 */
const started = { server: undefined, edge: undefined, profile: undefined };

/**
 * Ctrl+C or SIGTERM mid-run: the `finally` in main never runs when Node exits
 * on a signal, so stop Edge and the server here, remove the throwaway profile,
 * and exit 130, the shell's code for an interrupted command.
 */
function interrupted() {
  stop(started.edge);
  stop(started.server);
  if (started.profile) {
    try {
      rmSync(started.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Edge may still hold it for a moment; the OS cleans the temp dir.
    }
  }
  process.exit(130);
}

async function main() {
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const args = process.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  const names = args.filter((arg) => !arg.startsWith("--"));
  for (const name of names) if (!Object.hasOwn(SHOTS, name)) throw new Error(`no shot named ${name}; the shots are ${Object.keys(SHOTS).join(", ")}`);
  const wanted = names.length > 0 ? names : Object.keys(SHOTS);
  if (!existsSync(EDGE)) throw new Error(`Edge is not at ${EDGE}; set EDGE_PATH`);

  // The passkey card shows only where a mainnet client key is built in: a stand-in where none is, never called here.
  const env = {
    ...process.env,
    DOCS_SCREENSHOTS: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY: process.env.NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY || "docs-shots-client-key",
  };
  if (!skipBuild) run(["build"], env);

  const port = await freePort();
  const cdpPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const profile = mkdtempSync(path.join(tmpdir(), "vestiarion-docs-shots-edge-"));
  started.profile = profile;
  let page;
  try {
    started.server = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32",
    });
    await waitForHttp(`${base}/docs-shots/${wanted[0]}`, (r) => r.status === 200, "next start (with DOCS_SCREENSHOTS=1)", 60000);

    started.edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], {
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    page = await connect(cdpPort);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", { urls: ["*googletagmanager.com*", "*google-analytics.com*"] });
    // A wallet that never answers: the pages find one, and nothing a shot does asks it anything. The passkey choice is
    // shown as a browser with no wallet sees it. Headless Edge keeps no passkey of its own: the shots say it does, as most
    // computers do, but the phone handoff's, which shows a computer that keeps none.
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: [
        'if (!location.pathname.endsWith("/go-live-passkey-choice")) window.ethereum = { request: () => new Promise(() => {}) };',
        'if (window.PublicKeyCredential) window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => !location.pathname.endsWith("/go-live-passkey-phone");',
      ].join("\n"),
    });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "light" }] });

    mkdirSync(OUT_DIR, { recursive: true });
    for (const name of wanted) {
      const { file, bytes } = await photograph(page, base, name, SHOTS[name]);
      console.log(`  ${path.relative(ROOT, file)}  ${(bytes / 1024).toFixed(0)} KB`);
    }
  } finally {
    await page?.send("Browser.close").catch(() => {});
    page?.close();
    await sleep(500);
    stop(started.edge);
    stop(started.server);
    await sleep(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(path.join(ROOT, ".next", "types"), { recursive: true, force: true });
  }

  console.log(
    [
      "",
      `Wrote ${wanted.length} screenshot${wanted.length === 1 ? "" : "s"} to public/docs/guides/. Look at each before committing it.`,
      "The build in .next does not serve them: /docs-shots reads DOCS_SCREENSHOTS per request, so `next start` without the flag",
      "answers 404 there. The next deploy is unaffected: Vercel builds and serves without the flag.",
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
