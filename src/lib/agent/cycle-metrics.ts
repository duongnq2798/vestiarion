import type { DecisionMode } from "./decide";

export interface CycleMetrics {
  decisionCount: number;
  paidCount: number;
  heldCount: number;
  flaggedCount: number;
  awaitingInfoCount: number;
  releasedCount: number;
  modelDecisionCount: number;
  heuristicDecisionCount: number;
  guardrailOverrideCount: number;
  /** Model decisions that departed from the written rule-based policy. */
  referenceDisagreementCount: number;
}

export class CycleMetricsCollector {
  private metrics: CycleMetrics = {
    decisionCount: 0,
    paidCount: 0,
    heldCount: 0,
    flaggedCount: 0,
    awaitingInfoCount: 0,
    releasedCount: 0,
    modelDecisionCount: 0,
    heuristicDecisionCount: 0,
    guardrailOverrideCount: 0,
    referenceDisagreementCount: 0,
  };

  /**
   * `agreedWithReference` is null in heuristic mode, where the model and the
   * reference are the same thing and a disagreement is not defined. Counting
   * those as agreement would flatter the metric toward 100% exactly when the
   * model is not being consulted at all.
   */
  recordDecisionMode(mode: DecisionMode, agreedWithReference?: boolean | null): void {
    this.metrics.decisionCount += 1;
    if (mode === "heuristic") this.metrics.heuristicDecisionCount += 1;
    else this.metrics.modelDecisionCount += 1;
    if (agreedWithReference === false) this.metrics.referenceDisagreementCount += 1;
  }

  recordInvoice(status: string, guardrailBlocked: boolean): void {
    if (status === "paid") this.metrics.paidCount += 1;
    if (status === "held") this.metrics.heldCount += 1;
    if (status === "flagged") this.metrics.flaggedCount += 1;
    if (status === "awaiting_info") this.metrics.awaitingInfoCount += 1;
    if (guardrailBlocked) this.metrics.guardrailOverrideCount += 1;
  }

  recordMilestone(status: string, guardrailBlocked: boolean): void {
    if (status === "paid") this.metrics.releasedCount += 1;
    if (status === "held") this.metrics.heldCount += 1;
    if (guardrailBlocked) this.metrics.guardrailOverrideCount += 1;
  }

  snapshot(): CycleMetrics {
    return { ...this.metrics };
  }
}
