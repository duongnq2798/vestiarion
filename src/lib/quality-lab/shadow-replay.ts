import { COOLING_HOURS_MAX } from "../payee-lock-rules";
import { ruleWords } from "../rule-words";
import type { ShadowAction, ShadowDecision, ShadowVerdict } from "./shadow-export";

/**
 * The replay of the team's shadow-mode decisions through today's decision code
 * (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR1-SR9), the parts that touch no harness: the
 * model's answer as recorded, what code did then, which facts the record does not carry, the world rebuilt from the
 * record as plain data, the class each decision gets, and the committed file. Pure: tests/quality-lab-shadow.test.ts
 * turns each world into rows, runs the AP stage over them, and hands back what it did.
 */

export type ShadowMoney = "moves" | "stops";

/** What code did with a decision: the action it let stand, the rule that stopped it (null: let through), and the money. */
export interface ShadowOutcome {
  action: ShadowAction;
  rule: string | null;
  money: ShadowMoney;
}

export type ShadowReplayClass = "same" | "now_stopped" | "now_let_through" | "cannot_rebuild";

/** The model's answer as the replay scripts it (SR2). */
export interface ShadowAnswer {
  action: ShadowAction;
  /** A schedule's day, in days from the decision's day; null for any other answer, or a day that could not be read. */
  payOnInDays: number | null;
  fundWithSwap: boolean | null;
}

/** A fact the record may not carry (SX10), run both ways when a payment or a schedule could reach it (SR4). */
export type ShadowUnknownFact = "sanctions" | "spending_limits" | "address_change" | "pay_to" | "role" | "project";

export interface ShadowUnknown {
  fact: ShadowUnknownFact;
  /** Why it is not known, in a sentence. */
  reason: string;
}

/** Which way each unknown fact is rebuilt: the way that lets a payment through, or the way that stops it. */
export type ShadowVariant = Partial<Record<ShadowUnknownFact, "lets_through" | "stops">>;

export interface ShadowReplayPlan {
  answer: ShadowAnswer;
  then: ShadowOutcome;
  /** Why the replay does not rebuild the decision at all (SR3), or null. */
  unsupported: string | null;
  /** The facts the record does not carry that a payment or a schedule could reach (SR4), in a fixed order. */
  unknowns: ShadowUnknown[];
}

/** One replay of a decision, as the runner observed it. */
export interface ShadowReplayRun {
  variant: ShadowVariant;
  outcome: ShadowOutcome;
  /** Every transfer went to the address on file for the amount due, and there was at most one (SR7). */
  transfersRight: boolean;
}

export interface ShadowReplayResult {
  id: string;
  /** The day its dates count from (`decidedOn`). */
  day: string;
  answer: ShadowAnswer;
  verdict: ShadowVerdict | null;
  then: ShadowOutcome;
  /** Null when it cannot be rebuilt. */
  now: ShadowOutcome | null;
  class: ShadowReplayClass;
  reason: string | null;
  wrongPayment: boolean;
}

export interface ShadowReplaySummary {
  decisions: number;
  same: number;
  nowStopped: number;
  nowLetThrough: number;
  cannotRebuild: number;
  wrongPayments: number;
  agreed: number;
  disagreed: number;
  noVerdict: number;
}

export interface ShadowReplayResults {
  summary: ShadowReplaySummary;
  decisions: ShadowReplayResult[];
}

/** The spending limit's room as a decision weighed it (outflow budget R4). */
export interface ShadowReplayRoom {
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
  spentToday: number;
  spentThisWeek: number;
  remaining: number;
  binding: "day" | "week";
}

/** The spending limit contract's verdict on Arc, as the decision recorded it. */
export type ShadowReplayVerdict =
  | { state: "allowed" }
  | { state: "refused"; error: string; spent: number | null; amount: number | null; limit: number | null }
  | { state: "unreadable" };

export type ShadowProjectState = "reserved" | "over" | "archived" | "unreadable";

