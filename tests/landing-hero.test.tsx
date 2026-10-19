import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GUIDED_SETUP_HREF, TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { EXTENSION_ICON, INVOICE_CAPTURE_GUIDE } from "@/components/landing/hero/InvoiceCapture";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { STORE_URL } from "@/lib/extension/settings";
import { PRODUCT_HUNT_BADGE } from "@/lib/site-links";

/**
 * The landing page's promise, as the server renders it (docs/superpowers/specs/2026-10-11-landing-clarity-design.md):
 * what Vestiarion is in the first line, what it does with a bill in plain words, one call to action
 * that leads into shadow mode everywhere it appears, and what trying it asks of you. Nothing apologises for the product.
 */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const hero = () => renderToStaticMarkup(<Hero />);
const finalCta = () => renderToStaticMarkup(<FinalCta />);

/** Disclaimers that talk the product down instead of saying what it does. */
const DISCLAIMERS = [/no real money/i, /no real funds/i, /not real money/i, /fictional/i, /simulated money/i];

/** Words a business owner should not need to read before knowing what the product does. */
const JARGON = [/ledger/i, /hash/i, /chain/i, /Ed25519/, /testnet/i, /mainnet/i, /guardrail/i, /counterparty/i, /\bap · /];

describe("the landing hero", () => {
  it("says what it is in plain words, and what it does with a bill (H1)", () => {
    const words = text(hero());
    expect(words).toContain("Your AI agent for bills and payments");
    expect(words).toContain("Every bill. A clear way through.");
    expect(words).toContain(
      "Vestiarion's agent reviews each invoice from your contractors and suppliers and tells you whether it's ready to pay, should wait, or needs you, and why. Within limits you set, it pays the ready ones in USDC."
    );
    expect(hero()).toMatch(/<h1\b[^>]*id="hero-title"[^>]*>Your AI agent for bills and payments<\/h1>/);
  });

  it("leads into shadow mode, and says trying it needs no wallet or funds", () => {
    const markup = hero();
    const start = markup.match(new RegExp(`<a [^>]*href="${TRY_HREF.replace("?", "\\?")}"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? "";
    expect(text(start)).toContain(TRY_LABEL);
    expect(TRY_HREF).toBe("/onboarding?shadow=1");
    expect(markup).toMatch(/<a [^>]*href="#how-it-works"[^>]*>See how it works/);
    expect(markup).toMatch(/<a [^>]*href="\/docs\/guides\/shadow-mode"[^>]*>How shadow mode works/);
    const words = text(markup);
    expect(words).toContain("Start in shadow mode. Keep paying the way you do today while the agent decides on your real bills. No wallet or funds needed.");
    expect(words).toContain("Email sign-in, no password");
  });

  it("keeps the message, call to action and entry requirements before Invoice Capture", () => {
    const words = text(hero());
    const order = ["Every bill. A clear way through.", TRY_LABEL, "Start in shadow mode.", "No wallet or funds needed.", "Capture invoices from Chrome"].map((part) =>
      words.indexOf(part)
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The shadow-mode note remains plain prose, without a rule beside it.
    expect(hero()).not.toContain("border-l-2");
  });

  it("says what Invoice Capture does, a draft and nothing more, and its guide where it cannot be installed", () => {
    const markup = hero();
    const words = text(markup);
    expect(words).toContain("Capture invoices from Chrome Send an invoice from any page to your workspace as a draft.");
    const guide = markup.match(new RegExp(`<a [^>]*href="${INVOICE_CAPTURE_GUIDE}"[^>]*>`))?.[0] ?? "";
    expect(guide).toContain("pointer-fine:hidden");
    expect(words).toContain("Learn about Invoice Capture");
    // It never adds a bill, approves or pays: the words promise none of it.
    for (const claim of [/extension (adds|approves|pays|sends money)/i, /install vestiarion/i]) expect(words).not.toMatch(claim);
  });

  it("offers Add to Chrome as a small button with the extension's own icon, where it can be installed, in a new tab", () => {
    const markup = hero();
    const link = markup.match(/<a [^>]*data-cta="hero-chrome"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain(`href="${STORE_URL}"`);
    expect(STORE_URL).toBe("https://chromewebstore.google.com/detail/vestiarion-invoice-captur/jfhjgbdbolhnneomgifdnjamoldlioan");
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toMatch(/<img src="\/extension\/invoice-capture-48\.png" alt="" aria-hidden="true" width="18" height="18"/);
    expect(text(link)).toContain("Add to Chrome");
    expect(link).toContain("opens in a new tab");
    // Chrome installs extensions on a computer: the button shows to a mouse or trackpad only, in CSS, the same on the
    // server and in the browser; it is the small secondary button, below the call to action in weight.
    const classes = link.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
    for (const name of ["hidden", "pointer-fine:inline-flex", "h-8", "bg-surface/80"]) expect(classes).toContain(name);
    expect(classes).not.toContain("bg-agent");
    // The puzzle piece is gone, and Chrome's logo, Google's mark, is drawn nowhere.
    expect(markup).not.toContain("lucide-puzzle");
    expect(markup).not.toContain("chrome-web-store");
  });

  it("draws the extension's own icon, the one its store page shows", () => {
    const served = readFileSync(path.join(process.cwd(), "public", EXTENSION_ICON.src));
    const shipped = readFileSync(path.join(process.cwd(), "extensions/chrome-invoice-capture/extension/icons/icon-48.png"));
    expect(served.equals(shipped)).toBe(true);
  });

  it("links the README to the store with a button like its others, the extension's own mark on it and no Chrome logo", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain(`<a href="${STORE_URL}"><img src="docs/assets/readme/add-to-chrome.svg" alt="Add to Chrome: Vestiarion Invoice Capture`);
    // The four buttons on the README's first row are drawn alike: the same size, the same dark ground and rim.
    const files = [...readme.matchAll(/<img src="(docs\/assets\/readme\/[\w-]+\.svg)"[^>]*height="48">/g)].map((match) => match[1]);
    expect(files).toEqual(["docs/assets/readme/open-the-app.svg", "docs/assets/readme/watch-the-demo.svg", "docs/assets/readme/add-to-chrome.svg", "docs/assets/readme/npm-sdk.svg"]);
    const frame = (svg: string) => svg.match(/^<svg [^>]*width="(\d+)" height="(\d+)"[\s\S]*?<rect [^>]*fill="(#\w+)" stroke="(#\w+)"/)?.slice(1);
    const frames = files.map((file) => frame(readFileSync(path.join(process.cwd(), file), "utf8")));
    for (const each of frames) expect(each).toEqual(frames[0]);
    // Add to Chrome carries the brand mark the store lists the extension with, path for path, and none of Chrome's colours.
    const chrome = readFileSync(path.join(process.cwd(), "docs/assets/readme/add-to-chrome.svg"), "utf8");
    expect(chrome).toContain("ADD TO CHROME");
    expect(chrome).toContain("Invoice Capture");
    for (const drawing of readFileSync(path.join(process.cwd(), "src/app/icon.svg"), "utf8").match(/<(?:path|circle)\b[^>]*\/>/g) ?? []) {
      expect(chrome).toContain(drawing);
    }
    expect(chrome).not.toMatch(/#4285F4|#EA4335|#FBBC05|#34A853/i);
    expect(existsSync(path.join(process.cwd(), "public/badges/chrome-web-store.png"))).toBe(false);
  });

  it("keeps the technical vocabulary out of the first screen", () => {
    const words = text(hero());
    for (const term of JARGON) expect(words).not.toMatch(term);
  });

  it("never talks the product down", () => {
    const words = text(hero());
    for (const phrase of DISCLAIMERS) expect(words).not.toMatch(phrase);
  });

  it("no longer carries the Product Hunt badge, which the footer shows", () => {
    expect(hero()).not.toContain(PRODUCT_HUNT_BADGE.src);
    const footer = renderToStaticMarkup(<SiteFooter />).replace(/&amp;/g, "&");
    const badge = [...footer.matchAll(/<a\b([^>]*)>\s*<img\b([^>]*)>/g)].find((match) => match[1].includes(`href="${PRODUCT_HUNT_BADGE.href}"`));
    expect(badge, "a link holding the badge image").toBeDefined();
    expect(badge?.[1]).toContain('target="_blank"');
    expect(badge?.[1]).toContain('rel="noopener noreferrer"');
    expect(badge?.[2]).toContain(`alt="${PRODUCT_HUNT_BADGE.alt}"`);
    expect(badge?.[2]).toContain('loading="lazy"');
  });
});

describe("the landing page's one call to action", () => {
  it("is the same step in the header, its menu, the hero and the close, each tagged for counting", () => {
    const header = renderToStaticMarkup(<SiteHeader landing />);
    const start = header.match(/<a [^>]*data-cta="header-start"[^>]*>/)?.[0] ?? "";
    expect(start).toContain(`href="${TRY_HREF}"`);
    expect(hero()).toContain('data-cta="hero-try"');
    expect(finalCta()).toContain('data-cta="final-try"');
    const menu = readFileSync(path.join(process.cwd(), "src/components/vx/SiteMenu.tsx"), "utf8");
    expect(menu).toContain("href={TRY_HREF}");
    expect(menu).not.toContain("Open console");
  });

  it("closes with what happens after the click, and a guided setup for a team that wants a call (C1)", () => {
    const markup = finalCta();
    const words = text(markup);
    expect(words).toContain("See what the agent decides on your next bill.");
    expect(words).toContain(
      "Sign in with your email, open a workspace in shadow mode and add a bill. Its decision and the reason arrive within about a minute. No wallet or funds needed to start."
    );
    for (const step of ["Sign in by email link", "Open a workspace, shadow mode on", "Add one of your bills", "Read the agent's decision and why"]) {
      expect(words).toContain(step);
    }
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${GUIDED_SETUP_HREF}"[^>]*>Set it up with us on a call</a>`));
    expect(markup).toMatch(/<a [^>]*href="\/login"[^>]*>Sign in<\/a>/);
    for (const phrase of DISCLAIMERS) expect(words).not.toMatch(phrase);
  });
});
