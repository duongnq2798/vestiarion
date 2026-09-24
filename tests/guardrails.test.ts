import { describe, expect, it } from "vitest";
import { enforceApGuardrails } from "@/lib/agent/guardrails";

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
