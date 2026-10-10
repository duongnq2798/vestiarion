import type { CurrencyAmount, WorkspaceReport } from "./workspace-report";

/**
 * What the agent was worth, in three kinds of figures that are never added together
 * (docs/superpowers/specs/2026-10-10-shared-report-design.md S8): measured, from the ledger and the confirmed transfers;
 * estimated, from an owner's answer about how long one bill took before Vestiarion; and not counted at all. Pure and
 * browser-safe: the report comes in already counted, the answer already read (`readBaseline`, ./report-baseline).
 */

/** The newest answer to "how long did one bill take you before?" (0095's `report_baselines`). */
export interface ReportBaseline {
  id: string;
  minutesPerBill: number;
  peoplePerBill: number;
  /** Who answered: a member's user id, or null once they deleted their account. */
  answeredBy: string | null;
  answeredAt: string;
}

/** The answer as read: none given yet, or the table not there before migration 0095 runs. */
export type BaselineState = { available: false } | { available: true; answer: ReportBaseline | null };

export interface ReportValueGroups {
  measured: {
    handled: number;
    decided: number;
    medianMinutesToDecision: number | null;
    paid: number;
    onTime: number;
    /** The bill less what its transfer carried; amounts null where a shared copy hides them. */
    discountsTaken: { count: number; byCurrency: CurrencyAmount[] | null };
  };
  estimate:
    | { kind: "not_ready" }
    | { kind: "unanswered" }
    | {
        kind: "answered";
        minutesPerBill: number;
        peoplePerBill: number;
        answeredBy: string | null;
        answeredAt: string;
        /** Only the bills the agent decided: a bill it has not decided on yet saved nothing. */
        decided: number;
        /** decided × minutesPerBill, in hours to one decimal. A person's verdict still takes time; it is not taken off. */
        hours: number;
      };
  notCounted: {
    /** Bills not paid yet: no saving is projected onto them. */
    unpaid: number;
    /** Bills the agent flagged, or code refused as a repeat: stopping one is not money saved. */
    repeats: number;
    /** Discounts on offer that no transfer took, estimated from the terms; amounts null where a shared copy hides them. */
    discountsNotTaken: { count: number; byCurrency: CurrencyAmount[] | null };
  };
}

export function reportValue(report: WorkspaceReport, baseline: BaselineState): ReportValueGroups {
  const decided = report.bills.decided;
  let estimate: ReportValueGroups["estimate"];
  if (!baseline.available) estimate = { kind: "not_ready" };
  else if (!baseline.answer) estimate = { kind: "unanswered" };
  else {
    const { minutesPerBill, peoplePerBill, answeredBy, answeredAt } = baseline.answer;
    estimate = { kind: "answered", minutesPerBill, peoplePerBill, answeredBy, answeredAt, decided, hours: Math.round(((decided * minutesPerBill) / 60) * 10) / 10 };
  }
  return {
    measured: {
      handled: report.bills.handled,
      decided,
      medianMinutesToDecision: report.bills.medianMinutesToDecision,
      paid: report.paid.count,
      onTime: report.paid.onTime,
      discountsTaken: { count: report.discounts.captured.count, byCurrency: report.discounts.captured.byCurrency },
    },
    estimate,
    notCounted: {
      unpaid: report.bills.handled - report.paid.count,
      repeats: report.repeats,
      discountsNotTaken: { count: report.discounts.notTaken.count, byCurrency: report.discounts.notTaken.byCurrency },
    },
  };
}
