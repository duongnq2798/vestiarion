import { describe, expect, it } from "vitest";
import { compareActuals, currentActuals, type ActualRecord, type ActualsFacts } from "@/lib/actual-payments-compare";
import type { ReportBill, ReportDecision, ReportFacts, ReportPayment } from "@/lib/workspace-report";

/**
 * Agent vs what really happened (docs/superpowers/specs/2026-10-10-actual-payments-design.md A7): each bill's agent side
 * (its newest decision, its payment on Arc) next to what the business recorded paying, never inferred, with the days
 * between them, the flags worth a look, the discounts measured from recorded facts, and totals that never add two
 * currencies together.
 */

function bill(id: string, over: Partial<ReportBill> = {}): ReportBill {
  return {
    id,
    createdAt: "2026-10-02T09:00:00.000Z",
    dueDate: "2026-10-10T00:00:00.000Z",
    amount: 100,
    currency: "USDC",
    status: "pending",
    reviewedBy: null,
    paidAmount: null,
    discount: null,
    bill: null,
    payee: { id: `payee-${id}`, name: `Payee ${id}`, mirror: false, sample: false },
    ...over,
  };
}

function decision(seq: number, invoiceId: string, over: Partial<ReportDecision> = {}): ReportDecision {
  return {
    seq,
    ts: "2026-10-02T10:00:00.000Z",
    action: "ap_pay",
    invoiceId,
    guardrailBlocked: false,
    guardrailRule: null,
    heldBecause: "shadow_verdict",
    resultingStatus: "held",
    shadow: true,
    reasoning: "Pay it. The bill matches the order.",
    payOn: null,
    ...over,
  };
}

function payment(invoiceId: string, over: Partial<ReportPayment> = {}): ReportPayment {
  return { invoiceId, amount: 100, token: "USDC", txHash: `0x${"a".repeat(64)}`, at: "2026-10-03T12:00:00.000Z", simulated: false, ...over };
}

function paid(id: string, invoiceId: string, paidOn: string, over: Partial<ActualRecord> = {}): ActualRecord {
  return {
    id,
    invoiceId,
    outcome: "paid",
    paidOn,
    amount: 100,
    currency: "USDC",
    method: "bank_transfer",
    reference: null,
    note: null,
    reason: null,
    replaces: null,
    source: "form",
    recordedBy: "user-1",
    recordedAt: "2026-10-09T08:00:00.000Z",
    ...over,
  };
}

function notPaid(id: string, invoiceId: string, over: Partial<ActualRecord> = {}): ActualRecord {
  return paid(id, invoiceId, "", { outcome: "not_paid", paidOn: null, amount: null, currency: null, method: null, reason: "The supplier sent a credit note", ...over });
}

function facts(over: Partial<ReportFacts> = {}): ReportFacts {
  return {
    network: "arc-testnet",
    sandbox: false,
    openedAt: "2026-10-01T00:00:00.000Z",
    shadow: { currency: "USDC", startedAt: "2026-10-01T00:00:00.000Z" },
    bills: [],
    decisions: [],
    personActions: [],
    verdicts: [],
    payments: [],
    ...over,
  };
}

function actuals(records: ActualRecord[], over: Partial<ActualsFacts> = {}): ActualsFacts {
  return { records, entries: new Map(), verdictEntries: new Map(), ...over };
}

const row = (result: ReturnType<typeof compareActuals>, invoiceId: string) => result.rows.find((item) => item.invoiceId === invoiceId)!;

