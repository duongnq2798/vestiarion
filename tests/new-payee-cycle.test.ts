import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cycle's wiring of the new payee check (docs/superpowers/specs/2026-10-05-new-payee-check-design.md N3, N5),
 * pinned as source structure where a full `runAgentCycle()` is out of proportion (see tests/orchestrator.test.ts). The
 * rule is tested in tests/new-payee.test.ts and tests/guardrails.test.ts, its reads in tests/new-payee-facts.test.ts,
 * and the AP stage end to end in tests/ap-stage.test.ts. What is left is the cycle passing it wherever payments are real.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");

describe("the cycle and the first payment to a new payee", () => {
  it("gives the AP stage the check wherever payments are real", () => {
    const ap = source.slice(source.indexOf('await stage("ap"'), source.indexOf('await stage("contractors"'));
    expect(ap).toContain('...(provider.mode === "live" ? { newPayee: { load: (ids: string[]) => loadNewPayeeFacts(db, ids) } } : {}),');
  });

  it("holds a milestone's first release to an address one party alone stands behind", () => {
    const contractors = source.slice(source.indexOf('await stage("contractors"'), source.indexOf('await stage("treasury"'));
    expect(contractors).toContain('provider.mode === "live" && milestones.length > 0 ? await loadNewPayeeFacts(db, [...new Set(milestones.map((m) => m.contractor_id))]) : null');
    expect(contractors).toContain('guardrailRule = "counterparty.new_payee"');
    expect(contractors).toMatch(/newPayee: \{ addressBy: firstRelease\.addressBy, confirmedBy: firstRelease\.confirmedBy, twoParties: firstRelease\.twoParties \}/);
  });
});
