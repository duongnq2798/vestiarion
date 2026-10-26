import { describe, expect, it } from "vitest";
import file from "@/lib/quality-lab/shadow-decisions.json";
import type { ShadowDecision, ShadowDecisionsFile } from "@/lib/quality-lab/shadow-export";
import {
  judgeReplay,
  planReplay,
  renderReplay,
  replayResult,
  replayWorld,
  scriptedAnswer,
  summarizeReplay,
  thenOutcome,
  variantsOf,
  type ShadowOutcome,
  type ShadowReplayResult,
  type ShadowReplayRun,
} from "@/lib/quality-lab/shadow-replay";
import { answerWords, replayClassWords, replayOutcomeWords, replayResultWords, shadowReplayWords, verdictWords } from "@/lib/quality-lab/words";

/**
 * The replay of the shadow-mode decisions, the parts that touch no harness
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR2-SR10): the model's answer as recorded, what
 * code did then, which facts the record does not carry and are run both ways, the world rebuilt from the record, the
 * class each decision gets, a wrong payment, the committed file and its words. tests/quality-lab-shadow.test.ts runs it.
 */

const DECISIONS = (file as unknown as ShadowDecisionsFile).decisions;

/** A real exported decision, copied so a test may change it. */
function decision(id: string, change: (copy: ShadowDecision) => void = () => {}): ShadowDecision {
  const found = DECISIONS.find((one) => one.id === id);
  if (!found) throw new Error(`no ${id} in the export`);
  const copy = structuredClone(found);
  change(copy);
  return copy;
}

const paid: ShadowOutcome = { action: "pay", rule: null, money: "moves" };
const scheduled: ShadowOutcome = { action: "schedule", rule: null, money: "moves" };
const held: ShadowOutcome = { action: "hold", rule: null, money: "stops" };
const noAddress: ShadowOutcome = { action: "pay", rule: "counterparty.no_address", money: "stops" };

function run(outcome: ShadowOutcome, over: Partial<ShadowReplayRun> = {}): ShadowReplayRun {
  return { variant: {}, outcome, transfersRight: true, ...over };
}

/**
 * Moves a copy to a day after the same-work check was added (SX10.7), so its entry would record that check's answer: a
 * test of another fact then has only that fact unknown.
 */
function sinceSameWork(copy: ShadowDecision) {
  copy.decidedAt = "2026-10-20T03:00:00.000Z";
  copy.decidedOn = "2026-10-20";
}

const SAME_WORK_REASON =
  "It was decided on or before Oct 13, 2026, the day the check for an earlier milestone for the same purchase order or delivered work was added, so whether there was one is not in the record.";

describe("the model's answer, as the replay scripts it (SR2)", () => {
  it("is the decision as recorded when code moved nothing", () => {
    expect(scriptedAnswer(decision("shadow-24"))).toEqual({ action: "schedule", payOnInDays: 4, fundWithSwap: false });
    expect(scriptedAnswer(decision("shadow-01"))).toEqual({ action: "pay", payOnInDays: null, fundWithSwap: null });
  });

  it("is the model's own pay when code made it a schedule for gaining nothing by paying now", () => {
    const moved = decision("shadow-24", (copy) => {
      copy.timingRule = "pay.no_gain";
      copy.decision.fundWithSwap = null;
    });
    expect(scriptedAnswer(moved)).toEqual({ action: "pay", payOnInDays: null, fundWithSwap: null });
  });

  it("is the model's own schedule for the day it asked for when code moved that day", () => {
    const late = decision("shadow-24", (copy) => {
      copy.timingRule = "payon.after_due";
      copy.requestedPayOnInDays = 30;
      copy.decision.payOnInDays = 18;
    });
    expect(scriptedAnswer(late)).toEqual({ action: "schedule", payOnInDays: 30, fundWithSwap: false });
    const today = decision("shadow-01", (copy) => {
      copy.timingRule = "payon.not_after_today";
      copy.requestedPayOnInDays = 0;
    });
    expect(scriptedAnswer(today)).toEqual({ action: "schedule", payOnInDays: 0, fundWithSwap: null });
  });
});

describe("what code did then (SR5)", () => {
  it("lets a pay or a schedule through with money moving, as it would have outside shadow mode", () => {
    expect(thenOutcome(decision("shadow-01"))).toEqual(paid);
    expect(thenOutcome(decision("shadow-24"))).toEqual(scheduled);
  });

  it("moves no money on a hold or a request for information it let through", () => {
    expect(thenOutcome(decision("shadow-02"))).toEqual(held);
    expect(thenOutcome(decision("shadow-12"))).toEqual({ action: "request_info", rule: null, money: "stops" });
  });

  it("names the rule that stopped it", () => {
    expect(thenOutcome(decision("shadow-14"))).toEqual(noAddress);
    expect(thenOutcome(decision("shadow-45"))).toEqual({ action: "schedule", rule: "counterparty.cooling_off", money: "stops" });
  });
});

