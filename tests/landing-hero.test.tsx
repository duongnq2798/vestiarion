import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GUIDED_SETUP_HREF, TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { CHROME_WEB_STORE_BADGE, INVOICE_CAPTURE_GUIDE } from "@/components/landing/hero/InvoiceCapture";
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
    expect(words).toContain("Every bill checked before it's paid. Every decision on record.");
    expect(words).toContain(
      "Vestiarion's agent reviews each invoice from your contractors and suppliers and tells you whether it's ready to pay, should wait, or needs you, and why. Within limits you set, it pays the ready ones in USDC."
    );
    expect(hero()).toMatch(/<h1 id="hero-title"/);
  });

  it("leads into shadow mode, and says trying it needs no wallet or funds", () => {
    const markup = hero();
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${TRY_HREF.replace("?", "\\?")}"[^>]*>${TRY_LABEL}</a>`));
    expect(TRY_HREF).toBe("/onboarding?shadow=1");
    expect(markup).toMatch(/<a [^>]*href="#how-it-works"[^>]*>See how it works<\/a>/);
    expect(markup).toMatch(/<a [^>]*href="\/docs\/guides\/shadow-mode"[^>]*>How shadow mode works/);
    const words = text(markup);
    expect(words).toContain("Start in shadow mode. Keep paying the way you do today while the agent decides on your real bills. No wallet or funds needed to start.");
    expect(words).toContain("Email sign-in, no password");
  });

  it("keeps what trying it asks of you together, under the call to action", () => {
    const markup = hero();
    const note = markup.match(/<div class="[^"]*border-l-2[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const words = text(note);
    expect(words).toContain("Start in shadow mode.");
    expect(words).toContain("Email sign-in, no password.");
    expect(note).toContain('href="/docs/guides/shadow-mode"');
  });

  it("says what Invoice Capture does, a draft and nothing more, with its guide for everyone", () => {
    const markup = hero();
    const words = text(markup);
    expect(words).toContain("Capture invoices from your browser");
    expect(words).toContain("A Chrome extension saves an invoice from any page or file to your workspace as a draft, for you to check and add.");
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${INVOICE_CAPTURE_GUIDE}"[^>]*>Learn about Invoice Capture`));
    // It never adds a bill, approves or pays: the words promise none of it.
    for (const claim of [/extension (adds|approves|pays|sends money)/i, /install vestiarion/i]) expect(words).not.toMatch(claim);
  });

  it("offers the extension through Google's own store badge, where it can be installed, in a new tab", () => {
    const markup = hero();
    const link = markup.match(/<a [^>]*data-cta="hero-chrome"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
    expect(link).toContain(`href="${STORE_URL}"`);
    expect(STORE_URL).toBe("https://chromewebstore.google.com/detail/vestiarion-invoice-captur/jfhjgbdbolhnneomgifdnjamoldlioan");
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toMatch(/<img src="\/badges\/chrome-web-store\.png" alt="Available in the Chrome Web Store" width="170" height="48"/);
    expect(link).toContain("opens in a new tab");
    // Chrome installs extensions on a computer: the badge shows to a mouse or trackpad only, in CSS, the same on the
    // server and in the browser.
    const classes = link.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
    expect(classes).toContain("hidden");
    expect(classes).toContain("pointer-fine:inline-flex");
    // The puzzle piece is gone, and no Chrome logo is drawn outside Google's badge.
    expect(markup).not.toContain("lucide-puzzle");
  });

  it("serves Google's badge as Google ships it: resized in proportion, never changed", () => {
    const file = readFileSync(path.join(process.cwd(), "public", CHROME_WEB_STORE_BADGE.src));
    // developer.chrome.com/docs/webstore/branding, "Medium PNG (with border)".
    expect(createHash("sha256").update(file).digest("hex")).toBe("fbf289fca885e58a1507cc8c69a9df68f35e83e683825b3ad6cd617b0a17d79c");
    const [width, height] = [file.readUInt32BE(16), file.readUInt32BE(20)];
    expect([width, height]).toEqual([340, 96]);
    expect(CHROME_WEB_STORE_BADGE.width / CHROME_WEB_STORE_BADGE.height).toBeCloseTo(width / height, 2);
  });

  it("shows two sample bills in the product's own words, labelled as samples (H2)", () => {
    const words = text(hero());
    for (const part of [
      "Bills & receivables",
      "Sample bills",
      "Agent proposes: pay it",
      "Waiting for your verdict",
      "Agent's reasoning",
      "Do you agree with the agent?",
      "Agree and pay",
      "Held for you",
      "Blocked by code, not by the model. It is above the payee's payment limit.",
      "Two sample bills in shadow mode. The labels, checks and outcomes are the product's own; the payees and amounts are examples.",
    ]) {
      expect(words).toContain(part);
    }
    // The sample's controls are drawn, not pressable, and a screen reader hears that they are a sample's.
    expect(hero()).not.toMatch(/<button\b/);
    expect(hero()).toMatch(/<div aria-hidden="true" class="[^"]*cursor-default[^"]*"><span[^>]*>Agree and pay<\/span>/);
    expect(text(hero())).toContain("In the product: Agree and pay, or Disagree. Shown here as a sample.");
    // An agent's proposal is not a payment: the first bill waits for a person.
    expect(text(hero())).not.toContain("Agent: pay it");
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