/** Everything the runner builds a decision's world from (SR2), as plain data: no row, id or address. */
export interface ShadowReplayWorld {
  /** The runner's clock (ISO): the decision's minute, on the day its dates count from. */
  now: string;
  answer: ShadowAnswer & { confidence: number };
  bill: {
    amount: number;
    poPresent: boolean;
    goodsReceived: boolean;
    dueInDays: number;
    discount: { percent: number; deadlineInDays: number } | null;
    lateFee: { kind: "percent_month" | "fixed"; value: number; startsOnInDays: number } | null;
    /** The day an earlier cycle scheduled it for, when it is decided on that day or after it. */
    scheduledForInDays: number | null;
    /** The address its document named: the one on file, another, or none. */
    documentPayTo: "on_file" | "other" | null;
    inProject: boolean;
    /** Its purchase order came from the vendor's own document. */
    vendorDocument: boolean;
    /** A paid bill with the same purchase order and amount, which a recorded match would refuse it against. */
    repeatsPaidBill: boolean;
  };
  payee: {
    riskLevel: string;
    paymentLimit: number | null;
    role: string;
    /** The address on file: the lab's, one on OFAC's list, or none. */
    address: "lab" | "sanctioned" | null;
    purchaseOrderRequired: boolean;
    /** Hours before the clock its address last changed, and was confirmed; null for never. */
    addressChangedHoursAgo: number | null;
    addressConfirmedHoursAgo: number | null;
    /** Who stands behind the address for its first payment there (new payee check); null when it was paid there before. */
    firstPayment: {
      addressBy: "member" | "payee" | "mirror" | null;
      askedVia: "payee_link" | "github" | null;
      confirmed: boolean;
      twoParties: boolean;
      unanswered: boolean;
    } | null;
  };
  workspace: {
    operatingBalance: number;
    reserveApy: number;
    payeeLock: { on: boolean; hours: number };
    twoApprovalsAbove: number | null;
    /** The agent's spending limit's room; null for none set. */
    spendingLimit: ShadowReplayRoom | null;
    /** The spending limit contract's verdict on Arc; null for no contract enforced. */
    contract: ShadowReplayVerdict | null;
  };
  /** What fell due by its day besides it (`timing.earlierObligations`). */
  earlierObligations: { total: number; count: number };
  /** Earlier bills or milestones for the same work, as recorded (project budgets P9). */
  sameWork: Array<{ otherKind: "bill" | "milestone"; otherStatus: string; signal: "purchase_order" | "deliverable" }>;
  /** Its project's answer to the reservation, as recorded or run both ways; null for a bill in no project. */
  project: { state: ShadowProjectState; neededMinor: number; budgetMinor: number; bufferMinor: number; reservedMinor: number; paidMinor: number; availableMinor: number; already: boolean } | null;
}

const MONEY_ACTIONS: ReadonlySet<ShadowAction> = new Set(["pay", "schedule"]);
/** Holds code made for cash before its checks: the record keeps the hold, not the model's own answer (SR3). */
const CASH_HOLDS: ReadonlySet<string> = new Set(["cash.priority", "pay.cash_ahead"]);
/** The order the unknown facts are listed, run and named in. */
const UNKNOWN_ORDER: readonly ShadowUnknownFact[] = ["sanctions", "spending_limits", "address_change", "pay_to", "role", "project"];
/** Committed money a repeat is refused against (src/lib/agent/duplicates.ts `COMMITTED_STATUSES`). */
const COMMITTED = new Set(["paid", "received", "matched", "scheduled", "processing"]);
/** The confidence at which a repeat refuses (`DUPLICATE_BLOCK_CONFIDENCE`). */
const REFUSES_AT = 0.9;
const DAY_MS = 86_400_000;

/** The model's answer as the entry implies it (SR2): as recorded, or the model's own where code moved its date. */
export function scriptedAnswer(decision: ShadowDecision): ShadowAnswer {
  const { action, payOnInDays, fundWithSwap } = decision.decision;
  switch (decision.timingRule) {
    case "pay.no_gain":
      return { action: "pay", payOnInDays: null, fundWithSwap };
    case "payon.after_due":
    case "payon.not_after_today":
    case "payon.invalid":
      return { action: "schedule", payOnInDays: decision.requestedPayOnInDays, fundWithSwap };
    default:
      return { action, payOnInDays: action === "schedule" ? payOnInDays : null, fundWithSwap };
  }
}

