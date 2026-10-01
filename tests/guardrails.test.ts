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

describe("AP guardrails — a changed address no one has confirmed", () => {
  const base = { action: "pay" as const, reasoning: "Pay now.", amount: 2, riskLevel: "clear", paymentLimit: 5 };

  it("holds a pay verdict while the address change is unconfirmed, naming the date", () => {
    const result = enforceApGuardrails({ ...base, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "counterparty.address_unconfirmed" });
    expect(result.reasoning).toBe(
      "Pay now. [guardrail override: the counterparty's address changed on 2026-09-30 and no one has confirmed it — held for a person to approve]"
    );
  });

  it("holds when the last confirmation predates the change", () => {
    expect(
      enforceApGuardrails({ ...base, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: "2026-09-29T12:00:00Z" })
    ).toMatchObject({ blocked: true, rule: "counterparty.address_unconfirmed" });
  });

  it("pays once a person confirmed the new address", () => {
    expect(
      enforceApGuardrails({ ...base, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: "2026-09-30T12:05:00Z" })
    ).toEqual({ blocked: false, status: null, rule: null, reasoning: "Pay now." });
  });

  it("never holds an address set when the counterparty was added", () => {
    expect(enforceApGuardrails({ ...base, addressChangedAt: null, addressConfirmedAt: null })).toMatchObject({ blocked: false });
    expect(enforceApGuardrails(base)).toMatchObject({ blocked: false });
  });

  it("still flags high risk first", () => {
    expect(
      enforceApGuardrails({ ...base, riskLevel: "high", addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null })
    ).toMatchObject({ status: "flagged", rule: "counterparty.high_risk" });
  });

  it("names the address change ahead of the limit when both would hold", () => {
    expect(
      enforceApGuardrails({ ...base, amount: 50, addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null })
    ).toMatchObject({ status: "held", rule: "counterparty.address_unconfirmed" });
  });

  it("leaves a non-payment verdict alone", () => {
    expect(
      enforceApGuardrails({ ...base, action: "hold", addressChangedAt: "2026-09-30T12:00:00Z", addressConfirmedAt: null })
    ).toEqual({ blocked: false, status: null, rule: null, reasoning: "Pay now." });
  });
});

describe("AP guardrails — schedule is bound exactly like pay", () => {
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

  it("refuses a schedule verdict above a screened-down limit, same rule id as pay", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "The model recommends scheduling for the discount deadline.",
      amount: 0.9,
      riskLevel: "medium",
      paymentLimit: 0.5,
    });
    expect(result).toMatchObject({
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
    });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("refuses a schedule verdict for a high-risk counterparty", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "Schedule for the deadline.",
      amount: 10,
      riskLevel: "high",
      paymentLimit: 0,
    });
    expect(result).toMatchObject({ blocked: true, status: "flagged", rule: "counterparty.high_risk" });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("refuses a schedule verdict that repeats an already-settled invoice", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "PO matches, goods received, counterparty clear, amount within limit.",
      amount: 240,
      riskLevel: "clear",
      paymentLimit: 2000,
      duplicates: [settledTwin],
    });
    expect(result).toMatchObject({ blocked: true, status: "flagged", rule: "invoice.duplicate_of_settled" });
    expect(result.reasoning).toContain("scheduling refused before execution");
  });

  it("holds a schedule verdict while the counterparty's address change is unconfirmed", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "Schedule for the deadline.",
      amount: 2,
      riskLevel: "clear",
      paymentLimit: 5,
      addressChangedAt: "2026-09-30T12:00:00Z",
      addressConfirmedAt: null,
    });
    expect(result).toMatchObject({ blocked: true, status: "held", rule: "counterparty.address_unconfirmed" });
    // Unlike the "refused" rules, this reasoning was never "payment"-specific, and stays as-is.
    expect(result.reasoning).toContain("held for a person to approve");
  });

  it("leaves a clean schedule verdict alone", () => {
    const result = enforceApGuardrails({
      action: "schedule",
      reasoning: "Schedule for the deadline.",
      amount: 10,
      riskLevel: "clear",
      paymentLimit: 100,
    });
    expect(result).toEqual({ blocked: false, status: null, rule: null, reasoning: "Schedule for the deadline." });
  });
});
