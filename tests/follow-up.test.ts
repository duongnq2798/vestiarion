import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import {
  factChanges,
  followUpConfig,
  planFollowUp,
  planMilestoneFollowUp,
  type DecisionFacts,
  type FollowUpConfig,
  type FrozenInvoice,
  type HeldMilestone,
  type MilestoneDecisionFacts,
  twoApprovalsHeldValue,
} from "@/lib/agent/follow-up";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const config: FollowUpConfig = { staleAfterDays: 3, reEscalateAfterDays: 7 };

const facts: DecisionFacts = {
  poReference: null,
  goodsReceived: false,
  riskLevel: "clear",
  paymentLimit: 2,
};

function frozen(over: Partial<FrozenInvoice> = {}): FrozenInvoice {
  return {
    id: "inv-1",
    status: "awaiting_info",
    amount: 0.95,
    dueDate: daysAhead(5),
    decidedAt: daysAgo(1),
    escalatedAt: null,
    poReference: null,
    goodsReceived: false,
    riskLevel: "clear",
    paymentLimit: 2,
    ...over,
  };
}

describe("factChanges", () => {
  it("sees a purchase order arrive", () => {
    const changes = factChanges({ ...facts, poReference: "PO-1042" }, facts);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("since been supplied");
  });

  it("sees goods confirmed, and sees receipt withdrawn", () => {
    expect(factChanges({ ...facts, goodsReceived: true }, facts)[0]).toContain("confirmed received");
    expect(
      factChanges(facts, { ...facts, goodsReceived: true })[0]
    ).toContain("withdrawn");
  });

  it("sees a risk tier move in either direction", () => {
    expect(factChanges({ ...facts, riskLevel: "high" }, facts)[0]).toContain("clear → high");
    expect(factChanges(facts, { ...facts, riskLevel: "high" })[0]).toContain("high → clear");
  });

  it("sees a payment limit move, including to and from none", () => {
    expect(factChanges({ ...facts, paymentLimit: 8 }, facts)[0]).toContain("2 USDC → 8 USDC");
    expect(factChanges({ ...facts, paymentLimit: null }, facts)[0]).toContain("2 USDC → none");
  });

  it("reports nothing when nothing moved", () => {
    expect(factChanges(facts, facts)).toEqual([]);
  });

  it("reports every change, not just the first", () => {
    const changes = factChanges(
      { poReference: "PO-9", goodsReceived: true, riskLevel: "medium", paymentLimit: 9 },
      facts
    );
    expect(changes).toHaveLength(4);
  });

  it("ignores facts the payment decision does not rest on", () => {
    // A changed memo is not grounds to reopen a payment question.
    expect(factChanges({ ...facts }, { ...facts })).toEqual([]);
  });
});

describe("planFollowUp — reopening on changed evidence", () => {
  it("reopens when the purchase order the agent asked for arrives", () => {
    const plan = planFollowUp(frozen({ poReference: "PO-1042" }), facts, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.reason).toContain("evidence this decision rested on has changed");
  });

  it("reopens a held invoice when screening raises the limit back", () => {
    const plan = planFollowUp(
      frozen({ status: "held", paymentLimit: 8 }),
      { ...facts, paymentLimit: 0.5 },
      NOW,
      config
    );
    expect(plan.action).toBe("reopen");
    expect(plan.changes[0]).toContain("0.5 USDC → 8 USDC");
  });

  it("reopens on changed evidence even when the invoice is fresh", () => {
    // Freshness is a reason not to nag a human, never a reason to ignore new
    // evidence.
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(0.01), goodsReceived: true }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("reopen");
  });

  it("reopens rather than assuming, when no decision facts were recorded", () => {
    const plan = planFollowUp(frozen(), null, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.reason).toContain("No recorded decision facts");
  });
});