describe("the facts a replay cannot rebuild (SR3, SR4)", () => {
  it("leaves nothing unknown for a hold or a request for information, whatever the record lacks", () => {
    const bare = decision("shadow-02", (copy) => {
      copy.timing = null;
      copy.payeeLock = null;
      copy.payeeOnFile.role = null;
    });
    expect(planReplay(bare)).toMatchObject({ unsupported: null, unknowns: [] });
  });

  it("knows everything of a payment now to an address since the same-work check: the spending limits were read, and none were set", () => {
    expect(planReplay(decision("shadow-30"))).toMatchObject({ unsupported: null, unknowns: [] });
    expect(planReplay(decision("shadow-31")).unknowns).toEqual([]);
    expect(planReplay(decision("shadow-01", sinceSameWork))).toMatchObject({ unsupported: null, unknowns: [] });
  });

  it("runs both ways the spending limits of a schedule, or of a payment to no address, which never read them", () => {
    for (const id of ["shadow-33", "shadow-44"]) {
      expect(planReplay(decision(id)).unknowns.map((unknown) => unknown.fact), id).toEqual(["spending_limits"]);
    }
    for (const id of ["shadow-14", "shadow-24"]) {
      expect(planReplay(decision(id)).unknowns.map((unknown) => unknown.fact), id).toEqual(["spending_limits", "same_work"]);
    }
  });

  it("runs both ways earlier work for the same purchase order or deliverable for a payment or schedule decided by the day that check was added (SX10.7)", () => {
    // The check and its ledger field arrived together, and an entry records a match only when there is one: an entry
    // from before it records none whether there was one or not.
    for (const id of ["shadow-01", "shadow-04", "shadow-05", "shadow-08", "shadow-10", "shadow-27", "shadow-29"]) {
      expect(planReplay(decision(id)).unknowns, id).toEqual([{ fact: "same_work", reason: SAME_WORK_REASON }]);
    }
    expect(planReplay(decision("shadow-26")).unknowns.map((unknown) => unknown.fact)).toEqual(["spending_limits", "same_work"]);
    const lastMinute = decision("shadow-01", (copy) => {
      copy.decidedAt = "2026-10-13T23:59:00.000Z";
      copy.decidedOn = "2026-10-13";
    });
    expect(planReplay(lastMinute).unknowns.map((unknown) => unknown.fact)).toEqual(["same_work"]);
    const nextDay = decision("shadow-01", (copy) => {
      copy.decidedAt = "2026-10-14T00:00:00.000Z";
      copy.decidedOn = "2026-10-14";
    });
    expect(planReplay(nextDay).unknowns).toEqual([]);
    // A match recorded is known whenever it was made, and a hold or a request for information weighs none.
    const matched = decision("shadow-01", (copy) => {
      copy.observed.sameWork = [{ otherKind: "milestone", other: "m1", otherStatus: "verified", signal: "deliverable" }];
    });
    expect(planReplay(matched).unknowns).toEqual([]);
    expect(planReplay(decision("shadow-02")).unknowns).toEqual([]);
  });

  it("runs both ways whether the address was in the payee lock's wait when it changed again since", () => {
    const plan = planReplay(decision("shadow-42"));
    expect(plan.unknowns.map((unknown) => unknown.fact)).toEqual(["address_change"]);
    expect(plan.unknowns[0].reason).toBe(
      "The payee's address changed again after the decision, so how long before it the address had changed is not in the record, and the payee lock's wait cannot be weighed."
    );
  });

  it("knows the wait from the hours before the decision, or from a lock that was off", () => {
    expect(planReplay(decision("shadow-45")).unknowns.map((unknown) => unknown.fact)).toEqual(["spending_limits"]);
    const off = decision("shadow-42", (copy) => {
      copy.payeeLock = { on: false, coolingHours: 4 };
    });
    expect(planReplay(off).unknowns).toEqual([]);
  });

  it("runs both ways a lock the ledger cannot account for, when the address changed", () => {
    const unknownLock = decision("shadow-46", (copy) => {
      copy.payeeLock = null;
    });
    expect(planReplay(unknownLock).unknowns.find((unknown) => unknown.fact === "address_change")?.reason).toBe(
      "The payee lock in force at the decision is not in the record, so the wait after the address changed cannot be weighed."
    );
    const neverChanged = decision("shadow-01", (copy) => {
      sinceSameWork(copy);
      copy.payeeLock = null;
    });
    expect(planReplay(neverChanged).unknowns).toEqual([]);
  });

  it("runs both ways the sanctions list only when a repeat of a paid bill stopped the decision first (SX10.1)", () => {
    const repeat = decision("shadow-01", (copy) => {
      sinceSameWork(copy);
      copy.guardrailBlocked = true;
      copy.guardrailRule = "invoice.duplicate_of_settled";
    });
    expect(planReplay(repeat).unknowns.map((unknown) => unknown.fact)).toEqual(["sanctions"]);
  });

  it("runs both ways a document's pay-to it cannot tell, the payee's role and a project's answer", () => {
    const unknowns = decision("shadow-01", (copy) => {
      sinceSameWork(copy);
      copy.observed.documentPayTo = { present: true, differs: null };
      copy.payeeOnFile.role = null;
      copy.observed.projectId = "pj1";
    });
    expect(planReplay(unknowns).unknowns.map((unknown) => unknown.fact)).toEqual(["pay_to", "role", "project"]);
    const known = decision("shadow-01", (copy) => {
      sinceSameWork(copy);
      copy.observed.documentPayTo = { present: true, differs: false };
      copy.observed.projectId = "pj1";
      copy.observed.project = { state: "reserved", already: false, neededMinor: 4_500_000, budgetMinor: 10_000_000, bufferMinor: 0, reservedMinor: 0, paidMinor: 0, availableMinor: 10_000_000 };
    });
    expect(planReplay(known).unknowns).toEqual([]);
  });

  it("refuses up front what it does not rebuild, for an answer to pay or schedule, in plain words", () => {
    const cases: Array<[string, (copy: ShadowDecision) => void, string]> = [
      ["EURC", (copy) => void (copy.currency = "EURC"), "It is a EURC bill, and the replay rebuilds USDC bills only."],
      ["another chain", (copy) => void (copy.payout = { chain: "base", route: "cctp", feeUsdc: 0.1, gatewayBalanceUsdc: null, quotes: null }), "Its payee is paid on another chain, and the replay rebuilds payments on Arc only."],
      ["a bank", (copy) => void (copy.paidToBank = true), "Its payee is paid to a bank account, which the replay does not rebuild."],
      ["no timing", (copy) => void (copy.timing = null), "When the bill was due is not in the record."],
      ["cash ahead", (copy) => void (copy.cashAhead = { scheduledForInDays: 3, cashCounted: 1, dueBefore: null, needed: 2 }), "It was decided before its day because the cash would not cover it then, which the replay does not rebuild."],
      ["no rule", (copy) => void (copy.guardrailBlocked = true), "The rule that stopped it is not in the record."],
      ["no risk", (copy) => void (copy.observed.riskLevel = null), "The payee's risk level is not in the record."],
    ];
    for (const [name, change, reason] of cases) {
      expect(planReplay(decision("shadow-01", change)).unsupported, name).toBe(reason);
    }
  });

  it("refuses a hold code made for cash before its checks, whatever its action: the model's own answer is not kept", () => {
    const waited = decision("shadow-02", (copy) => {
      copy.timingRule = "cash.priority";
    });
    expect(planReplay(waited).unsupported).toBe("Code held it for cash before its checks, and the model's own answer is not in the record.");
  });
});

