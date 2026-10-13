import { describe, expect, it } from "vitest";
import { enforceApGuardrails, type ApGuardrailInput, type ApGuardrailResult } from "@/lib/agent/guardrails";
import {
  afterGuardrails,
  PROJECT_BUDGET_RULE,
  projectBudgetHold,
  projectCheckOf,
  projectRecord,
  SAME_WORK_RULE,
  sameWorkHold,
  type ObligationHold,
  type ProjectCheck,
} from "@/lib/agent/obligation-checks";
import type { ReservedFigures } from "@/lib/projects/reserve";
import type { SameWorkMatch } from "@/lib/projects/same-work";

/**
 * The checks after every guardrail (docs/superpowers/specs/2026-10-13-project-budgets-design.md P5, P9): the same work
 * billed as a bill and a milestone, and a project whose budget cannot hold a payment. Each can only hold: whatever the
 * guardrails decided, the agent pays nothing it would not have paid before.
 */

const FIGURES: ReservedFigures = {
  projectId: "p1",
  projectName: "Website rebuild",
  neededMinor: 30_000,
  budgetMinor: 100_000,
  bufferMinor: 10_000,
  reservedMinor: 60_000,
  paidMinor: 15_000,
  availableMinor: 15_000,
};

const MATCH: SameWorkMatch = {
  otherKind: "milestone",
  otherId: "m1",
  otherLabel: "Design phase",
  otherStatus: "verified",
  signal: "purchase_order",
  reference: "PO-1042",
  explanation: 'This bill names purchase order PO-1042, as the milestone "Design phase" for the same payee does (verified): paying both would pay that order twice.',
};

const OVER: ProjectCheck = { state: "over", figures: FIGURES };
const HOLDS: Array<ObligationHold | null> = [
  null,
  sameWorkHold([MATCH], "Pay it.", "payment", "bill"),
  projectBudgetHold(OVER, "Pay it.", "payment", "bill"),
  projectBudgetHold({ state: "unreadable", projectId: "p1" }, "Pay it.", "payment", "bill"),
  projectBudgetHold({ state: "archived", figures: FIGURES }, "Pay it.", "payment", "bill"),
];

/** Every guardrail input this varies: each check's own trigger, alone, and none. */
function guardrailInputs(): ApGuardrailInput[] {
  const base: ApGuardrailInput = { action: "pay", reasoning: "Pay it.", amount: 300, riskLevel: "low", paymentLimit: 1000 };
  const variants: Array<Partial<ApGuardrailInput>> = [
    {},
    { riskLevel: "high" },
    { riskLevel: "unscreened" },
    { counterpartyRole: "client" },
    { addressMissing: true },
    { addressChangedAt: "2026-10-01T00:00:00Z", addressConfirmedAt: null },
    { match: { poReference: null, goodsReceived: false, purchaseOrderRequired: true } },
    { newPayee: { twoParties: false } },
    { currency: "EURC", fxAvailable: false },
    { paymentLimit: 100 },
    { twoApprovalsAbove: 100 },
    { outflowBudget: { dailyUsdc: 100, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0, remaining: 100, binding: "day" } },
    {
      duplicates: [
        { otherId: "i0", otherStatus: "paid", otherDueDate: "2026-10-01", otherAmount: 300, confidence: 0.95, signals: ["same_purchase_order", "same_amount"], explanation: "Same PO.", againstSettled: true },
      ],
    },
  ];
  const actions: ApGuardrailInput["action"][] = ["pay", "schedule", "hold", "flag_fraud", "request_info"];
  return actions.flatMap((action) => variants.map((variant) => ({ ...base, ...variant, action })));
}

describe("afterGuardrails", () => {
  it("never lets through what a guardrail stopped, and never changes why it stopped", () => {
    for (const input of guardrailInputs()) {
      const prior = enforceApGuardrails(input);
      for (const hold of HOLDS) {
        const after = afterGuardrails(prior, input.action, hold);
        if (prior.blocked) expect(after).toBe(prior);
        // Never a payment the guardrails held, flagged or asked about.
        expect(after.blocked || !prior.blocked).toBe(true);
      }
    }
  });

  it("holds a payment or a schedule the guardrails let through, for a person, and only when a check found something", () => {
    for (const input of guardrailInputs()) {
      const prior = enforceApGuardrails(input);
      if (prior.blocked) continue;
      for (const hold of HOLDS) {
        const after = afterGuardrails(prior, input.action, hold);
        const pays = input.action === "pay" || input.action === "schedule";
        if (!pays || !hold) {
          expect(after).toBe(prior);
          continue;
        }
        expect(after).toEqual({ blocked: true, status: "held", rule: hold.rule, reasoning: hold.reasoning });
      }
    }
  });

  it("holds a milestone's release, and leaves its hold alone", () => {
    const passed: ApGuardrailResult = { blocked: false, status: null, rule: null, reasoning: "Release it." };
    const hold = projectBudgetHold(OVER, "Release it.", "release", "milestone");
    expect(afterGuardrails(passed, "release", hold)).toMatchObject({ blocked: true, status: "held", rule: PROJECT_BUDGET_RULE });
    expect(afterGuardrails(passed, "hold", hold)).toBe(passed);
  });
});

