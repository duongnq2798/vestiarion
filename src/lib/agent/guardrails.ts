export interface ApGuardrailInput {
  action: "pay" | "hold" | "flag_fraud" | "request_info";
  reasoning: string;
  amount: number;
  riskLevel: string;
  paymentLimit: number | null;
}

export interface ApGuardrailResult {
  blocked: boolean;
  status: "held" | "flagged" | null;
  rule: "counterparty.high_risk" | "counterparty.payment_limit" | null;
  reasoning: string;
}

/** The final code boundary between a model's recommendation and execution. */
export function enforceApGuardrails(input: ApGuardrailInput): ApGuardrailResult {
  if (input.action !== "pay") return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
  if (input.riskLevel === "high") {
    return {
      blocked: true,
      status: "flagged",
      rule: "counterparty.high_risk",
      reasoning: `${input.reasoning} [guardrail override: counterparty is high risk — payment refused before execution]`,
    };
  }
  if (input.paymentLimit != null && input.amount > input.paymentLimit) {
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
      reasoning: `${input.reasoning} [guardrail override: amount exceeds the ${input.paymentLimit} USDC payment limit — payment refused before execution]`,
    };
  }
  return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
}