/** What code did with the decision then (SR5): the rule that stopped it, or let through; money for a pay or schedule. */
export function thenOutcome(decision: ShadowDecision): ShadowOutcome {
  const action = decision.decision.action;
  const stopped = decision.guardrailBlocked === true;
  return {
    action,
    rule: stopped ? decision.guardrailRule : null,
    money: !stopped && MONEY_ACTIONS.has(action) ? "moves" : "stops",
  };
}

/** Whether the address was in the payee lock's wait at the decision: true, false, or null when the record cannot say. */
function inWait(decision: ShadowDecision): boolean | null {
  const lock = decision.payeeLock;
  const { addressChangedHoursBefore: hours, addressChangedSinceDecision: since } = decision.payeeOnFile;
  if (lock && (!lock.on || lock.coolingHours <= 0)) return false;
  if (!since && hours === null) return false;
  if (!since && hours !== null) {
    if (lock) return hours < lock.coolingHours;
    return hours >= COOLING_HOURS_MAX ? false : null;
  }
  return null;
}

/** Why the replay does not rebuild a decision at all (SR3), or null. */
function unsupportedReason(decision: ShadowDecision, answer: ShadowAnswer): string | null {
  if (decision.timingRule !== null && CASH_HOLDS.has(decision.timingRule)) {
    return "Code held it for cash before its checks, and the model's own answer is not in the record.";
  }
  if (!MONEY_ACTIONS.has(answer.action)) return null;
  if (decision.guardrailBlocked === true && decision.guardrailRule === null) return "The rule that stopped it is not in the record.";
  if (decision.currency !== "USDC") return "It is a EURC bill, and the replay rebuilds USDC bills only.";
  if (decision.payout !== null) return "Its payee is paid on another chain, and the replay rebuilds payments on Arc only.";
  if (decision.paidToBank) return "Its payee is paid to a bank account, which the replay does not rebuild.";
  if (decision.cashAhead !== null) return "It was decided before its day because the cash would not cover it then, which the replay does not rebuild.";
  const observed = decision.observed;
  const timing = decision.timing;
  if (!timing || timing.dueInDays === null) return "When the bill was due is not in the record.";
  if (decision.scheduledForInDays !== null && decision.scheduledForInDays > 0 && timing.dueInDays > 0) {
    return "It was decided before the day it was scheduled for, which the replay does not rebuild.";
  }
  const missing: Array<[unknown, string]> = [
    [observed.amount, "The bill's amount"],
    [observed.riskLevel, "The payee's risk level"],
    [observed.goodsReceived, "Whether the goods were received"],
    [observed.purchaseOrderRequired, "Whether the payee needs a purchase order"],
    [observed.operatingBalance, "The operating balance"],
  ];
  const lacking = missing.find(([value]) => value === null);
  if (lacking) return `${lacking[1]} is not in the record.`;
  if (decision.onChainLimit && decision.onChainLimit.covered !== true) {
    return "The spending limit contract on Arc could not carry it, for a reason the replay does not rebuild.";
  }
  const room = decision.outflowBudget;
  if (room && (room.spentToday === null || room.spentThisWeek === null || room.remaining === null || (room.binding !== "day" && room.binding !== "week"))) {
    return "The spending limit's figures are not all in the record.";
  }
  return null;
}

/** The facts the record does not carry that a payment or a schedule could reach (SR4, SX10), in a fixed order. */
function unknownsOf(decision: ShadowDecision, then: ShadowOutcome): ShadowUnknown[] {
  const unknowns: ShadowUnknown[] = [];
  if (then.rule === "invoice.duplicate_of_settled") {
    unknowns.push({ fact: "sanctions", reason: "A repeat of a paid bill stopped it first then, so whether its address was on OFAC's sanctions list is not in the record." });
  }
  if (!(decision.decision.action === "pay" && !decision.observed.addressMissing)) {
    unknowns.push({
      fact: "spending_limits",
      reason: "It was not a payment now to an address, so the agent's spending limit and the contract on Arc were not read, and their figures are not in the record.",
    });
  }
  if (inWait(decision) === null) {
    unknowns.push({
      fact: "address_change",
      reason: decision.payeeOnFile.addressChangedSinceDecision
        ? "The payee's address changed again after the decision, so how long before it the address had changed is not in the record, and the payee lock's wait cannot be weighed."
        : "The payee lock in force at the decision is not in the record, so the wait after the address changed cannot be weighed.",
    });
  }
  if (decision.observed.documentPayTo.present && decision.observed.documentPayTo.differs === null) {
    unknowns.push({ fact: "pay_to", reason: "The payee's address changed after the decision, so whether the bill's document named the address on file then is not in the record." });
  }
  if (decision.payeeOnFile.role === null) unknowns.push({ fact: "role", reason: "The payee's role is not in the record." });
  if (decision.observed.projectId !== null && decision.observed.project === null) {
    unknowns.push({ fact: "project", reason: "The decision did not reach its project's budget, so what the project had left is not in the record." });
  }
  return unknowns;
}

