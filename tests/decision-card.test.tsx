import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import type { Decision } from "@/components/vx/types";
import type { InvoiceRow } from "@/lib/queries";

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

  it.each(["deepseek", "anthropic", "openai", "llm"])("names no model when %s decided: its reasoning is the agent's", (mode) => {
    const markup = html(<DecisionCard decision={{ ...base, decisionMode: mode }} orgSlug="acme" />);
    expect(markup.toLowerCase()).not.toContain(mode);
    expect(markup).not.toContain("Written policy");
  });

  it("marks a decision the written policy made because no model answered", () => {
    const markup = html(<DecisionCard decision={{ ...base, decisionMode: "heuristic" }} orgSlug="acme" />);
    expect(markup).toContain("Written policy");
    expect(markup).toContain('title="No model answered, so the written policy decided."');
    expect(markup).not.toContain("heuristic");
  });

  it("links its audit entry and its transaction", () => {
    const markup = html(<DecisionCard decision={{ ...base, auditSeq: 42, txHash: `0x${"ab".repeat(32)}` }} orgSlug="acme" />);
    expect(markup).toContain('href="/o/acme/audit#seq-42"');
    expect(markup).toContain("audit #0042");
    expect(markup).toContain("https://explorer.testnet.arc.io/tx/0x");
  });

  it("links the mint on the payee's chain after the burn on Arc (CCTP payouts X11)", () => {
    const markup = html(
      <DecisionCard
        decision={{ ...base, txHash: `0x${"ab".repeat(32)}`, mint: { chainLabel: "Base Sepolia", txHash: `0x${"cd".repeat(32)}`, href: `https://sepolia.basescan.org/tx/0x${"cd".repeat(32)}` } }}
        orgSlug="acme"
      />
    );
    expect(markup).toContain("https://explorer.testnet.arc.io/tx/0x");
    expect(markup).toContain(`href="https://sepolia.basescan.org/tx/0x${"cd".repeat(32)}"`);
    expect(markup).toContain("minted on Base Sepolia");
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

/**
 * An invoice's card, as the AP / AR page renders it: the badge says where the
 * invoice is, and only a scheduled one says Scheduled, with its day.
 */
describe("DecisionCard for an invoice", () => {
  const invoice = (overrides: Partial<InvoiceRow>): InvoiceRow => ({
    id: "inv-1",
    direction: "payable",
    counterparty_id: "cp-1",
    counterparty_name: "Northwind Supply",
    amount: 400,
    memo: "Annual support plan",
    po_reference: "PO-9",
    goods_received: true,
    due_date: "2026-10-30T12:00:00.000Z",
    status: "pending",
    agent_reasoning: null,
    tx_ref: null,
    scheduled_for: null,
    early_pay_discount_pct: null,
    discount_due_date: null,
    paid_amount: null,
    ...overrides,
  });
  const cardFor = (row: InvoiceRow) => html(<DecisionCard decision={invoiceDecision(row, undefined, [])} orgSlug="acme" />);

  it("reads Not yet decided for a pending invoice", () => {
    const markup = cardFor(invoice({ status: "pending" }));
    expect(markup).toContain("Not yet decided");
    expect(markup).not.toContain("Scheduled");
  });

  it("reads Payment in flight for a matched invoice", () => {
    const markup = cardFor(invoice({ status: "matched", tx_ref: "circle-tx-1" }));
    expect(markup).toContain("Payment in flight");
    expect(markup).not.toContain("Scheduled");
  });

  it("reads Scheduled for <date> for a scheduled invoice, once", () => {
    const markup = cardFor(invoice({ status: "scheduled", scheduled_for: "2026-10-10T00:00:00.000Z" }));
    expect(markup).toContain("Scheduled for Oct 10, 2026");
    expect(markup.match(/Oct 10, 2026/g)).toHaveLength(1);
    expect(markup).not.toContain("Scheduled ·");
  });
});