describe("planFollowUp — escalating on silence", () => {
  it("escalates once the question has gone unanswered past the threshold", () => {
    const plan = planFollowUp(frozen({ decidedAt: daysAgo(4) }), facts, NOW, config);
    expect(plan.action).toBe("escalate");
    expect(plan.reason).toContain("gone unanswered");
  });

  it("escalates a past-due invoice immediately, however recently decided", () => {
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(0.1), dueDate: daysAgo(1) }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("escalate");
    expect(plan.pastDue).toBe(true);
    expect(plan.reason).toContain("due date");
  });

  it("does not escalate an invoice that is merely recent", () => {
    const plan = planFollowUp(frozen({ decidedAt: daysAgo(1) }), facts, NOW, config);
    expect(plan.action).toBe("wait");
  });

  it("escalates exactly on the threshold, not a day late", () => {
    expect(planFollowUp(frozen({ decidedAt: daysAgo(3) }), facts, NOW, config).action).toBe("escalate");
  });

  it("names the amount a human has to rule on", () => {
    const plan = planFollowUp(
      frozen({ amount: 6.2, status: "held", dueDate: daysAgo(1) }),
      facts,
      NOW,
      config
    );
    expect(plan.reason).toContain("6.2 USDC");
  });
});

describe("planFollowUp — not turning into an alert treadmill", () => {
  it("does not escalate the same unchanged invoice every cycle", () => {
    // Telling a human the same thing every cycle is how an alert stops being
    // read at all.
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(10), escalatedAt: daysAgo(1) }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("wait");
    expect(plan.reason).toContain("re-escalation window");
  });

  it("escalates again once the re-escalation window has passed", () => {
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(20), escalatedAt: daysAgo(8) }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("escalate");
  });

  it("reopens on new evidence even inside the quiet window", () => {
    // Suppressing a repeat alert must never suppress a real change.
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(10), escalatedAt: daysAgo(1), goodsReceived: true }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("reopen");
  });

  it("never re-runs the model on identical facts inside the window", () => {
    for (const age of [4, 10, 30, 365]) {
      const plan = planFollowUp(
        frozen({ decidedAt: daysAgo(age), escalatedAt: daysAgo(0.5) }),
        facts,
        NOW,
        config
      );
      expect(plan.action, `age ${age}d`).toBe("wait");
    }
  });
});

describe("followUpConfig", () => {
  // Validation moved into configFromEnv, so these build a config rather than
  // mutating the environment a running scope has already read.
  const cadence = (over: Record<string, string> = {}) =>
    runWithConfig(
      configFromEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "k",
        ...over,
      }),
      () => followUpConfig()
    );

  it("has usable defaults", () => {
    expect(cadence()).toEqual({ staleAfterDays: 3, reEscalateAfterDays: 7 });
  });

  it("reads an explicit cadence", () => {
    expect(cadence({ FOLLOW_UP_STALE_DAYS: "1", FOLLOW_UP_RE_ESCALATE_DAYS: "2" }))
      .toEqual({ staleAfterDays: 1, reEscalateAfterDays: 2 });
  });

  it("falls back to the default on nonsense rather than never escalating", () => {
    // A bad value must not mean "stay silent forever", which is the direction
    // that loses money quietly.
    for (const bad of ["", "abc", "-1", "0"]) {
      expect(cadence({ FOLLOW_UP_STALE_DAYS: bad }).staleAfterDays).toBe(3);
    }
  });
});

describe("planFollowUp — a EURC invoice (review I2)", () => {
  it("says its amount in EURC when it escalates it", () => {
    const plan = planFollowUp(
      frozen({ currency: "EURC", amount: 100, dueDate: daysAgo(2), decidedAt: daysAgo(9) }),
      { poReference: null, goodsReceived: false, riskLevel: "clear", paymentLimit: 2 },
      NOW,
      config
    );
    expect(plan.action).toBe("escalate");
    expect(plan.reason).toContain("100 EURC needs a human decision");
  });
});