/** What the replay of a decision needs to know before it runs (SR2-SR5). */
export function planReplay(decision: ShadowDecision): ShadowReplayPlan {
  const answer = scriptedAnswer(decision);
  const then = thenOutcome(decision);
  const unsupported = unsupportedReason(decision, answer);
  const unknowns = unsupported === null && MONEY_ACTIONS.has(answer.action) ? unknownsOf(decision, then) : [];
  return { answer, then, unsupported, unknowns };
}

/** Every combination of the unknown facts' two ways (SR4), in a fixed order; one, with none, when nothing is unknown. */
export function variantsOf(unknowns: readonly ShadowUnknown[]): ShadowVariant[] {
  // Counted in binary: the first fact's two ways alternate fastest.
  return Array.from({ length: 2 ** unknowns.length }, (_, count) =>
    Object.fromEntries(unknowns.map(({ fact }, index) => [fact, (count >> index) & 1 ? "stops" : "lets_through"])) as ShadowVariant
  );
}

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** The clock a decision is replayed at (SR1): its minute, or the last minute of its day when written after midnight. */
function clockOf(decision: ShadowDecision): string {
  return decision.decidedAt.slice(0, 10) === decision.decidedOn ? decision.decidedAt : `${decision.decidedOn}T23:59:00.000Z`;
}

/** The reserve's yield a discount's float was weighed with: from the float recorded, or none without one (SR2). */
function reserveApyOf(decision: ShadowDecision): number {
  const timing = decision.timing;
  const discount = decision.terms?.earlyPayDiscount;
  const amount = decision.observed.amount;
  if (!timing || !discount || timing.discountValue === null || !timing.floatValueToDue || !amount) return 0;
  if (discount.deadlineInDays === null || timing.dueInDays === null) return 0;
  const days = timing.dueInDays - discount.deadlineInDays;
  return days > 0 ? (timing.floatValueToDue * 365) / (amount * days) : 0;
}

/** When the address changed and was confirmed, in hours before the clock, and the lock it waits under (SR2, SR4). */
function addressTimes(decision: ShadowDecision, way: "lets_through" | "stops" | undefined): {
  changed: number | null;
  confirmed: number | null;
  lock: { on: boolean; hours: number };
} {
  const known = decision.payeeLock;
  const { addressChangedHoursBefore: hours, addressChangedSinceDecision: since } = decision.payeeOnFile;
  const unconfirmed = decision.observed.addressUnconfirmed === true;
  const recordedHours = !since && hours !== null ? hours + 0.5 : null;
  let changed: number | null;
  let lock = known ? { on: known.on, hours: known.coolingHours } : { on: false, hours: 0 };
  if (inWait(decision) === null && way !== undefined) {
    const waits = known !== null && known.on && known.coolingHours > 0;
    if (way === "stops") {
      if (!waits) lock = { on: true, hours: COOLING_HOURS_MAX };
      changed = recordedHours ?? 0.5;
    } else {
      changed = recordedHours ?? (waits ? known.coolingHours + 0.5 : 0.5);
    }
  } else {
    changed = recordedHours ?? (unconfirmed ? 0.5 : null);
  }
  if (changed === null && unconfirmed) changed = 0.5;
  return { changed, confirmed: changed === null || unconfirmed ? null : changed - 0.25, lock };
}

