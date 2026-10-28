import { describe, expect, it } from "vitest";
import {
  replayDecisions,
  replaySummary,
  withCandidate,
  type ReplayEntry,
  type RuleFigures,
  type ShadowHistory,
} from "@/lib/policy-replay";

/**
 * Trying a rule figure on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md): the code's checks
 * replayed on recorded facts, with the figures in force and with a candidate swapped in. Pure, so every case is a list
 * of ledger entries and two sets of figures.
 */

const ACME = "cp-acme";
const BOLT = "cp-bolt";
const DAY1 = "2026-10-01";
const WINDOW_START = "2026-10-01T00:00:00.000Z";

let seq = 100;

/** An agent's decision on a bill, as the AP stage records it: paid by default, on Arc, in a sandbox. */
function bill(options: {
  counterpartyId?: string;
  amount?: number;
  at?: string;
  action?: "pay" | "schedule" | "hold" | "flag_fraud" | "request_info";
  rule?: string | null;
  risk?: string;
  limit?: number | null;
  paid?: boolean;
  invoiceId?: string;
  detail?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}): ReplayEntry {
  const action = options.action ?? "pay";
  const rule = options.rule === undefined ? null : options.rule;
  const amount = options.amount ?? 100;
  const paid = options.paid ?? (action === "pay" && rule === null);
  return {
    seq: seq++,
    ts: options.at ?? `${DAY1}T09:00:00.000Z`,
    action: `ap_${action}`,
    detail: {
      invoiceId: options.invoiceId ?? `inv-${seq}`,
      counterpartyId: options.counterpartyId ?? ACME,
      decision: { action, reasoning: "r", confidence: 0.9 },
      guardrailBlocked: rule !== null,
      guardrailRule: rule,
      currency: "USDC",
      ...(action === "pay" ? { amountPaid: paid ? amount : null } : {}),
      observed: { amount, paymentLimit: options.limit === undefined ? 500 : options.limit, riskLevel: options.risk ?? "clear", ...options.observed },
      execution: { chainMode: "simulate", resultingStatus: paid ? "paid" : rule ? "held" : action === "schedule" ? "scheduled" : "held", ...options.execution },
      ...options.detail,
    },
  };
}

/** An agent's decision on a contractor milestone, as the contractor stage records it. */
function release(options: {
  counterpartyId?: string;
  amount?: number;
  at?: string;
  action?: "release" | "hold";
  rule?: string | null;
  risk?: string;
  paid?: boolean;
  observed?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  detail?: Record<string, unknown>;
}): ReplayEntry {
  const action = options.action ?? "release";
  const rule = options.rule === undefined ? null : options.rule;
  const amount = options.amount ?? 100;
  const paid = options.paid ?? (action === "release" && rule === null);
  return {
    seq: seq++,
    ts: options.at ?? `${DAY1}T09:00:00.000Z`,
    action: `milestone_${action}`,
    detail: {
      milestoneId: `ms-${seq}`,
      counterpartyId: options.counterpartyId ?? BOLT,
      decision: { action, reasoning: "r", confidence: 0.9 },
      guardrailBlocked: rule !== null,
      guardrailRule: rule,
      observed: { amount, paymentLimit: 500, riskLevel: options.risk ?? "clear", ...options.observed },
      execution: { chainMode: "simulate", resultingStatus: paid ? "paid" : "held", ...options.execution },
      ...options.detail,
    },
  };
}

function figures(overrides: Partial<RuleFigures> = {}): RuleFigures {
  return {
    counterpartyLimits: { [ACME]: 500, [BOLT]: 500 },
    twoApprovalsAbove: null,
    spendingLimit: { dailyUsdc: null, weeklyUsdc: null },
    ...overrides,
  };
}

function run(entries: ReplayEntry[], current: RuleFigures, candidate: RuleFigures, options: { cycleEnds?: number[]; shadow?: ShadowHistory } = {}) {
  return replayDecisions(entries, { windowStart: WINDOW_START, current, candidate, ...options });
}

/** What the reader knows on Arc mainnet, where shadow mode cannot run. */
const NEVER_SHADOW: ShadowHistory = { onSince: null, earlierPossible: false };

const changes = (result: ReturnType<typeof run>) => result.decisions.map((decision) => decision.change);

describe("withCandidate", () => {
  it("swaps one counterparty's configured limit, and nothing else", () => {
    const now = figures({ twoApprovalsAbove: 1000 });
    const next = withCandidate(now, { kind: "counterparty_limit", counterpartyId: ACME, limit: 200 });
    expect(next.counterpartyLimits).toEqual({ [ACME]: 200, [BOLT]: 500 });
    expect(next.twoApprovalsAbove).toBe(1000);
    expect(now.counterpartyLimits[ACME]).toBe(500);
  });

  it("swaps the two-approvals figure, or the spending limit's two figures", () => {
    expect(withCandidate(figures(), { kind: "two_approvals", above: 300 }).twoApprovalsAbove).toBe(300);
    expect(withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 50, weeklyUsdc: null }).spendingLimit).toEqual({ dailyUsdc: 50, weeklyUsdc: null });
  });
});

