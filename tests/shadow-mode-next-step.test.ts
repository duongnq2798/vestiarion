import { describe, expect, it } from "vitest";
import { HELD_FOR_VERDICT } from "@/lib/agent/shadow-hold";
import { agentResumes, awaitsVerdict, heldForVerdict, ruleInBrief, ruleNextStep, SHADOW_VERDICT } from "@/lib/next-step";

/**
 * What a person reads about a payment held in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S2,
 * S4): no rule refused it, the agent wanted to pay it, and it waits for a person to agree. The agent never decides it
 * again on its own.
 */

const counterparty = { id: "cp-1", name: "Northwind" };

describe("a payment awaiting a person's verdict (shadow mode S4)", () => {
  it("is one shadow mode held, or one the agent decided to pay in shadow mode that a check in code held", () => {
    expect(awaitsVerdict({ guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: HELD_FOR_VERDICT } })).toBe(true);
    expect(awaitsVerdict({ shadow: true, guardrailBlocked: true, decision: { action: "pay" }, execution: { resultingStatus: "held" } })).toBe(true);
    // Outside shadow mode a code hold is settled as it always was.
    expect(awaitsVerdict({ guardrailBlocked: true, decision: { action: "pay" }, execution: { resultingStatus: "held" } })).toBe(false);
    // The agent's own hold, flag or question is not a payment it decided.
    expect(awaitsVerdict({ shadow: true, guardrailBlocked: true, decision: { action: "hold" }, execution: { resultingStatus: "held" } })).toBe(false);
    expect(awaitsVerdict({ shadow: true, guardrailBlocked: false, decision: { action: "pay" }, execution: { resultingStatus: "paid" } })).toBe(false);
    expect(awaitsVerdict(null)).toBe(false);
  });
});

describe("a payment held in shadow mode", () => {
  it("is read from its decision's entry, and never from a guardrail's hold", () => {
    expect(heldForVerdict({ guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: HELD_FOR_VERDICT } })).toBe(true);
    expect(heldForVerdict({ guardrailBlocked: true, execution: { resultingStatus: "held", heldBecause: HELD_FOR_VERDICT } })).toBe(false);
    expect(heldForVerdict({ execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } })).toBe(false);
    expect(heldForVerdict(null)).toBe(false);
  });

  it("says the agent wanted to pay it, and that it waits for a person to agree or disagree", () => {
    expect(ruleNextStep(SHADOW_VERDICT, counterparty)).toEqual({
      sentence: "Shadow mode: the agent decided to pay it, and pays nothing until a person agrees. Agree and pay it, or disagree, in Approvals.",
      fix: null,
    });
    expect(ruleInBrief(SHADOW_VERDICT)).toBe("shadow mode waits for a person to agree");
  });

  it("is never decided again by the agent on its own", () => {
    expect(agentResumes(SHADOW_VERDICT)).toBeNull();
  });
});
