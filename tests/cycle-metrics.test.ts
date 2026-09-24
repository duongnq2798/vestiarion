import { describe, expect, it } from "vitest";
import { CycleMetricsCollector } from "@/lib/agent/cycle-metrics";

describe("cycle metrics", () => {
  it("counts outcomes, decision sources, and guardrail overrides without inferring them later", () => {
    const metrics = new CycleMetricsCollector();
    metrics.recordDecisionMode("deepseek");
    metrics.recordInvoice("paid", false);
    metrics.recordDecisionMode("heuristic");
    metrics.recordInvoice("awaiting_info", false);
    metrics.recordDecisionMode("openai");
    metrics.recordInvoice("held", true);
    metrics.recordDecisionMode("anthropic");
    metrics.recordMilestone("paid", false);
    metrics.recordDecisionMode("heuristic");
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