describe("the payment limit (P5)", () => {
  it("holds a bill the agent paid when the candidate limit is lower", () => {
    const result = run([bill({ amount: 300 }), bill({ amount: 150 })], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 200 }));
    expect(changes(result)).toEqual(["now_held", "unchanged"]);
    expect(result.decisions[0].before).toEqual({ kind: "goes_ahead" });
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "counterparty.payment_limit" });
  });

  it("pays a bill the limit held when the candidate is higher", () => {
    const result = run([bill({ amount: 700, rule: "counterparty.payment_limit" })], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 800 }));
    expect(result.decisions[0].before).toEqual({ kind: "stopped", rule: "counterparty.payment_limit" });
    expect(result.decisions[0].after).toEqual({ kind: "goes_ahead" });
    expect(changes(result)).toEqual(["now_paid"]);
  });

  it("weighs the limit as screening allowed it for the risk the decision recorded", () => {
    // Medium risk: a quarter of the configured limit. 150 is above a quarter of 500, below a quarter of 800.
    const entries = [bill({ amount: 150, risk: "medium", limit: 125, rule: "counterparty.payment_limit" })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 800 }));
    expect(changes(result)).toEqual(["now_paid"]);
  });

  it("leaves another counterparty's bills as they were", () => {
    const entries = [bill({ counterpartyId: BOLT, amount: 300 })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 100 }));
    expect(changes(result)).toEqual(["unchanged"]);
  });

  it("keeps the recorded limit for a counterparty no longer in the workspace, in both columns", () => {
    const entries = [bill({ counterpartyId: "cp-gone", amount: 300, limit: 200, rule: "counterparty.payment_limit" })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "two_approvals", above: 1000 }));
    expect(result.decisions[0].before).toEqual({ kind: "stopped", rule: "counterparty.payment_limit" });
    expect(changes(result)).toEqual(["unchanged"]);
  });

  it("weighs a EURC bill at the USDC value its decision recorded", () => {
    const entries = [bill({ amount: 100, detail: { currency: "EURC", usdcValue: 116, amountPaid: 100 } })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 110 }));
    expect(changes(result)).toEqual(["now_held"]);
  });

  it("cannot tell when the decision recorded no risk level", () => {
    const entries = [bill({ amount: 300, observed: { riskLevel: undefined } })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 200 }));
    expect(result.decisions[0].after).toEqual({ kind: "cant_tell", because: "risk_missing" });
    expect(changes(result)).toEqual(["cant_tell"]);
  });
});

describe("two approvals (P5, P8)", () => {
  it("counts a bill the agent paid above a lower figure as now needing two people", () => {
    const result = run([bill({ amount: 300 }), bill({ amount: 50 })], figures(), withCandidate(figures(), { kind: "two_approvals", above: 100 }));
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "workspace.two_approvals" });
    expect(changes(result)).toEqual(["now_two_people", "unchanged"]);
  });

  it("pays a bill held for two approvals once the figure is turned off", () => {
    const now = figures({ twoApprovalsAbove: 100 });
    const result = run([bill({ amount: 300, rule: "workspace.two_approvals" })], now, withCandidate(now, { kind: "two_approvals", above: null }));
    expect(changes(result)).toEqual(["now_paid"]);
  });

  it("holds a schedule above the figure too, since the agent would commit to pay it", () => {
    const result = run([bill({ amount: 300, action: "schedule" })], figures(), withCandidate(figures(), { kind: "two_approvals", above: 100 }));
    expect(changes(result)).toEqual(["now_two_people"]);
  });

  it("counts a bill now held by a lower payment limit, ahead of two approvals, as held", () => {
    const now = figures({ twoApprovalsAbove: 1000 });
    const result = run([bill({ amount: 300 })], now, withCandidate(now, { kind: "counterparty_limit", counterpartyId: ACME, limit: 200 }));
    expect(changes(result)).toEqual(["now_held"]);
  });
});