describe("each combination of the unknown facts (SR4)", () => {
  it("is one replay when nothing is unknown, and every combination otherwise, in a fixed order", () => {
    expect(variantsOf([])).toEqual([{}]);
    const both = variantsOf([
      { fact: "spending_limits", reason: "a" },
      { fact: "address_change", reason: "b" },
    ]);
    expect(both).toEqual([
      { spending_limits: "lets_through", address_change: "lets_through" },
      { spending_limits: "stops", address_change: "lets_through" },
      { spending_limits: "lets_through", address_change: "stops" },
      { spending_limits: "stops", address_change: "stops" },
    ]);
  });
});

describe("the world rebuilt from a decision (SR2)", () => {
  it("is the bill, the payee and the workspace as recorded, at the decision's minute", () => {
    const world = replayWorld(decision("shadow-01"));
    expect(world.now).toBe("2026-10-08T03:00:00.000Z");
    expect(world.answer).toEqual({ action: "pay", payOnInDays: null, fundWithSwap: null, confidence: 0.95 });
    expect(world.bill).toEqual({
      amount: 4.5, poPresent: true, goodsReceived: true, dueInDays: 0, discount: null, lateFee: null, scheduledForInDays: null,
      documentPayTo: null, inProject: false, vendorDocument: false, repeatsPaidBill: false,
    });
    expect(world.payee).toEqual({
      riskLevel: "clear", paymentLimit: 5000, role: "vendor", address: "lab", purchaseOrderRequired: true,
      addressChangedHoursAgo: null, addressConfirmedHoursAgo: null, firstPayment: null,
    });
    expect(world.workspace).toEqual({ operatingBalance: 6.5, reserveApy: 0, payeeLock: { on: false, hours: 0 }, twoApprovalsAbove: null, spendingLimit: null, contract: null });
    expect(world.earlierObligations).toEqual({ total: 0, count: 0 });
    expect(world.sameWork).toEqual([]);
    expect(world.project).toBeNull();
  });

  it("changed the address at the middle of its recorded hour, confirmed after it unless it was unconfirmed", () => {
    expect(replayWorld(decision("shadow-46")).payee).toMatchObject({ addressChangedHoursAgo: 4.5, addressConfirmedHoursAgo: 4.25 });
    expect(replayWorld(decision("shadow-44")).payee).toMatchObject({ addressChangedHoursAgo: 0.5, addressConfirmedHoursAgo: null });
    expect(replayWorld(decision("shadow-46")).workspace.payeeLock).toEqual({ on: true, hours: 4 });
  });

  it("puts an address that changed again since inside the lock's wait one way, and past it the other", () => {
    const inside = replayWorld(decision("shadow-42"), { address_change: "stops" });
    const past = replayWorld(decision("shadow-42"), { address_change: "lets_through" });
    expect(inside.payee).toMatchObject({ addressChangedHoursAgo: 0.5, addressConfirmedHoursAgo: 0.25 });
    expect(past.payee).toMatchObject({ addressChangedHoursAgo: 4.5, addressConfirmedHoursAgo: 4.25 });
    expect(inside.workspace.payeeLock).toEqual({ on: true, hours: 4 });
  });

  it("hands in no earlier work for the same work one way, and an earlier milestone for the same delivered work the other (SX10.7)", () => {
    expect(replayWorld(decision("shadow-01"), { same_work: "lets_through" }).sameWork).toEqual([]);
    // Before migration 0111 a milestone had no purchase order, so the work it delivered is what a bill could repeat.
    expect(replayWorld(decision("shadow-01"), { same_work: "stops" }).sameWork).toEqual([{ otherKind: "milestone", otherStatus: "verified", signal: "deliverable" }]);
  });

  it("rebuilds who stands behind a first payment's address", () => {
    expect(replayWorld(decision("shadow-02")).payee.firstPayment).toEqual({ addressBy: "mirror", askedVia: null, confirmed: false, twoParties: true, unanswered: false });
    expect(replayWorld(decision("shadow-46")).payee.firstPayment).toEqual({ addressBy: "member", askedVia: null, confirmed: true, twoParties: false, unanswered: false });
    expect(replayWorld(decision("shadow-41")).payee.firstPayment).toEqual({ addressBy: "member", askedVia: null, confirmed: false, twoParties: false, unanswered: false });
  });

  it("hands in the spending limit and the contract's verdict as recorded, or refusing ones the way that stops", () => {
    const recorded = replayWorld(decision("shadow-27")).workspace;
    expect(recorded.spendingLimit).toEqual({ dailyUsdc: 15, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0, remaining: 15, binding: "day" });
    expect(recorded.contract).toEqual({ state: "refused", error: "OverDailyLimit", spent: 0, amount: 24, limit: 15 });
    const refusing = replayWorld(decision("shadow-14"), { spending_limits: "stops" }).workspace;
    expect(refusing.spendingLimit).toMatchObject({ remaining: 0 });
    expect(refusing.contract).toMatchObject({ state: "refused" });
    expect(replayWorld(decision("shadow-14"), { spending_limits: "lets_through" }).workspace).toMatchObject({ spendingLimit: null, contract: null });
  });

  it("keeps what fell due besides the bill, and the day an earlier cycle scheduled it for when it is decided on it", () => {
    expect(replayWorld(decision("shadow-22")).earlierObligations).toEqual({ total: 216.44, count: 2 });
    expect(replayWorld(decision("shadow-30")).bill.scheduledForInDays).toBe(0);
    expect(replayWorld(decision("shadow-35")).bill.scheduledForInDays).toBeNull();
    expect(replayWorld(decision("shadow-24")).bill.discount).toEqual({ percent: 2, deadlineInDays: 4 });
  });

  it("puts an address on OFAC's list where the record shows it was listed, and nowhere else (SX10.1)", () => {
    const listed = decision("shadow-01", (copy) => {
      copy.guardrailBlocked = true;
      copy.guardrailRule = "counterparty.high_risk";
    });
    expect(replayWorld(listed).payee.address).toBe("sanctioned");
    const highRisk = decision("shadow-01", (copy) => {
      copy.guardrailBlocked = true;
      copy.guardrailRule = "counterparty.high_risk";
      copy.observed.riskLevel = "high";
    });
    expect(replayWorld(highRisk).payee.address).toBe("lab");
    expect(replayWorld(decision("shadow-14")).payee.address).toBeNull();
  });

  it("derives the reserve's yield from the float a discount was weighed against, and counts none without one", () => {
    const float = decision("shadow-24", (copy) => {
      copy.timing!.floatValueToDue = 0.086301;
    });
    expect(replayWorld(float).workspace.reserveApy).toBeCloseTo(0.045, 5);
    expect(replayWorld(decision("shadow-24")).workspace.reserveApy).toBe(0);
  });

  it("is replayed at the last minute of its day when its entry was written after midnight (SX5)", () => {
    const late = decision("shadow-01", (copy) => {
      copy.decidedAt = "2026-10-09T00:02:00.000Z";
      copy.decidedOn = "2026-10-08";
    });
    expect(replayWorld(late).now).toBe("2026-10-08T23:59:00.000Z");
  });
});

