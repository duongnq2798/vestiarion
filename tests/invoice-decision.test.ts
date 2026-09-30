import { describe, expect, it } from "vitest";
import { invoiceDecision } from "@/components/vx/map";
import type { InvoiceRow } from "@/lib/queries";

/**
 * `invoiceDecision` (src/components/vx/map.ts) turns an invoice row into the
 * `Decision` a `DecisionCard` renders. Payment timing (2026-09-30) adds: a
 * scheduled invoice's outcome names the date, its terms show as evidence when
 * it carries an early-payment discount, a scheduled invoice's status shows as
 * evidence too, and a paid invoice that took the discount shows what it
 * actually paid.
 */

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
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
  };
}

describe("invoiceDecision: scheduled outcome", () => {
  it("reads Scheduled for <date>, with the agent's reasoning", () => {
    const decision = invoiceDecision(
      invoice({
        status: "scheduled",
        scheduled_for: "2026-10-10T00:00:00.000Z",
        agent_reasoning: "A 2% early-payment discount (8 USDC) is worth more; paying on the discount deadline, Oct 10, 2026.",
      }),
      undefined,
      []
    );
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Scheduled for Oct 10, 2026");
    expect(decision.reasoning).toContain("discount deadline, Oct 10, 2026");
  });

  it("leaves the outcome label alone for a pending invoice, which has no scheduled day", () => {
    const decision = invoiceDecision(invoice({ status: "pending" }), undefined, []);
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBeUndefined();
  });
});

describe("invoiceDecision: terms evidence", () => {
  it("shows the discount's terms when the invoice carries one", () => {
    const decision = invoiceDecision(
      invoice({ early_pay_discount_pct: "2.00", discount_due_date: "2026-10-10T12:00:00.000Z" }),
      undefined,
      []
    );
    expect(decision.evidence).toContainEqual({ label: "Terms", value: "2% off if paid by Oct 10, 2026", state: "neutral" });
  });

  it("omits it without a discount", () => {
    const decision = invoiceDecision(invoice(), undefined, []);
    expect(decision.evidence.find((item) => item.label === "Terms")).toBeUndefined();
  });
});

describe("invoiceDecision: status evidence", () => {
  it("shows Scheduled · <date> for a scheduled invoice", () => {
    const decision = invoiceDecision(invoice({ status: "scheduled", scheduled_for: "2026-10-10T00:00:00.000Z" }), undefined, []);
    expect(decision.evidence).toContainEqual({ label: "Status", value: "Scheduled · Oct 10, 2026", state: "neutral" });
  });

  it("omits it for a pending invoice", () => {
    const decision = invoiceDecision(invoice({ status: "pending" }), undefined, []);
    expect(decision.evidence.find((item) => item.label === "Status")).toBeUndefined();
  });
});

describe("invoiceDecision: what a discounted payment actually paid", () => {
  it("shows the paid amount and the discount, when paid_amount is less than the full amount", () => {
    const decision = invoiceDecision(
      invoice({ status: "paid", amount: 400, paid_amount: 392, early_pay_discount_pct: "2.00", tx_ref: "sim_1" }),
      undefined,
      []
    );
    expect(decision.evidence).toContainEqual({ label: "Paid", value: "392.00 USDC (2% discount)", state: "ok" });
  });

  it("omits it when the full amount was paid", () => {
    const decision = invoiceDecision(invoice({ status: "paid", amount: 400, paid_amount: 400, tx_ref: "sim_1" }), undefined, []);
    expect(decision.evidence.find((item) => item.label === "Paid")).toBeUndefined();
  });

  it("omits it when nothing has been paid yet", () => {
    const decision = invoiceDecision(invoice({ status: "pending", paid_amount: null }), undefined, []);
    expect(decision.evidence.find((item) => item.label === "Paid")).toBeUndefined();
  });
});