describe("the spending limit, replayed in recorded order (P6)", () => {
  it("holds the payment that would take the agent past a lower daily figure, and starts again the next UTC day", () => {
    const entries = [
      bill({ amount: 60, at: "2026-10-02T08:00:00.000Z" }),
      bill({ amount: 60, at: "2026-10-02T09:00:00.000Z", counterpartyId: BOLT }),
      bill({ amount: 60, at: "2026-10-03T08:00:00.000Z" }),
    ];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 100, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged", "now_held", "unchanged"]);
    expect(result.decisions[1].after).toEqual({ kind: "stopped", rule: "workspace.outflow_budget" });
  });

  it("counts a payment it now lets through, so a later one the same day may no longer fit", () => {
    const now = figures({ spendingLimit: { dailyUsdc: 100, weeklyUsdc: null } });
    const entries = [
      bill({ amount: 80, at: "2026-10-02T08:00:00.000Z" }),
      bill({ amount: 50, at: "2026-10-02T09:00:00.000Z", rule: "workspace.outflow_budget" }),
      bill({ amount: 20, at: "2026-10-02T10:00:00.000Z", counterpartyId: BOLT }),
    ];
    // At 140 a day: 80, then 50 fits (130), then 20 would make 150.
    const result = run(entries, now, withCandidate(now, { kind: "spending_limit", dailyUsdc: 140, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged", "now_paid", "now_held"]);
  });

  it("counts the 7 days ending each decision, and what the agent paid in the six days before the window", () => {
    const entries = [
      // Before the window: counted as recorded, never replayed.
      bill({ amount: 90, at: "2026-09-28T08:00:00.000Z" }),
      bill({ amount: 90, at: "2026-10-02T08:00:00.000Z" }),
      bill({ amount: 90, at: "2026-10-05T08:00:00.000Z" }),
    ];
    // A 7-day figure of 200: Oct 2's week (Sep 26 to Oct 2) holds Sep 28's 90, and 180 fits. Oct 5's week starts on
    // Sep 29, so only Oct 2's 90 counts, and 180 fits again.
    const result = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: null, weeklyUsdc: 200 }));
    expect(result.decisions.map((decision) => decision.seq)).toEqual([entries[1].seq, entries[2].seq]);
    expect(changes(result)).toEqual(["unchanged", "unchanged"]);

    const tighter = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: null, weeklyUsdc: 150 }));
    // Oct 2: 90 before the window and 90 now make 180, past 150.
    expect(changes(tighter)).toEqual(["now_held", "unchanged"]);
  });

  it("does not weigh a schedule, a model's hold or a milestone's hold against it", () => {
    const entries = [
      bill({ amount: 500, action: "schedule" }),
      bill({ amount: 500, action: "hold" }),
      release({ amount: 500, action: "hold" }),
      bill({ amount: 40 }),
    ];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 50, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(result.decisions[1].after).toEqual({ kind: "agent_held" });
  });

  it("counts milestone releases against it, in order with bills", () => {
    const entries = [release({ amount: 70 }), bill({ amount: 40 })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 100, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged", "now_held"]);
  });

  it("counts a bill paid earlier in the replay once, when the follow-up decided it again later", () => {
    const now = figures({ spendingLimit: { dailyUsdc: 100, weeklyUsdc: null } });
    const entries = [
      bill({ invoiceId: "inv-a", amount: 120, at: "2026-10-02T08:00:00.000Z", rule: "workspace.outflow_budget" }),
      // The follow-up decided it again the next day, and the limit held it again.
      bill({ invoiceId: "inv-a", amount: 120, at: "2026-10-03T08:00:00.000Z", rule: "workspace.outflow_budget" }),
      bill({ invoiceId: "inv-b", amount: 100, at: "2026-10-03T09:00:00.000Z" }),
    ];
    const result = run(entries, now, withCandidate(now, { kind: "spending_limit", dailyUsdc: 150, weeklyUsdc: null }));
    expect(result.decisions[0].after).toEqual({ kind: "goes_ahead" });
    expect(result.decisions[1].after).toEqual({ kind: "paid_earlier", seq: entries[0].seq });
    // inv-a was paid on Oct 2, so Oct 3 has room for inv-b's 100. The bill moves a count once: its Oct 2 decision.
    expect(changes(result)).toEqual(["now_paid", "unchanged", "unchanged"]);
    expect(result.counts).toMatchObject({ nowPaid: 1, unchanged: 2 });
  });

  it("counts a bill once when the figure in force pays it and the candidate holds every decision on it", () => {
    const now = figures({ spendingLimit: { dailyUsdc: 150, weeklyUsdc: null } });
    const entries = [
      bill({ invoiceId: "inv-a", amount: 120, at: "2026-10-02T08:00:00.000Z", rule: "workspace.outflow_budget" }),
      bill({ invoiceId: "inv-a", amount: 120, at: "2026-10-03T08:00:00.000Z", rule: "workspace.outflow_budget" }),
    ];
    const result = run(entries, now, withCandidate(now, { kind: "spending_limit", dailyUsdc: 100, weeklyUsdc: null }));
    expect(result.decisions[1].before).toEqual({ kind: "paid_earlier", seq: entries[0].seq });
    expect(result.decisions[1].after).toEqual({ kind: "stopped", rule: "workspace.outflow_budget" });
    expect(changes(result)).toEqual(["now_held", "unchanged"]);
  });

  it("counts a schedule the candidate frees as possibly paid on its day, so a payment that day it may crowd out cannot be told", () => {
    const now = figures({ twoApprovalsAbove: 50, spendingLimit: { dailyUsdc: 100, weeklyUsdc: null } });
    const scheduled = bill({
      action: "schedule",
      amount: 80,
      rule: "workspace.two_approvals",
      at: "2026-10-02T09:00:00.000Z",
      detail: { decision: { action: "schedule", payOn: "2026-10-04", reasoning: "r", confidence: 0.9 } },
    });
    const onItsDay = bill({ amount: 40, counterpartyId: BOLT, at: "2026-10-04T09:00:00.000Z" });
    const dayAfter = bill({ amount: 40, counterpartyId: BOLT, at: "2026-10-05T09:00:00.000Z" });
    const result = run([scheduled, onItsDay, dayAfter], now, withCandidate(now, { kind: "two_approvals", above: null }));
    // On Oct 4 the agent decides the schedule again and may pay its 80: 40 more makes 40 or 120 against 100.
    expect(result.decisions[1].after).toEqual({ kind: "cant_tell", because: "budget_unsettled" });
    expect(changes(result)).toEqual(["now_paid", "cant_tell", "unchanged"]);
  });

  it("cannot tell a schedule the candidate frees when its entry has no day to pay it on", () => {
    const now = figures({ twoApprovalsAbove: 50 });
    const result = run([bill({ action: "schedule", amount: 80, rule: "workspace.two_approvals" })], now, withCandidate(now, { kind: "two_approvals", above: null }));
    expect(result.decisions[0].after).toEqual({ kind: "cant_tell", because: "facts_missing" });
  });

  it("spends nothing for a payment a pause, cash or a failed transfer stopped, as then", () => {
    const entries = [bill({ amount: 90, paid: false, execution: { heldBecause: "cash_shortfall" } }), bill({ amount: 40 })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 100, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged", "unchanged"]);
  });

  it("spends nothing in shadow mode, where a person's verdict pays", () => {
    const entries = [bill({ amount: 90, paid: false, detail: { shadow: true }, execution: { heldBecause: "shadow_verdict" } }), bill({ amount: 40 })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 100, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged", "unchanged"]);
    expect(result.decisions.map((decision) => decision.shadow)).toEqual([true, false]);
  });

  describe("a payment the agent made on its own in shadow mode, for an earned vendor (earned vendors AL22, AL27)", () => {
    const EARNED = { shadow: true, earned: { recordSeq: 7, streak: 5, agreed: 6 } };
    const daily = (dailyUsdc: number) => figures({ spendingLimit: { dailyUsdc, weeklyUsdc: null } });
    const paidOnItsOwn = (at: string) => bill({ amount: 400, at, detail: EARNED });

    it("counts what it paid against the spending limit, as a live payment counts", () => {
      const entries = [paidOnItsOwn("2026-10-02T08:00:00.000Z"), paidOnItsOwn("2026-10-02T09:00:00.000Z"), paidOnItsOwn("2026-10-02T10:00:00.000Z")];
      const result = run(entries, daily(2000), daily(1000));
      expect(changes(result)).toEqual(["unchanged", "unchanged", "now_held"]);
      expect(result.decisions[2].after).toEqual({ kind: "stopped", rule: "workspace.outflow_budget" });
      expect(result.decisions.map((decision) => [decision.shadow, decision.onItsOwn])).toEqual([[true, true], [true, true], [true, true]]);
    });

    it("rebuilds the hold the spending limit made after them, and frees it under a higher figure", () => {
      const paid = [paidOnItsOwn("2026-10-02T08:00:00.000Z"), paidOnItsOwn("2026-10-02T09:00:00.000Z")];
      const held = bill({ amount: 400, at: "2026-10-02T10:00:00.000Z", rule: "workspace.outflow_budget", detail: { shadow: true } });
      const result = run([...paid, held], daily(1000), daily(2000));
      expect(result.decisions[2].before).toEqual({ kind: "stopped", rule: "workspace.outflow_budget" });
      expect(changes(result)).toEqual(["unchanged", "unchanged", "now_paid"]);
      expect(result.decisions[2].onItsOwn).toBe(false);
    });

    it("counts one before the window as it counts any payment the agent made", () => {
      const result = run([paidOnItsOwn("2026-09-29T08:00:00.000Z"), paidOnItsOwn("2026-10-02T08:00:00.000Z")], figures(), figures({ spendingLimit: { dailyUsdc: null, weeklyUsdc: 600 } }));
      expect(changes(result)).toEqual(["now_held"]);
    });
  });

  describe("a milestone in shadow mode, whose entry names shadow mode only when it held it for a verdict", () => {
    const now = figures({ twoApprovalsAbove: 50, spendingLimit: { dailyUsdc: 100, weeklyUsdc: null } });
    const candidate = withCandidate(now, { kind: "two_approvals", above: null });
    const entries = (shadowBill = true) => [
      release({ amount: 80, rule: "workspace.two_approvals", at: "2026-10-02T08:00:00.000Z" }),
      shadowBill
        ? bill({ amount: 40, paid: false, at: "2026-10-02T15:00:00.000Z", detail: { shadow: true }, execution: { heldBecause: "shadow_verdict" } })
        : bill({ amount: 40, at: "2026-10-02T15:00:00.000Z" }),
    ];

    it("spends nothing for one the candidate frees while shadow mode was on", () => {
      const result = run(entries(), now, candidate, { shadow: { onSince: "2026-09-20T00:00:00.000Z", earlierPossible: true } });
      expect(result.decisions[0].shadow).toBe(true);
      expect(changes(result)).toEqual(["now_paid", "unchanged"]);
      expect(result.counts).toMatchObject({ nowPaid: 1, nowHeld: 0 });
    });

    it("cannot tell what it spends when shadow mode may have been on", () => {
      const result = run(entries(), now, candidate);
      expect(result.decisions[0].shadow).toBeNull();
      expect(result.decisions[1].after).toEqual({ kind: "cant_tell", because: "budget_unsettled" });
      expect(changes(result)).toEqual(["now_paid", "cant_tell"]);
    });

    it("counts its full amount where shadow mode never ran", () => {
      const result = run(entries(false), now, candidate, { shadow: NEVER_SHADOW });
      expect(changes(result)).toEqual(["now_paid", "now_held"]);
    });

    it("reads shadow mode from a milestone held for a verdict, and its absence from one sent", () => {
      const result = run([release({ paid: false, execution: { heldBecause: "shadow_verdict" } }), release({})], now, candidate);
      expect(result.decisions.map((decision) => decision.shadow)).toEqual([true, false]);
    });
  });

  it("cannot tell a check whose answer depends on a decision it cannot tell, and can when both ends agree", () => {
    const unknown = bill({ amount: 60, at: "2026-10-02T08:00:00.000Z", rule: "counterparty.payment_limit", observed: { riskLevel: undefined } });
    const big = bill({ amount: 60, at: "2026-10-02T09:00:00.000Z", counterpartyId: BOLT });
    const nextDay = bill({ amount: 10, at: "2026-10-03T10:00:00.000Z", counterpartyId: BOLT });
    const candidate = withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 100, weeklyUsdc: null });
    const result = run([unknown, big, nextDay], figures(), candidate);
    // The first may have paid 60 or nothing, so 60 more makes 60 or 120 against 100: no answer. The next UTC day starts
    // from nothing at both ends, and 10 fits either way.
    expect(result.decisions[0].before).toEqual({ kind: "cant_tell", because: "risk_missing" });
    expect(result.decisions[1].after).toEqual({ kind: "cant_tell", because: "budget_unsettled" });
    expect(changes(result)).toEqual(["cant_tell", "cant_tell", "unchanged"]);
  });
});

