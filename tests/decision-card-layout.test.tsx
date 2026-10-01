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

describe("a long piece of evidence", () => {
  // Real decisions cite "Duplicate check: clear against 1 earlier invoice" and "Payee's chain: Base Sepolia, through
  // CCTP"; in the 15rem column those chips ran past the card's edge (partner's screenshot, 2026-10-01).
  const long = {
    ...decision,
    evidence: [
      { label: "Duplicate check", value: "clear against 1 earlier invoice", state: "ok" },
      { label: "Payee's chain", value: "Base Sepolia, through CCTP", state: "neutral" },
    ],
  } as unknown as Decision;
  const markup = renderToStaticMarkup(<DecisionCard decision={long} orgSlug="testnet-2" />);
  const items = [...markup.matchAll(/<li([^>]*)><span[^>]*class="([^"]*)"/g)];

  it("keeps each chip within its column, wrapping its words onto more lines rather than overflowing", () => {
    expect(items.length).toBe(4); // the column and the footer row, two chips each
    for (const [, li, badge] of items) {
      expect(li).toMatch(/class="[^"]*max-w-full[^"]*"/);
      expect(li).toMatch(/min-w-0/);
      expect(badge).toMatch(/whitespace-normal/);
      expect(badge).not.toMatch(/whitespace-nowrap/);
      expect(badge).toMatch(/flex-wrap/);
    }
  });
});
