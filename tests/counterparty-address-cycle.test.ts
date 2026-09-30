import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cycle's two uses of an unconfirmed address, pinned as source structure.
 * A full `runAgentCycle()` is out of proportion for a unit test (see
 * tests/orchestrator.test.ts), and the rule itself — `addressUnconfirmed`
 * and the AP guardrail — is tested directly in tests/counterparty-address.test.ts
 * and tests/guardrails.test.ts. What is left is the wiring, one careless
 * edit away from gone.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");

describe("the cycle and an unconfirmed address", () => {
  it("reads both address timestamps with every counterparty it pays", () => {
    const selects = [...source.matchAll(/counterparties\(id, name, risk_level, payment_limit, performance_score, performance_inputs, address[^)]*\)/g)];
    expect(selects).toHaveLength(2);
    for (const [select] of selects) expect(select).toContain("address, address_changed_at, address_confirmed_at");
  });

  it("hands both to the AP guardrail", () => {
    const call = source.slice(source.indexOf("enforceApGuardrails({"), source.indexOf("});", source.indexOf("enforceApGuardrails({")));
    expect(call).toContain("addressChangedAt: counterparty.address_changed_at");
    expect(call).toContain("addressConfirmedAt: counterparty.address_confirmed_at");
  });

  it("skips a milestone before its decision, without writing it, while the contractor's address is unconfirmed", () => {
    const check = source.indexOf("if (addressUnconfirmed(contractor.address_changed_at, contractor.address_confirmed_at))");
    const decision = source.indexOf("await decide<MilestoneDecision>(");
    expect(check).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(check);
    const skip = source.slice(check, decision);
    expect(skip).toContain("continue;");
    expect(skip).not.toMatch(/appendLedgerEntry|\.update\(/);
    // After the in-flight reconcile: a release already sent is reconciled, never held back.
    expect(source.indexOf("existingMilestoneIntents(db, milestones)")).toBeLessThan(check);
  });
});
