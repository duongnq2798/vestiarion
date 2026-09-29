import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FinalCta } from "@/components/landing/FinalCta";
import { Hero } from "@/components/landing/Hero";
import { TooltipProvider } from "@/components/ui/Tooltip";

/**
 * The landing page's promise, as the server renders it (hosted wallets H8).
 * It offers a real Arc testnet wallet only where the deployment has the
 * hosted pair; without it, the copy is the sandbox-only one it replaced.
 */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");

const hero = (hostedAvailable: boolean) =>
  text(renderToStaticMarkup(<TooltipProvider><Hero provenance={[]} head={[]} hostedAvailable={hostedAvailable} /></TooltipProvider>));
const finalCta = (hostedAvailable: boolean) => text(renderToStaticMarkup(<FinalCta hostedAvailable={hostedAvailable} />));

describe("the landing hero", () => {
  it("with the hosted pair: a real Arc testnet wallet in one click, funded from Circle's faucet", () => {
    const words = hero(true);
    expect(words).toContain(
      "Email sign-in, a workspace of your own, and a real Arc testnet wallet in one click. Fund it with testnet USDC from Circle's faucet; no real money moves."
    );
    expect(words).toContain("Try it on Arc testnet");
    expect(words).not.toContain("No wallet, no real funds");
    expect(words).not.toContain("Try it with simulated money");
  });

  it("without it: a sandbox of your own, no wallet and no real funds", () => {
    const words = hero(false);
    expect(words).toContain("Email sign-in, then a sandbox workspace of your own. No wallet, no real funds.");
    expect(words).toContain("Try it with simulated money");
    expect(words).not.toContain("real Arc testnet wallet");
    expect(words).not.toContain("Try it on Arc testnet");
  });
});

describe("the landing page's final call to action", () => {
  it("with the hosted pair: a sandbox to start, and a real Arc testnet wallet one click away in Settings", () => {
    const words = finalCta(true);
    expect(words).toContain("A real Arc testnet wallet is one click away in Settings");
    expect(words).toContain("testnet USDC from Circle's faucet");
    expect(words).toContain("no real money");
    expect(words).toContain("Start a sandbox workspace");
    expect(words).not.toContain("Keep the money fictional");
    expect(words).not.toContain("requires separate wallet setup");
  });

  it("without it: today's copy, fictional money and a separate wallet setup", () => {
    const words = finalCta(false);
    expect(words).toContain("Give the agent a sandbox. Keep the money fictional.");
    expect(words).toContain("requires separate wallet setup");
    expect(words).toContain("Start a sandbox workspace");
    expect(words).not.toContain("one click away");
  });
});
