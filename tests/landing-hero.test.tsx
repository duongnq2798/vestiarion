import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { PRODUCT_HUNT_BADGE } from "@/lib/site-links";

/**
 * The landing page's promise, as the server renders it (hosted wallets H8).
 * It offers an Arc testnet wallet in one click only where the deployment has
 * the hosted pair. Either way it states what the product does, plainly: Arc
 * testnet is named as the network it runs on, and nothing apologises for it.
 */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");

const hero = (hostedAvailable: boolean) =>
  text(renderToStaticMarkup(<TooltipProvider><Hero provenance={[]} head={[]} hostedAvailable={hostedAvailable} /></TooltipProvider>));
const finalCta = (hostedAvailable: boolean) => text(renderToStaticMarkup(<FinalCta hostedAvailable={hostedAvailable} />));

/** Disclaimers that talk the product down instead of saying what it does. */
const DISCLAIMERS = [/no real money/i, /no real funds/i, /not real money/i, /fictional/i, /simulated money/i];

describe("the landing hero", () => {
  it("with the hosted pair: an Arc testnet wallet in one click, funded from Circle's faucet, or a wallet you hold on Arc mainnet", () => {
    const words = hero(true);
    expect(words).toContain(
      "Email sign-in and a workspace of your own. On Arc testnet, a wallet in one click and USDC from Circle's faucet; on Arc mainnet, the agent pays from a wallet you hold."
    );
    expect(words).toContain("Try it on your bills");
  });

  it("speaks to the owner whose bills it pays, and leads into shadow mode (landing owner hero L1)", () => {
    const words = hero(true);
    expect(words).toContain("The agent pays your bills. Evidence remains.");
    expect(words).toContain("An agent for your bills · Live on Arc mainnet");
    expect(words).toContain("Try it beside how you pay today: the agent decides each bill, and you agree or disagree, on Arc testnet.");
    expect(words).toContain("Once you trust it, it pays your real bills in USDC on Arc mainnet, within the spending limits you set.");
    expect(words).toContain("Every decision, refusals included, is signed into a chain anyone can verify.");
    const markup = renderToStaticMarkup(<TooltipProvider><Hero provenance={[]} head={[]} hostedAvailable /></TooltipProvider>);
    expect(markup).toMatch(/<a [^>]*href="\/docs\/guides\/shadow-mode"[^>]*>How shadow mode works/);
    // Its call to action ticks shadow mode on the form that creates the workspace.
    expect(markup).toMatch(/<a [^>]*href="\/onboarding\?shadow=1"[^>]*>Try it on your bills/);
  });

  it("without it: a workspace of your own, with Circle connected from Settings", () => {
    const words = hero(false);
    expect(words).toContain("Email sign-in, then a workspace of your own. Connect your Circle account from Settings to pay on Arc testnet or Arc mainnet.");
    expect(words).toContain("Open a workspace");
    expect(words).not.toContain("one click");
  });

  it.each([true, false])("never talks the product down (hosted: %s)", (hostedAvailable) => {
    const words = hero(hostedAvailable);
    for (const phrase of DISCLAIMERS) expect(words).not.toMatch(phrase);
  });

  it("shows Product Hunt's badge, opening Vestiarion's page there in a new tab", () => {
    const markup = renderToStaticMarkup(<TooltipProvider><Hero provenance={[]} head={[]} hostedAvailable /></TooltipProvider>).replace(/&amp;/g, "&");
    const badge = [...markup.matchAll(/<a\b([^>]*)>\s*<img\b([^>]*)>/g)].find((match) => match[1].includes(`href="${PRODUCT_HUNT_BADGE.href}"`));
    expect(badge, "a link holding the badge image").toBeDefined();
    expect(badge?.[1]).toContain('target="_blank"');
    expect(badge?.[1]).toContain('rel="noopener noreferrer"');
    expect(badge?.[2]).toContain(`src="${PRODUCT_HUNT_BADGE.src}"`);
    expect(badge?.[2]).toContain(`alt="${PRODUCT_HUNT_BADGE.alt}"`);
    expect(badge?.[2]).toContain('width="250"');
    expect(badge?.[2]).toContain('height="54"');
  });
});

describe("the landing page's final call to action", () => {
  it("with the hosted pair: a wallet one click away in Settings, and the agent at work", () => {
    const words = finalCta(true);
    expect(words).toContain("Open a workspace. Put the agent to work on Arc.");
    expect(words).toContain("Try it on Arc testnet with a wallet added in one click from Settings and USDC from Circle's faucet");
    expect(words).toContain("open a workspace on Arc mainnet and the agent pays your invoices and contractors in real USDC, from a wallet you hold.");
    expect(words).toContain("Open a workspace");
  });

  it("without it: a workspace, and Circle connected when you are ready", () => {
    const words = finalCta(false);
    expect(words).toContain("Open a workspace. See the agent decide.");
    expect(words).toContain("Connect your Circle account from Settings");
    expect(words).not.toContain("one click");
  });

  it.each([true, false])("never talks the product down (hosted: %s)", (hostedAvailable) => {
    const words = finalCta(hostedAvailable);
    for (const phrase of DISCLAIMERS) expect(words).not.toMatch(phrase);
  });
});