describe("checks no setting here changes (P4)", () => {
  it("keeps a bill a check before the payment limit stopped, whatever the figures", () => {
    const entries = [bill({ amount: 900, rule: "counterparty.high_risk", risk: "high" }), bill({ amount: 900, rule: "invoice.duplicate_of_settled" })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 5000 }));
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "counterparty.high_risk" });
    expect(changes(result)).toEqual(["unchanged", "unchanged"]);
  });

  it("cannot tell a bill to another chain once a higher limit lets it reach the cross-chain checks", () => {
    const crossChain = bill({ amount: 700, rule: "counterparty.payment_limit", detail: { payout: { chain: "Base", route: "cctp", feeUsdc: 0.1 } } });
    const onArc = bill({ amount: 700, rule: "counterparty.payment_limit" });
    const result = run([crossChain, onArc], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 }));
    expect(result.decisions[0].after).toEqual({ kind: "cant_tell", because: "stage_unsettled" });
    expect(changes(result)).toEqual(["cant_tell", "now_paid"]);
  });

  it("runs the same work and the project's budget last: the same work fires from its record, a bill in a project cannot be told", () => {
    const sameWork = bill({ amount: 700, rule: "counterparty.payment_limit", observed: { sameWork: [{ otherKind: "milestone", otherId: "m1", signal: "purchase_order" }] } });
    const inProject = bill({ amount: 700, rule: "counterparty.payment_limit", observed: { projectId: "p1" } });
    const plain = bill({ amount: 700, rule: "counterparty.payment_limit" });
    const result = run([sameWork, inProject, plain], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 }));
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "obligation.duplicate_reference" });
    expect(result.decisions[1].after).toEqual({ kind: "cant_tell", because: "stage_unsettled" });
    expect(changes(result)).toEqual(["unchanged", "cant_tell", "now_paid"]);
  });

  it("keeps a bill its project's budget held, under a candidate that changes nothing before it", () => {
    const held = bill({ amount: 300, rule: "project.budget_exceeded", observed: { projectId: "p1" } });
    const result = run([held], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 }));
    expect(result.decisions[0].before).toEqual({ kind: "stopped", rule: "project.budget_exceeded" });
    expect(changes(result)).toEqual(["unchanged"]);
  });

  it("cannot tell a EURC payment that reaches the swap checks, and passes a USDC one", () => {
    const eurc = bill({ amount: 700, rule: "counterparty.payment_limit", detail: { currency: "EURC", usdcValue: 800, amountPaid: null } });
    const result = run([eurc], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 }));
    expect(result.decisions[0].after).toEqual({ kind: "cant_tell", because: "stage_unsettled" });
  });

  it("keeps a check after the figure that fired, unless the figure now stops it first", () => {
    const entries = [bill({ amount: 300, rule: "bridge.fee_above_cap", detail: { payout: { chain: "Base", route: "cctp", feeUsdc: 30 } } })];
    const lower = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 200 }));
    expect(lower.decisions[0].before).toEqual({ kind: "stopped", rule: "bridge.fee_above_cap" });
    expect(lower.decisions[0].after).toEqual({ kind: "stopped", rule: "counterparty.payment_limit" });
    expect(changes(lower)).toEqual(["unchanged"]);
  });

  it("leaves the model's own holds, flags and questions as they were", () => {
    const entries = [bill({ action: "hold" }), bill({ action: "flag_fraud" }), bill({ action: "request_info" })];
    const result = run(entries, figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 10 }));
    expect(changes(result)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });
});

