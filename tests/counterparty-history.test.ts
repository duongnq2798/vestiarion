import { describe, expect, it } from "vitest";
import {
  COUNTERPARTY_HISTORY_ACTIONS,
  deriveCounterpartyHistories,
  derivePerformanceScore,
  emptyCounterpartyHistory,
  isMaterialPerformanceChange,
  type CounterpartyHistoryInputs,
} from "@/lib/agent/counterparty-history";

function inputs(over: Partial<CounterpartyHistoryInputs> = {}): CounterpartyHistoryInputs {
  return { ...emptyCounterpartyHistory(), ...over };
}

describe("derivePerformanceScore", () => {
  it("returns no score when there is no history", () => {
    expect(derivePerformanceScore(inputs())).toMatchObject({ score: null, observations: 0 });
  });

  it("approaches one on a long clean history without ever claiming certainty", () => {
    const short = derivePerformanceScore(inputs({ paidWithoutIntervention: 3 })).score!;
    const long = derivePerformanceScore(inputs({ paidWithoutIntervention: 60 })).score!;
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(1);
  });

  it("makes a single fraud flag visible among many clean payments", () => {
    expect(
      derivePerformanceScore(inputs({
        paidWithoutIntervention: 19,
        duplicateSubmissions: 1,
      })).score
    ).toBe(0.909);
  });

  it("refuses to make a strong claim from one observation", () => {
    // A raw ratio scored one held invoice at 0.000 and one clean payment at
    // 1.000 — the numbers a reviewer would act on, from a single data point.
    const oneGood = derivePerformanceScore(inputs({ paidWithoutIntervention: 1 })).score!;
    const oneBad = derivePerformanceScore(inputs({ heldOrFlagged: 1 })).score!;

    expect(oneGood).toBeGreaterThan(0.5);
    expect(oneGood).toBeLessThan(0.75);
    expect(oneBad).toBeLessThan(0.5);
    expect(oneBad).toBeGreaterThan(0.25);
  });

  it("separates weak evidence from strong evidence in the same direction", () => {
    const weak = derivePerformanceScore(inputs({ paidWithoutIntervention: 1 })).score!;
    const strong = derivePerformanceScore(inputs({ paidWithoutIntervention: 20 })).score!;
    expect(strong - weak).toBeGreaterThan(0.25);
  });

  it("does not mark a counterparty down for a limit we set ourselves", () => {
    // A hold caused by our own configuration says nothing about their conduct,
    // and the risk tier behind it is already in front of the model.
    const clean = derivePerformanceScore(inputs({ paidWithoutIntervention: 4 })).score!;
    const withOurHolds = derivePerformanceScore(
      inputs({ paidWithoutIntervention: 4, heldByOurPolicy: 3 })
    );
    expect(withOurHolds.score).toBe(clean);
    expect(withOurHolds.observations).toBe(4);
    // It is still disclosed, just not scored.
    expect(withOurHolds.inputs.heldByOurPolicy).toBe(3);
  });

  it("is monotonic: clean outcomes never lower it and adverse facts never raise it", () => {
    const baseline = inputs({
      paidWithoutIntervention: 8,
      informationRequested: 1,
      heldOrFlagged: 1,
      duplicateSubmissions: 1,
      riskTierChanges: 1,
    });
    const baselineScore = derivePerformanceScore(baseline).score!;

    expect(
      derivePerformanceScore({ ...baseline, paidWithoutIntervention: 9 }).score
    ).toBeGreaterThan(baselineScore);
    for (const field of [
      "informationRequested",
      "heldOrFlagged",
      "duplicateSubmissions",
      "riskTierChanges",
    ] as const) {
      expect(
        derivePerformanceScore({ ...baseline, [field]: baseline[field] + 1 }).score
      ).toBeLessThan(baselineScore);
    }
  });

  it("treats one-point score movement as material but ignores 0.001 drift", () => {
    expect(isMaterialPerformanceChange(0.8, 0.799)).toBe(false);
    expect(isMaterialPerformanceChange(0.8, 0.79)).toBe(true);
    expect(isMaterialPerformanceChange(null, 1)).toBe(true);
  });
});

