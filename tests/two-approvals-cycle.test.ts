import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cycle's wiring of two approvals above the workspace's figure (docs/superpowers/specs/2026-10-05-two-approvals-design.md
 * T3), pinned as source structure where a full `runAgentCycle()` is out of proportion (see tests/orchestrator.test.ts).
 * The rule is tested in tests/two-approvals.test.ts and tests/guardrails.test.ts, and the AP stage end to end in
 * tests/ap-stage.test.ts. What is left is the contractor stage and the follow-up.
 */

const source = readFileSync(path.join(process.cwd(), "src", "lib", "agent", "orchestrator.ts"), "utf8");

describe("the contractor stage and two approvals", () => {
  const contractors = source.slice(source.indexOf('await stage("contractors"'), source.indexOf('await stage("treasury"'));

  it("reads the figure once for the stage, when there is a milestone to decide", () => {
    expect(contractors).toContain("const twoApprovalsAbove = milestones.length > 0 ? await readTwoApprovalsAbove(db) : null;");
  });

  it("holds a release above it, after the new payee check and before the spending limit and the contract on Arc", () => {
    expect(contractors).toContain("const twoApprovalsHeld = twoApprovalsAbove !== null && amount > twoApprovalsAbove;");
    expect(contractors).toContain("outflowBudget = highRisk || unscreened || overLimit || newPayeeHeld || twoApprovalsHeld ? null : await budget.room();");
    expect(contractors).toContain("highRisk || unscreened || overLimit || newPayeeHeld || twoApprovalsHeld || escrowed ? null : await onChainLimit.check(");
    const newPayee = contractors.indexOf('guardrailRule = "counterparty.new_payee";');
    const twoApprovals = contractors.indexOf("guardrailRule = TWO_APPROVALS_RULE;");
    const budget = contractors.indexOf('guardrailRule = "workspace.outflow_budget";');
    expect(newPayee).toBeGreaterThan(-1);
    expect(twoApprovals).toBeGreaterThan(newPayee);
    expect(budget).toBeGreaterThan(twoApprovals);
    expect(contractors).toContain(
      "reasoning += ` [guardrail override: payments above ${twoApprovalsAbove} USDC need two people's approval in this workspace — release refused; two people approve it on Contractors]`;"
    );
  });

  it("records the figure the release was weighed against", () => {
    expect(contractors).toContain("...(twoApprovalsAbove != null ? { twoApprovalsAbove } : {}),");
  });
});

describe("the follow-up and a payment held for two approvals", () => {
  const followUp = source.slice(source.indexOf("const frozenRows = unwrap("), source.indexOf("followUpHeldMilestones(db, budget)"));

  it("knows which decisions held a payable for two approvals, at what value, and reads the figure only then", () => {
    expect(followUp).toContain("heldForTwoApprovals: twoApprovalsHeldValue(entry),");
    expect(followUp).toContain("const twoApprovalsNow = twoApprovalsHeldIds.length > 0 ? await readTwoApprovalsAbove(db) : undefined;");
    expect(followUp).toContain("...(twoApprovalsNow !== undefined ? { twoApprovalsAbove: twoApprovalsNow } : {}),");
  });

  it("does the same for a held milestone", () => {
    const milestones = source.slice(source.indexOf("export async function followUpHeldMilestones"), source.indexOf("export async function payApInvoiceIfNotPaused"));
    expect(milestones).toContain('heldForTwoApprovals: detail.guardrailRule === TWO_APPROVALS_RULE,');
    expect(milestones).toContain("const twoApprovalsNow = held.some((row) => heldForTwoApprovalsIds.has(row.id)) ? await readTwoApprovalsAbove(orgDb) : undefined;");
  });
});