function firstPaymentOf(decision: ShadowDecision): ShadowReplayWorld["payee"]["firstPayment"] {
  const check = decision.observed.newPayee;
  if (!check) return null;
  return { addressBy: check.addressBy, askedVia: check.askedVia, confirmed: check.confirmed, twoParties: check.twoParties === true, unanswered: check.unanswered };
}

/** Whether a recorded match would refuse the bill: 0.9 or more against committed money, which a repeat is rebuilt as. */
function repeatsPaid(decision: ShadowDecision): boolean {
  return (decision.observed.duplicateCheck?.matches ?? []).some(
    (match) => match.confidence !== null && match.confidence >= REFUSES_AT && match.otherInvoiceStatus !== null && COMMITTED.has(match.otherInvoiceStatus)
  );
}

const REFUSING_ROOM: ShadowReplayRoom = { dailyUsdc: 0, weeklyUsdc: null, spentToday: 0, spentThisWeek: 0, remaining: 0, binding: "day" };

function spendingLimitsOf(decision: ShadowDecision, way: "lets_through" | "stops" | undefined): { spendingLimit: ShadowReplayRoom | null; contract: ShadowReplayVerdict | null } {
  if (way === "stops") {
    return { spendingLimit: REFUSING_ROOM, contract: { state: "refused", error: "OverDailyLimit", spent: 0, amount: decision.observed.amount, limit: 0 } };
  }
  if (way === "lets_through") return { spendingLimit: null, contract: null };
  const room = decision.outflowBudget;
  const verdict = decision.onChainLimit?.covered === true ? decision.onChainLimit.verdict : null;
  return {
    spendingLimit:
      room && room.spentToday !== null && room.spentThisWeek !== null && room.remaining !== null && (room.binding === "day" || room.binding === "week")
        ? { dailyUsdc: room.dailyUsdc, weeklyUsdc: room.weeklyUsdc, spentToday: room.spentToday, spentThisWeek: room.spentThisWeek, remaining: room.remaining, binding: room.binding }
        : null,
    contract: !decision.onChainLimit
      ? null
      : verdict?.state === "allowed"
        ? { state: "allowed" }
        : verdict?.state === "refused"
          ? { state: "refused", error: verdict.error ?? "Refused", spent: verdict.spent, amount: verdict.amount, limit: verdict.limit }
          : { state: "unreadable" },
  };
}

function projectOf(decision: ShadowDecision, way: "lets_through" | "stops" | undefined): ShadowReplayWorld["project"] {
  if (decision.observed.projectId === null) return null;
  const neededMinor = Math.round((decision.observed.amount ?? 0) * 1_000_000);
  const recorded = decision.observed.project;
  if (recorded && way === undefined) {
    const state = (["reserved", "over", "archived", "unreadable"] as const).find((one) => one === recorded.state) ?? "unreadable";
    return {
      state,
      neededMinor: recorded.neededMinor ?? neededMinor,
      budgetMinor: recorded.budgetMinor ?? 0,
      bufferMinor: recorded.bufferMinor ?? 0,
      reservedMinor: recorded.reservedMinor ?? 0,
      paidMinor: recorded.paidMinor ?? 0,
      availableMinor: recorded.availableMinor ?? 0,
      already: recorded.already === true,
    };
  }
  const fits = way !== "stops";
  return { state: fits ? "reserved" : "over", neededMinor, budgetMinor: fits ? neededMinor : 0, bufferMinor: 0, reservedMinor: 0, paidMinor: 0, availableMinor: fits ? neededMinor : 0, already: false };
}

/**
 * The world a decision is replayed in (SR2), from its record and nothing else: the facts it records, and each unknown
 * fact the way `variant` says. For a hold, a flag or a request for information, a fact the record lacks takes a neutral
 * value, since code weighs none for one (SR3).
 */
