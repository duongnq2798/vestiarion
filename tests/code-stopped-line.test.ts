import { describe, expect, it } from "vitest";
import { CASH_SHORTFALL, codeStoppedLine, stopRuleOf } from "@/lib/next-step";

/**
 * What a chat says of a payable code stopped (docs/superpowers/specs/2026-10-24-chat-code-stop-reason-design.md CS1,
 * CS2): the rule in brief, as the bill's row on Bills says it, never the model's sentence that may say the opposite; and
 * which rule that is, from the payable's latest AP decision, as the approval card reads it.
 */

describe("codeStoppedLine", () => {
  it("says the rule in brief, for a guardrail rule and for the cash shortfall hold", () => {
    expect(codeStoppedLine("counterparty.payment_limit")).toBe("Code stopped it: it is above the counterparty's payment limit.");
    expect(codeStoppedLine("invoice.pay_to_differs")).toBe("Code stopped it: the invoice asks to be paid to a different address from the one on file.");
    expect(codeStoppedLine(CASH_SHORTFALL)).toBe("Code stopped it: the operating wallet did not hold the cash it needs.");
  });

  it("says nothing for a rule with no words of its own, whose name the model's reasoning says better", () => {
    expect(codeStoppedLine("some.new_rule")).toBeNull();
  });

  it("says nothing without a rule", () => {
    expect(codeStoppedLine(null)).toBeNull();
    expect(codeStoppedLine(undefined)).toBeNull();
  });
});

describe("stopRuleOf", () => {
  it("gives the guardrail rule that refused the payment", () => {
    expect(stopRuleOf({ invoiceId: "inv-1", guardrailBlocked: true, guardrailRule: "counterparty.cooling_off", decision: { action: "pay" } })).toBe("counterparty.cooling_off");
  });

  it("gives nothing for a refusal that names no rule", () => {
    expect(stopRuleOf({ guardrailBlocked: true })).toBeNull();
    expect(stopRuleOf({ guardrailBlocked: true, guardrailRule: 42 })).toBeNull();
    // A rule recorded on a decision code let through stopped nothing.
    expect(stopRuleOf({ guardrailBlocked: false, guardrailRule: "counterparty.payment_limit" })).toBeNull();
  });

  it("gives the cash shortfall for a payment held for want of cash", () => {
    expect(stopRuleOf({ guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } })).toBe(CASH_SHORTFALL);
  });

  it("gives nothing for a hold the model chose, or one shadow mode keeps for a verdict", () => {
    expect(stopRuleOf({ guardrailBlocked: false, decision: { action: "hold" }, execution: { resultingStatus: "held" } })).toBeNull();
    expect(stopRuleOf({ guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } })).toBeNull();
  });

  it("gives nothing without a decision", () => {
    expect(stopRuleOf(null)).toBeNull();
    expect(stopRuleOf(undefined)).toBeNull();
  });
});
