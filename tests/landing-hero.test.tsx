import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GUIDED_SETUP_HREF, TRY_HREF, TRY_LABEL } from "@/components/landing/cta";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
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

  it("offers the Chrome extension from its store page, quietly, in a new tab", () => {
    const markup = hero();
    const link = markup.match(/<a [^>]*data-cta="hero-chrome"[^>]*>/)?.[0] ?? "";
    expect(link).toContain(`href="${STORE_URL}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    const words = text(markup);
    expect(words).toContain("Add to Chrome");
    expect(words).toContain("Send an invoice from any page to your workspace as a draft.");
  });

  it("shows two sample bills in the product's own words, labelled as samples (H2)", () => {
    const words = text(hero());
    for (const part of [
      "Bills & receivables",
      "Sample bills",
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
    // The sample's controls are drawn, not pressable.
    expect(hero()).not.toMatch(/<button\b/);
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