describe("the class each decision gets (SR6, SR7)", () => {
  const plan = (one: ShadowDecision) => planReplay(one);

  it("is the same when code lets it through both times and money moves", () => {
    const one = decision("shadow-01");
    expect(judgeReplay(one, plan(one), [run(paid)])).toEqual({ now: paid, class: "same", reason: null, wrongPayment: false });
  });

  it("is the same when the same rule stops it, saying so when code now gives the answer another action", () => {
    const one = decision("shadow-15");
    const now: ShadowOutcome = { action: "schedule", rule: "counterparty.no_address", money: "stops" };
    expect(judgeReplay(one, plan(one), [run(now)])).toEqual({
      now,
      class: "same",
      reason: "Code now makes the answer a schedule rather than a payment now, and the same rule stops it.",
      wrongPayment: false,
    });
  });

  it("is now stopped, a safe miss and no wrong payment, when a rule stops what code let through then", () => {
    const one = decision("shadow-01");
    const now: ShadowOutcome = { action: "pay", rule: "counterparty.new_payee", money: "stops" };
    expect(judgeReplay(one, plan(one), [run(now)])).toEqual({
      now,
      class: "now_stopped",
      reason: "Stopped now because a first payment to a new address needs two people: a rule that did not stop it then.",
      wrongPayment: false,
    });
  });

  it("is now stopped, naming both rules, when another rule stops it now", () => {
    const one = decision("shadow-14");
    const now: ShadowOutcome = { action: "pay", rule: "counterparty.high_risk", money: "stops" };
    expect(judgeReplay(one, plan(one), [run(now)])).toMatchObject({
      class: "now_stopped",
      reason: "Stopped now because the payee was screened high risk; then because the payee had no payment address yet.",
    });
  });

  it("is now let through, and a wrong payment, when money moves where code stopped it then", () => {
    const one = decision("shadow-14");
    expect(judgeReplay(one, plan(one), [run(paid)])).toEqual({
      now: paid,
      class: "now_let_through",
      reason: "Stopped then because the payee had no payment address yet; code lets it through now.",
      wrongPayment: true,
    });
  });

  it("is a wrong payment when money moves on a decision the person disagreed with", () => {
    const one = decision("shadow-01", (copy) => {
      copy.verdict = "disagree";
    });
    expect(judgeReplay(one, plan(one), [run(paid)])).toMatchObject({ class: "same", wrongPayment: true });
  });

  it("is a wrong payment when a transfer went elsewhere, for another amount, or twice", () => {
    const one = decision("shadow-01");
    expect(judgeReplay(one, plan(one), [run(paid, { transfersRight: false })])).toMatchObject({ class: "same", wrongPayment: true });
  });

  it("cannot be rebuilt when the two ways of a fact the record lacks end differently, naming only the facts that matter", () => {
    const one = decision("shadow-42");
    const unknowns = [
      { fact: "spending_limits" as const, reason: "The spending limits are not in the record." },
      { fact: "address_change" as const, reason: "The address's wait is not in the record." },
    ];
    const cooling: ShadowOutcome = { action: "pay", rule: "counterparty.cooling_off", money: "stops" };
    const newPayee: ShadowOutcome = { action: "pay", rule: "counterparty.new_payee", money: "stops" };
    const runs = [
      run(newPayee, { variant: { spending_limits: "lets_through", address_change: "lets_through" } }),
      run(newPayee, { variant: { spending_limits: "stops", address_change: "lets_through" } }),
      run(cooling, { variant: { spending_limits: "lets_through", address_change: "stops" } }),
      run(cooling, { variant: { spending_limits: "stops", address_change: "stops" } }),
    ];
    expect(judgeReplay(one, { ...plan(one), unknowns }, runs)).toEqual({
      now: null,
      class: "cannot_rebuild",
      reason: "The address's wait is not in the record. Money stops either way.",
      wrongPayment: false,
    });
  });

  it("says when money moves one way and not the other, no wrong payment when money moved then and no one disagreed", () => {
    const one = decision("shadow-24");
    const unknowns = [{ fact: "project" as const, reason: "The project's answer is not in the record." }];
    const runs = [run(scheduled, { variant: { project: "lets_through" } }), run({ action: "schedule", rule: "project.budget_exceeded", money: "stops" }, { variant: { project: "stops" } })];
    expect(judgeReplay(one, { ...plan(one), unknowns }, runs)).toEqual({
      now: null,
      class: "cannot_rebuild",
      reason: "The project's answer is not in the record. Money moves one way and not the other.",
      wrongPayment: false,
    });
  });

  it("cannot rebuild a payment let through before the same-work check existed, which an earlier milestone for the same work would hold now (SX10.7)", () => {
    const one = decision("shadow-01");
    const runs = [
      run(paid, { variant: { same_work: "lets_through" } }),
      run({ action: "pay", rule: "obligation.duplicate_reference", money: "stops" }, { variant: { same_work: "stops" } }),
    ];
    expect(judgeReplay(one, plan(one), runs)).toEqual({
      now: null,
      class: "cannot_rebuild",
      reason: `${SAME_WORK_REASON} Money moves one way and not the other.`,
      wrongPayment: false,
    });
  });

  it("cannot be rebuilt, and is a wrong payment, when one way the record does not rule out moves money where code stopped it then (shadow-43)", () => {
    // Stopped then by the new payee check, which code weighs after the payee lock's wait: the way past the wait is the
    // record's own. Were the new payee check broken, that way would pay.
    const one = decision("shadow-43");
    expect(plan(one).then).toEqual({ action: "pay", rule: "counterparty.new_payee", money: "stops" });
    expect(plan(one).unknowns.map((unknown) => unknown.fact)).toEqual(["address_change"]);
    const runs = [
      run(paid, { variant: { address_change: "lets_through" } }),
      run({ action: "pay", rule: "counterparty.cooling_off", money: "stops" }, { variant: { address_change: "stops" } }),
    ];
    expect(judgeReplay(one, plan(one), runs)).toEqual({
      now: null,
      class: "cannot_rebuild",
      reason: `${plan(one).unknowns[0].reason} Money moves one way and not the other. In a way the record does not rule out, money moves where code stopped it then.`,
      wrongPayment: true,
    });
  });

  it("is a wrong payment when a fact the rule then does not rest on is unknown, and one way moves money", () => {
    const limited = decision("shadow-01", (copy) => {
      sinceSameWork(copy);
      copy.guardrailBlocked = true;
      copy.guardrailRule = "counterparty.payment_limit";
      copy.payeeOnFile.role = null;
    });
    expect(plan(limited).unknowns.map((unknown) => unknown.fact)).toEqual(["role"]);
    const runs = [
      run(paid, { variant: { role: "lets_through" } }),
      run({ action: "pay", rule: "counterparty.client_payable", money: "stops" }, { variant: { role: "stops" } }),
    ];
    expect(judgeReplay(limited, plan(limited), runs)).toMatchObject({ class: "cannot_rebuild", wrongPayment: true });
  });

  it("is a wrong payment when one way moves money on a decision the person disagreed with", () => {
    const one = decision("shadow-24", (copy) => {
      copy.verdict = "disagree";
    });
    const unknowns = [{ fact: "project" as const, reason: "The project's answer is not in the record." }];
    const runs = [run(scheduled, { variant: { project: "lets_through" } }), run({ action: "schedule", rule: "project.budget_exceeded", money: "stops" }, { variant: { project: "stops" } })];
    expect(judgeReplay(one, { ...plan(one), unknowns }, runs)).toEqual({
      now: null,
      class: "cannot_rebuild",
      reason: "The project's answer is not in the record. Money moves one way and not the other. In a way the record does not rule out, money moves on a decision the person disagreed with.",
      wrongPayment: true,
    });
  });

  it("is no wrong payment when only the way that relaxes the very fact behind the rule then moves money: the record rules that way out", () => {
    const cases: Array<[string, "address_change" | "pay_to" | "role" | "sanctions" | "spending_limits" | "project"]> = [
      ["counterparty.cooling_off", "address_change"],
      ["invoice.pay_to_differs", "pay_to"],
      ["counterparty.client_payable", "role"],
      ["counterparty.high_risk", "sanctions"],
      ["workspace.outflow_budget", "spending_limits"],
      ["workspace.onchain_limit", "spending_limits"],
      ["workspace.onchain_limit_route", "spending_limits"],
      ["project.budget_exceeded", "project"],
    ];
    for (const [rule, fact] of cases) {
      const one = decision("shadow-01", (copy) => {
        copy.guardrailBlocked = true;
        copy.guardrailRule = rule;
      });
      const unknowns = [{ fact, reason: "Not in the record." }];
      const stopped: ShadowOutcome = { action: "pay", rule, money: "stops" };
      const relaxed = [run(paid, { variant: { [fact]: "lets_through" } }), run(stopped, { variant: { [fact]: "stops" } })];
      expect(judgeReplay(one, { ...plan(one), unknowns }, relaxed), rule).toMatchObject({ class: "cannot_rebuild", wrongPayment: false });
      // The way that keeps the fact is the record's own: money moving there is a wrong payment.
      const kept = [run(stopped, { variant: { [fact]: "lets_through" } }), run(paid, { variant: { [fact]: "stops" } })];
      expect(judgeReplay(one, { ...plan(one), unknowns }, kept), rule).toMatchObject({ class: "cannot_rebuild", wrongPayment: true });
    }
    // shadow-42, stopped then by the payee lock's wait: past the wait is the way the record rules out.
    const waited = decision("shadow-42");
    const runs = [
      run(paid, { variant: { address_change: "lets_through" } }),
      run({ action: "pay", rule: "counterparty.cooling_off", money: "stops" }, { variant: { address_change: "stops" } }),
    ];
    expect(judgeReplay(waited, plan(waited), runs)).toMatchObject({ class: "cannot_rebuild", wrongPayment: false });
  });

  it("is a wrong payment, saying so, when code records a stop and money moves all the same", () => {
    const letThrough = decision("shadow-01");
    const ignored: ShadowOutcome = { action: "pay", rule: "counterparty.new_payee", money: "moves" };
    expect(judgeReplay(letThrough, plan(letThrough), [run(ignored)])).toEqual({
      now: ignored,
      class: "now_stopped",
      reason: "Code recorded a stop because a first payment to a new address needs two people, but money moved.",
      wrongPayment: true,
    });
    const stoppedThen = decision("shadow-14");
    const same: ShadowOutcome = { action: "pay", rule: "counterparty.no_address", money: "moves" };
    expect(judgeReplay(stoppedThen, plan(stoppedThen), [run(same)])).toEqual({
      now: same,
      class: "now_let_through",
      reason: "Code recorded a stop because the payee had no payment address yet, but money moved.",
      wrongPayment: true,
    });
    // One way of an unknown fact is enough, even one the record rules out.
    const one = decision("shadow-24");
    const unknowns = [{ fact: "project" as const, reason: "The project's answer is not in the record." }];
    const runs = [run(scheduled, { variant: { project: "lets_through" } }), run({ action: "schedule", rule: "project.budget_exceeded", money: "moves" }, { variant: { project: "stops" } })];
    expect(judgeReplay(one, { ...plan(one), unknowns }, runs)).toEqual({
      now: null,
      class: "cannot_rebuild",
      reason: "The project's answer is not in the record. Money moves either way. One way, code recorded a stop because its project's budget had no room left for it, but money moved.",
      wrongPayment: true,
    });
    const cooled = decision("shadow-42");
    const cooling = [
      run({ action: "pay", rule: "counterparty.new_payee", money: "stops" }, { variant: { address_change: "lets_through" } }),
      run({ action: "pay", rule: "counterparty.cooling_off", money: "moves" }, { variant: { address_change: "stops" } }),
    ];
    expect(judgeReplay(cooled, plan(cooled), cooling)).toMatchObject({ class: "cannot_rebuild", wrongPayment: true });
  });

  it("is the one outcome every way ends in when the unknown facts do not change it", () => {
    const one = decision("shadow-14");
    const runs = [run(noAddress, { variant: { spending_limits: "lets_through" } }), run(noAddress, { variant: { spending_limits: "stops" } })];
    expect(judgeReplay(one, plan(one), runs)).toEqual({ now: noAddress, class: "same", reason: null, wrongPayment: false });
  });

  it("cannot be rebuilt, with its reason, when the replay refuses it up front", () => {
    const one = decision("shadow-01", (copy) => {
      copy.currency = "EURC";
    });
    expect(judgeReplay(one, plan(one), [])).toEqual({ now: null, class: "cannot_rebuild", reason: "It is a EURC bill, and the replay rebuilds USDC bills only.", wrongPayment: false });
  });
});

