import { describe, expect, it } from "vitest";
import { reportValue, type BaselineState } from "@/lib/report-value";
import { buildReport } from "@/lib/workspace-report";
import { bill, decision, facts, payment } from "./support/report-facts";

/**
 * Value, in three kinds never added together (docs/superpowers/specs/2026-10-10-shared-report-design.md S8): what the
 * ledger and the confirmed transfers measured, the estimate from an owner's answer about how a bill was handled before,
 * and what is not counted as saved at all.
 */

const ANSWER = { id: "b-1", minutesPerBill: 30, peoplePerBill: 2, answeredBy: "u-owner", answeredAt: "2026-10-09T08:00:00.000Z" };
const answered: BaselineState = { available: true, answer: ANSWER };

/** Four bills: one paid on time with its discount, one paid late at full price, one flagged, one refused as a repeat. */
const REPORT = buildReport(
  facts({
    bills: [
      bill("paid", { discount: { pct: 2, deadline: "2026-10-05T00:00:00.000Z" }, paidAmount: 98, status: "paid" }),
      bill("full", { discount: { pct: 2, deadline: "2026-10-05T00:00:00.000Z" }, amount: 50, status: "paid", dueDate: "2026-10-01T00:00:00.000Z" }),
      bill("flagged", { status: "flagged" }),
      bill("repeat", { status: "held" }),
      bill("waiting", { discount: { pct: 1, deadline: "2026-10-20T00:00:00.000Z" }, amount: 200 }),
    ],
    decisions: [
      decision(1, "paid", { ts: "2026-10-02T10:02:00.000Z" }),
      decision(2, "full", { ts: "2026-10-02T10:04:00.000Z" }),
      decision(3, "flagged", { action: "ap_flag_fraud", resultingStatus: "flagged", ts: "2026-10-02T10:06:00.000Z" }),
      decision(4, "flagged", { action: "ap_flag_fraud", resultingStatus: "flagged", ts: "2026-10-03T10:06:00.000Z" }),
      decision(5, "repeat", { action: "ap_hold", guardrailBlocked: true, guardrailRule: "invoice.duplicate_of_settled", resultingStatus: "held" }),
    ],
    payments: [payment("paid", { amount: 98 }), payment("full", { amount: 50, at: "2026-10-03T10:00:00.000Z" })],
  })
);

describe("the report's figures for value", () => {
  it("counts the bills the agent flagged, or code refused as a repeat, once each", () => {
    expect(REPORT.repeats).toBe(2);
  });

  it("counts the discounts on offer that no transfer took, estimated from their terms", () => {
    expect(REPORT.discounts.captured).toEqual({ count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] });
    expect(REPORT.discounts.notTaken).toEqual({ count: 2, byCurrency: [{ currency: "USDC", amount: 3 }] });
  });
});

describe("reportValue", () => {
  it("keeps three groups and no total across them", () => {
    const value = reportValue(REPORT, answered);
    expect(Object.keys(value).sort()).toEqual(["estimate", "measured", "notCounted"]);
    expect(JSON.stringify(value)).not.toMatch(/total/i);
  });

  it("measures from the ledger and the confirmed transfers", () => {
    expect(reportValue(REPORT, answered).measured).toEqual({
      handled: 5,
      decided: 4,
      medianMinutesToDecision: REPORT.bills.medianMinutesToDecision,
      paid: 2,
      onTime: 1,
      discountsTaken: { count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] },
    });
  });

  it("estimates time saved from the answer, over the bills the agent decided only", () => {
    expect(reportValue(REPORT, answered).estimate).toEqual({
      kind: "answered",
      minutesPerBill: 30,
      peoplePerBill: 2,
      answeredBy: "u-owner",
      answeredAt: "2026-10-09T08:00:00.000Z",
      decided: 4,
      hours: 2,
    });
    const odd = reportValue(REPORT, { available: true, answer: { ...ANSWER, minutesPerBill: 7 } }).estimate;
    expect(odd).toMatchObject({ kind: "answered", hours: 0.5 });
  });

  it("estimates nothing without an answer, and says when answers are not set up", () => {
    expect(reportValue(REPORT, { available: true, answer: null }).estimate).toEqual({ kind: "unanswered" });
    expect(reportValue(REPORT, { available: false }).estimate).toEqual({ kind: "not_ready" });
  });

  it("does not count as saved the bills not paid yet, the repeats, or the discounts not taken", () => {
    expect(reportValue(REPORT, answered).notCounted).toEqual({
      unpaid: 3,
      repeats: 2,
      discountsNotTaken: { count: 2, byCurrency: [{ currency: "USDC", amount: 3 }] },
    });
  });
});
