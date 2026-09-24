import { describe, expect, it } from "vitest";
import {
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

  it("scores an entirely clean history at one", () => {
    expect(derivePerformanceScore(inputs({ paidWithoutIntervention: 12 }))).toMatchObject({
      score: 1,
      observations: 12,
    });
  });

  it("makes a single fraud flag visible among many clean payments", () => {
    expect(
      derivePerformanceScore(inputs({
        paidWithoutIntervention: 19,
        duplicateSubmissions: 1,
      })).score
    ).toBe(0.95);
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
});