describe("planMilestoneFollowUp — a held milestone goes back to the agent when its facts change", () => {
  const atDecision: MilestoneDecisionFacts = { riskLevel: "clear", paymentLimit: 1, verificationSource: "PR #84", heldBecausePaused: false };
  const held = (over: Partial<HeldMilestone> = {}): HeldMilestone => ({
    id: "ms-1",
    title: "Thumbnails",
    amount: 2,
    riskLevel: "clear",
    paymentLimit: 1,
    verificationSource: "PR #84",
    ...over,
  });

  it("reopens when the contractor's limit was raised", () => {
    const plan = planMilestoneFollowUp(held({ paymentLimit: 5 }), atDecision);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["payment limit moved 1 USDC → 5 USDC"]);
    expect(plan.reason).toContain("evidence this decision rested on has changed");
  });

  it("reopens when screening moved the contractor's risk", () => {
    const plan = planMilestoneFollowUp(held(), { ...atDecision, riskLevel: "high" });
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["contractor risk moved high → clear"]);
  });

  it("reopens when the evidence of the work changed", () => {
    const plan = planMilestoneFollowUp(held({ verificationSource: "https://github.com/acme/app/pull/12" }), { ...atDecision, verificationSource: null });
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["evidence of the work is now https://github.com/acme/app/pull/12"]);
  });

  it("reopens a milestone held only because the agent was paused, now that a cycle runs", () => {
    const plan = planMilestoneFollowUp(held(), { ...atDecision, heldBecausePaused: true });
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the agent was paused when it was held, and is running again"]);
  });

  it("reports every change, not just the first", () => {
    const plan = planMilestoneFollowUp(held({ paymentLimit: 5, riskLevel: "medium" }), atDecision);
    expect(plan.changes).toHaveLength(2);
  });

  it("waits, with no model call, when nothing it rested on has changed", () => {
    const plan = planMilestoneFollowUp(held(), atDecision);
    expect(plan.action).toBe("wait");
    expect(plan.changes).toEqual([]);
  });

  it("reopens rather than assuming, when no decision facts were recorded", () => {
    const plan = planMilestoneFollowUp(held(), null);
    expect(plan.action).toBe("reopen");
    expect(plan.reason).toContain("No recorded decision facts");
  });
});