describe("projectBudgetHold", () => {
  it("lets a payment whose money was set aside through", () => {
    expect(projectBudgetHold(null, "Pay it.", "payment", "bill")).toBeNull();
    expect(projectBudgetHold({ state: "reserved", figures: FIGURES, already: false }, "Pay it.", "payment", "bill")).toBeNull();
  });

  it("holds one the project cannot hold, with the project's own figures, as a hold the follow-up reopens", () => {
    const hold = projectBudgetHold(OVER, "Pay it.", "payment", "bill");
    expect(hold).toEqual({
      rule: PROJECT_BUDGET_RULE,
      heldForProject: true,
      reasoning:
        'Pay it. [guardrail override: project "Website rebuild" has 150.00 USDC of its 1,000.00 USDC budget left to set aside after its 100.00 USDC buffer, less than the 300.00 USDC this needs — payment refused before execution; a person pays it in Approvals, moves it, or raises the project\'s budget]',
    });
    expect(projectBudgetHold({ state: "over", figures: { ...FIGURES, bufferMinor: 0, availableMinor: -500 } }, "Release it.", "release", "milestone")?.reasoning).toContain(
      'project "Website rebuild" has 0.00 USDC of its 1,000.00 USDC budget left to set aside, less than the 300.00 USDC this needs — release refused before execution; a person pays it with Pay now on Contractors'
    );
  });

  it("holds one whose project could not be read, or is archived, for a person, with no reopen of its own", () => {
    expect(projectBudgetHold({ state: "unreadable", projectId: "p1" }, "Pay it.", "scheduling", "bill")).toMatchObject({ rule: PROJECT_BUDGET_RULE, heldForProject: false });
    expect(projectBudgetHold({ state: "unreadable", projectId: "p1" }, "Pay it.", "scheduling", "bill")?.reasoning).toContain("could not be checked — scheduling refused");
    expect(projectBudgetHold({ state: "archived", figures: FIGURES }, "Pay it.", "payment", "bill")?.reasoning).toContain('its project "Website rebuild" is archived');
  });
});

describe("sameWorkHold", () => {
  it("names the earlier bill or milestone, and says a person pays it if both are owed", () => {
    expect(sameWorkHold([], "Pay it.", "payment", "bill")).toBeNull();
    expect(sameWorkHold([MATCH], "Pay it.", "payment", "bill")).toEqual({
      rule: SAME_WORK_RULE,
      heldForProject: false,
      reasoning:
        'Pay it. [guardrail override: this bill names purchase order PO-1042, as the milestone "Design phase" for the same payee does (verified): paying both would pay that order twice — payment refused before execution; a person pays it in Approvals if both are owed]',
    });
  });
});

describe("projectCheckOf and projectRecord", () => {
  it("reads the reservation's answer, and a bill in no project as no check", () => {
    expect(projectCheckOf({ state: "reserved", already: true, reservationId: "r1", ...FIGURES })).toEqual({ state: "reserved", already: true, figures: FIGURES });
    expect(projectCheckOf({ state: "over", ...FIGURES })).toEqual({ state: "over", figures: FIGURES });
    expect(projectCheckOf({ state: "no_project" })).toBeNull();
    expect(projectCheckOf({ state: "settled", projectId: "p1" })).toBeNull();
  });

  it("records the figures the decision was weighed against", () => {
    expect(projectRecord(OVER)).toEqual({
      id: "p1",
      name: "Website rebuild",
      state: "over",
      neededMinor: 30_000,
      budgetMinor: 100_000,
      bufferMinor: 10_000,
      reservedMinor: 60_000,
      paidMinor: 15_000,
      availableMinor: 15_000,
    });
    expect(projectRecord({ state: "unreadable", projectId: "p1" })).toEqual({ id: "p1", state: "unreadable" });
  });
});