describe("a bill whose purchase order came from its vendor's document (document checks DK8)", () => {
  // Every ap_* entry on such a bill records the document it came from, whichever rule held it.
  const fromDocument = { vendorDocument: { requestId: "req-1", source: "vendor", fileSha256: "ab".repeat(32) } };
  const raised = (limit: number) => withCandidate(figures({ counterpartyLimits: { [ACME]: 50, [BOLT]: 500 } }), { kind: "counterparty_limit", counterpartyId: ACME, limit });
  const current = () => figures({ counterpartyLimits: { [ACME]: 50, [BOLT]: 500 } });

  it("is still held for a person once a higher limit lets it past the limit it was held on", () => {
    const held = bill({ amount: 60, limit: 50, rule: "counterparty.payment_limit", detail: fromDocument });
    const result = run([held], current(), raised(100));
    expect(result.decisions[0].before).toEqual({ kind: "stopped", rule: "counterparty.payment_limit" });
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "invoice.vendor_document" });
    expect(changes(result)).toEqual(["unchanged"]);
  });

  it("replays one held on that rule as held, not as a rule it does not know", () => {
    const held = bill({ amount: 30, limit: 50, rule: "invoice.vendor_document", detail: fromDocument });
    const result = run([held], current(), raised(100));
    expect(result.decisions[0].before).toEqual({ kind: "stopped", rule: "invoice.vendor_document" });
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "invoice.vendor_document" });
    expect(changes(result)).toEqual(["unchanged"]);
    // A lower limit stops it first, as code would.
    expect(run([held], current(), raised(20)).decisions[0].after).toEqual({ kind: "stopped", rule: "counterparty.payment_limit" });
  });

  it("holds a schedule too, since the rule weighs a schedule as it weighs a payment", () => {
    const scheduled = bill({ action: "schedule", amount: 60, limit: 50, rule: "counterparty.payment_limit", detail: { ...fromDocument, decision: { action: "schedule", payOn: "2026-10-05" } } });
    expect(run([scheduled], current(), raised(100)).decisions[0].after).toEqual({ kind: "stopped", rule: "invoice.vendor_document" });
  });

  it("lets a bill with no vendor's document go ahead once the limit allows it", () => {
    const held = bill({ amount: 60, limit: 50, rule: "counterparty.payment_limit" });
    const result = run([held], current(), raised(100));
    expect(result.decisions[0].after).toEqual({ kind: "goes_ahead" });
    expect(changes(result)).toEqual(["now_paid"]);
  });
});

