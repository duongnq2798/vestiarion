import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "@/components/landing/Hero";
import { TooltipProvider } from "@/components/ui/Tooltip";

/** The landing hero's promise, as the server renders it (hosted wallets H8). */
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");

describe("the landing hero", () => {
  const words = text(renderToStaticMarkup(<TooltipProvider><Hero provenance={[]} head={[]} /></TooltipProvider>));

  it("says a real Arc testnet wallet comes in one click, funded from Circle's faucet", () => {
    expect(words).toContain(
      "Email sign-in, a workspace of your own, and a real Arc testnet wallet in one click. Fund it with testnet USDC from Circle's faucet; no real money moves."
    );
  });

  it("no longer says there is no wallet", () => {
    expect(words).not.toContain("No wallet, no real funds");
  });
});
