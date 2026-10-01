import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import type { Decision } from "@/components/vx/types";

/**
 * A decision card's layout by its own width: on a wide card (Invoices, with no sidebar) the evidence sits in a
 * column beside the reasoning, so the reasoning keeps a readable line and the card has no empty half; on a
 * narrow card it stays in the footer, as before.
 */

const decision = {
  id: "inv-1", domain: "ap", action: "Pay", subject: "Centronex", amount: 2, token: "USDC", outcome: "recorded", outcomeLabel: "Settled on Arc",
  reasoning: "Centronex invoice for 2 USDC against PO-103 has goods received.",
  evidence: [{ label: "PO", value: "PO-103", state: "ok" }, { label: "Risk", value: "clear", state: "neutral" }],
  txHash: `0x${"1".repeat(64)}`, auditSeq: 586, at: "2026-10-01T08:50:00Z",
} as unknown as Decision;

describe("the decision card's width", () => {
  const markup = renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="testnet-2" />);

  it("measures itself: the card is a container the layout responds to", () => {
    expect(markup).toMatch(/<article[^>]*class="[^"]*@container/);
  });

  it("puts the evidence beside the reasoning when the card is wide, and lets the reasoning fill its column", () => {
    expect(markup).toMatch(/@4xl:grid-cols-\[minmax\(0,1fr\)_15rem\]/);
    const aside = markup.match(/<aside[^>]*>/)?.[0] ?? "";
    expect(aside).toContain('aria-label="Evidence cited by this decision"');
    expect(aside).toMatch(/class="hidden @4xl:block"/);
    expect(markup).toContain("@4xl:max-w-none");
  });

  it("keeps the evidence in the footer when the card is narrow, and never shows it twice", () => {
    expect(markup).toMatch(/<ul[^>]*aria-label="Evidence cited by this decision"[^>]*class="[^"]*@4xl:hidden/);
    expect(markup.match(/PO-103/g)?.length).toBe(3);
  });
});