describe("compareActuals", () => {
  it("says how many days earlier or later the agent was than the business, and the median", () => {
    const result = compareActuals(
      facts({
        bills: [bill("a"), bill("b"), bill("c"), bill("d")],
        decisions: [
          decision(1, "a", { ts: "2026-10-02T10:00:00.000Z" }),
          decision(2, "b", { action: "ap_schedule", payOn: "2026-10-08", heldBecause: null, resultingStatus: "scheduled" }),
          decision(3, "c", { ts: "2026-10-02T23:00:00.000Z" }),
          decision(4, "d", { ts: "2026-10-02T10:00:00.000Z" }),
        ],
        verdicts: [{ entrySeq: 4, verdict: "agree" }],
        payments: [payment("d", { at: "2026-10-04T09:00:00.000Z" })],
      }),
      actuals([paid("r1", "a", "2026-10-05"), paid("r2", "b", "2026-10-06"), paid("r3", "c", "2026-10-02"), paid("r4", "d", "2026-10-03")])
    );
    // Positive: the agent was earlier than the business.
    expect(row(result, "a").daysDiff).toBe(3);
    expect(row(result, "a").agent).toMatchObject({ stance: "pay", day: "2026-10-02", dayKind: "decided" });
    expect(row(result, "b").daysDiff).toBe(-2);
    expect(row(result, "b").agent).toMatchObject({ stance: "schedule", day: "2026-10-08", dayKind: "scheduled" });
    expect(row(result, "c").daysDiff).toBe(0);
    // Paid on Arc after a person agreed: the agent's day is the day it decided, not the day the person agreed.
    expect(row(result, "d").agent).toMatchObject({ stance: "paid", day: "2026-10-02", dayKind: "decided" });
    expect(row(result, "d").daysDiff).toBe(1);
    expect(result.totals.medianDays).toBe(0.5);
    expect(result.totals.daysCompared).toBe(4);
  });

  it("takes the day a person paid it on Arc when the agent never decided to pay it", () => {
    const result = compareActuals(
      facts({
        bills: [bill("a", { status: "paid" })],
        decisions: [decision(1, "a", { action: "ap_hold", heldBecause: null, resultingStatus: "held", reasoning: "The amount is twice the usual. Check it." })],
        payments: [payment("a", { at: "2026-10-04T09:00:00.000Z" })],
      }),
      actuals([paid("r1", "a", "2026-10-06")])
    );
    expect(row(result, "a").agent).toMatchObject({ stance: "paid", day: "2026-10-04", dayKind: "paidOnArc" });
    expect(row(result, "a").daysDiff).toBe(2);
  });

  it("says Not recorded for a bill with no record, and never infers one from a payment, a verdict or its status", () => {
    const result = compareActuals(
      facts({
        bills: [bill("a", { status: "paid", paidAmount: 100 }), bill("b")],
        decisions: [decision(1, "a"), decision(2, "b")],
        verdicts: [{ entrySeq: 1, verdict: "agree" }],
        payments: [payment("a")],
      }),
      actuals([paid("r2", "b", "2026-10-03")])
    );
    expect(row(result, "a").actual).toBeNull();
    expect(row(result, "a").flags).toEqual([]);
    expect(row(result, "a").agrees).toBeNull();
    expect(row(result, "a").daysDiff).toBeNull();
    expect(result.totals).toMatchObject({ compared: 1, notRecorded: 1 });
    expect(result.totals.paidByBusiness).toEqual([{ currency: "USDC", amount: 100 }]);
  });

  it("flags a bill the agent held, or code refused, that the business paid; a wait for cash is no hold", () => {
    const result = compareActuals(
      facts({
        bills: [bill("held"), bill("code"), bill("waited"), bill("agreed")],
        decisions: [
          decision(1, "held", { action: "ap_flag_fraud", heldBecause: null, resultingStatus: "flagged", reasoning: "It repeats a bill from two days before." }),
          decision(2, "code", { guardrailBlocked: true, guardrailRule: "counterparty.payment_limit", heldBecause: null }),
          decision(3, "waited", { heldBecause: "cash_shortfall" }),
          decision(4, "agreed", { action: "ap_hold", heldBecause: null, resultingStatus: "held" }),
        ],
      }),
      actuals([paid("r1", "held", "2026-10-03"), paid("r2", "code", "2026-10-03"), paid("r3", "waited", "2026-10-03"), notPaid("r4", "agreed")])
    );
    expect(row(result, "held")).toMatchObject({ flags: ["held_but_paid"], agrees: false });
    expect(row(result, "held").agent.why).toContain("It repeats a bill from two days before.");
    expect(row(result, "code")).toMatchObject({ flags: ["held_but_paid"], agrees: false });
    expect(row(result, "code").agent.why).toContain("above the counterparty's payment limit");
    expect(row(result, "waited")).toMatchObject({ flags: [], agrees: null });
    expect(row(result, "waited").agent.stance).toBe("waited");
    expect(row(result, "agreed")).toMatchObject({ flags: [], agrees: true });
    expect(result.totals).toMatchObject({ agreed: 1, disagreed: 2, flags: { heldButPaid: 2, paidNotPaid: 0, amountDiffers: 0 } });
    // Flagged bills come first.
    expect(result.rows.slice(0, 2).map((item) => item.invoiceId).sort()).toEqual(["code", "held"]);
  });

  it("flags a bill paid on Arc, or one the agent decided to pay, that the business did not pay", () => {
    const result = compareActuals(
      facts({
        bills: [bill("arc", { status: "paid" }), bill("would")],
        decisions: [decision(1, "arc"), decision(2, "would")],
        payments: [payment("arc")],
      }),
      actuals([notPaid("r1", "arc"), notPaid("r2", "would", { reason: "Paid by the parent company" })])
    );
    expect(row(result, "arc")).toMatchObject({ flags: ["paid_not_paid"], agrees: false });
    expect(row(result, "arc").agent.stance).toBe("paid");
    expect(row(result, "would")).toMatchObject({ flags: ["paid_not_paid"], agrees: false });
    expect(row(result, "would").actual?.reason).toBe("Paid by the parent company");
    expect(result.totals.flags.paidNotPaid).toBe(2);
  });

  it("flags an amount that differs from what Arc carried, or from the bill, by at least a cent", () => {
    const result = compareActuals(
      facts({
        bills: [bill("partial"), bill("arc", { status: "paid", paidAmount: 98 }), bill("cent")],
        decisions: [decision(1, "partial"), decision(2, "arc"), decision(3, "cent")],
        payments: [payment("arc", { amount: 98 })],
      }),
      actuals([paid("r1", "partial", "2026-10-03", { amount: 60 }), paid("r2", "arc", "2026-10-03", { amount: 100 }), paid("r3", "cent", "2026-10-03", { amount: 100.004 })])
    );
    expect(row(result, "partial").amount).toEqual({ business: 60, against: 100, currency: "USDC", of: "bill", differs: true });
    expect(row(result, "partial").flags).toEqual(["amount_differs"]);
    // Agreement is about paying it or not; the amount has its own flag.
    expect(row(result, "partial").agrees).toBe(true);
    expect(row(result, "arc").amount).toEqual({ business: 100, against: 98, currency: "USDC", of: "arc", differs: true });
    expect(row(result, "cent").amount?.differs).toBe(false);
    expect(result.totals.flags.amountDiffers).toBe(2);
  });

  it("reads the newest record of a bill: a correction replaces the earlier one, history kept", () => {
    const records = [
      paid("first", "a", "2026-10-05", { amount: 100, recordedAt: "2026-10-06T08:00:00.000Z" }),
      paid("second", "a", "2026-10-06", { amount: 90, replaces: "first", recordedAt: "2026-10-07T08:00:00.000Z" }),
      paid("b1", "b", "2026-10-05", { recordedAt: "2026-10-06T08:00:00.000Z" }),
      notPaid("b2", "b", { replaces: "b1", recordedAt: "2026-10-07T08:00:00.000Z" }),
    ];
    expect(currentActuals(records).get("a")).toMatchObject({ current: { id: "second" }, corrections: 1 });
    const result = compareActuals(
      facts({ bills: [bill("a"), bill("b")], decisions: [decision(1, "a"), decision(2, "b")] }),
      actuals(records, { entries: new Map([["first", 50], ["second", 51]]) })
    );
    expect(row(result, "a").actual).toMatchObject({ id: "second", amount: 90, entrySeq: 51 });
    expect(row(result, "a").corrections).toBe(1);
    expect(row(result, "a").daysDiff).toBe(4);
    expect(row(result, "b").actual?.outcome).toBe("not_paid");
    expect(row(result, "b").flags).toEqual(["paid_not_paid"]);
    expect(result.totals.paidByBusiness).toEqual([{ currency: "USDC", amount: 90 }]);
  });

  it("never compares or sums two currencies: USD and USDC stay apart", () => {
    const result = compareActuals(
      facts({
        bills: [bill("eur", { amount: 230.5, bill: { amount: 200, currency: "EUR" } }), bill("usd"), bill("usdc-on-eur", { amount: 115.25, bill: { amount: 100, currency: "EUR" }, status: "paid" })],
        decisions: [decision(1, "eur"), decision(2, "usd"), decision(3, "usdc-on-eur")],
        payments: [payment("usdc-on-eur", { amount: 115.25 })],
      }),
      actuals([
        paid("r1", "eur", "2026-10-03", { amount: 200, currency: "EUR" }),
        paid("r2", "usd", "2026-10-03", { amount: 100, currency: "USD" }),
        paid("r3", "usdc-on-eur", "2026-10-03", { amount: 115.25, currency: "USDC" }),
      ])
    );
    expect(row(result, "eur").amount).toEqual({ business: 200, against: 200, currency: "EUR", of: "bill", differs: false });
    expect(row(result, "eur").bill).toEqual({ amount: 200, currency: "EUR" });
    expect(row(result, "usd").amount).toBeNull();
    expect(row(result, "usdc-on-eur").amount).toEqual({ business: 115.25, against: 115.25, currency: "USDC", of: "arc", differs: false });
    expect(result.totals.paidByBusiness).toEqual([
      { currency: "EUR", amount: 200 },
      { currency: "USD", amount: 100 },
      { currency: "USDC", amount: 115.25 },
    ]);
  });

  it("measures the discounts taken from recorded facts only, and estimates the one on offer", () => {
    const terms = { pct: 2, deadline: "2026-10-05T00:00:00.000Z" };
    const result = compareActuals(
      facts({
        bills: [
          bill("both", { discount: terms, status: "paid", paidAmount: 98 }),
          bill("late", { discount: terms }),
          bill("partial", { discount: terms }),
          bill("eur", { discount: terms, amount: 115.25, bill: { amount: 100, currency: "EUR" } }),
        ],
        decisions: [decision(1, "both"), decision(2, "late"), decision(3, "partial"), decision(4, "eur")],
        payments: [payment("both", { amount: 98 })],
      }),
      actuals([
        paid("r1", "both", "2026-10-04", { amount: 98 }),
        paid("r2", "late", "2026-10-07", { amount: 100 }),
        paid("r3", "partial", "2026-10-04", { amount: 50 }),
        paid("r4", "eur", "2026-10-05", { amount: 98, currency: "EUR" }),
      ])
    );
    expect(row(result, "both").discount).toEqual({
      pct: 2,
      deadline: "2026-10-05",
      onOffer: { amount: 2, currency: "USDC" },
      agent: { amount: 2, currency: "USDC" },
      business: { amount: 2, currency: "USDC" },
      businessInTime: true,
    });
    expect(row(result, "late").discount).toMatchObject({ agent: null, business: null, businessInTime: false });
    // Half the bill by the deadline is a partial payment, not a discount.
    expect(row(result, "partial").discount).toMatchObject({ business: null, businessInTime: true });
    expect(row(result, "eur").discount).toMatchObject({ onOffer: { amount: 2, currency: "EUR" }, business: { amount: 2, currency: "EUR" } });
    expect(result.totals.discounts.agent).toEqual([{ currency: "USDC", amount: 2 }]);
    // Per currency, in the order of their codes, never added together.
    expect(result.totals.discounts.business).toEqual([
      { currency: "EUR", amount: 2 },
      { currency: "USDC", amount: 2 },
    ]);
    expect(result.totals.discounts.onOffer).toEqual([
      { currency: "EUR", amount: 2 },
      { currency: "USDC", amount: 6 },
    ]);
  });

  it("counts the bills the report counts: sample data only while there is no real bill, simulated payments only in a sandbox", () => {
    const sample = { id: "s", name: "Sample Co", mirror: false, sample: true };
    const mixed = compareActuals(
      facts({ bills: [bill("real"), bill("sample", { payee: sample })], decisions: [decision(1, "real"), decision(2, "sample")] }),
      actuals([paid("r1", "sample", "2026-10-03")])
    );
    expect(mixed.source).toBe("real");
    expect(mixed.rows.map((item) => item.invoiceId)).toEqual(["real"]);

    const sampleOnly = compareActuals(facts({ bills: [bill("sample", { payee: sample })], decisions: [decision(1, "sample")] }), actuals([]));
    expect(sampleOnly.source).toBe("sample");
    expect(sampleOnly.rows.map((item) => item.invoiceId)).toEqual(["sample"]);

    const simulatedPayment = { decisions: [decision(1, "a")], payments: [payment("a", { simulated: true, txHash: null })], bills: [bill("a", { status: "paid" })] };
    const sandbox = compareActuals(facts({ ...simulatedPayment, sandbox: true }), actuals([]));
    expect(sandbox.simulated).toBe(true);
    expect(row(sandbox, "a").agent.stance).toBe("paid");
    expect(row(sandbox, "a").agent.payment?.simulated).toBe(true);
    const live = compareActuals(facts(simulatedPayment), actuals([]));
    expect(row(live, "a").agent.payment).toBeNull();
  });

  it("shows a bill with a record but no decision, which counts as neither compared nor waiting for a record", () => {
    const result = compareActuals(facts({ bills: [bill("a"), bill("untouched")] }), actuals([paid("r1", "a", "2026-10-03")]));
    expect(result.rows.map((item) => item.invoiceId)).toEqual(["a"]);
    expect(row(result, "a").agent.stance).toBe("none");
    expect(result.totals).toMatchObject({ compared: 0, notRecorded: 0, agreed: 0, disagreed: 0 });
  });

  it("names the source of each figure: the decision, its verdict's entry, the payment's transaction, the record's entry", () => {
    const tx = `0x${"b".repeat(64)}`;
    const result = compareActuals(
      facts({
        bills: [bill("a", { status: "paid" })],
        decisions: [decision(7, "a", { ts: "2026-10-02T10:00:00.000Z" }), decision(9, "a", { ts: "2026-10-03T10:00:00.000Z" })],
        verdicts: [{ entrySeq: 7, verdict: "disagree" }],
        payments: [payment("a", { txHash: tx })],
      }),
      actuals([paid("r1", "a", "2026-10-04")], { entries: new Map([["r1", 31]]), verdictEntries: new Map([[7, 12]]) })
    );
    const only = row(result, "a");
    expect(only.agent.decision).toMatchObject({ seq: 9, action: "ap_pay" });
    expect(only.agent.payment?.txHash).toBe(tx);
    expect(only.verdict).toEqual({ verdict: "disagree", decisionSeq: 7, entrySeq: 12 });
    expect(only.actual).toMatchObject({ id: "r1", entrySeq: 31, recordedBy: "user-1" });
  });
});
