import { describe, expect, it } from "vitest";
import type { ActualRecord } from "@/lib/actual-payment-fields";
import { paidOutside, reportValue, type BaselineState } from "@/lib/report-value";
import { buildReport } from "@/lib/workspace-report";
import { bill, decision, facts, payment } from "./support/report-facts";

/**
 * Value, in three kinds never added together (docs/superpowers/specs/2026-10-10-shared-report-design.md S8): what the
 * ledger and the confirmed transfers measured, the estimate from an owner's answer about how a bill was handled before,
 * and what is not counted as saved at all.
 */

const ANSWER = { id: "b-1", minutesPerBill: 30, peoplePerBill: 2, answeredBy: "u-owner", answeredAt: "2026-10-09T08:00:00.000Z" };
const answered: BaselineState = { available: true, answer: ANSWER };
const EARLY = { pct: 2, deadline: "2026-10-05T00:00:00.000Z" };
const LATER = { pct: 1, deadline: "2026-10-20T00:00:00.000Z" };

/**
 * Eleven bills, read on Oct 11: two the agent paid on its own (one with its discount, one late at full price), one it
 * would have paid in shadow mode, one flagged and one refused as a repeat, one still waiting with its discount open,
 * one whose discount lapsed unpaid, one the agent held that was then rejected, one scheduled that a person disagreed
 * with, one a person rejected after the agent decided to pay, and one the agent held that the business paid itself.
 */
const FACTS = facts({
  bills: [
    bill("paid", { discount: EARLY, paidAmount: 98, status: "paid" }),
    bill("full", { discount: EARLY, amount: 50, status: "paid", dueDate: "2026-10-01T00:00:00.000Z" }),
    bill("flagged", { status: "flagged" }),
    bill("repeat", { status: "held", discount: LATER }),
    bill("waiting", { discount: LATER, amount: 200 }),
    bill("lapsed", { discount: { pct: 3, deadline: "2026-10-05T00:00:00.000Z" } }),
    bill("rejected", { discount: EARLY, status: "rejected" }),
    bill("shadow", { status: "paid" }),
    bill("disagreed", { status: "scheduled" }),
    bill("stepped", { status: "rejected" }),
    bill("outside", { status: "held" }),
  ],
  decisions: [
    decision(1, "paid", { ts: "2026-10-02T10:02:00.000Z" }),
    decision(2, "full", { ts: "2026-10-02T10:04:00.000Z" }),
    decision(3, "flagged", { action: "ap_flag_fraud", resultingStatus: "flagged", ts: "2026-10-02T10:06:00.000Z" }),
    decision(4, "flagged", { action: "ap_flag_fraud", resultingStatus: "flagged", ts: "2026-10-03T10:06:00.000Z" }),
    decision(5, "repeat", { action: "ap_hold", guardrailBlocked: true, guardrailRule: "invoice.duplicate_of_settled", resultingStatus: "held" }),
    decision(6, "rejected", { action: "ap_hold", resultingStatus: "held" }),
    decision(7, "shadow", { heldBecause: "shadow_verdict", resultingStatus: "held", shadow: true }),
    decision(8, "disagreed", { action: "ap_schedule", resultingStatus: "scheduled", payOn: "2026-10-12" }),
    decision(9, "stepped", { resultingStatus: "processing" }),
    decision(11, "outside", { action: "ap_hold", resultingStatus: "held" }),
  ],
  personActions: [{ seq: 10, ts: "2026-10-02T11:00:00.000Z", action: "approval_rejected", invoiceId: "stepped" }],
  verdicts: [
    { entrySeq: 7, verdict: "agree" },
    { entrySeq: 8, verdict: "disagree" },
  ],
  payments: [payment("paid", { amount: 98 }), payment("full", { amount: 50, at: "2026-10-03T10:00:00.000Z" }), payment("shadow")],
});
const REPORT = buildReport(FACTS);

const record = (invoiceId: string, over: Partial<ActualRecord> = {}): ActualRecord => ({
  id: `r-${invoiceId}`,
  invoiceId,
  outcome: "paid",
  paidOn: "2026-10-04",
  amount: 100,
  currency: "USD",
  method: "bank_transfer",
  reference: null,
  note: null,
  reason: null,
  replaces: null,
  source: "form",
  recordedBy: "u-owner",
  recordedAt: "2026-10-06T08:00:00.000Z",
  ...over,
});
const notPaid = { outcome: "not_paid", paidOn: null, amount: null, currency: null, method: null } as const;