describe("the committed results (SR9)", () => {
  const results: ShadowReplayResult[] = [
    replayResult(decision("shadow-01"), planReplay(decision("shadow-01")), [run(paid)]),
    replayResult(decision("shadow-02"), planReplay(decision("shadow-02")), [run(held)]),
    replayResult(decision("shadow-14"), planReplay(decision("shadow-14")), [run(noAddress)]),
  ];

  it("keep the decision's id, day, scripted answer, verdict, then, now, class, reason and wrong payment", () => {
    expect(results[0]).toEqual({
      id: "shadow-01",
      day: "2026-10-08",
      answer: { action: "pay", payOnInDays: null, fundWithSwap: null },
      verdict: "agree",
      then: paid,
      now: paid,
      class: "same",
      reason: null,
      wrongPayment: false,
    });
    expect(Object.keys(results[0])).toEqual(["id", "day", "answer", "verdict", "then", "now", "class", "reason", "wrongPayment"]);
  });

  it("are summed up by class and verdict", () => {
    const cannot = replayResult(decision("shadow-42"), planReplay(decision("shadow-42")), [
      run({ action: "pay", rule: "counterparty.cooling_off", money: "stops" }, { variant: { address_change: "stops" } }),
      run({ action: "pay", rule: "counterparty.new_payee", money: "stops" }, { variant: { address_change: "lets_through" } }),
    ]);
    expect(summarizeReplay([...results, cannot])).toEqual({
      decisions: 4, same: 3, nowStopped: 0, nowLetThrough: 0, cannotRebuild: 1, wrongPayments: 0, agreed: 3, disagreed: 0, noVerdict: 1,
    });
  });

  it("count a wrong payment as one only, never in a class, so a stop code recorded while money moved is never counted as stopped (SR7, SR9)", () => {
    const ignored = replayResult(decision("shadow-01"), planReplay(decision("shadow-01")), [run({ action: "pay", rule: "counterparty.new_payee", money: "moves" })]);
    expect(ignored).toMatchObject({ class: "now_stopped", wrongPayment: true });
    const letThrough = replayResult(decision("shadow-14"), planReplay(decision("shadow-14")), [run(paid)]);
    expect(letThrough).toMatchObject({ class: "now_let_through", wrongPayment: true });
    const twice = replayResult(decision("shadow-01"), planReplay(decision("shadow-01")), [run(paid, { transfersRight: false })]);
    expect(twice).toMatchObject({ class: "same", wrongPayment: true });
    const all = [...results, ignored, letThrough, twice];
    const summary = summarizeReplay(all);
    expect(summary).toEqual({
      decisions: 6, same: 3, nowStopped: 0, nowLetThrough: 0, cannotRebuild: 0, wrongPayments: 3, agreed: 6, disagreed: 0, noVerdict: 0,
    });
    // Each decision is counted once.
    expect(summary.same + summary.nowStopped + summary.nowLetThrough + summary.cannotRebuild + summary.wrongPayments).toBe(summary.decisions);
    expect(shadowReplayWords(summary)).toBe(
      "6 real decisions from the team's own shadow-mode workspaces, replayed through today's code: 3 reach the same outcome, 3 wrong payments."
    );
  });

  it("are written as two-space JSON with the summary first, LF and a final newline", () => {
    const text = renderReplay(results);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
    const parsed = JSON.parse(text) as { summary: unknown; decisions: unknown[] };
    expect(Object.keys(parsed)).toEqual(["summary", "decisions"]);
    expect(parsed.decisions).toEqual(results);
    expect(text).toContain('\n  "summary": {\n    "decisions": 3,');
  });
});

