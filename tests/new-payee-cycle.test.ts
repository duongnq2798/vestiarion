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

describe("the follow-up and a payable held as a new payee (new payee check N7)", () => {
  const followUp = source.slice(source.indexOf("const frozenRows = unwrap("), source.indexOf("followUpHeldMilestones(db, budget)"));

  it("reads the payee's address with each frozen payable, and which decisions held it as a new payee", () => {
    expect(followUp).toMatch(/"id, status, amount, currency, due_date, decided_at, escalated_at, po_reference, goods_received, counterparty_id, counterparties\([^)]*address,/);
    expect(followUp).toContain('newPayeeHeld: entry.detail.guardrailRule === "counterparty.new_payee",');
  });

  it("asks who stands behind those addresses now, wherever payments are real, and hands it to the plan", () => {
    expect(followUp).toContain('provider.mode === "live" && newPayeeHeldIds.length > 0 ? await loadNewPayeeFacts(db, newPayeeHeldIds) : null');
    expect(followUp).toContain("...(newPayeeNow.has(row.id) ? { newPayee: newPayeeNow.get(row.id) } : {}),");
  });
});
