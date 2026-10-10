import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ShadowModeSummary from "@/components/ShadowModeSummary";
import { TooltipProvider } from "@/components/ui/Tooltip";

vi.mock("@/app/actions/test-usdc", () => ({ addTestUsdcAction: vi.fn() }));

/**
 * The console's shadow mode panel (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S5): how often people agreed
 * with the agent, out of the verdicts given, and how many decisions wait for one.
 */

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").trim();
const MODE = { currency: "VND", startedAt: "2026-10-07T12:00:00Z", startedBy: null };
const panel = (summary: { agreed: number; disagreed: number; waiting: number }) => html(<ShadowModeSummary orgSlug="northstar" mode={MODE} summary={summary} />);

describe("ShadowModeSummary", () => {
  it("says how often people agreed with the agent, out of the verdicts given", () => {
    const words = text(panel({ agreed: 9, disagreed: 2, waiting: 0 }));
    expect(words).toContain("Shadow mode");
    expect(words).toContain("for bills in VND");
    expect(words).toContain("You agreed with 9 of 11 decisions (82%).");
    expect(words).toContain("Each payment you agree to is made in USDC on Arc testnet.");
    expect(words).not.toContain("wait for your verdict");
  });

  it("says how many decisions wait for a verdict, and where to give it", () => {
    const markup = panel({ agreed: 1, disagreed: 0, waiting: 3 });
    expect(text(markup)).toContain("3 decisions wait for your verdict.");
    expect(markup).toContain('href="/o/northstar/invoices"');
    expect(text(markup)).toContain("See them in Bills &amp; receivables");
    expect(text(panel({ agreed: 1, disagreed: 0, waiting: 1 }))).toContain("1 decision waits for your verdict.");
  });

  it("says what to do before any verdict is given", () => {
    expect(text(panel({ agreed: 0, disagreed: 0, waiting: 2 }))).toContain("No verdicts yet: agree or disagree with each decision as the agent makes it.");
  });
});

/** Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T8): the line and the button. */
describe("ShadowModeSummary: test USDC", () => {
  const withTestUsdc = (testUsdc: Parameters<typeof ShadowModeSummary>[0]["testUsdc"]) =>
    html(<ShadowModeSummary orgSlug="northstar" mode={MODE} summary={{ agreed: 0, disagreed: 0, waiting: 0 }} testUsdc={testUsdc} />);

  it("says how much the open bills need beyond the wallet, and offers to add it", () => {
    const markup = withTestUsdc({ view: { need: 480.01, action: "add", amount: 480.01 }, latest: null, operatingAddress: "0xabc", latestTxUrl: null });
    const words = text(markup);
    expect(words).toContain("Your open bills need 480.01 USDC more than the operating wallet holds.");
    expect(words).toContain("Add 480.01 test USDC");
    expect(words).toContain("From Vestiarion's test USDC float, on Arc testnet.");
    expect(markup).toContain('name="orgSlug" value="northstar"');
  });

  it("offers what is left of the week, worded with its thousands", () => {
    const words = text(withTestUsdc({ view: { need: 3000, action: "add", amount: 1200.5 }, latest: null, operatingAddress: "0xabc", latestTxUrl: null }));
    expect(words).toContain("Your open bills need 3,000 USDC more than the operating wallet holds.");
    expect(words).toContain("Add 1,200.5 test USDC");
  });

  it("says the week's limit is used, and where to buy more", () => {
    const markup = withTestUsdc({ view: { need: 3000, action: "limit", weeklyLimit: 5000 }, latest: null, operatingAddress: "0xabc", latestTxUrl: null });
    expect(text(markup)).toContain("This workspace took its 5,000 test USDC for this week. For more, buy testnet USDC from TestMint and send it to the operating wallet: 0xabc");
    expect(markup).toContain('href="https://testmint.myproceeds.xyz"');
    expect(text(markup)).not.toContain("Add ");
  });

  it("shows the need alone to someone who may not add it", () => {
    const words = text(withTestUsdc({ view: { need: 10, action: null }, latest: null, operatingAddress: null, latestTxUrl: null }));
    expect(words).toContain("Your open bills need 10 USDC more than the operating wallet holds.");
    expect(words).not.toContain("Add 10 test USDC");
    expect(words).not.toContain("From Vestiarion's test USDC float");
  });

  it("says what was added last, with its transaction", () => {
    const markup = withTestUsdc({ view: null, latest: { amount: 480.01, at: "2026-10-08T11:00:00Z", txHash: "0xabc" }, operatingAddress: null, latestTxUrl: "https://explorer.testnet.arc.io/tx/0xabc" });
    expect(text(markup)).toContain("Last added: 480.01 test USDC on Oct 8.");
    expect(markup).toContain('href="https://explorer.testnet.arc.io/tx/0xabc"');
    expect(text(markup)).toContain("View transaction");
    expect(text(markup)).not.toContain("Your open bills need");
  });

  it("says nothing about test USDC without it", () => {
    expect(text(panel({ agreed: 1, disagreed: 0, waiting: 0 }))).not.toContain("test USDC");
  });
});