describe("the spending-limit contract on Arc (P2)", () => {
  const live = { chainMode: "live" };

  it("cannot tell a refusal for want of room under other spending-limit figures, and keeps it under the same", () => {
    const refused = bill({
      amount: 80,
      rule: "workspace.onchain_limit",
      execution: live,
      detail: {
        outflowBudget: { dailyUsdc: 100, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0, remaining: 100, binding: "day" },
        onChainLimit: { covered: true, verdict: { state: "refused", error: "OverDailyLimit", spent: 50, limit: 100 } },
      },
    });
    const now = figures({ spendingLimit: { dailyUsdc: 100, weeklyUsdc: null } });
    const same = run([refused], now, withCandidate(now, { kind: "two_approvals", above: 1000 }));
    expect(same.decisions[0].after).toEqual({ kind: "stopped", rule: "workspace.onchain_limit" });
    const other = run([refused], now, withCandidate(now, { kind: "spending_limit", dailyUsdc: 300, weeklyUsdc: null }));
    expect(other.decisions[0].after).toEqual({ kind: "cant_tell", because: "contract_unsettled" });
  });

  it("keeps a contract refusal whose check was not recorded, as it fired", () => {
    const refused = bill({ amount: 80, rule: "workspace.onchain_limit", execution: live });
    const result = run([refused], figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 1000, weeklyUsdc: null }));
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "workspace.onchain_limit" });
  });

  it("keeps a payment the contract cannot carry held, whatever the figures", () => {
    const route = bill({ amount: 80, rule: "workspace.onchain_limit_route", execution: live, detail: { onChainLimit: { covered: false, uncoveredBecause: "another_chain", verdict: null } } });
    const result = run([route], figures(), withCandidate(figures(), { kind: "spending_limit", dailyUsdc: 1000, weeklyUsdc: null }));
    expect(changes(result)).toEqual(["unchanged"]);
  });

  it("reads a live bill's recorded check once a higher limit lets it reach the contract", () => {
    const enforced = bill({ amount: 700, rule: "counterparty.payment_limit", execution: live, detail: { onChainLimit: { covered: false, verdict: null } } });
    const notEnforced = bill({ amount: 700, rule: "counterparty.payment_limit", execution: live });
    const result = run([enforced, notEnforced], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 }));
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "workspace.onchain_limit_route" });
    expect(result.decisions[1].after).toEqual({ kind: "goes_ahead" });
  });
});

