import { describe, expect, it } from "vitest";
import { invoiceDecision } from "@/components/vx/map";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";

/**
 * `invoiceDecision` (src/components/vx/map.ts) turns an invoice row into the
 * `Decision` a `DecisionCard` renders. Payment timing (2026-09-30) adds: a
 * scheduled invoice's outcome names the date, and only a scheduled one reads
 * "Scheduled" — a pending one has not been decided and a matched one is being
 * paid; its terms show as evidence when it carries an early-payment discount;
 * and a paid invoice that took the discount shows what it actually paid.
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

  it("reads Not yet decided for a pending invoice, which has no scheduled day", () => {
    const decision = invoiceDecision(invoice({ status: "pending" }), undefined, []);
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Not yet decided");
  });

  it("reads Payment in flight for a matched invoice, whose transfer has been submitted", () => {
    const decision = invoiceDecision(invoice({ status: "matched", tx_ref: "circle-tx-1" }), undefined, []);
    expect(decision.outcome).toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Payment in flight");
  });

  it("reads Being decided by a person for an invoice claimed on Approvals", () => {
    const decision = invoiceDecision(invoice({ status: "processing" }), undefined, []);
    expect(decision.outcomeLabel).toBe("Being decided by a person");
  });

  it.each(["pending", "matched", "processing"])("never reads Scheduled for a %s invoice, even with a stale scheduled day", (status) => {
    const decision = invoiceDecision(invoice({ status, scheduled_for: "2026-10-10T00:00:00.000Z" }), undefined, []);
    expect(decision.outcomeLabel).toBeDefined();
    expect(decision.outcomeLabel).not.toMatch(/Scheduled/);
  });

  it("reads Awaiting payment for a pending receivable, since the agent never decides receivables", () => {
    const decision = invoiceDecision(invoice({ direction: "receivable", status: "pending" }), undefined, []);
    expect(decision.outcomeLabel).toBe("Awaiting payment");
  });

  it("still reads Not yet decided for a pending payable", () => {
    const decision = invoiceDecision(invoice({ direction: "payable", status: "pending" }), undefined, []);
    expect(decision.outcomeLabel).toBe("Not yet decided");
  });

  it("reads as paid, never Scheduled, for a paid invoice whose tx_ref is missing (the sample data's paid history row)", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: null }), undefined, []);
    expect(decision.outcome).not.toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Paid");
  });

  it("reads as paid, never Scheduled, for a paid invoice whose tx_ref is in a form the badge doesn't recognise", () => {
    const decision = invoiceDecision(invoice({ status: "paid", tx_ref: "circle-tx-1" }), undefined, []);
    expect(decision.outcome).not.toBe("scheduled");
    expect(decision.outcomeLabel).toBe("Paid");
  });

  it("still reads Settled on Arc / Simulated (its own outcome word, not Paid) for a paid invoice with a recognised tx_ref", () => {
    const onChain = invoiceDecision(invoice({ status: "paid", tx_ref: "0xabc" }), undefined, []);
    expect(onChain.outcome).toBe("settled");
    expect(onChain.outcomeLabel).toBeUndefined();

    const simulated = invoiceDecision(invoice({ status: "paid", tx_ref: "sim_1" }), undefined, []);
    expect(simulated.outcome).toBe("simulated");
    expect(simulated.outcomeLabel).toBeUndefined();
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
  it("does not repeat a scheduled invoice's date as evidence: the outcome already reads Scheduled for <date>", () => {
    const decision = invoiceDecision(invoice({ status: "scheduled", scheduled_for: "2026-10-10T00:00:00.000Z" }), undefined, []);
    expect(decision.outcomeLabel).toBe("Scheduled for Oct 10, 2026");
    expect(decision.evidence.find((item) => item.label === "Status")).toBeUndefined();
    expect(decision.evidence.some((item) => item.value.includes("Oct 10, 2026"))).toBe(false);
  });

  it("omits it for a pending invoice", () => {
    const decision = invoiceDecision(invoice({ status: "pending" }), undefined, []);
    expect(decision.evidence.find((item) => item.label === "Status")).toBeUndefined();
  });
});

describe("invoiceDecision: duplicate evidence", () => {
  const entry = (otherInvoiceStatus: string): LedgerEntry =>
    ({
      seq: 7,
      id: "e7",
      ts: "2026-10-01T09:00:00.000Z",
      actor: "agent",
      domain: "ap",
      action: "ap_flag_fraud",
      summary: "",
      detail: {
        invoiceId: "inv-1",
        guardrailBlocked: true,
        observed: { duplicateCheck: { candidatesConsidered: 3, matches: [{ otherInvoiceId: "inv-0", otherInvoiceStatus, confidence: 0.95 }] } },
      },
    }) as unknown as LedgerEntry;

  it.each([
    ["paid", "1 match at 95% against an invoice already paid"],
    ["received", "1 match at 95% against an invoice already paid"],
    ["matched", "1 match at 95% against an invoice already being paid"],
    ["scheduled", "1 match at 95% against an invoice already scheduled"],
    ["processing", "1 match at 95% against an invoice already being decided by a person"],
    ["pending", "1 match at 95%"],
  ])("says what the matched invoice's money is doing when it is %s", (status, value) => {
    const decision = invoiceDecision(invoice({ status: "flagged" }), undefined, [entry(status)]);
    expect(decision.evidence).toContainEqual({ label: "Duplicate check", value, state: "missing" });
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
