import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/treasury", () => ({ fundGatewayAction: vi.fn() }));

import { GatewayPanel, nextRequestId } from "@/components/GatewayPanel";
import { OurPayments } from "@/components/open/OurPayments";

/**
 * What a person sees of the Gateway route (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G5):
 * the Treasury page's Gateway balance and its funding form, the decision card's route, and /open's link
 * for a payout minted on another chain.
 */

const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the Gateway panel", () => {
  it("says a workspace has no Gateway balance yet, and offers an owner or admin the funding form", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress={null} balanceUsdc={null} canFund requestId={REQUEST} />);
    expect(text(markup)).toContain("Gateway balance");
    expect(text(markup)).toContain("Not funded yet.");
    expect(text(markup)).toContain("Amount to move from the operating wallet (USDC)");
    expect(markup).toMatch(/<input[^>]*name="amount"/);
    expect(markup).toMatch(/<input[^>]*type="hidden"[^>]*name="requestId"[^>]*value="[0-9a-f-]{36}"|<input[^>]*name="requestId"[^>]*type="hidden"/);
    expect(text(markup)).toContain("Fund Gateway");
    expect(text(markup)).toContain("USDC moved into Gateway stays there until it is paid out; it cannot be moved back from here.");
  });

  it("shows the balance and the signer, and no form to someone who may not fund it", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress="0x5aF3107A4000000000000000000000000000b0b0" balanceUsdc={2.95} canFund={false} requestId={REQUEST} />);
    expect(text(markup)).toContain("2.95 USDC");
    expect(markup).toContain("0x5aF3107A4000000000000000000000000000b0b0");
    expect(markup).not.toMatch(/name="amount"/);
  });

  it("carries the request id the page made, so the server's markup and the browser's agree (review M8)", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress={null} balanceUsdc={null} canFund requestId="0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d" />);
    expect(markup).toMatch(/<input[^>]*name="requestId"[^>]*value="0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d"|<input[^>]*value="0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d"[^>]*name="requestId"/);
  });

  it("makes a new request id after a deposit, and after a step Circle failed; keeps it after any other answer (review I5)", () => {
    const make = () => "new-id";
    expect(nextRequestId({ ok: true, message: "Deposited 1 USDC into Gateway." }, "old-id", make)).toBe("new-id");
    expect(nextRequestId({ ok: false, message: "Circle did not complete the deposit into Gateway (FAILED).", renew: true }, "old-id", make)).toBe("new-id");
    expect(nextRequestId({ ok: false, message: "Circle did not complete the deposit into Gateway (no answer yet)." }, "old-id", make)).toBe("old-id");
  });

  it("says when Gateway did not answer", () => {
    const markup = renderToStaticMarkup(<GatewayPanel orgSlug="testnet-2" signerAddress="0x5aF3107A4000000000000000000000000000b0b0" balanceUsdc={null} canFund={false} requestId={REQUEST} />);
    expect(text(markup)).toContain("Gateway did not answer just now.");
  });
});

// The decision card's route and links are tested on invoiceDecision itself, in tests/invoice-decision.test.ts (Gateway review I4).

describe("/open's list of our payments", () => {
  it("links a payout minted on another chain to that chain's explorer, and one on Arc to Arc's", () => {
    const markup = renderToStaticMarkup(
      <OurPayments
        payments={[
          { at: "2026-10-01T06:00:00Z", amount: 1, token: "USDC", txHash: "0xbase", chain: "BASE-SEPOLIA" },
          { at: "2026-10-01T05:00:00Z", amount: 1.25, token: "USDC", txHash: "0xarc", chain: "ARC-TESTNET" },
        ]}
      />
    );
    expect(markup).toContain('href="https://sepolia.basescan.org/tx/0xbase"');
    expect(markup).toContain('href="https://explorer.testnet.arc.io/tx/0xarc"');
  });
});
