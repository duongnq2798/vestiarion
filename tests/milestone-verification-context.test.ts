import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { milestoneVerification } from "@/lib/agent/milestone-evidence";

/**
 * What the model is told about how a milestone was verified. A milestone a
 * person verified by hand often has no evidence link (pay a freelancer sets
 * one up that way), and given only `verificationSource: null` the model read
 * it as unverified and held it (testnet-2, ledger #641, 2026-10-01).
 */

describe("milestoneVerification", () => {
  it("says a milestone a person verified by hand is verified, by whom's method and with their note, link or not", () => {
    expect(
      milestoneVerification({
        verified: true,
        verification_method: "manual",
        verification_source: null,
        verification_detail: { note: "Delivered work confirmed when the payment was set up" },
      })
    ).toEqual({ verified: true, method: "manual", source: null, note: "Delivered work confirmed when the payment was set up" });
  });

  it("says a pull request verified it", () => {
    expect(
      milestoneVerification({
        verified: true,
        verification_method: "github",
        verification_source: "https://github.com/acme/app/pull/12",
        verification_detail: { mergedAt: "2026-10-01T10:00:00Z" },
      })
    ).toEqual({ verified: true, method: "github", source: "https://github.com/acme/app/pull/12", note: null });
  });

  it("keeps whatever is missing missing", () => {
    expect(milestoneVerification({ verified: true, verification_source: null })).toEqual({ verified: true, method: null, source: null, note: null });
  });
});

describe("the contractor stage's decision", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
  const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
  const prompt = stage.slice(stage.indexOf("await decide<MilestoneDecision>("), stage.indexOf("schema: milestoneDecisionSchema"));

  it("tells the model how the milestone was verified, and that a missing link does not undo it", () => {
    expect(prompt).toContain("verification: milestoneVerification(milestone)");
    expect(prompt).toContain("A missing evidence link does not make it unverified");
  });

  it("records the same in the decision's observed facts", () => {
    const observed = stage.slice(stage.indexOf("observed: {"), stage.indexOf("execution: {"));
    expect(observed).toContain("verification: milestoneVerification(milestone)");
  });
});

describe("the contractor stage and the agent's spending limit (outflow budget spec R4–R6)", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
  const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
  const release = stage.slice(stage.indexOf('if (decision.action === "release") {'), stage.indexOf("const now = new Date().toISOString();"));

  it("weighs a release against what the limit leaves, after the contractor's own checks and before anything is sent", () => {
    expect(release).toContain("outflowBudget = highRisk || overLimit ? null : await budget.room();");
    expect(release.indexOf("exceedsBudget(amount, outflowBudget)")).toBeLessThan(release.indexOf("releaseMilestoneIfNotPaused("));
    expect(release).toContain('guardrailRule = "workspace.outflow_budget";');
  });

  it("counts a release that went out, so the next payment this cycle sees it", () => {
    expect(release).toContain('if (status === "paid" || status === "matched") budget.spend(amount);');
  });

  it("records the rule, the limit it was weighed against, and why it held, for the follow-up stage", () => {
    const entry = stage.slice(stage.indexOf("action: `milestone_${decision.action}`"));
    expect(entry).toContain("guardrailRule,");
    expect(entry).toContain("...(outflowBudget ? { outflowBudget } : {}),");
    expect(entry).toContain('...(guardrailRule === "workspace.outflow_budget" ? { heldBecause: HELD_FOR_BUDGET } : {}),');
  });

  it("shares one running total with the AP stage, made before the follow-up stage", () => {
    const cycle = source.slice(source.indexOf("async function executeCycle("));
    expect(cycle.indexOf("const budget = budgetGate(db);")).toBeLessThan(cycle.indexOf('await stage("follow_up"'));
    expect(cycle).toContain("followUpHeldMilestones(db, budget)");
    expect(cycle.slice(cycle.indexOf('await stage("ap"'), cycle.indexOf('await stage("contractors"'))).toContain("budget,");
  });
});
