import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ShadowModeSummary from "@/components/ShadowModeSummary";
import { TooltipProvider } from "@/components/ui/Tooltip";

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
    expect(text(markup)).toContain("See them in AP / AR");
    expect(text(panel({ agreed: 1, disagreed: 0, waiting: 1 }))).toContain("1 decision waits for your verdict.");
  });

  it("says what to do before any verdict is given", () => {
    expect(text(panel({ agreed: 0, disagreed: 0, waiting: 2 }))).toContain("No verdicts yet: agree or disagree with each decision as the agent makes it.");
  });
});
