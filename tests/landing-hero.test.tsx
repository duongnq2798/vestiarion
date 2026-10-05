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
  it("with the hosted pair: an Arc testnet wallet in one click, funded from Circle's faucet", () => {
    const words = hero(true);
    expect(words).toContain(
      "Email sign-in, a workspace of your own, and an Arc testnet wallet in one click. Fund it with USDC from Circle's faucet, and the agent pays from it."
    );
    expect(words).toContain("Start on Arc testnet");
  });

  it("without it: a workspace of your own, with Circle connected from Settings", () => {
    const words = hero(false);
    expect(words).toContain("Email sign-in, then a workspace of your own. Connect your Circle account from Settings to pay on Arc testnet.");
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
    expect(words).toContain("Add an Arc testnet wallet in one click from Settings");
    expect(words).toContain("USDC from Circle's faucet");
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