describe("the report's figures for value", () => {
  it("counts the bills the agent flagged, or code refused as a repeat, once each", () => {
    expect(REPORT.repeats).toBe(2);
  });

  it("counts the bills the agent took to payment on its own, apart from those it decided in shadow mode", () => {
    // Not counted: a hold or flag, a schedule a person disagreed with, and a payment a person stepped in on.
    expect(REPORT.carried).toEqual({ live: 2, shadow: 1 });
  });

  it("lists as still to pay only the bills that are not paid, not rejected and not a repeat", () => {
    expect([...REPORT.unpaid].sort()).toEqual(["disagreed", "lapsed", "outside", "waiting"]);
  });

  it("counts a discount as not taken once its bill was paid without it, or its last day passed", () => {
    expect(REPORT.discounts.captured).toEqual({ count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] });
    // Paid late at full price (1), and lapsed unpaid (3); never a rejected bill's, nor a repeat's.
    expect(REPORT.discounts.notTaken).toEqual({ count: 2, byCurrency: [{ currency: "USDC", amount: 4 }] });
  });

  it("keeps a discount whose last day has not passed as still on offer, not as missed", () => {
    expect(REPORT.discounts.open).toEqual({ count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] });
    // On the last day itself, it is still on offer.
    const lastDay = buildReport(facts({ ...FACTS, now: "2026-10-20T23:00:00.000Z" }));
    expect(lastDay.discounts.open.count).toBe(1);
    const dayAfter = buildReport(facts({ ...FACTS, now: "2026-10-21T00:30:00.000Z" }));
    expect(dayAfter.discounts.open.count).toBe(0);
    expect(dayAfter.discounts.notTaken).toEqual({ count: 3, byCurrency: [{ currency: "USDC", amount: 6 }] });
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
      handled: 11,
      decided: 9,
      medianMinutesToDecision: REPORT.bills.medianMinutesToDecision,
      paid: 3,
      onTime: 2,
      discountsTaken: { count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] },
    });
  });

  it("estimates time saved over the bills the agent took to payment on its own, and apart, what it would have saved in shadow mode", () => {
    expect(reportValue(REPORT, answered).estimate).toEqual({
      kind: "answered",
      minutesPerBill: 30,
      peoplePerBill: 2,
      answeredBy: "u-owner",
      answeredAt: "2026-10-09T08:00:00.000Z",
      saved: { bills: 2, hours: 1 },
      wouldHaveSaved: { bills: 1, hours: 0.5 },
    });
    const odd = reportValue(REPORT, { available: true, answer: { ...ANSWER, minutesPerBill: 7 } }).estimate;
    expect(odd).toMatchObject({ kind: "answered", saved: { bills: 2, hours: 0.2 } });
  });

  it("says only what the agent would have saved in a workspace in shadow mode, where the business pays its bills itself", () => {
    const inShadow = { currency: "USD", startedAt: "2026-10-01T00:00:00.000Z" };
    const shadow = buildReport(facts({ ...FACTS, shadow: inShadow, decisions: FACTS.decisions.filter((item) => item.shadow) }));
    expect(reportValue(shadow, answered).estimate).toMatchObject({ saved: null, wouldHaveSaved: { bills: 1, hours: 0.5 } });
    // In shadow mode before any such bill, it still says what it would have saved, not what it saved.
    expect(reportValue(buildReport(facts({ shadow: inShadow })), answered).estimate).toMatchObject({ saved: null, wouldHaveSaved: { bills: 0, hours: 0 } });
    // Outside shadow mode, with nothing yet, it says time saved.
    expect(reportValue(buildReport(facts()), answered).estimate).toMatchObject({ saved: { bills: 0, hours: 0 }, wouldHaveSaved: null });
  });

  it("estimates nothing without an answer, and says when answers are not set up", () => {
    expect(reportValue(REPORT, { available: true, answer: null }).estimate).toEqual({ kind: "unanswered" });
    expect(reportValue(REPORT, { available: false }).estimate).toEqual({ kind: "not_ready" });
  });

  it("does not count as saved the bills not paid yet, the repeats, or the discounts not taken or still on offer", () => {
    expect(reportValue(REPORT, answered).notCounted).toEqual({
      unpaid: 4,
      repeats: 2,
      discountsNotTaken: { count: 2, byCurrency: [{ currency: "USDC", amount: 4 }] },
      discountsOpen: { count: 1, byCurrency: [{ currency: "USDC", amount: 2 }] },
    });
  });

  it("does not call a bill the business recorded paying outside Vestiarion not paid yet", () => {
    const records = [record("outside"), record("waiting", { ...notPaid, reason: "Disputed" })];
    const outside = paidOutside({ available: true, facts: { records, entries: new Map(), verdictEntries: new Map() } });
    expect([...outside]).toEqual(["outside"]);
    expect(reportValue(REPORT, answered, outside).notCounted.unpaid).toBe(3);
    // A corrected record is read at its newest: paid, then corrected to not paid, is not paid.
    const correction = record("outside", { ...notPaid, id: "r-2", replaces: "r-outside", reason: "Bounced", recordedAt: "2026-10-07T08:00:00.000Z" });
    expect(paidOutside({ available: true, facts: { records: [record("outside"), correction], entries: new Map(), verdictEntries: new Map() } }).size).toBe(0);
    expect(paidOutside({ available: false }).size).toBe(0);
  });
});
