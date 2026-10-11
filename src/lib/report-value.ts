import { currentActuals, type ActualsFacts } from "./actual-payments-compare";
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

/** Bills times the minutes one bill took before, and that in hours to one decimal. */
export interface TimeEstimate {
  bills: number;
  hours: number;
}

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
        /**
         * Time saved: the bills the agent took to payment on its own outside shadow mode, times the answer. A bill it held,
         * flagged or has not decided, or one a person stepped in on, saved nothing. A person's verdict still takes time; it
         * is not taken off. Null in shadow mode while the agent has taken no bill to payment outside it.
         */
        saved: TimeEstimate | null;
        /**
         * Time it would have saved: the same in shadow mode, where the business paid its bills itself. Null outside
         * shadow mode with no such bill.
         */
        wouldHaveSaved: TimeEstimate | null;
      };
  notCounted: {
    /** Bills still to pay: not paid, not rejected, not a repeat, and not recorded as paid outside Vestiarion. */
    unpaid: number;
    /** Bills the agent flagged, or code refused as a repeat: stopping one is not money saved. */
    repeats: number;
    /** Discounts on offer that were missed, estimated from the terms; amounts null where a shared copy hides them. */
    discountsNotTaken: { count: number; byCurrency: CurrencyAmount[] | null };
    /** Discounts still on offer on bills not paid yet, estimated from the terms; amounts null where a copy hides them. */
    discountsOpen: { count: number; byCurrency: CurrencyAmount[] | null };
  };
}

/**
 * The bills whose newest record (0090) says the business paid them outside Vestiarion; none before 0090 runs. A record
 * corrected to not paid is not paid.
 */
export function paidOutside(actuals: { available: false } | { available: true; facts: ActualsFacts }): Set<string> {
  if (!actuals.available) return new Set();
  return new Set([...currentActuals(actuals.facts.records)].filter(([, { current }]) => current.outcome === "paid").map(([invoiceId]) => invoiceId));
}

const timeOf = (bills: number, minutesPerBill: number): TimeEstimate => ({ bills, hours: Math.round(((bills * minutesPerBill) / 60) * 10) / 10 });

export function reportValue(report: WorkspaceReport, baseline: BaselineState, paidElsewhere: ReadonlySet<string> = new Set()): ReportValueGroups {
  let estimate: ReportValueGroups["estimate"];
  if (!baseline.available) estimate = { kind: "not_ready" };
  else if (!baseline.answer) estimate = { kind: "unanswered" };
  else {
    const { minutesPerBill, peoplePerBill, answeredBy, answeredAt } = baseline.answer;
    const { live, shadow } = report.carried;
    // In shadow mode, and for the bills decided in it, the agent only would have saved the time: the business paid itself.
    const wouldHaveSaved = shadow > 0 || report.shadow !== null ? timeOf(shadow, minutesPerBill) : null;
    const saved = live > 0 || wouldHaveSaved === null ? timeOf(live, minutesPerBill) : null;
    estimate = { kind: "answered", minutesPerBill, peoplePerBill, answeredBy, answeredAt, saved, wouldHaveSaved };
  }
  return {
    measured: {
      handled: report.bills.handled,
      decided: report.bills.decided,
      medianMinutesToDecision: report.bills.medianMinutesToDecision,
      paid: report.paid.count,
      onTime: report.paid.onTime,
      discountsTaken: { count: report.discounts.captured.count, byCurrency: report.discounts.captured.byCurrency },
    },
    estimate,
    notCounted: {
      unpaid: report.unpaid.filter((invoiceId) => !paidElsewhere.has(invoiceId)).length,
      repeats: report.repeats,
      discountsNotTaken: { count: report.discounts.notTaken.count, byCurrency: report.discounts.notTaken.byCurrency },
      discountsOpen: { count: report.discounts.open.count, byCurrency: report.discounts.open.byCurrency },
    },
  };
}
