import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AddUsdcFromChain from "@/components/treasury/AddUsdcFromChain";

/**
 * Add USDC from another chain (docs/superpowers/specs/2026-10-08-add-usdc-from-another-chain-design.md B6): folded behind
 * one secondary button until a person opens it. Its steps run in the browser, against the wallet and Iris; their logic
 * is tested in tests/inbound-usdc.test.ts, and the panel's placements in tests/go-live-panel.test.tsx.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'");
const WALLET = "0x49A0e31153562a81cdc79ACF6D138B1965F71631";

describe("AddUsdcFromChain", () => {
  it("is one secondary button until it is opened, on either network", () => {
    for (const network of ["arc-mainnet", "arc-testnet"] as const) {
      const markup = renderToStaticMarkup(<AddUsdcFromChain network={network} recipient={WALLET} recipientLabel="Your wallet" />);
      expect(markup).toMatch(/<button[^>]*type="button"[^>]*>(?:(?!<\/button>).)*Add USDC from another chain/s);
      expect(markup).toMatch(/aria-expanded="false"/);
      expect(text(markup)).not.toContain("Review");
      expect(markup).not.toContain("<input");
    }
  });
});
