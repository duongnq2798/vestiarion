import { describe, expect, it } from "vitest";
import { enforceApGuardrails } from "@/lib/agent/guardrails";
import type { DuplicateMatch } from "@/lib/agent/duplicates";

describe("AP execution guardrails", () => {
  it("refuses a model pay verdict above a screened-down limit", () => {
    const result = enforceApGuardrails({
      action: "pay",
      reasoning: "The model recommends paying because the invoice evidence matches.",
      amount: 0.9,
      riskLevel: "medium",
      paymentLimit: 0.5,
    });
    expect(result).toMatchObject({
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
    });
    expect(result.reasoning).toContain("refused before execution");
  });

  it("gives high risk precedence even when the amount also exceeds the limit", () => {
    expect(enforceApGuardrails({
      action: "pay",
      reasoning: "Pay now.",
      amount: 10,
      riskLevel: "high",
      paymentLimit: 0,
    })).toMatchObject({ blocked: true, status: "flagged", rule: "counterparty.high_risk" });
  });

  it("does not rewrite a non-payment model verdict", () => {
    expect(enforceApGuardrails({
      action: "hold",
      reasoning: "Hold for review.",
      amount: 10,
      riskLevel: "high",
      paymentLimit: 0,
    })).toEqual({ blocked: false, status: null, rule: null, reasoning: "Hold for review." });
  });
});

describe("AP guardrails — duplicate billing", () => {
  const settledTwin: DuplicateMatch = {
    otherId: "inv-old",
    otherStatus: "paid",
    otherDueDate: "2026-09-27T00:00:00.000Z",
    otherAmount: 240,
    confidence: 0.95,
    signals: ["same_purchase_order", "same_amount"],
    explanation: "Bills the same purchase order for the same 240 USDC as invoice due 2026-09-27 (already paid).",
    againstSettled: true,
  };

  const clean = {
    action: "pay" as const,
    reasoning: "PO matches, goods received, counterparty clear, amount within limit.",
    amount: 240,
    riskLevel: "clear",
    paymentLimit: 2000,
  };

  it("refuses a pay verdict that repeats an already-settled invoice", () => {
    // Every other check passes, and that is the point: the counterparty is
    // clear, the amount is within its limit and the three-way match is
    // complete — because all of that was true the first time the bill was paid.
    const result = enforceApGuardrails({ ...clean, duplicates: [settledTwin] });
    expect(result).toMatchObject({
      blocked: true,
      status: "flagged",
      rule: "invoice.duplicate_of_settled",
    });
    expect(result.reasoning).toContain("refused before execution");
    expect(result.reasoning).toContain("same purchase order");
  });

  it("names the duplicate ahead of risk when both would block", () => {
    // The reported rule is what a reviewer acts on. A repeat of settled money
    // needs a different response from a sanctions hit, so the more specific
    // finding has to survive.
    const result = enforceApGuardrails({
      ...clean,
      riskLevel: "high",
      duplicates: [settledTwin],
    });
    expect(result.rule).toBe("invoice.duplicate_of_settled");
  });

  it("does not block on a repeat of an invoice that is still unpaid", () => {
    // Worth raising with a human, but nothing has left the account, so code
    // does not overrule the model on its own authority.
    const result = enforceApGuardrails({
      ...clean,
      duplicates: [{ ...settledTwin, otherStatus: "pending", againstSettled: false, confidence: 0.85 }],
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block on a weak resemblance", () => {
    const result = enforceApGuardrails({
      ...clean,
      duplicates: [{ ...settledTwin, confidence: 0.55, signals: ["purchase_order_rebilled"] }],
    });
    expect(result.blocked).toBe(false);
  });

  it("leaves a clean invoice alone when nothing matched", () => {
    expect(enforceApGuardrails({ ...clean, duplicates: [] }).blocked).toBe(false);
    expect(enforceApGuardrails(clean).blocked).toBe(false);
  });

  it("does not manufacture a block when the model already refused", () => {
    // A guardrail overrides a "pay"; it must not rewrite a verdict that
    // already declined, or the ledger would credit code for the model's call.
    const result = enforceApGuardrails({
      ...clean,
      action: "flag_fraud",
      duplicates: [settledTwin],
    });
    expect(result.blocked).toBe(false);
    expect(result.reasoning).toBe(clean.reasoning);
  });
});