describe("milestone releases", () => {
  it("replays a release the payment limit held", () => {
    const result = run([release({ amount: 700, rule: "counterparty.payment_limit" })], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: BOLT, limit: 800 }));
    expect(changes(result)).toEqual(["now_paid"]);
    expect(result.decisions[0].source).toBe("milestone");
  });

  it("reads the new payee check, which comes after the limit for a release, from what the decision recorded", () => {
    const oneParty = release({ amount: 700, rule: "counterparty.payment_limit", observed: { newPayee: { twoParties: false } } });
    const result = run([oneParty], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: BOLT, limit: 800 }));
    expect(result.decisions[0].after).toEqual({ kind: "stopped", rule: "counterparty.new_payee" });
    expect(changes(result)).toEqual(["unchanged"]);
  });

  it("cannot tell a live release that reaches the contract, which was not asked once an earlier check stopped it", () => {
    const live = release({ amount: 700, rule: "counterparty.payment_limit", execution: { chainMode: "live" } });
    const result = run([live], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: BOLT, limit: 800 }));
    expect(result.decisions[0].after).toEqual({ kind: "cant_tell", because: "stage_unsettled" });
  });
});

describe("a contractor stage's releases, written once the stage has sent them (P6)", () => {
  // The contractor stage writes a milestone it holds at once, and one it releases only after every milestone is decided
  // and the batch is sent, so its entries do not show the order it checked them in.
  const daily = (dailyUsdc: number, overrides: Partial<RuleFigures> = {}) => figures({ spendingLimit: { dailyUsdc, weeklyUsdc: null }, ...overrides });

  it("cannot tell a spending-limit check whose answer depends on the order the stage checked them in", () => {
    // The stage released A (100) first and held B (140) at the 150 limit, but wrote B first.
    const held = release({ amount: 140, rule: "workspace.outflow_budget", at: "2026-10-02T09:00:01.000Z", execution: { heldBecause: "outflow_budget" } });
    const sent = release({ amount: 100, at: "2026-10-02T09:00:05.000Z" });
    const result = run([held, sent], daily(150), daily(120), { shadow: NEVER_SHADOW });
    expect(result.decisions[0].before).toEqual({ kind: "cant_tell", because: "budget_unsettled" });
    expect(result.decisions[1].before).toEqual({ kind: "cant_tell", because: "budget_unsettled" });
    expect(result.counts).toMatchObject({ nowHeld: 0, nowPaid: 0, cantTell: 2 });
  });

  it("replays the stages of different cycles in ledger order", () => {
    const current = daily(150, { counterpartyLimits: { [ACME]: 50, [BOLT]: 500 } });
    const candidate = withCandidate(current, { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 });
    const limited = release({ counterpartyId: ACME, amount: 100, rule: "counterparty.payment_limit", at: "2026-10-02T09:00:00.000Z" });
    const cycleEnd = seq++;
    const sent = release({ amount: 100, at: "2026-10-02T15:00:00.000Z" });

    // With no cycle's end between them, the two may be one stage, checked in either order.
    expect(changes(run([limited, sent], current, candidate, { shadow: NEVER_SHADOW }))).toEqual(["cant_tell", "cant_tell"]);
    // A cycle ended between them: the freed 100, then 100 more, past 150.
    const split = run([limited, sent], current, candidate, { shadow: NEVER_SHADOW, cycleEnds: [cycleEnd] });
    expect(changes(split)).toEqual(["now_paid", "now_held"]);
    expect(split.decisions[1].after).toEqual({ kind: "stopped", rule: "workspace.outflow_budget" });
  });

  it("knows a held milestone written after a release came from a later stage", () => {
    const current = daily(150, { counterpartyLimits: { [ACME]: 50, [BOLT]: 500 } });
    const candidate = withCandidate(current, { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 });
    const sent = release({ amount: 100, at: "2026-10-02T09:00:00.000Z" });
    const limited = release({ counterpartyId: ACME, amount: 100, rule: "counterparty.payment_limit", at: "2026-10-02T15:00:00.000Z" });
    const result = run([sent, limited], current, candidate, { shadow: NEVER_SHADOW });
    expect(result.decisions[1].after).toEqual({ kind: "stopped", rule: "workspace.outflow_budget" });
    expect(changes(result)).toEqual(["unchanged", "unchanged"]);
  });

  it("counts a release the stage planned against the limit at once, for the stage's later releases, even one whose transfer failed", () => {
    const failed = release({ amount: 100, paid: false, execution: { resultingStatus: "failed" } });
    const next = release({ amount: 60 });
    const later = bill({ amount: 100, at: `${DAY1}T15:00:00.000Z` });
    const result = run([failed, next, later], figures(), daily(150), { shadow: NEVER_SHADOW });
    // 100 planned, then 60 makes 160. The failed 100 was never paid, so the bill later that day fits.
    expect(changes(result)).toEqual(["unchanged", "now_held", "unchanged"]);
  });

  it("replays a stage's releases among themselves in the order it sent them", () => {
    const entries = [release({ amount: 70 }), release({ amount: 70 })];
    const result = run(entries, figures(), daily(100), { shadow: NEVER_SHADOW });
    expect(changes(result)).toEqual(["unchanged", "now_held"]);
  });
});