export function replayWorld(decision: ShadowDecision, variant: ShadowVariant = {}): ShadowReplayWorld {
  const answer = scriptedAnswer(decision);
  const then = thenOutcome(decision);
  const observed = decision.observed;
  const timing = decision.timing;
  const dueInDays = timing?.dueInDays ?? 0;
  const discount = decision.terms?.earlyPayDiscount;
  const lateFee = decision.terms?.lateFee;
  const scheduledFor = decision.scheduledForInDays;
  const sanctioned =
    variant.sanctions === "stops" || (variant.sanctions === undefined && then.rule === "counterparty.high_risk" && observed.riskLevel !== "high");
  const times = addressTimes(decision, variant.address_change);
  const limits = spendingLimitsOf(decision, variant.spending_limits);
  const payTo = observed.documentPayTo;
  const earlier = timing?.earlierObligations;
  return {
    now: clockOf(decision),
    answer: { ...answer, confidence: decision.decision.confidence ?? 0.9 },
    bill: {
      amount: observed.amount ?? 0,
      poPresent: observed.poPresent,
      goodsReceived: observed.goodsReceived ?? true,
      dueInDays,
      discount: discount && discount.percent !== null && discount.deadlineInDays !== null ? { percent: discount.percent, deadlineInDays: discount.deadlineInDays } : null,
      lateFee:
        lateFee && (lateFee.kind === "percent_month" || lateFee.kind === "fixed") && lateFee.value !== null && lateFee.startsOnInDays !== null
          ? { kind: lateFee.kind, value: lateFee.value, startsOnInDays: lateFee.startsOnInDays }
          : null,
      // Only a bill on its day, or past its due day, is decided: one scheduled for later is decided as pending (SR3).
      scheduledForInDays: scheduledFor !== null && (scheduledFor <= 0 || dueInDays <= 0) ? scheduledFor : null,
      documentPayTo: !payTo.present ? null : (payTo.differs ?? variant.pay_to === "stops") ? "other" : "on_file",
      inProject: observed.projectId !== null,
      vendorDocument: decision.vendorDocument !== null,
      repeatsPaidBill: repeatsPaid(decision),
    },
    payee: {
      riskLevel: observed.riskLevel ?? "clear",
      paymentLimit: observed.paymentLimit,
      role: decision.payeeOnFile.role ?? (variant.role === "stops" ? "client" : "vendor"),
      address: observed.addressMissing ? null : sanctioned ? "sanctioned" : "lab",
      purchaseOrderRequired: observed.purchaseOrderRequired ?? true,
      addressChangedHoursAgo: times.changed,
      addressConfirmedHoursAgo: times.confirmed,
      firstPayment: firstPaymentOf(decision),
    },
    workspace: {
      operatingBalance: observed.operatingBalance ?? 0,
      reserveApy: reserveApyOf(decision),
      payeeLock: times.lock,
      twoApprovalsAbove: observed.twoApprovalsAbove,
      ...limits,
    },
    earlierObligations: { total: earlier?.total ?? 0, count: earlier?.count ?? 0 },
    sameWork: observed.sameWork.flatMap((match) =>
      (match.otherKind === "bill" || match.otherKind === "milestone") && (match.signal === "purchase_order" || match.signal === "deliverable")
        ? [{ otherKind: match.otherKind, otherStatus: match.otherStatus ?? "verified", signal: match.signal }]
        : []
    ),
    project: projectOf(decision, variant.project),
  };
}

const key = (outcome: ShadowOutcome) => `${outcome.rule ?? ""}|${outcome.money}`;

/** "a payment now", "a schedule", "a hold": an action as the reason names it. */
const ACTION_NOUN: Record<ShadowAction, string> = {
  pay: "a payment now",
  schedule: "a schedule",
  hold: "a hold",
  flag_fraud: "a flag",
  request_info: "a request for information",
};

/** A rule as the end of a "because" clause; one with no words is named as a check in code. */
function because(rule: string): string {
  return ruleWords(rule) ?? `a check in code (${rule})`;
}

/** Whether some two runs that differ in this fact alone end differently. */
function matters(fact: ShadowUnknownFact, runs: readonly ShadowReplayRun[]): boolean {
  return runs.some((a) =>
    runs.some((b) => a.variant[fact] !== b.variant[fact] && UNKNOWN_ORDER.every((other) => other === fact || a.variant[other] === b.variant[other]) && key(a.outcome) !== key(b.outcome))
  );
}

