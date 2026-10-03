import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readiness } from "@/components/CounterpartyRow";
import { enforceApGuardrails, type ApGuardrailInput } from "@/lib/agent/guardrails";
import { heldReason, type HeldFacts } from "@/lib/agent/milestone-decisions";

/**
 * A counterparty never screened is paid nothing by the agent (docs/superpowers/specs/2026-10-03-unscreened-hold-design.md):
 * its payable is held with `counterparty.unscreened`, pay or schedule; so is a milestone release; a person may still
 * pay it; the Counterparties page says it is not screened yet.
 */

const base: ApGuardrailInput = { action: "pay", reasoning: "Pay it.", amount: 2, riskLevel: "unscreened", paymentLimit: 10 };

describe("the AP guardrails and a counterparty never screened", () => {
  it("holds a payment, and a schedule, to a counterparty with no screening verdict", () => {
    for (const action of ["pay", "schedule"] as const) {
      const result = enforceApGuardrails({ ...base, action });
      expect(result, action).toMatchObject({ blocked: true, status: "held", rule: "counterparty.unscreened" });
      expect(result.reasoning).toContain("has not been screened yet");
    }
  });

  it("lets a duplicate and a high-risk verdict speak first, and ahead of the address and the limit", () => {
    expect(enforceApGuardrails({ ...base, riskLevel: "high" }).rule).toBe("counterparty.high_risk");
    expect(enforceApGuardrails({ ...base, amount: 50 }).rule).toBe("counterparty.unscreened");
    expect(enforceApGuardrails({ ...base, addressChangedAt: "2026-10-03T00:00:00Z", addressConfirmedAt: null }).rule).toBe("counterparty.unscreened");
  });

  it("does not touch a counterparty screened clear or medium", () => {
    expect(enforceApGuardrails({ ...base, riskLevel: "clear" }).blocked).toBe(false);
    expect(enforceApGuardrails({ ...base, riskLevel: "medium" }).blocked).toBe(false);
  });

  it("leaves a decision to hold alone", () => {
    expect(enforceApGuardrails({ ...base, action: "hold" }).blocked).toBe(false);
  });
});

describe("a held milestone whose contractor was never screened", () => {
  const facts: HeldFacts = {
    amount: 1,
    agentReasoning: "Release it. [guardrail override: contractor has not been screened yet — release refused; decided again once screening gives a verdict]",
    contractor: {
      name: "Puka Hotel",
      riskLevel: "unscreened",
      riskNotes: null,
      paymentLimit: 5,
      baselinePaymentLimit: 5,
      address: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4",
      addressChangedAt: null,
      addressConfirmedAt: null,
    },
    intent: null,
    lastEntry: { action: "milestone_hold", detail: { guardrailRule: "counterparty.unscreened" } },
    live: true,
  };

  it("says it waits for screening, links Counterparties, and lets a person pay it now", () => {
    const reason = heldReason(facts);
    expect(reason).toMatchObject({ kind: "unscreened", hint: "Not screened yet", canPay: true, canClose: true, override: true });
    expect(reason.link?.path).toBe("/counterparties");
    expect(reason.text).toContain("Puka Hotel has not been screened yet");
  });
});

describe("the Counterparties page", () => {
  it("says a vendor with an address and no verdict is not screened yet, among what needs someone", () => {
    const counterparty = { risk_level: "unscreened", risk_notes: null, address: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4", address_changed_at: null, address_confirmed_at: null, role: "vendor" };
    expect(readiness(counterparty)).toEqual({ label: "Not screened yet", tone: "held", rank: 2 });
    expect(readiness({ ...counterparty, role: "client", address: null }).label).toBe("Client");
  });
});

describe("the contractor stage and a contractor never screened", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
  const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
  const release = stage.slice(stage.indexOf('if (decision.action === "release") {'), stage.indexOf("await writeDecision({"));

  it("refuses a release to an unscreened contractor before anything is planned", () => {
    expect(stage).toContain('const unscreened = contractor.risk_level === "unscreened";');
    expect(release).toContain('guardrailRule = highRisk ? "counterparty.high_risk" : unscreened ? "counterparty.unscreened" : "counterparty.payment_limit";');
    expect(release.indexOf("if (highRisk || unscreened || overLimit) {")).toBeLessThan(release.indexOf("planned.push("));
  });
});
