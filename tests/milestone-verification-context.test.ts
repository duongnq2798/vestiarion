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
  const release = stage.slice(stage.indexOf('if (decision.action === "release") {'), stage.indexOf("await writeDecision({"));

  it("weighs a release against what the limit leaves, after the contractor's own checks and before anything is sent", () => {
    // After the new payee check too (new payee check N3): a release held for want of a second person reads no limit.
    expect(release).toContain("outflowBudget = highRisk || unscreened || overLimit || newPayeeHeld || twoApprovalsHeld ? null : await budget.room();");
    expect(release.indexOf("exceedsBudget(amount, outflowBudget)")).toBeLessThan(release.indexOf("planned.push("));
    expect(release).toContain('guardrailRule = "workspace.outflow_budget";');
    // Sent only after every milestone is decided (batch payouts §2).
    expect(stage.indexOf("planned.push(")).toBeLessThan(stage.indexOf("await releaseMilestones("));
  });

  it("counts a release when it is planned, so the releases of one cycle never pass the limit together", () => {
    expect(release.indexOf("budget.spend(amount);")).toBeGreaterThan(-1);
    expect(release.indexOf("budget.spend(amount);")).toBeLessThan(release.indexOf("planned.push("));
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

describe("the contractor stage and the spending limit enforced on Arc (onchain spending limit R3, R5, R7, R8)", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");
  const stage = source.slice(source.indexOf("// --------------------------------------------------------------- 3. contractors"));
  const release = stage.slice(stage.indexOf('if (decision.action === "release") {'), stage.indexOf("await writeDecision({"));

  it("asks the contract about a release not from escrow, after the contractor's own checks", () => {
    expect(release).toContain('["funded", "funding"].includes(String((milestone as { escrow_state?: string | null }).escrow_state ?? ""))');
    expect(release).toContain('highRisk || unscreened || overLimit || newPayeeHeld || twoApprovalsHeld || escrowed ? null : await onChainLimit.check({ sourceType: "milestone", sourceId: milestone.id, to: contractor.address, amount })');
  });

  it("lets the code's own limit speak first, then holds what the contract would refuse, before anything is planned", () => {
    expect(release.indexOf("exceedsBudget(amount, outflowBudget)")).toBeLessThan(release.indexOf("} else if (onChainHold) {"));
    expect(release.indexOf("} else if (onChainHold) {")).toBeLessThan(release.indexOf("planned.push("));
    expect(release).toContain("guardrailRule = onChainHold.rule;");
  });

  it("sends a planned release through the contract, and records the check on the decision", () => {
    expect(release).toContain("onChainLimit: onChainCheck });");
    const dispatch = stage.slice(stage.indexOf("await releaseMilestones("), stage.indexOf("{ provider, operatingAccountId: operating.id, operatingBalance }"));
    expect(dispatch).toContain("...(check?.payment ? { spendingLimit: check.payment } : {}),");
    const entry = stage.slice(stage.indexOf("action: `milestone_${decision.action}`"));
    expect(entry).toContain("...(onChainCheck ? { onChainLimit: onChainLimitRecord(onChainCheck) } : {}),");
  });

  it("shares one gate with the AP stage, and with the reconcile of a release in flight", () => {
    const cycle = source.slice(source.indexOf("async function executeCycle("));
    expect(cycle.indexOf("const onChainLimit = onChainLimitGate();")).toBeLessThan(cycle.indexOf('await stage("ap"'));
    expect(cycle.slice(cycle.indexOf('await stage("ap"'), cycle.indexOf('await stage("contractors"'))).toContain("onChainLimit,");
    expect(stage).toContain("{ db, provider, operating: operating ? { id: operating.id } : null, onChainLimit }");
  });
});