describe("missing facts (P7)", () => {
  it("cannot tell a decision with no recorded amount, decision or rule", () => {
    const noObserved = bill({});
    delete noObserved.detail.observed;
    const noDecision = bill({});
    delete noDecision.detail.decision;
    const noRule = bill({ rule: "counterparty.payment_limit" });
    delete noRule.detail.guardrailRule;
    const unknownRule = bill({ rule: "workspace.some_retired_rule" });
    const result = run([noObserved, noDecision, noRule, unknownRule], figures(), withCandidate(figures(), { kind: "two_approvals", above: 1000 }));
    expect(result.decisions.map((decision) => decision.after)).toEqual([
      { kind: "cant_tell", because: "facts_missing" },
      { kind: "cant_tell", because: "facts_missing" },
      { kind: "cant_tell", because: "rule_unknown" },
      { kind: "cant_tell", because: "rule_unknown" },
    ]);
    expect(result.counts.cantTell).toBe(4);
  });

  it("cannot tell a later decision on a bill an earlier one may have paid", () => {
    const first = bill({ invoiceId: "inv-x", amount: 300, rule: "counterparty.payment_limit", observed: { riskLevel: undefined } });
    const second = bill({ invoiceId: "inv-x", amount: 300, at: `${DAY1}T10:00:00.000Z` });
    const result = run([first, second], figures(), withCandidate(figures(), { kind: "counterparty_limit", counterpartyId: ACME, limit: 1000 }));
    expect(result.decisions[1].after).toEqual({ kind: "cant_tell", because: "earlier_unsettled" });
  });
});

describe("counts and the ledger's summary (P8, P10)", () => {
  it("counts every decision in the window once, in ledger order whatever order they came in", () => {
    const entries = [
      bill({ amount: 300 }),
      bill({ amount: 50 }),
      bill({ amount: 700, rule: "counterparty.payment_limit" }),
      bill({ amount: 900, rule: "workspace.two_approvals", counterpartyId: BOLT }),
      bill({ amount: 300, observed: { riskLevel: undefined } }),
    ];
    const now = figures({ twoApprovalsAbove: 800 });
    const result = run([...entries].reverse(), now, withCandidate(now, { kind: "counterparty_limit", counterpartyId: ACME, limit: 200 }));
    expect(result.decisions.map((decision) => decision.seq)).toEqual(entries.map((entry) => entry.seq));
    expect(result.counts).toEqual({ decisions: 5, unchanged: 3, nowHeld: 1, nowPaid: 0, nowTwoPeople: 0, cantTell: 1 });

    expect(replaySummary(result, { days: 30, from: WINDOW_START, to: "2026-10-31T00:00:00.000Z" })).toEqual({
      windowDays: 30,
      from: WINDOW_START,
      to: "2026-10-31T00:00:00.000Z",
      decisions: 5,
      unchanged: 3,
      nowHeld: 1,
      nowPaid: 0,
      nowTwoPeople: 0,
      cantTell: 1,
    });
  });
});