describe("deriveCounterpartyHistories", () => {
  it("classifies immutable invoice events without counting a duplicate twice", () => {
    const histories = deriveCounterpartyHistories(
      [
        {
          domain: "ap",
          action: "ap_pay",
          detail: {
            invoiceId: "clean",
            execution: { resultingStatus: "paid" },
            guardrailBlocked: false,
          },
        },
        {
          domain: "ap",
          action: "ap_flag_fraud",
          detail: {
            invoiceId: "duplicate",
            observed: {
              duplicateCheck: {
                matches: [{ otherInvoiceStatus: "paid", confidence: 0.95 }],
              },
            },
          },
        },
        {
          domain: "compliance",
          action: "risk_level_changed",
          detail: { counterpartyId: "cp-1" },
        },
      ],
      {
        invoiceCounterparty: new Map([
          ["clean", "cp-1"],
          ["duplicate", "cp-1"],
        ]),
        milestoneCounterparty: new Map(),
      }
    );

    expect(histories.get("cp-1")).toEqual(
      inputs({
        paidWithoutIntervention: 1,
        duplicateSubmissions: 1,
        riskTierChanges: 1,
      })
    );
  });

  it("counts a EURC payable held at its USDC value, for want of a rate, or for want of our own EURC as ours, not theirs (review I4)", () => {
    const hold = (invoiceId: string, detail: Record<string, unknown>) => ({
      domain: "ap",
      action: "ap_hold",
      detail: { invoiceId, guardrailBlocked: false, guardrailRule: null, currency: "EURC", ...detail },
    });
    const histories = deriveCounterpartyHistories(
      [
        // 100 EURC is under the 110 USDC limit at face value, but 117 USDC at the rate is over it.
        hold("over-at-rate", { usdcValue: 117, observed: { amount: 100, paymentLimit: 110, riskLevel: "clear" } }),
        // Circle gave no quote.
        hold("no-rate", { usdcValue: null, fx: null, observed: { amount: 100, paymentLimit: 200, riskLevel: "clear" } }),
        // The wallet's EURC could not cover it.
        hold("short", { usdcValue: 117, eurcBalance: 40, observed: { amount: 100, paymentLimit: 200, riskLevel: "clear" } }),
      ],
      {
        invoiceCounterparty: new Map([
          ["over-at-rate", "cp-1"],
          ["no-rate", "cp-1"],
          ["short", "cp-1"],
        ]),
        milestoneCounterparty: new Map(),
      }
    );
    expect(histories.get("cp-1")).toEqual(inputs({ heldByOurPolicy: 3 }));
  });

  it("never counts a payable or milestone held for the agent's spending limit against them (outflow budget spec)", () => {
    const histories = deriveCounterpartyHistories(
      [
        {
          domain: "ap",
          action: "ap_pay",
          detail: { invoiceId: "over-budget", guardrailBlocked: true, guardrailRule: "workspace.outflow_budget", currency: "USDC", observed: { amount: 30, paymentLimit: 100, riskLevel: "clear" } },
        },
        {
          domain: "contractor",
          action: "milestone_release",
          detail: { milestoneId: "ms-over", guardrailBlocked: true, guardrailRule: "workspace.outflow_budget", observed: { amount: 3, paymentLimit: 10, riskLevel: "clear" } },
        },
      ],
      { invoiceCounterparty: new Map([["over-budget", "cp-1"]]), milestoneCounterparty: new Map([["ms-over", "cp-1"]]) }
    );
    // Refused by code, as a payment over the counterparty's own limit is: neither paid nor held against them.
    expect(histories.get("cp-1")).toEqual(inputs());
  });

  it("counts a payment the reconcile later confirmed as paid, and one still pending as nothing yet", () => {
    const histories = deriveCounterpartyHistories(
      [
        // Paid by the agent, pending at first, confirmed by a later cycle's reconcile.
        { domain: "ap", action: "ap_pay", detail: { invoiceId: "settled-later", execution: { resultingStatus: "matched" }, guardrailBlocked: false } },
        { domain: "ap", action: "ap_reconcile", detail: { invoiceId: "settled-later", reconciled: true, execution: { resultingStatus: "paid" } } },
        // Still in flight.
        { domain: "ap", action: "ap_reconcile", detail: { invoiceId: "in-flight", reconciled: true, execution: { resultingStatus: "matched" } } },
      ],
      {
        invoiceCounterparty: new Map([
          ["settled-later", "cp-1"],
          ["in-flight", "cp-1"],
        ]),
        milestoneCounterparty: new Map(),
      }
    );

    expect(histories.get("cp-1")).toEqual(inputs({ paidWithoutIntervention: 1 }));
  });

  it("reads ap_reconcile entries from the ledger", () => {
    expect(COUNTERPARTY_HISTORY_ACTIONS).toContain("ap_reconcile");
  });

  it("counts a release the milestone reconcile later confirmed as paid, and one still pending as nothing yet", () => {
    const histories = deriveCounterpartyHistories(
      [
        // Released by the agent, pending at first, confirmed by a later cycle's reconcile.
        { domain: "contractor", action: "milestone_release", detail: { milestoneId: "settled-later", execution: { resultingStatus: "verified" }, guardrailBlocked: false } },
        { domain: "contractor", action: "milestone_reconcile", detail: { milestoneId: "settled-later", counterpartyId: "cp-2", reconciled: true, execution: { resultingStatus: "paid" } } },
        // Still in flight.
        { domain: "contractor", action: "milestone_reconcile", detail: { milestoneId: "in-flight", counterpartyId: "cp-2", reconciled: true, execution: { resultingStatus: "verified" } } },
      ],
      {
        invoiceCounterparty: new Map(),
        milestoneCounterparty: new Map([
          ["settled-later", "cp-2"],
          ["in-flight", "cp-2"],
        ]),
      }
    );

    expect(histories.get("cp-2")).toEqual(inputs({ paidWithoutIntervention: 1 }));
  });

  it("reads milestone_reconcile entries from the ledger", () => {
    expect(COUNTERPARTY_HISTORY_ACTIONS).toContain("milestone_reconcile");
  });
});