/** The class a decision gets (SR6), and whether it is a wrong payment (SR7), from every replay of it. */
export function judgeReplay(
  decision: ShadowDecision,
  plan: ShadowReplayPlan,
  runs: readonly ShadowReplayRun[]
): Pick<ShadowReplayResult, "now" | "class" | "reason" | "wrongPayment"> {
  const transfersWrong = runs.some((run) => !run.transfersRight);
  if (plan.unsupported !== null) return { now: null, class: "cannot_rebuild", reason: plan.unsupported, wrongPayment: transfersWrong };
  if (runs.length === 0) throw new Error(`${decision.id} was not replayed`);
  const then = plan.then;
  if (new Set(runs.map((run) => key(run.outcome))).size > 1) {
    const named = plan.unknowns.filter((unknown) => matters(unknown.fact, runs));
    const money = runs.every((run) => run.outcome.money === "stops")
      ? "Money stops either way."
      : runs.every((run) => run.outcome.money === "moves")
        ? "Money moves either way."
        : "Money moves one way and not the other.";
    const reasons = (named.length > 0 ? named : plan.unknowns).map((unknown) => unknown.reason);
    return { now: null, class: "cannot_rebuild", reason: [...reasons, money].join(" "), wrongPayment: transfersWrong };
  }
  const now = runs[0].outcome;
  const wrongPayment = transfersWrong || (now.money === "moves" && (then.money === "stops" || decision.verdict === "disagree"));
  if (now.rule === then.rule && now.money === then.money) {
    const reason =
      now.action === then.action
        ? null
        : `Code now makes the answer ${ACTION_NOUN[now.action]} rather than ${ACTION_NOUN[then.action]}, and ${now.rule ? "the same rule stops it" : "the outcome is the same"}.`;
    return { now, class: "same", reason, wrongPayment };
  }
  if (now.money === "moves" && then.money === "stops") {
    const reason = then.rule
      ? `Stopped then because ${because(then.rule)}; code lets it through now.`
      : `The model's answer moved no money then; code lets money move now.`;
    return { now, class: "now_let_through", reason, wrongPayment };
  }
  const reason =
    now.rule === null
      ? "Code let it through its checks now, but no money moved."
      : then.rule === null
        ? `Stopped now because ${because(now.rule)}: a rule that did not stop it then.`
        : `Stopped now because ${because(now.rule)}; then because ${because(then.rule)}.`;
  return { now, class: "now_stopped", reason, wrongPayment };
}

/** One decision's line in the committed file (SR9). */
export function replayResult(decision: ShadowDecision, plan: ShadowReplayPlan, runs: readonly ShadowReplayRun[]): ShadowReplayResult {
  const judged = judgeReplay(decision, plan, runs);
  return {
    id: decision.id,
    day: decision.decidedOn,
    answer: plan.answer,
    verdict: decision.verdict,
    then: plan.then,
    now: judged.now,
    class: judged.class,
    reason: judged.reason,
    wrongPayment: judged.wrongPayment,
  };
}

export function summarizeReplay(results: ReadonlyArray<Pick<ShadowReplayResult, "class" | "verdict" | "wrongPayment">>): ShadowReplaySummary {
  const count = (test: (result: (typeof results)[number]) => boolean) => results.filter(test).length;
  return {
    decisions: results.length,
    same: count((result) => result.class === "same"),
    nowStopped: count((result) => result.class === "now_stopped"),
    nowLetThrough: count((result) => result.class === "now_let_through"),
    cannotRebuild: count((result) => result.class === "cannot_rebuild"),
    wrongPayments: count((result) => result.wrongPayment),
    agreed: count((result) => result.verdict === "agree"),
    disagreed: count((result) => result.verdict === "disagree"),
    noVerdict: count((result) => result.verdict === null),
  };
}

/** The committed file's text (SR9): the summary, then each decision, two-space JSON, LF, a final newline. */
export function renderReplay(results: ShadowReplayResult[]): string {
  const document: ShadowReplayResults = { summary: summarizeReplay(results), decisions: results };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The bill's due day as an ISO day, `days` after the decision's day. */
export function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** What a transfer for the bill should carry (SR7): its amount, less an early-payment discount through its deadline's day. */
export function amountDue(world: ShadowReplayWorld): number {
  const { amount, discount } = world.bill;
  return discount && discount.deadlineInDays >= 0 ? round6(amount * (1 - discount.percent / 100)) : round6(amount);
}
