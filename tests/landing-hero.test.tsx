import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

  it("keeps to three groups: the message, the call to action with what it asks of you, then Invoice Capture", () => {
    const words = text(hero());
    const order = ["Every bill checked", TRY_LABEL, "Start in shadow mode.", "No wallet or funds needed to start.", "Capture invoices from Chrome"].map((part) =>
      words.indexOf(part)
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Space sets the groups apart: no rule beside the shadow-mode note, none above Invoice Capture.
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

  it("links the README to the store with Google's badge as Google ships it, and draws no Chrome logo of its own", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain(`<a href="${STORE_URL}"><img src="public/badges/chrome-web-store.png" alt="Available in the Chrome Web Store`);
    const badge = readFileSync(path.join(process.cwd(), "public/badges/chrome-web-store.png"));
    // developer.chrome.com/docs/webstore/branding, "Medium PNG (with border)", unchanged.
    expect(createHash("sha256").update(badge).digest("hex")).toBe("fbf289fca885e58a1507cc8c69a9df68f35e83e683825b3ad6cd617b0a17d79c");
    expect([badge.readUInt32BE(16), badge.readUInt32BE(20)]).toEqual([340, 96]);
    // The README's buttons no longer redraw Chrome's logo: no chrome icon, none of its four colours' blue centre.
    const buttons = readFileSync(path.join(process.cwd(), "scripts/readme-buttons.mjs"), "utf8");
    expect(buttons).not.toMatch(/\bchrome:\s*`|icon: "chrome"|#4285F4/i);
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
    // The drawn Agree and pay is quieter than the page's own call to action: never solid agent blue.
    const drawn = hero().match(/<span class="([^"]*)">Agree and pay<\/span>/)?.[1].split(" ") ?? [];
    expect(drawn).toContain("bg-agent-soft");
    expect(drawn).not.toContain("bg-agent");
  });

  it("draws the two sample bills as rows of one list, each headed alike", () => {
    const markup = hero();
    // One card: the held bill is the list's next row, not a second card tucked under the first.
    expect(markup).not.toContain("-mt-px");
    expect(markup).not.toContain("rounded-b-2xl");
    // Both rows: a payee's initial, name, invoice and amount in the same sizes.
    const amounts = [...markup.matchAll(/<p class="([^"]*)">(2,400\.00|6,500\.00)<span/g)].map((match) => match[1]);
    expect(amounts).toHaveLength(2);
    expect(amounts[0]).toBe(amounts[1]);
    const words = text(markup);
    expect(words).toContain("Northwind Dev Invoice 0412 · milestone 2 of 3 2,400.00 USDC");
    expect(words).toContain("Kestrel Design Invoice 0931 · campaign assets 6,500.00 USDC");
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
