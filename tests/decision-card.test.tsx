import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import type { Decision } from "@/components/vx/types";

const html = (node: ReactElement) => renderToStaticMarkup(node);

const base: Decision = {
  id: "d1",
  domain: "ap",
  action: "Paid",
  subject: "INV-204 to Northwind Supply",
  outcome: "settled",
  amount: 1250,
  reasoning: "Paid INV-204 for 1,250.00 USDC because the purchase order matched.",
  evidence: [],
  at: "2026-09-29T10:15:00Z",
};

describe("DecisionCard", () => {
  it("is one article in the card's tone", () => {
    const markup = html(<DecisionCard decision={base} orgSlug="acme" />);
    expect(markup).toMatch(/^<article class="[^"]*rounded-2xl/);
    expect(markup).toContain("Settled on Arc");
  });

  it("has no footer without evidence, a transaction or an audit entry", () => {
    expect(html(<DecisionCard decision={base} orgSlug="acme" />)).not.toContain("<footer");
  });

  it("links its audit entry and its transaction", () => {
    const markup = html(<DecisionCard decision={{ ...base, auditSeq: 42, txHash: `0x${"ab".repeat(32)}` }} orgSlug="acme" />);
    expect(markup).toContain('href="/o/acme/audit#seq-42"');
    expect(markup).toContain("audit #0042");
    expect(markup).toContain("https://testnet.arcscan.app/tx/0x");
  });

  it("shows the rule a refused decision broke, and says nothing was sent", () => {
    const refused: Decision = {
      ...base,
      action: "Pay",
      outcome: "refused",
      amount: 9000,
      guardrail: { rule: "payment_limit", attempted: 9000, limit: 5000, note: "new vendor" },
      auditSeq: 7,
    };
    const markup = html(<DecisionCard decision={refused} orgSlug="acme" />);
    expect(markup).toContain("Blocked by code, not by the model");
    expect(markup).toContain("payment_limit");
    expect(markup).toContain("Tried to");
    expect(markup).toContain("no transaction sent");
    expect(markup).toContain("line-through");
    // A refusal listed on a page is standing information, not something that just went wrong.
    expect(markup).not.toContain('role="alert"');
  });

  it("marks missing evidence in the held tone and keeps its value", () => {
    const markup = html(<DecisionCard decision={{ ...base, evidence: [{ label: "PO", value: "PO-7", state: "missing" }] }} orgSlug="acme" />);
    expect(markup).toContain('aria-label="Evidence cited by this decision"');
    expect(markup).toContain("text-held");
    expect(markup).toContain("PO-7");
  });

  it("opens linked evidence in a new tab", () => {
    const markup = html(<DecisionCard decision={{ ...base, evidence: [{ label: "PR", value: "acme-pr#12", href: "https://github.com/acme/pull/12", state: "ok" }] }} orgSlug="acme" />);
    expect(markup).toContain('href="https://github.com/acme/pull/12"');
    expect(markup).toContain('target="_blank"');
  });
});
