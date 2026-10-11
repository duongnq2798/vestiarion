import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { DecisionTrail } from "@/components/vx/DecisionTrail";
import { invoiceDecision, milestoneDecision, treasuryLedgerDecision } from "@/components/vx/map";
import { evidencePath } from "@/lib/evidence-paths";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow, MilestoneRow } from "@/lib/queries";

/**
 * The ways into a payment's evidence (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E6): every payable's
 * and milestone's card links it, "Why it was paid" once paid and "Evidence so far" before, and the decision trail ends
 * with it. Receivables and treasury moves have none.
 */

const INVOICE = "5f1e2d3c-0000-4000-8000-000000000001";
const MILESTONE = "5f1e2d3c-0000-4000-8000-000000000002";
const TX = `0x${"79".repeat(32)}`;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const invoice = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: INVOICE,
  direction: "payable",
  counterparty_id: "cp-1",
  counterparty_name: "Northstar Studio",
  amount: 12.5,
  memo: "October design retainer",
  po_reference: "PO-2207",
  goods_received: true,
  due_date: "2026-10-15",
  status: "paid",
  agent_reasoning: "Paid.",
  tx_ref: TX,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: 12.5,
  ...overrides,
});

const milestone = (overrides: Partial<MilestoneRow> = {}): MilestoneRow => ({
  id: MILESTONE,
  contractor_id: "cp-2",
  contractor_name: "Linh Design",
  title: "Five October posts",
  amount: 12.5,
  verification_source: null,
  verification_method: "manual",
  verification_status: "verified",
  verification_checked_at: null,
  verified_at: "2026-10-05T09:00:00Z",
  verification_detail: {},
  verified: true,
  status: "paid",
  agent_reasoning: null,
  tx_ref: TX,
  ...overrides,
});

const PAID_ENTRY = {
  seq: 22,
  id: "e22",
  ts: "2026-10-05T10:02:40Z",
  actor: "agent",
  domain: "ap",
  action: "ap_pay",
  summary: "",
  detail: { invoiceId: INVOICE, decisionMode: "deepseek", decision: { action: "pay" }, observed: { riskLevel: "clear", paymentLimit: 50 }, execution: { txRef: TX, resultingStatus: "paid" } },
  bodyHash: "00",
  signature: "00",
  prevHash: null,
  hash: "00",
  signingKeyId: null,
} as unknown as LedgerEntry;

describe("where a payment's evidence lives", () => {
  it("is one page per record, named by its kind and id", () => {
    expect(evidencePath("invoice", INVOICE)).toBe(`/evidence/invoice/${INVOICE}`);
    expect(evidencePath("milestone", MILESTONE)).toBe(`/evidence/milestone/${MILESTONE}`);
  });
});

describe("a card's way into the evidence", () => {
  it("is carried by a payable's decision, paid or not", () => {
    expect(invoiceDecision(invoice(), undefined, [PAID_ENTRY], { network: "arc-testnet" }).chain).toEqual({ kind: "invoice", paid: true });
    expect(invoiceDecision(invoice({ status: "held", tx_ref: null, paid_amount: null }), undefined, [], { network: "arc-testnet" }).chain).toEqual({ kind: "invoice", paid: false });
    expect(invoiceDecision(invoice({ status: "rejected", tx_ref: null, paid_amount: null }), undefined, [], { network: "arc-testnet" }).chain).toEqual({ kind: "invoice", paid: false });
  });

  it("is carried by a milestone's decision, paid or not", () => {
    expect(milestoneDecision(milestone(), [], { network: "arc-testnet" }).chain).toEqual({ kind: "milestone", paid: true });
    expect(milestoneDecision(milestone({ status: "pending", verified: false, tx_ref: null }), [], { network: "arc-testnet" }).chain).toEqual({ kind: "milestone", paid: false });
  });

  it("is not carried by a receivable or a treasury move", () => {
    expect(invoiceDecision(invoice({ direction: "receivable", status: "pending", tx_ref: null, paid_amount: null }), undefined, [], { network: "arc-testnet" }).chain).toBeUndefined();
    const sweep = { ...PAID_ENTRY, domain: "treasury", action: "sweep_to_usyc", detail: { decision: { action: "sweep_to_usyc", amount: 5 } } } as unknown as LedgerEntry;
    expect(treasuryLedgerDecision(sweep, "arc-testnet").chain).toBeUndefined();
  });

  it("reads Why it was paid in a paid payable's footer, linking its evidence page", () => {
    const markup = renderToStaticMarkup(<DecisionCard decision={invoiceDecision(invoice(), undefined, [PAID_ENTRY], { network: "arc-testnet" })} orgSlug="acme" />);
    expect(markup).toMatch(new RegExp(`<a[^>]*href="/o/acme/evidence/invoice/${INVOICE}"[^>]*>.*Why it was paid</a>`));
    expect(text(markup)).not.toContain("Evidence so far");
  });

  it("reads Evidence so far on any other, a milestone's included", () => {
    const held = renderToStaticMarkup(<DecisionCard decision={invoiceDecision(invoice({ status: "held", tx_ref: null, paid_amount: null }), undefined, [], { network: "arc-testnet" })} orgSlug="acme" />);
    expect(held).toMatch(new RegExp(`<a[^>]*href="/o/acme/evidence/invoice/${INVOICE}"[^>]*>.*Evidence so far</a>`));
    const pending = renderToStaticMarkup(<DecisionCard decision={milestoneDecision(milestone({ status: "pending", verified: false, tx_ref: null }), [], { network: "arc-testnet" })} orgSlug="acme" />);
    expect(pending).toMatch(new RegExp(`<a[^>]*href="/o/acme/evidence/milestone/${MILESTONE}"[^>]*>.*Evidence so far</a>`));
    const paid = renderToStaticMarkup(<DecisionCard decision={milestoneDecision(milestone(), [], { network: "arc-testnet" })} orgSlug="acme" />);
    expect(text(paid)).toContain("Why it was paid");
  });

  it("is absent from a receivable's card", () => {
    const markup = renderToStaticMarkup(<DecisionCard decision={invoiceDecision(invoice({ direction: "receivable", status: "pending", tx_ref: null, paid_amount: null }), undefined, [], { network: "arc-testnet" })} orgSlug="acme" />);
    expect(markup).not.toContain("/evidence/");
  });
});

describe("the decision trail's last line", () => {
  it("links the whole chain, from purchase order to receipt", () => {
    const decision = invoiceDecision(invoice(), undefined, [PAID_ENTRY], { network: "arc-testnet" });
    const markup = renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="acme" />);
    const trail = markup.slice(markup.indexOf(`id="trail-${INVOICE}"`), markup.indexOf("</details>"));
    expect(trail).toMatch(new RegExp(`<a[^>]*href="/o/acme/evidence/invoice/${INVOICE}"[^>]*>The whole chain, from purchase order to receipt</a>`));
  });

  it("is left out where no evidence page is given, as a guide's picture of the trail alone", () => {
    const decision = invoiceDecision(invoice(), undefined, [PAID_ENTRY], { network: "arc-testnet" });
    const markup = renderToStaticMarkup(<DecisionTrail id={decision.id} steps={decision.trail ?? []} orgSlug="acme" network="arc-testnet" />);
    expect(markup).not.toContain("The whole chain");
  });
});