describe("the replay in words (SR10, SR11)", () => {
  const summary = { decisions: 46, same: 44, nowStopped: 0, nowLetThrough: 0, cannotRebuild: 2, wrongPayments: 0, agreed: 18, disagreed: 0, noVerdict: 28 };

  it("says the line beside the scenarios with the real numbers, naming only the classes that are not zero", () => {
    expect(shadowReplayWords(summary)).toBe(
      "46 real decisions from the team's own shadow-mode workspaces, replayed through today's code: 44 reach the same outcome, 2 cannot be rebuilt from the record, 0 wrong payments."
    );
    // Each decision is counted once (SR9): a wrong payment only as one.
    expect(shadowReplayWords({ ...summary, same: 42, cannotRebuild: 1, nowStopped: 1, nowLetThrough: 1, wrongPayments: 1 })).toBe(
      "46 real decisions from the team's own shadow-mode workspaces, replayed through today's code: 42 reach the same outcome, 1 is now stopped by a rule that did not stop it then, 1 is now let through where code stopped it then, 1 cannot be rebuilt from the record, 1 wrong payment."
    );
    expect(shadowReplayWords({ ...summary, decisions: 1, same: 1, cannotRebuild: 0 })).toBe(
      "1 real decision from the team's own shadow-mode workspaces, replayed through today's code: 1 reaches the same outcome, 0 wrong payments."
    );
  });

  it("says what code did, the model's answer, the verdict and the class", () => {
    expect(replayOutcomeWords(paid)).toBe("Let through to pay");
    expect(replayOutcomeWords(scheduled)).toBe("Let through to schedule");
    expect(replayOutcomeWords(held)).toBe("Held, as the model answered");
    expect(replayOutcomeWords({ action: "request_info", rule: null, money: "stops" })).toBe("Information asked for, as the model answered");
    expect(replayOutcomeWords({ action: "flag_fraud", rule: null, money: "stops" })).toBe("Flagged, as the model answered");
    expect(replayOutcomeWords(noAddress)).toBe("Stopped because the payee had no payment address yet");
    expect(replayOutcomeWords({ ...noAddress, money: "moves" })).toBe("Recorded as stopped because the payee had no payment address yet, but money moved");
    expect(replayOutcomeWords(null)).toBe("Not known");
    expect(answerWords({ action: "pay", payOnInDays: null, fundWithSwap: null })).toBe("Pay now");
    expect(answerWords({ action: "schedule", payOnInDays: 4, fundWithSwap: false })).toBe("Schedule in 4 days");
    expect(answerWords({ action: "schedule", payOnInDays: 1, fundWithSwap: null })).toBe("Schedule in 1 day");
    expect(answerWords({ action: "hold", payOnInDays: null, fundWithSwap: null })).toBe("Hold");
    expect(answerWords({ action: "request_info", payOnInDays: null, fundWithSwap: null })).toBe("Ask for information");
    expect(answerWords({ action: "flag_fraud", payOnInDays: null, fundWithSwap: null })).toBe("Flag as fraud");
    expect(verdictWords("agree")).toBe("Agreed");
    expect(verdictWords("disagree")).toBe("Disagreed");
    expect(verdictWords(null)).toBe("None");
    expect(replayClassWords({ class: "same", reason: null, wrongPayment: false })).toBe("Same");
    expect(replayClassWords({ class: "cannot_rebuild", reason: "Why.", wrongPayment: false })).toBe("Cannot rebuild. Why.");
    expect(replayClassWords({ class: "now_let_through", reason: "Why.", wrongPayment: true })).toBe("Now let through, a wrong payment. Why.");
    expect(replayClassWords({ class: "now_stopped", reason: "Why.", wrongPayment: false })).toBe("Now stopped. Why.");
    expect(replayClassWords({ class: "same", reason: null, wrongPayment: true })).toBe("Same, a wrong payment");
    // A stop code recorded while money moved is named as a wrong payment, never as stopped (SR6, SR7).
    expect(
      replayClassWords({ class: "now_stopped", reason: "Code recorded a stop because a first payment to a new address needs two people, but money moved.", wrongPayment: true })
    ).toBe("A wrong payment. Code recorded a stop because a first payment to a new address needs two people, but money moved.");
  });

  it("says the docs table's result in a few words, naming the note that gives its reason (SR11)", () => {
    expect(replayResultWords({ class: "same", wrongPayment: false }, null)).toBe("Same");
    expect(replayResultWords({ class: "same", wrongPayment: false }, 2)).toBe("Same, note 2");
    expect(replayResultWords({ class: "cannot_rebuild", wrongPayment: false }, 1)).toBe("Cannot rebuild, note 1");
    expect(replayResultWords({ class: "cannot_rebuild", wrongPayment: true }, 1)).toBe("Cannot rebuild, a wrong payment, note 1");
    expect(replayResultWords({ class: "now_let_through", wrongPayment: true }, 3)).toBe("Now let through, a wrong payment, note 3");
    expect(replayResultWords({ class: "same", wrongPayment: true }, null)).toBe("Same, a wrong payment");
    // A stop code recorded while money moved is named only as a wrong payment here too (SR6, SR7).
    expect(replayResultWords({ class: "now_stopped", wrongPayment: true }, 4)).toBe("A wrong payment, note 4");
    expect(replayResultWords({ class: "now_stopped", wrongPayment: false }, 4)).toBe("Now stopped, note 4");
  });
});