describe("follow-up — held for want of cash (reserve cash back R4)", () => {
  const cashHeld = (over: Partial<FrozenInvoice> = {}) => frozen({ status: "held", amount: 0.35, ...over });
  const heldWith = (seen: { operating: number; reserve: number }): DecisionFacts => ({ ...facts, heldForCash: { needed: 0.35, ...seen } });
  const emptyReserve = heldWith({ operating: 0.119389, reserve: 0 });

  it("reopens a payable once cash came in and covers what it needed", () => {
    const plan = planFollowUp(cashHeld({ cash: { operating: 20.119389, reserve: 0 } }), emptyReserve, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the cash it needs is there now (20.119389 USDC in the operating wallet and the reserve)"]);
  });

  it("reopens it once a person brought the reserve back to the operating wallet, the total unchanged", () => {
    const plan = planFollowUp(cashHeld({ cash: { operating: 60.81074, reserve: 0 } }), heldWith({ operating: 0.119389, reserve: 60.691351 }), NOW, config);
    expect(plan.action).toBe("reopen");
  });

  it("waits while the cash has not moved since the decision, so a failing or paused redemption never loops", () => {
    const stood = { operating: 0.119389, reserve: 60.691351 };
    expect(planFollowUp(cashHeld({ cash: stood }), heldWith(stood), NOW, config).action).toBe("wait");
  });

  it("waits while they still hold less than it needs, or the cash was not read", () => {
    expect(planFollowUp(cashHeld({ cash: { operating: 0.2, reserve: 0 } }), emptyReserve, NOW, config).action).toBe("wait");
    expect(planFollowUp(cashHeld(), emptyReserve, NOW, config).action).toBe("wait");
  });

  it("never reopens a payable held for another reason because cash came in", () => {
    expect(planFollowUp(cashHeld({ cash: { operating: 1000, reserve: 0 } }), facts, NOW, config).action).toBe("wait");
  });

  // A milestone release the operating wallet could not cover, after the releases before it in its cycle (mainnet pre-flight).
  const milestoneAtDecision: MilestoneDecisionFacts = {
    riskLevel: "clear",
    paymentLimit: 10,
    verificationSource: "PR #84",
    heldBecausePaused: false,
    heldForCash: { needed: 5, operating: 2, reserve: 0 },
  };
  const heldMilestone = (over: Partial<HeldMilestone> = {}): HeldMilestone => ({
    id: "ms-1", title: "Launch", amount: 5, riskLevel: "clear", paymentLimit: 10, verificationSource: "PR #84", ...over,
  });

  it("reopens a milestone held for want of cash once cash came in and covers it, and waits until then", () => {
    expect(planMilestoneFollowUp(heldMilestone({ cash: { operating: 5, reserve: 0 } }), milestoneAtDecision)).toMatchObject({
      action: "reopen",
      changes: ["the cash it needs is there now (5 USDC in the operating wallet and the reserve)"],
    });
    expect(planMilestoneFollowUp(heldMilestone({ cash: { operating: 2, reserve: 4 } }), milestoneAtDecision).action).toBe("reopen");
    expect(planMilestoneFollowUp(heldMilestone({ cash: { operating: 2, reserve: 0 } }), milestoneAtDecision).action).toBe("wait");
    expect(planMilestoneFollowUp(heldMilestone({ cash: { operating: 4.99, reserve: 0 } }), milestoneAtDecision).action).toBe("wait");
    expect(planMilestoneFollowUp(heldMilestone(), milestoneAtDecision).action).toBe("wait");
  });

  it("never reopens a milestone held for another reason because cash came in", () => {
    expect(planMilestoneFollowUp(heldMilestone({ cash: { operating: 1000, reserve: 0 } }), { ...milestoneAtDecision, heldForCash: null }).action).toBe("wait");
  });
});

describe("follow-up — held while the counterparty's new address waited for a person", () => {
  // The decision saw the address unconfirmed (`observed.addressUnconfirmed`), so the AP guardrail held it for a person.
  const waitedOnAddress: DecisionFacts = { ...facts, addressUnconfirmed: true };
  const held = (over: Partial<FrozenInvoice> = {}) => frozen({ status: "held", ...over });

  it("reopens a payable once someone confirms the address, so the agent decides it again", () => {
    const plan = planFollowUp(held({ addressUnconfirmed: false }), waitedOnAddress, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the counterparty's new address has since been confirmed"]);
  });

  it("waits while the address is still unconfirmed, or was not read", () => {
    expect(planFollowUp(held({ addressUnconfirmed: true }), waitedOnAddress, NOW, config).action).toBe("wait");
    expect(planFollowUp(held(), waitedOnAddress, NOW, config).action).toBe("wait");
  });

  it("does not reopen a payable decided with a confirmed address because the address changed since: the guardrail holds it anyway", () => {
    expect(planFollowUp(held({ addressUnconfirmed: true }), { ...facts, addressUnconfirmed: false }, NOW, config).action).toBe("wait");
  });

  it("reads a decision recorded before the address was observed as one that did not wait on it", () => {
    expect(planFollowUp(held({ addressUnconfirmed: false }), facts, NOW, config).action).toBe("wait");
  });
});

describe("follow-up — held because the counterparty had no payment address", () => {
  // The decision saw no address (`observed.addressMissing`), so the AP guardrail held it (counterparty.no_address).
  const noAddress: DecisionFacts = { ...facts, addressMissing: true };
  const held = (over: Partial<FrozenInvoice> = {}) => frozen({ status: "held", ...over });

  it("reopens a payable once the counterparty has an address and it is confirmed", () => {
    const plan = planFollowUp(held({ addressMissing: false, addressUnconfirmed: false }), noAddress, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the counterparty now has a confirmed payment address"]);
  });

  it("waits while the address is missing, unconfirmed, or was not read", () => {
    expect(planFollowUp(held({ addressMissing: true, addressUnconfirmed: false }), noAddress, NOW, config).action).toBe("wait");
    expect(planFollowUp(held({ addressMissing: false, addressUnconfirmed: true }), noAddress, NOW, config).action).toBe("wait");
    expect(planFollowUp(held(), noAddress, NOW, config).action).toBe("wait");
  });

  it("does not reopen a decision that had an address", () => {
    expect(planFollowUp(held({ addressMissing: false, addressUnconfirmed: false }), facts, NOW, config).action).toBe("wait");
  });
});

describe("follow-up — held only for the agent's spending limit (outflow budget R6)", () => {
  const heldForBudget: DecisionFacts = { ...facts, heldForBudgetUsdc: 1.5 };
  const budgetHeld = (over: Partial<FrozenInvoice> = {}) => frozen({ status: "held", amount: 1.5, ...over });

  it("reopens a payable once the limit has room for it again", () => {
    const plan = planFollowUp(budgetHeld({ budgetRoom: 1.5 }), heldForBudget, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the agent's spending limit has room for it again (1.5 USDC left)"]);
  });

  it("reopens a payable once no limit is set", () => {
    const plan = planFollowUp(budgetHeld({ budgetRoom: null }), heldForBudget, NOW, config);
    expect(plan.changes).toEqual(["the agent's spending limit was removed"]);
  });

  it("waits while the limit still leaves less than it needs, or the room was not read", () => {
    expect(planFollowUp(budgetHeld({ budgetRoom: 1.4 }), heldForBudget, NOW, config).action).toBe("wait");
    expect(planFollowUp(budgetHeld(), heldForBudget, NOW, config).action).toBe("wait");
  });

  it("never reopens a payable held for another reason because the limit has room", () => {
    expect(planFollowUp(budgetHeld({ budgetRoom: 100 }), facts, NOW, config).action).toBe("wait");
  });

  const atDecision: MilestoneDecisionFacts = { riskLevel: "clear", paymentLimit: 10, verificationSource: "PR #84", heldBecausePaused: false, heldForBudget: true };
  const held = (over: Partial<HeldMilestone> = {}): HeldMilestone => ({
    id: "ms-1", title: "Thumbnails", amount: 2, riskLevel: "clear", paymentLimit: 10, verificationSource: "PR #84", ...over,
  });

  it("reopens a milestone once the limit has room for it, and waits until then", () => {
    expect(planMilestoneFollowUp(held({ budgetRoom: 2 }), atDecision)).toMatchObject({
      action: "reopen",
      changes: ["the agent's spending limit has room for it again (2 USDC left)"],
    });
    expect(planMilestoneFollowUp(held({ budgetRoom: null }), atDecision).changes).toEqual(["the agent's spending limit was removed"]);
    expect(planMilestoneFollowUp(held({ budgetRoom: 1.99 }), atDecision).action).toBe("wait");
    expect(planMilestoneFollowUp(held({ budgetRoom: 50 }), { ...atDecision, heldForBudget: false }).action).toBe("wait");
  });
});

describe("follow-up — a counterparty now paid without purchase orders (three-way match design M5)", () => {
  // Decided while the counterparty needed a purchase order and none was on file: the guardrail asked for information.
  const neededOne: DecisionFacts = { ...facts, goodsReceived: true, purchaseOrderRequired: true };
  const waiting = (over: Partial<FrozenInvoice> = {}) => frozen({ goodsReceived: true, ...over });

  it("reopens a payable that waited for a purchase order once its counterparty needs none", () => {
    const plan = planFollowUp(waiting({ purchaseOrderRequired: false }), neededOne, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the counterparty is now paid without purchase orders"]);
  });

  it("reopens nothing when purchase orders are required again, or the setting was not read", () => {
    expect(planFollowUp(waiting({ purchaseOrderRequired: true }), { ...neededOne, purchaseOrderRequired: false }, NOW, config).action).toBe("wait");
    expect(planFollowUp(waiting(), neededOne, NOW, config).action).toBe("wait");
  });

  it("leaves a payable that had its purchase order: it waits for something the setting does not change", () => {
    const plan = planFollowUp(waiting({ poReference: "PO-7", purchaseOrderRequired: false }), { ...neededOne, poReference: "PO-7" }, NOW, config);
    expect(plan.action).toBe("wait");
    expect(plan.changes).toEqual([]);
  });

  it("reads a decision recorded before the setting existed as one where purchase orders were needed", () => {
    const plan = planFollowUp(waiting({ purchaseOrderRequired: false }), { ...facts, goodsReceived: true }, NOW, config);
    expect(plan.changes).toEqual(["the counterparty is now paid without purchase orders"]);
  });
});

describe("follow-up — a EURC payable held for FX (FX re-evaluation F2, F3, F6)", () => {
  // Loto's 0.5 EURC, held because Circle quoted no rate (#1434).
  const heldForRate: DecisionFacts = {
    poReference: "PO-SWAP-1",
    goodsReceived: true,
    riskLevel: "clear",
    paymentLimit: 1,
    fxHold: {
      blocker: "no_rate",
      decisionSeq: 1434,
      action: "hold",
      guardrailRule: null,
      amount: 0.5,
      rate: null,
      usdcValue: null,
      swapCostPercent: null,
      eurcShort: 0.5,
    },
  };
  const loto = (over: Partial<FrozenInvoice> = {}) =>
    frozen({ status: "held", amount: 0.5, currency: "EURC", poReference: "PO-SWAP-1", goodsReceived: true, paymentLimit: 1, ...over });
  const quoted = { rate: 1.215262, usdcValue: 0.607631, swapCostPercent: null, swapAvailable: null, quotedAt: "2026-09-24T12:00:00.000Z" };

  it("reopens it once a fresh quote clears what held it, with the change and what the reopen records", () => {
    const plan = planFollowUp(loto({ fx: quoted }), heldForRate, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual([
      "a EURC rate is quoted again: 0.5 EURC is worth 0.607631 USDC at 1.215262 USDC per EURC, where there was none at the decision",
    ]);
    expect(plan.reevaluation).toEqual({
      trigger: "rate_available",
      previousDecision: { seq: 1434, action: "hold", guardrailRule: null },
      before: { rate: null, usdcValue: null, swapCostPercent: null },
      after: { rate: 1.215262, usdcValue: 0.607631, swapCostPercent: null, quotedAt: "2026-09-24T12:00:00.000Z" },
    });
  });

  it("leaves it held when the quote still fails, or was not asked", () => {
    expect(planFollowUp(loto({ fx: { ...quoted, rate: null, usdcValue: null } }), heldForRate, NOW, config)).toMatchObject({ action: "wait", changes: [] });
    const notAsked = planFollowUp(loto(), heldForRate, NOW, config);
    expect(notAsked.action).toBe("wait");
    expect(notAsked.reevaluation).toBeUndefined();
  });

  it("weighs a value above the limit against the counterparty's limit now", () => {
    const over: DecisionFacts = {
      ...heldForRate,
      paymentLimit: 2,
      fxHold: { ...heldForRate.fxHold!, blocker: "over_limit", amount: 1.9, rate: 1.215956, usdcValue: 2.310316, guardrailRule: "counterparty.payment_limit", action: "pay" },
    };
    const cheaper = { ...quoted, rate: 1.05, usdcValue: 1.995 };
    expect(planFollowUp(loto({ amount: 1.9, paymentLimit: 2, fx: cheaper }), over, NOW, config).reevaluation?.trigger).toBe("value_within_limit");
    expect(planFollowUp(loto({ amount: 1.9, paymentLimit: 1.5, fx: cheaper }), { ...over, paymentLimit: 1.5 }, NOW, config).action).toBe("wait");
  });
});

describe("follow-up — a payable held as a new payee (new payee check N7)", () => {
  const heldAsNewPayee: DecisionFacts = { poReference: "PO-1", goodsReceived: true, riskLevel: "clear", paymentLimit: 2, newPayeeHeld: true };
  const held = (over: Partial<FrozenInvoice> = {}) => frozen({ status: "held", poReference: "PO-1", goodsReceived: true, ...over });

  it("reopens it once its address has received a confirmed payment", () => {
    const plan = planFollowUp(held({ newPayee: { addressPaid: true, twoParties: false } }), heldAsNewPayee, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["the payee's address has received a confirmed payment since"]);
  });

  it("reopens it once a second person stands behind its address", () => {
    const plan = planFollowUp(held({ newPayee: { addressPaid: false, twoParties: true } }), heldAsNewPayee, NOW, config);
    expect(plan.changes).toEqual(["a second person now stands behind the payee's address"]);
  });

  it("leaves it while one person alone still stands behind it, or when that was not read", () => {
    expect(planFollowUp(held({ newPayee: { addressPaid: false, twoParties: false } }), heldAsNewPayee, NOW, config).action).toBe("wait");
    expect(planFollowUp(held(), heldAsNewPayee, NOW, config).action).toBe("wait");
  });

  it("asks nothing of a payable held for anything else", () => {
    const other: DecisionFacts = { ...heldAsNewPayee, newPayeeHeld: false };
    expect(planFollowUp(held({ newPayee: { addressPaid: true, twoParties: true } }), other, NOW, config).action).toBe("wait");
  });
});

describe("follow-up — a payment held for two approvals (two approvals T3)", () => {
  const heldForTwo: DecisionFacts = { poReference: "PO-1", goodsReceived: true, riskLevel: "clear", paymentLimit: 500, heldForTwoApprovals: { value: 300, above: 250 } };
  const held = (over: Partial<FrozenInvoice> = {}) => frozen({ status: "held", amount: 300, poReference: "PO-1", goodsReceived: true, paymentLimit: 500, ...over });

  it("reopens a payable once the figure is turned off", () => {
    const plan = planFollowUp(held({ twoApprovalsAbove: null }), heldForTwo, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.changes).toEqual(["two approvals above 250 USDC were turned off"]);
  });

  it("reopens it once the figure is raised to its value or more", () => {
    expect(planFollowUp(held({ twoApprovalsAbove: 300 }), heldForTwo, NOW, config).changes).toEqual([
      "the figure for two approvals was raised from 250 USDC to 300 USDC, which covers its 300 USDC",
    ]);
  });

  it("leaves it while the figure still holds it, or when the figure was not read", () => {
    expect(planFollowUp(held({ twoApprovalsAbove: 299 }), heldForTwo, NOW, config).action).toBe("wait");
    expect(planFollowUp(held(), heldForTwo, NOW, config).action).toBe("wait");
  });

  it("asks nothing of a payable held for anything else", () => {
    const other: DecisionFacts = { ...heldForTwo, heldForTwoApprovals: null };
    expect(planFollowUp(held({ twoApprovalsAbove: null }), other, NOW, config).action).toBe("wait");
  });

  it("reopens a milestone held for two approvals once the figure no longer covers it", () => {
    const milestone: HeldMilestone = { id: "ms-1", title: "Design", amount: 300, riskLevel: "clear", paymentLimit: 500, verificationSource: null };
    const atDecision: MilestoneDecisionFacts = { riskLevel: "clear", paymentLimit: 500, verificationSource: null, heldBecausePaused: false, heldForTwoApprovals: true };
    expect(planMilestoneFollowUp({ ...milestone, twoApprovalsAbove: null }, atDecision)).toMatchObject({ action: "reopen", changes: ["two approvals were turned off"] });
    expect(planMilestoneFollowUp({ ...milestone, twoApprovalsAbove: 300 }, atDecision).changes).toEqual(["the figure for two approvals is now 300 USDC, which covers its 300 USDC"]);
    expect(planMilestoneFollowUp({ ...milestone, twoApprovalsAbove: 299 }, atDecision).action).toBe("wait");
    expect(planMilestoneFollowUp(milestone, atDecision).action).toBe("wait");
    expect(planMilestoneFollowUp({ ...milestone, twoApprovalsAbove: null }, { ...atDecision, heldForTwoApprovals: false }).action).toBe("wait");
  });
});

describe("twoApprovalsHeldValue", () => {
  it("is the value and figure a decision held for two approvals was weighed at, null for any other", () => {
    expect(twoApprovalsHeldValue({ detail: { guardrailRule: "workspace.two_approvals", observed: { amount: 300, twoApprovalsAbove: 250 } } })).toEqual({ value: 300, above: 250 });
    expect(twoApprovalsHeldValue({ detail: { guardrailRule: "workspace.two_approvals", usdcValue: 108, observed: { amount: 100, twoApprovalsAbove: 100 } } })).toEqual({ value: 108, above: 100 });
    expect(twoApprovalsHeldValue({ detail: { guardrailRule: "counterparty.payment_limit", observed: { amount: 300 } } })).toBeNull();
    expect(twoApprovalsHeldValue({ detail: { guardrailRule: "workspace.two_approvals", observed: { amount: 300 } } })).toBeNull();
  });
});

describe("a payment held in shadow mode for a person to agree (shadow mode S2)", () => {
  it("is never reopened, whatever changed since: only a person ends it", () => {
    const held: DecisionFacts = { ...facts, heldForVerdict: true };
    const changed = frozen({ status: "held", poReference: "PO-1042", goodsReceived: true, riskLevel: "high", paymentLimit: 50 });
    expect(planFollowUp(changed, held, NOW, config).action).not.toBe("reopen");
    expect(planFollowUp(changed, held, NOW, config).changes).toEqual([]);
  });

  it("leaves a milestone held in shadow mode held, whatever changed since", () => {
    const atDecision: MilestoneDecisionFacts = { riskLevel: "clear", paymentLimit: 10, verificationSource: "PR #84", heldBecausePaused: false, heldForVerdict: true };
    const changed: HeldMilestone = { id: "ms-1", title: "Launch", amount: 5, riskLevel: "high", paymentLimit: 2, verificationSource: "PR #85", cash: { operating: 1000, reserve: 0 } };
    expect(planMilestoneFollowUp(changed, atDecision)).toMatchObject({ action: "wait", changes: [] });
  });
});
