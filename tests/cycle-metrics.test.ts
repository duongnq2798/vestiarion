import { describe, expect, it } from "vitest";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";

describe("cycle metrics", () => {
  it("counts outcomes, decision sources, and guardrail overrides without inferring them later", () => {
    const metrics = new CycleMetricsCollector();
    metrics.recordDecisionMode("deepseek", true);
    metrics.recordInvoice("paid", false);
    metrics.recordDecisionMode("heuristic", null);
    metrics.recordInvoice("awaiting_info", false);
    metrics.recordDecisionMode("openai", false);
    metrics.recordInvoice("held", true);
    metrics.recordDecisionMode("anthropic", true);
    metrics.recordMilestone("paid", false);
    metrics.recordDecisionMode("heuristic", null);
    metrics.recordMilestone("held", true);

    expect(metrics.snapshot()).toEqual({
      decisionCount: 5,
      paidCount: 1,
      heldCount: 2,
      flaggedCount: 0,
      awaitingInfoCount: 1,
      releasedCount: 1,
      modelDecisionCount: 3,
      heuristicDecisionCount: 2,
      guardrailOverrideCount: 2,
      referenceDisagreementCount: 1,
    });
  });

  it("returns snapshots by value so historical metrics cannot be mutated accidentally", () => {
    const metrics = new CycleMetricsCollector();
    metrics.recordDecisionMode("heuristic");
    const first = metrics.snapshot();
    first.decisionCount = 99;
    expect(metrics.snapshot().decisionCount).toBe(1);
  });
});

describe("reference-policy disagreement", () => {
  it("does not count heuristic decisions as agreement", () => {
    // In heuristic mode the model is not consulted at all, so scoring those as
    // agreement would drive the metric toward 100% precisely when it is
    // measuring nothing.
    const metrics = new CycleMetricsCollector();
    metrics.recordDecisionMode("heuristic", null);
    metrics.recordDecisionMode("heuristic", null);
    const snap = metrics.snapshot();
    expect(snap.referenceDisagreementCount).toBe(0);
    expect(snap.modelDecisionCount).toBe(0);
  });

  it("counts every model verdict that departed from the written policy", () => {
    const metrics = new CycleMetricsCollector();
    metrics.recordDecisionMode("deepseek", false);
    metrics.recordDecisionMode("deepseek", false);
    metrics.recordDecisionMode("deepseek", true);
    const snap = metrics.snapshot();
    expect(snap.referenceDisagreementCount).toBe(2);
    expect(snap.modelDecisionCount).toBe(3);
  });

  it("treats an undetermined comparison as neither agreement nor disagreement", () => {
    const metrics = new CycleMetricsCollector();
    metrics.recordDecisionMode("deepseek");
    expect(metrics.snapshot().referenceDisagreementCount).toBe(0);
  });
});
