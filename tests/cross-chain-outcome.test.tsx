import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { invoiceDecision } from "@/components/vx/map";
import type { LedgerEntry } from "@/lib/ledger";
import type { CounterpartyRow, InvoiceRow } from "@/lib/queries";

/**
 * A payable paid to another chain settles there: the money lands on the payee's chain, and the
 * card's outcome names that chain ("Settled on Arbitrum Sepolia"), not Arc. The chain comes from
 * the mint the decision recorded; a payout recorded before mints were, from the payee's chain.
 */

const MINT = `0x${"7a".repeat(32)}`;
const BURN = `0x${"b0".repeat(32)}`;

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    direction: "payable",
    counterparty_id: "cp-1",
    counterparty_name: "STM",
    amount: 2,
    memo: null,
    po_reference: "PO-109",
    goods_received: true,
    due_date: "2026-10-01T12:00:00.000Z",
    status: "paid",
    agent_reasoning: "Paid.",
    tx_ref: MINT,
    scheduled_for: null,
    early_pay_discount_pct: null,
    discount_due_date: null,
    paid_amount: null,
    ...overrides,
  };
}

const counterparty = (chain: string | null) => ({ id: "cp-1", name: "STM", role: "vendor", address: null, chain, payment_limit: 5, risk_level: "clear" }) as unknown as CounterpartyRow;

function paid(detail: Record<string, unknown>): LedgerEntry {
  return { seq: 580, ts: "2026-10-01T08:28:28.351Z", actor: "agent", domain: "ap", action: "ap_pay", summary: "PAY invoice from STM for 2 USDC", detail: { invoiceId: "inv-1", ...detail } } as unknown as LedgerEntry;
}

const gatewayMint = paid({ payout: { route: "gateway", feeUsdc: 0.107811 }, execution: { mintTxHash: MINT, destinationChain: "ARB-SEPOLIA" } });
const cctpMint = paid({ payout: { route: "cctp", feeUsdc: 0.05482 }, execution: { mintTxHash: MINT, destinationChain: "BASE-SEPOLIA" } });

describe("a payable paid to another chain", () => {
  it("reads Settled on the chain a Gateway payout was minted on", () => {
    const decision = invoiceDecision(invoice(), counterparty("ARB-SEPOLIA"), [gatewayMint]);
    expect(decision.outcome).toBe("settled");
    expect(decision.outcomeLabel).toBe("Settled on Arbitrum Sepolia");
  });

  it("reads Settled on the chain a CCTP payout was minted on, though its own transaction is the burn on Arc", () => {
    const decision = invoiceDecision(invoice({ tx_ref: BURN }), counterparty("BASE-SEPOLIA"), [cctpMint]);
    expect(decision.outcomeLabel).toBe("Settled on Base Sepolia");
  });

  it("names the payee's chain for a payout recorded before its mint was", () => {
    const decision = invoiceDecision(invoice({ tx_ref: BURN }), counterparty("BASE-SEPOLIA"), [paid({ payout: { route: "cctp" } })]);
    expect(decision.outcomeLabel).toBe("Settled on Base Sepolia");
  });

  it("keeps the chain the money was minted on after the payee moves to another", () => {
    const decision = invoiceDecision(invoice(), counterparty("ARC-TESTNET"), [gatewayMint]);
    expect(decision.outcomeLabel).toBe("Settled on Arbitrum Sepolia");
  });

  it("shows the label on the card, and never Settled on Arc", () => {
    const markup = renderToStaticMarkup(<DecisionCard decision={invoiceDecision(invoice(), counterparty("ARB-SEPOLIA"), [gatewayMint])} orgSlug="acme" />);
    expect(markup).toContain("Settled on Arbitrum Sepolia");
    expect(markup).not.toContain("Settled on Arc");
  });
});

describe("a payable that did not settle on another chain", () => {
  it("still reads Settled on Arc when it was paid on Arc", () => {
    const decision = invoiceDecision(invoice(), counterparty("ARC-TESTNET"), [paid({})]);
    expect(decision.outcome).toBe("settled");
    expect(decision.outcomeLabel).toBeUndefined();
    expect(renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="acme" />)).toContain("Settled on Arc");
  });

  it("is not called settled while it waits for a person", () => {
    const decision = invoiceDecision(invoice({ status: "held", tx_ref: null }), counterparty("ARB-SEPOLIA"), [paid({ payout: { route: "gateway" } })]);
    expect(decision.outcome).toBe("held");
    expect(decision.outcomeLabel ?? "").not.toMatch(/^Settled/);
  });

  it("is not called settled when it was simulated", () => {
    const decision = invoiceDecision(invoice({ tx_ref: "sim_44bd8923" }), counterparty("BASE-SEPOLIA"), [paid({ payout: { route: "cctp" } })]);
    expect(decision.outcome).toBe("simulated");
    expect(decision.outcomeLabel ?? "").not.toMatch(/^Settled/);
  });
});
