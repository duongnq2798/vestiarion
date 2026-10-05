import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cycle's wiring of the FX re-check (docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md F3, F6), pinned as
 * source structure where a full `runAgentCycle()` is out of proportion (see tests/orchestrator.test.ts). The rules are
 * tested directly: what held a payable and what clears it in tests/fx-recheck.test.ts, the quote in
 * tests/fx-probe.test.ts, the reopen in tests/follow-up.test.ts and tests/control-cycle.test.ts, and the decision's
 * record in tests/ap-stage.test.ts. What is left is the follow-up stage passing them along.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
const followUp = source.slice(source.indexOf("const frozenRows = unwrap("), source.indexOf("followUpHeldMilestones(db, budget)"));

describe("the cycle and a EURC payable held for FX", () => {
  it("reads each frozen payable's entries with their sequence, time and action, to find its decision and its last reopen", () => {
    expect(followUp).toContain('.select("seq, ts, action, detail")');
    expect(followUp).toContain("fxHold: fxHoldOf({ seq: entry.seq, detail: entry.detail }),");
  });

  it("asks a fresh quote, once, for at most five payables due a re-check", () => {
    expect(followUp).toContain("fxRecheckCandidates(");
    expect(followUp).toContain("FX_RECHECKS_PER_CYCLE");
    expect(followUp).toMatch(/onceQuotes\(\{[^}]*operatingAddress/);
    expect(followUp).toContain("await probeFx(candidate.hold, quotes)");
    expect(source).toContain("const FX_RECHECKS_PER_CYCLE = 5;");
  });

  it("weighs the quote in the plan, and hands the reopen to the AP stage", () => {
    expect(followUp).toContain("...(fxNow.has(row.id) ? { fx: fxNow.get(row.id) } : {}),");
    expect(followUp).toMatch(/applyFollowUp\([\s\S]*?\(seq\) =>[\s\S]*?reevaluations\.set\(row\.id/);
    const ap = source.slice(source.indexOf('await stage("ap"'), source.indexOf('await stage("contractors"'));
    expect(ap).toContain("reevaluations,");
  });
});
