import type { DuplicateMatch } from "./duplicates";
import { blockingDuplicate } from "./duplicates";
import { addressUnconfirmed } from "../counterparty-address";

export interface ApGuardrailInput {
  action: "pay" | "schedule" | "hold" | "flag_fraud" | "request_info";
  reasoning: string;
  amount: number;
  riskLevel: string;
  paymentLimit: number | null;
  /** Reportable repeats of this invoice, strongest first. */
  duplicates?: DuplicateMatch[];
  /** When a person last changed the counterparty's address; null when it was set as the counterparty was added. */
  addressChangedAt?: string | null;
  /** When a person last confirmed the counterparty's address. */
  addressConfirmedAt?: string | null;
  /**
   * The invoice's currency (EURC invoices design). For EURC, `amount` is its
   * USDC value at the quoted rate, which is what counts against the limit;
   * `fxAvailable` false means there was no quote, so there is no USDC value.
   */
  currency?: "USDC" | "EURC";
  fxAvailable?: boolean;
  /** A live EURC payment the wallet's EURC cannot cover: what it holds and what the payment sends. */
  eurcShort?: { balance: number; needed: number } | null;
}

export type ApGuardrailRule =
  | "counterparty.high_risk"
  | "counterparty.payment_limit"
  | "counterparty.address_unconfirmed"
  | "invoice.duplicate_of_settled"
  | "fx.rate_unavailable"
  | "treasury.insufficient_eurc";

export interface ApGuardrailResult {
  blocked: boolean;
  status: "held" | "flagged" | null;
  rule: ApGuardrailRule | null;
  reasoning: string;
}

/** The final code boundary between a model's recommendation and execution. */
export function enforceApGuardrails(input: ApGuardrailInput): ApGuardrailResult {
  if (input.action !== "pay" && input.action !== "schedule") {
    return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
  }
  // A payment the agent commits to must be one it would be allowed to make:
  // every check below applies to `schedule` exactly as it does to `pay`. Only
  // the wording of a refusal changes, so a person reading the ledger sees
  // what was actually refused.
  const verb = input.action === "schedule" ? "scheduling" : "payment";

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
      reasoning: `${input.reasoning} [guardrail override: this invoice repeats one already paid, being paid, scheduled or being decided by a person (${duplicate.explanation}) — ${verb} refused before execution]`,
    };
  }

  if (input.riskLevel === "high") {
    return {
      blocked: true,
      status: "flagged",
      rule: "counterparty.high_risk",
      reasoning: `${input.reasoning} [guardrail override: counterparty is high risk — ${verb} refused before execution]`,
    };
  }
  // Ahead of the limit so the reason names the change: an edited address is
  // the classic payment-redirection fraud, and whatever the amount, the first
  // payment to it waits for a person.
  const changedAt = input.addressChangedAt ?? null;
  if (addressUnconfirmed(changedAt, input.addressConfirmedAt ?? null)) {
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.address_unconfirmed",
      reasoning: `${input.reasoning} [guardrail override: the counterparty's address changed on ${(changedAt as string).slice(0, 10)} and no one has confirmed it — held for a person to approve]`,
    };
  }
  // A EURC payable with no quote has no USDC value, so its limit cannot be
  // checked: it waits for a person, who sees the EURC amount (E4).
  if (input.currency === "EURC" && input.fxAvailable === false) {
    return {
      blocked: true,
      status: "held",
      rule: "fx.rate_unavailable",
      reasoning: `${input.reasoning} [guardrail override: no EURC→USDC rate from Circle's Stablecoin Service, so the payment limit cannot be checked — held for a person to approve]`,
    };
  }
  if (input.paymentLimit != null && input.amount > input.paymentLimit) {
    const amount = input.currency === "EURC" ? `its USDC value at the quoted rate, ${input.amount} USDC,` : "amount";
    return {
      blocked: true,
      status: "held",
      rule: "counterparty.payment_limit",
      reasoning: `${input.reasoning} [guardrail override: ${amount} exceeds the ${input.paymentLimit} USDC payment limit — ${verb} refused before execution]`,
    };
  }
  // A EURC invoice is paid from EURC, never from USDC (E5): a payment the
  // wallet's EURC cannot cover now waits for a person.
  if (input.action === "pay" && input.eurcShort) {
    return {
      blocked: true,
      status: "held",
      rule: "treasury.insufficient_eurc",
      reasoning: `${input.reasoning} [guardrail override: the operating wallet holds ${input.eurcShort.balance} EURC, less than the ${input.eurcShort.needed} EURC this payment sends — held for a person; fund EURC from Circle's faucet first]`,
    };
  }
  return { blocked: false, status: null, rule: null, reasoning: input.reasoning };
}
