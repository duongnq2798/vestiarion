import type { DuplicateMatch } from "./duplicates";
import { blockingDuplicate } from "./duplicates";

export interface ApGuardrailInput {
  action: "pay" | "hold" | "flag_fraud" | "request_info";
  reasoning: string;
  amount: number;
  riskLevel: string;
  paymentLimit: number | null;
  /** Reportable repeats of this invoice, strongest first. */
  duplicates?: DuplicateMatch[];
}

export type ApGuardrailRule =
  | "counterparty.high_risk"
  | "counterparty.payment_limit"
  | "invoice.duplicate_of_settled";

export interface ApGuardrailResult {
  blocked: boolean;
  status: "held" | "flagged" | null;
  rule: ApGuardrailRule | null;
  reasoning: string;
}

/** The final code boundary between a model's recommendation and execution. */
export function enforceApGuardrails(input: ApGuardrailInput): ApGuardrailResult {
  if (input.action !== "pay") return { blocked: false, status: null, rule: null, reasoning: input.reasoning };

  // Checked before risk and limit because a duplicate is the one failure where
  // every other check legitimately passes: the counterparty is clear, the
  // amount is within its limit, the purchase order matches and the goods were
  // received — because all of that was true the first time the bill was paid.
  const duplicate = blockingDuplicate(input.duplicates ?? []);
  if (duplicate) {
    return {
      blocked: true,
      status: "flagged",
      rule: "invoice.duplicate_of_settled",
      reasoning: `${input.reasoning} [guardrail override: this invoice repeats one already settled (${duplicate.explanation}) — payment refused before execution]`,
    };
  }

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
