import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/treasury", () => ({ fundGatewayAction: vi.fn() }));

import { GatewayPanel } from "@/components/GatewayPanel";
import { OurPayments } from "@/components/open/OurPayments";

/**
 * What a person sees of the Gateway route (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G5):
 * the Treasury page's Gateway balance and its funding form, the decision card's route, and /open's link
 * for a payout minted on another chain.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the Gateway panel", () => {
  it("says a workspace has no Gateway balance yet, and offers an owner or admin the funding form", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress={null} balanceUsdc={null} canFund />);
    expect(text(markup)).toContain("Gateway balance");
    expect(text(markup)).toContain("Not funded yet.");
    expect(text(markup)).toContain("Amount to move from the operating wallet (USDC)");
    expect(markup).toMatch(/<input[^>]*name="amount"/);
    expect(markup).toMatch(/<input[^>]*type="hidden"[^>]*name="requestId"[^>]*value="[0-9a-f-]{36}"|<input[^>]*name="requestId"[^>]*type="hidden"/);
    expect(text(markup)).toContain("Fund Gateway");
    expect(text(markup)).toContain("USDC moved into Gateway stays there until it is paid out; it cannot be moved back from here.");
  });

  it("shows the balance and the signer, and no form to someone who may not fund it", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress="0x5aF3107A4000000000000000000000000000b0b0" balanceUsdc={2.95} canFund={false} />);
    expect(text(markup)).toContain("2.95 USDC");
    expect(markup).toContain("0x5aF3107A4000000000000000000000000000b0b0");
    expect(markup).not.toMatch(/name="amount"/);
  });

  it("says when Gateway did not answer", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress="0x5aF3107A4000000000000000000000000000b0b0" balanceUsdc={null} canFund={false} />);
    expect(text(markup)).toContain("Gateway did not answer just now.");
  });
});

// The decision card's route and links are tested on invoiceDecision itself, in tests/invoice-decision.test.ts (Gateway review I4).

describe("/open's list of our payments", () => {
  it("links a payout minted on another chain to that chain's explorer, and one on Arc to arcscan", () => {
    const markup = renderToStaticMarkup(
      <OurPayments
        payments={[
          { at: "2026-10-01T06:00:00Z", amount: 1, token: "USDC", txHash: "0xbase", chain: "BASE-SEPOLIA" },
          { at: "2026-10-01T05:00:00Z", amount: 1.25, token: "USDC", txHash: "0xarc", chain: "ARC-TESTNET" },
        ]}
      />
    );
    expect(markup).toContain('href="https://sepolia.basescan.org/tx/0xbase"');
    expect(markup).toContain('href="https://testnet.arcscan.app/tx/0xarc"');
  });
});
