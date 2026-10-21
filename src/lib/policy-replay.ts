import { agentOutflowUsdc, budgetRoom, exceedsBudget, type OutflowBudget } from "./agent/outflow-budget";
import { paymentLimitForRisk } from "./compliance";
import { heldForCash, heldForVerdict } from "./next-step";
import { TWO_APPROVALS_RULE } from "./two-approvals";

/**
 * Trying a rule figure on past decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md). The code's checks
 * replayed on the facts the agent's decisions recorded, twice: with the figures in force now, and with one figure
 * swapped for a candidate. No model is asked: a decision where the model chose not to pay stays as it was. Pure, so
 * the reader (./policy-replay-read.ts) hands it the entries and the figures.
 */

/** A figure someone may try: a counterparty's configured payment limit, two approvals, or the agent's spending limit (P1). */
export type RuleCandidate =
  | { kind: "counterparty_limit"; counterpartyId: string; limit: number | null }
  | { kind: "two_approvals"; above: number | null }
  | { kind: "spending_limit"; dailyUsdc: number | null; weeklyUsdc: number | null };

export type RuleKind = RuleCandidate["kind"];

/** Every figure the replay checks a payment against. */
export interface RuleFigures {
  /** Each counterparty's configured payment limit, by id. One not here keeps the limit its decision recorded (P5). */
  counterpartyLimits: Record<string, number | null>;
  twoApprovalsAbove: number | null;
  spendingLimit: OutflowBudget;
}

/** The figures with one candidate swapped in, the rest as they are. */
export function withCandidate(figures: RuleFigures, candidate: RuleCandidate): RuleFigures {
  switch (candidate.kind) {
    case "counterparty_limit":
      return { ...figures, counterpartyLimits: { ...figures.counterpartyLimits, [candidate.counterpartyId]: candidate.limit } };
    case "two_approvals":
      return { ...figures, twoApprovalsAbove: candidate.above };
    case "spending_limit":
      return { ...figures, spendingLimit: { dailyUsdc: candidate.dailyUsdc, weeklyUsdc: candidate.weeklyUsdc } };
  }
}

/** An agent's ledger entry as the replay reads it: a decision on a bill (`ap_*`) or a milestone (`milestone_*`). */
export interface ReplayEntry {
  seq: number;
  ts: string;
  action: string;
  detail: Record<string, unknown>;
}

/** Why a column cannot say what code would have done (P7). */
export type CantTellReason =
  | "facts_missing"
  | "rule_unknown"
  | "risk_missing"
  | "stage_unsettled"
  | "budget_unsettled"
  | "contract_unsettled"
  | "earlier_unsettled";

/** What code does with one decision under one set of figures. */
export type ReplayVerdict =
  | { kind: "goes_ahead" }
  | { kind: "paid_earlier"; seq: number }
  | { kind: "stopped"; rule: string }
  | { kind: "agent_held" }
  | { kind: "cant_tell"; because: CantTellReason };

/** How a decision's outcome moves from the figures in force to the candidate (P8). */
export type ReplayChange = "unchanged" | "now_held" | "now_paid" | "now_two_people" | "cant_tell";

export interface ReplayedDecision {
  seq: number;
  ts: string;
  source: "bill" | "milestone";
  /** The invoice or milestone decided; null when the entry names none. */
  sourceId: string | null;
  counterpartyId: string | null;
  amount: number | null;
  currency: "USDC" | "EURC";
  /** What the checks weigh: the amount, or a EURC bill's USDC value. */
  amountUsdc: number | null;
  /** Decided in shadow mode, where a payment the checks let through waits for a person to agree; null when unknown. */
  shadow: boolean | null;
  before: ReplayVerdict;
  after: ReplayVerdict;
  change: ReplayChange;
}

/**
 * What the reader knows of the workspace's shadow mode (P6), for a milestone whose entry does not say: the contractor
 * stage names shadow mode on a release it held for a verdict, never on one a rule stopped. A bill's entry always says.
 */
export interface ShadowHistory {
  /** When the shadow mode on now began; null when it is off now. */
  onSince: string | null;
  /** Whether it may have been on before then, or at all when it is off now: never where it cannot run (Arc mainnet). */
  earlierPossible: boolean;
}

/** Nothing known: a milestone a rule stopped may have been decided in shadow mode or not. */
const SHADOW_UNKNOWN: ShadowHistory = { onSince: null, earlierPossible: true };

export interface ReplayCounts {
  decisions: number;
  unchanged: number;
  nowHeld: number;
  nowPaid: number;
  nowTwoPeople: number;
  cantTell: number;
}

export interface ReplayResult {
  decisions: ReplayedDecision[];
  counts: ReplayCounts;
}

const LIMIT = "counterparty.payment_limit";
const BUDGET = "workspace.outflow_budget";
const ROUTE = "workspace.onchain_limit_route";
const CONTRACT = "workspace.onchain_limit";
/** After every other check (project budgets P5, P9): the same work billed twice, and the project's budget. */
const SAME_WORK = "obligation.duplicate_reference";
const PROJECT = "project.budget_exceeded";

/** The figures' own checks; every other stage is a check no setting here changes. */
const FIGURE_STAGES = new Set<string>([LIMIT, TWO_APPROVALS_RULE, BUDGET]);

/** The order `enforceApGuardrails` (./agent/guardrails.ts) runs its checks in, for a bill (P4). */
export const BILL_STAGES: readonly string[] = [
  "invoice.duplicate_of_settled",
  "counterparty.high_risk",
  "counterparty.unscreened",
  "counterparty.client_payable",
  "counterparty.no_address",
  "counterparty.address_unconfirmed",
  "counterparty.cooling_off",
  "invoice.pay_to_differs",
  "invoice.match_incomplete",
  "counterparty.new_payee",
  "fx.rate_unavailable",
  LIMIT,
  "bridge.unsupported_token",
  "bridge.fee_unavailable",
  "bridge.fee_above_cap",
  "bridge.gateway_balance_short",
  "payout.bank_needs_person",
  TWO_APPROVALS_RULE,
  BUDGET,
  ROUTE,
  CONTRACT,
  "fx.swap_cost_above_cap",
  "fx.swap_usdc_short",
  "treasury.insufficient_eurc",
  SAME_WORK,
  PROJECT,
];

/** The order the contractor stage (./agent/orchestrator.ts) runs its checks in, for a milestone release (P4). */
export const MILESTONE_STAGES: readonly string[] = [
  "counterparty.high_risk",
  "counterparty.unscreened",
  LIMIT,
  "counterparty.new_payee",
  TWO_APPROVALS_RULE,
  BUDGET,
  ROUTE,
  CONTRACT,
  SAME_WORK,
  PROJECT,
];

/** Checks that run only for a payment now (a bill's `pay`, a milestone's `release`), never for a schedule. */
const NOW_ONLY = new Set<string>([BUDGET, ROUTE, CONTRACT, "fx.swap_cost_above_cap", "fx.swap_usdc_short", "treasury.insufficient_eurc"]);
const CROSS_CHAIN = new Set<string>(["bridge.unsupported_token", "bridge.fee_unavailable", "bridge.fee_above_cap", "bridge.gateway_balance_short"]);
const EURC_FUNDING = new Set<string>(["fx.swap_cost_above_cap", "fx.swap_usdc_short", "treasury.insufficient_eurc"]);

const DAY_MS = 86_400_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numeric(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Where the contractor stage wrote a milestone's entry (P6): `first`, as it decided it (a hold, a rule's refusal, a
 * release held for cash or for a verdict); `last`, a release it planned, written once every milestone was decided and
 * the batch sent; `either` when the entry does not say.
 */
type StageOrder = "first" | "last" | "either";

/** What one decision recorded that the checks weigh. */
interface Facts {
  seq: number;
  ts: string;
  day: number;
  source: "bill" | "milestone";
  sourceId: string | null;
  counterpartyId: string | null;
  /** The decision's action after code's bounds; null when none was recorded. */
  action: string | null;
  /** The agent chose to pay: pay or schedule a bill, release a milestone. */
  goes: boolean;
  /** A payment now: what the spending limit and the contract weigh. */
  now: boolean;
  amount: number | null;
  currency: "USDC" | "EURC";
  amountUsdc: number | null;
  risk: string | null;
  /** The current limit the decision weighed; undefined when it recorded none. */
  recordedLimit: number | null | undefined;
  /** The rule that stopped it, null for none; undefined when the entry does not say. */
  recordedRule: string | null | undefined;
  /** What it counted against the spending limit, as recorded. */
  paidUsdc: number;
  /** Decided in shadow mode; null when neither the entry nor the workspace's history says. */
  shadow: boolean | null;
  /** A schedule's UTC day to pay on; null for anything else, or when the entry has none. */
  payOnDay: number | null;
  /** A milestone's place in its contractor stage's entries; `first` for a bill. */
  order: StageOrder;
  crossChain: boolean;
  /** Paid to a bank account through BlindPay, as the decision recorded it; none was before bank payouts (B6). */
  paidToBank: boolean;
  live: boolean;
  /** The spending-limit contract's check, as recorded; undefined when none was recorded. */
  contract: Record<string, unknown> | undefined;
  /** The spending limit's figures the decision was weighed against; null with none set. */
  recordedBudget: OutflowBudget | null;
  newPayee: { twoParties: boolean } | null;
  /** The decision found an earlier bill or milestone for the same work (`observed.sameWork`, project budgets P9). */
  sameWork: boolean;
  /** The bill or milestone was in a project (`observed.projectId`, project budgets P5). */
  inProject: boolean;
  /** The entry has what any replay needs: an amount and a decision. */
  complete: boolean;
}

function stageOrderOf(action: string | null, recordedRule: string | null | undefined, detail: Record<string, unknown>): StageOrder {
  if (action === null || (action === "release" && recordedRule === undefined)) return "either";
  if (action !== "release" || recordedRule !== null) return "first";
  return heldForCash(detail) || heldForVerdict(detail) ? "first" : "last";
}

/** Whether a decision was made in shadow mode: from its entry where it says, else from the workspace's history. */
function shadowOf(entry: ReplayEntry, action: string | null, recordedRule: string | null | undefined, history: ShadowHistory): boolean | null {
  if (entry.detail.shadow === true || heldForVerdict(entry.detail)) return true;
  // A release no rule stopped went on to be sent, or to wait for cash: shadow mode holds one for a verdict before both.
  if (entry.action === "milestone_release" && action === "release" && recordedRule === null) return false;
  if (history.onSince !== null && Date.parse(entry.ts) >= Date.parse(history.onSince)) return true;
  // The AP stage names shadow mode on every decision it makes in it; the contractor stage only on a verdict's hold.
  if (entry.action.startsWith("ap_")) return false;
  return history.earlierPossible ? null : false;
}

/** A schedule's `payOn` (YYYY-MM-DD, UTC) as a day number; null when it cannot be read. */
function payOnDayOf(decision: Record<string, unknown> | null): number | null {
  const payOn = typeof decision?.payOn === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(decision.payOn)?.[0] : undefined;
  const at = payOn ? Date.parse(`${payOn}T00:00:00.000Z`) : NaN;
  return Number.isFinite(at) ? Math.floor(at / DAY_MS) : null;
}

function factsOf(entry: ReplayEntry, history: ShadowHistory): Facts | null {
  const source = entry.action.startsWith("ap_") ? "bill" : entry.action.startsWith("milestone_") ? "milestone" : null;
  if (!source) return null;
  const detail = entry.detail;
  const observed = record(detail.observed);
  const decision = record(detail.decision);
  const action = typeof decision?.action === "string" ? decision.action : null;
  const currency = detail.currency === "EURC" ? "EURC" : "USDC";
  const amount = numeric(observed?.amount);
  const amountUsdc = currency === "EURC" ? numeric(detail.usdcValue) : amount;
  const recordedRule =
    typeof detail.guardrailRule === "string"
      ? detail.guardrailRule
      : detail.guardrailBlocked === false || (detail.guardrailRule === null && detail.guardrailBlocked !== true)
        ? null
        : undefined;
  const budget = record(detail.outflowBudget);
  const newPayee = record(observed?.newPayee);
  const execution = record(detail.execution);
  const goes = source === "bill" ? action === "pay" || action === "schedule" : action === "release";
  const sourceId = source === "bill" ? detail.invoiceId : detail.milestoneId;
  return {
    seq: entry.seq,
    ts: entry.ts,
    day: Math.floor(Date.parse(entry.ts) / DAY_MS),
    source,
    sourceId: typeof sourceId === "string" ? sourceId : null,
    counterpartyId: typeof detail.counterpartyId === "string" ? detail.counterpartyId : null,
    action,
    goes,
    now: action === "pay" || action === "release",
    amount,
    currency,
    amountUsdc,
    risk: typeof observed?.riskLevel === "string" ? observed.riskLevel : null,
    // No limit is recorded as null; a value that is not a number says nothing.
    recordedLimit: observed?.paymentLimit === null ? null : (numeric(observed?.paymentLimit) ?? undefined),
    recordedRule,
    paidUsdc: agentOutflowUsdc({ actor: "agent", action: entry.action, detail }),
    shadow: shadowOf(entry, action, recordedRule, history),
    payOnDay: action === "schedule" ? payOnDayOf(decision) : null,
    order: source === "milestone" ? stageOrderOf(action, recordedRule, detail) : "first",
    crossChain: record(detail.payout) !== null,
    paidToBank: detail.paidToBank === true,
    live: execution?.chainMode === "live",
    contract: record(detail.onChainLimit) ?? undefined,
    recordedBudget: budget ? { dailyUsdc: numeric(budget.dailyUsdc), weeklyUsdc: numeric(budget.weeklyUsdc) } : null,
    newPayee: newPayee ? { twoParties: newPayee.twoParties === true } : null,
    sameWork: Array.isArray(observed?.sameWork) && observed.sameWork.length > 0,
    inProject: typeof observed?.projectId === "string",
    complete: observed !== null && amount !== null && action !== null,
  };
}

/** What a decision has the agent paying on one UTC day, as a range: its low and high end (P6). */
interface Contribution {
  day: number;
  low: number;
  high: number;
}

/** What the agent has paid on the day of a check and in the 7 days ending it, at the low and the high end. */
interface SpentRange {
  low: { today: number; week: number };
  high: { today: number; week: number };
}

/** Adds what may have been paid on `paidOn` to `range`, for a check on `day`, at the high end only (P6). */
function addMaybe(range: SpentRange, paidOn: number, amount: number, day: number): void {
  if (paidOn === day) range.high.today += amount;
  if (paidOn <= day && paidOn > day - 7) range.high.week += amount;
}

/** What one column has the agent paying, by UTC day, as a range: its low and high end (P6). */
class Spend {
  private readonly days = new Map<number, { low: number; high: number }>();

  add(day: number, low: number, high: number): void {
    if (low === 0 && high === 0) return;
    const bucket = this.days.get(day) ?? { low: 0, high: 0 };
    bucket.low += low;
    bucket.high += high;
    this.days.set(day, bucket);
  }

  /** Today's and the 7 days' totals ending on `day`, at each end. */
  around(day: number): SpentRange {
    const today = this.days.get(day) ?? { low: 0, high: 0 };
    let weekLow = 0;
    let weekHigh = 0;
    for (let d = day - 6; d <= day; d++) {
      const bucket = this.days.get(d);
      if (bucket) {
        weekLow += bucket.low;
        weekHigh += bucket.high;
      }
    }
    return { low: { today: today.low, week: weekLow }, high: { today: today.high, week: weekHigh } };
  }
}

/** One column of the replay: its figures, what it has the agent paying, and the bills it has paid. */
interface Column {
  figures: RuleFigures;
  spend: Spend;
  /** Bills and milestones paid in this column, by source, with the decision that paid them. */
  paid: Map<string, number>;
  /** Sources a decision this column cannot tell may have paid. */
  unsettled: Set<string>;
}

type StageAnswer = "fires" | "passes" | { cantTell: CantTellReason };

const sameFigures = (a: OutflowBudget, b: OutflowBudget | null) =>
  (a.dailyUsdc ?? null) === (b?.dailyUsdc ?? null) && (a.weeklyUsdc ?? null) === (b?.weeklyUsdc ?? null);

/** A contract refusal for want of room: its own figures, which follow the spending limit's (P2). */
function roomRefusal(contract: Record<string, unknown> | undefined): boolean {
  const verdict = record(contract?.verdict);
  return verdict?.state === "refused" && (verdict.error === "OverDailyLimit" || verdict.error === "OverWeeklyLimit");
}

/** The contract's answer, from its recorded check (P2): a route it cannot carry, or a refusal. */
function contractAnswer(stage: string, facts: Facts, figures: RuleFigures): StageAnswer {
  const check = facts.contract;
  if (!check) return "passes";
  if (stage === ROUTE) return check.covered === false ? "fires" : "passes";
  if (record(check.verdict)?.state !== "refused") return "passes";
  if (roomRefusal(check) && !sameFigures(figures.spendingLimit, facts.recordedBudget)) return { cantTell: "contract_unsettled" };
  return "fires";
}

/** A check no setting here changes, at a stage past the recorded rule: settled from the facts, where they settle it (P4). */
function settleFromFacts(stage: string, facts: Facts, figures: RuleFigures): StageAnswer {
  if (CROSS_CHAIN.has(stage)) return facts.crossChain ? { cantTell: "stage_unsettled" } : "passes";
  // No setting here pays a bank payout without a person (bank payouts B6).
  if (stage === "payout.bank_needs_person") return facts.paidToBank ? "fires" : "passes";
  if (EURC_FUNDING.has(stage)) return facts.currency === "EURC" ? { cantTell: "stage_unsettled" } : "passes";
  if (stage === ROUTE || stage === CONTRACT) {
    // A sandbox has no contract. A bill's check is asked before its checks run, so none recorded means none enforced;
    // a release's is asked only once its earlier checks pass, so none recorded says nothing.
    if (!facts.live) return "passes";
    if (facts.contract === undefined && facts.source === "milestone") return { cantTell: "stage_unsettled" };
    return contractAnswer(stage, facts, figures);
  }
  if (stage === "counterparty.new_payee") return facts.newPayee && !facts.newPayee.twoParties ? "fires" : "passes";
  // The same work: recorded whenever a decision found an earlier bill or milestone for it, whatever held it.
  if (stage === SAME_WORK) return facts.sameWork ? "fires" : "passes";
  // A project's budget is read at the moment of the decision, so a bill in a project cannot be told; one in none passes.
  if (stage === PROJECT) return facts.inProject ? { cantTell: "stage_unsettled" } : "passes";
  return { cantTell: "stage_unsettled" };
}

function figureAnswer(stage: string, facts: Facts, column: Column, spentAround: () => SpentRange): StageAnswer {
  const amount = facts.amountUsdc;
  if (amount === null) return { cantTell: "facts_missing" };
  const { figures } = column;
  if (stage === LIMIT) {
    const id = facts.counterpartyId;
    let limit: number | null;
    if (id !== null && Object.hasOwn(figures.counterpartyLimits, id)) {
      if (facts.risk === null) return { cantTell: "risk_missing" };
      limit = paymentLimitForRisk(facts.risk, figures.counterpartyLimits[id]);
    } else {
      if (facts.recordedLimit === undefined) return { cantTell: "facts_missing" };
      limit = facts.recordedLimit;
    }
    return limit !== null && amount > limit ? "fires" : "passes";
  }
  if (stage === TWO_APPROVALS_RULE) {
    const above = figures.twoApprovalsAbove;
    return above !== null && amount > above ? "fires" : "passes";
  }
  // The spending limit: what the column has the agent paying that UTC day and in the 7 days ending it, at each end.
  const spent = spentAround();
  const atLow = exceedsBudget(amount, budgetRoom(figures.spendingLimit, spent.low));
  const atHigh = exceedsBudget(amount, budgetRoom(figures.spendingLimit, spent.high));
  if (atLow !== atHigh) return { cantTell: "budget_unsettled" };
  return atLow ? "fires" : "passes";
}

function sourceKey(facts: Facts): string | null {
  return facts.sourceId === null ? null : `${facts.source}:${facts.sourceId}`;
}

/** What code does with one decision in one column; `spentAround` is what the spending limit weighs it against. */
function verdictIn(facts: Facts, column: Column, spentAround: () => SpentRange): ReplayVerdict {
  const key = sourceKey(facts);
  if (key !== null && column.paid.has(key)) return { kind: "paid_earlier", seq: column.paid.get(key) as number };
  if (key !== null && column.unsettled.has(key)) return { kind: "cant_tell", because: "earlier_unsettled" };
  if (!facts.complete) return { kind: "cant_tell", because: "facts_missing" };
  if (!facts.goes) return { kind: "agent_held" };
  if (facts.recordedRule === undefined) return { kind: "cant_tell", because: "rule_unknown" };
  const stages = facts.source === "bill" ? BILL_STAGES : MILESTONE_STAGES;
  const recorded = facts.recordedRule === null ? stages.length : stages.indexOf(facts.recordedRule);
  if (recorded < 0) return { kind: "cant_tell", because: "rule_unknown" };

  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    if (NOW_ONLY.has(stage) && !facts.now) continue;
    let answer: StageAnswer;
    if (FIGURE_STAGES.has(stage)) answer = figureAnswer(stage, facts, column, spentAround);
    else if (index < recorded) answer = "passes";
    // The recorded rule fired; a contract refusal is read again, since it can rest on the spending limit's figures.
    else if (index === recorded) answer = stage === CONTRACT && facts.contract ? contractAnswer(stage, facts, column.figures) : "fires";
    else answer = settleFromFacts(stage, facts, column.figures);
    if (answer === "fires") return { kind: "stopped", rule: stage };
    if (answer !== "passes") return { kind: "cant_tell", because: answer.cantTell };
  }
  // A schedule a rule held then is decided again on its day, and may be paid then (P6): with no day, it cannot be placed.
  if (laterPayment(facts) && facts.payOnDay === null) return { kind: "cant_tell", because: "facts_missing" };
  return { kind: "goes_ahead" };
}

/** A schedule a rule held then, outside shadow mode: let through, its day's decision is not in the ledger (P6). */
const laterPayment = (facts: Facts) => facts.action === "schedule" && facts.recordedRule !== null && facts.shadow !== true;

/**
 * What a decision the column let through has the agent paying (P6), and on which day: what it paid if it paid; nothing
 * if something other than a rule stopped it then, or in shadow mode; its full USDC value if a rule stopped it then, from
 * nothing to that where shadow mode is not known. A schedule a rule held then, from nothing to its full USDC value on
 * its day, when the agent decides it again.
 */
function spendOf(facts: Facts): Contribution | null {
  if (facts.shadow === true) return null;
  if (laterPayment(facts)) return facts.payOnDay === null ? null : { day: facts.payOnDay, low: 0, high: facts.amountUsdc ?? Infinity };
  if (!facts.now) return null;
  if (facts.paidUsdc > 0) return { day: facts.day, low: facts.paidUsdc, high: facts.paidUsdc };
  if (facts.recordedRule === null) return null;
  const amount = facts.amountUsdc ?? Infinity;
  return { day: facts.day, low: facts.shadow === null ? 0 : amount, high: amount };
}

/** The most a decision the column cannot tell may have the agent paying, and on which day. */
function mostSpendOf(facts: Facts): Contribution | null {
  if (facts.paidUsdc > 0) return { day: facts.day, low: 0, high: facts.paidUsdc };
  if (facts.action !== null) {
    if (facts.shadow === true || facts.recordedRule === null) return null;
    if (laterPayment(facts)) return facts.payOnDay === null ? null : { day: facts.payOnDay, low: 0, high: facts.amountUsdc ?? Infinity };
    if (!facts.now) return null;
  }
  return { day: facts.day, low: 0, high: facts.amountUsdc ?? Infinity };
}

/** What a decision has the agent paying in one column, once replayed there. */
function contributionOf(facts: Facts, verdict: ReplayVerdict): Contribution | null {
  if (verdict.kind === "goes_ahead") return spendOf(facts);
  if (verdict.kind === "cant_tell") return mostSpendOf(facts);
  return null;
}

/**
 * What a milestone counts against the spending limit for the rest of its contractor stage: a release the stage planned
 * counts its amount at once, whatever came of the transfer (the stage's `budget.spend`); anything else what it pays.
 */
function stageSpendOf(facts: Facts, verdict: ReplayVerdict): Contribution | null {
  if (facts.order !== "last") return contributionOf(facts, verdict);
  const amount = facts.amountUsdc ?? Infinity;
  if (verdict.kind === "goes_ahead") return { day: facts.day, low: amount, high: amount };
  if (verdict.kind === "cant_tell") return { day: facts.day, low: 0, high: amount };
  return null;
}

/** A bill or milestone the column has surely paid is paid; one it may have paid is unsettled for later decisions on it. */
function markSource(facts: Facts, verdict: ReplayVerdict, column: Column): void {
  const key = sourceKey(facts);
  const part = contributionOf(facts, verdict);
  if (key === null || part === null) return;
  if (verdict.kind === "goes_ahead" && part.low > 0) column.paid.set(key, facts.seq);
  else if (part.high > 0) column.unsettled.add(key);
}

/**
 * One contractor stage's milestones, or one bill, in one column (P6). The stage writes what it holds as it decides it,
 * and the releases it planned once it has sent them, so its entries do not show which it checked first: a held one and
 * a planned one weigh each other at the high end only, and a spending-limit check that order would decide is can't
 * tell. Among those written as decided, and among the releases, the ledger's order is the stage's.
 */
function replayStage(group: Facts[], column: Column): ReplayVerdict[] {
  const asDecided = new Spend();
  const planned = new Spend();
  const releasedLater = group.flatMap((facts, index) => (facts.order === "first" ? [] : [{ facts, index }]));
  const verdicts = group.map((facts, index) => {
    const spentAround = () => {
      const range = column.spend.around(facts.day);
      const key = sourceKey(facts);
      const add = (spend: Spend, orderKnown: boolean) => {
        const part = spend.around(facts.day);
        if (orderKnown) {
          range.low.today += part.low.today;
          range.low.week += part.low.week;
        }
        range.high.today += part.high.today;
        range.high.week += part.high.week;
      };
      if (facts.order === "last") {
        add(planned, true);
        add(asDecided, false);
      } else {
        add(asDecided, true);
        add(planned, false);
        // A release written after this one may have been checked before it, and counted its amount then.
        for (const later of releasedLater) {
          if (later.index <= index || (key !== null && sourceKey(later.facts) === key)) continue;
          addMaybe(range, later.facts.day, later.facts.amountUsdc ?? Infinity, facts.day);
        }
      }
      return range;
    };
    const verdict = verdictIn(facts, column, spentAround);
    markSource(facts, verdict, column);
    const part = stageSpendOf(facts, verdict);
    if (part) (facts.order === "last" ? planned : asDecided).add(part.day, part.low, part.high);
    return verdict;
  });
  for (const [index, facts] of group.entries()) {
    const part = contributionOf(facts, verdicts[index]);
    if (part) column.spend.add(part.day, part.low, part.high);
  }
  return verdicts;
}

const ahead = (verdict: ReplayVerdict) => verdict.kind === "goes_ahead" || verdict.kind === "paid_earlier";

/** A bill moves a count once (P8): a later decision on one the replay already paid, in either column, is unchanged. */
function changeOf(before: ReplayVerdict, after: ReplayVerdict): ReplayChange {
  if (before.kind === "cant_tell" || after.kind === "cant_tell") return "cant_tell";
  if (before.kind === "paid_earlier" || after.kind === "paid_earlier") return "unchanged";
  if (ahead(before) === ahead(after)) return "unchanged";
  if (!ahead(before)) return "now_paid";
  return after.kind === "stopped" && after.rule === TWO_APPROVALS_RULE ? "now_two_people" : "now_held";
}

export interface ReplayOptions {
  windowStart: string;
  current: RuleFigures;
  candidate: RuleFigures;
  /** The ledger sequences of `cycle_complete` entries: a contractor stage's entries never straddle one (P6). */
  cycleEnds?: number[];
  /** What is known of shadow mode, for a milestone whose entry does not say; nothing by default. */
  shadow?: ShadowHistory;
}

/**
 * Every decision in the window, in ledger order, with what code does under the figures in force (`current`) and under
 * the candidate's (P3). Entries before `windowStart` count only what they paid, as recorded, toward the spending limit's
 * running totals (P6); the caller passes the six days before the window for that.
 */
export function replayDecisions(entries: ReplayEntry[], options: ReplayOptions): ReplayResult {
  const from = Date.parse(options.windowStart);
  const history = options.shadow ?? SHADOW_UNKNOWN;
  const ends = [...(options.cycleEnds ?? [])].sort((a, b) => a - b);
  const column = (figures: RuleFigures): Column => ({ figures, spend: new Spend(), paid: new Map(), unsettled: new Set() });
  const before = column(options.current);
  const after = column(options.candidate);
  const decisions: ReplayedDecision[] = [];
  const counts: ReplayCounts = { decisions: 0, unchanged: 0, nowHeld: 0, nowPaid: 0, nowTwoPeople: 0, cantTell: 0 };
  const COUNT_KEY: Record<ReplayChange, Exclude<keyof ReplayCounts, "decisions">> = {
    unchanged: "unchanged",
    now_held: "nowHeld",
    now_paid: "nowPaid",
    now_two_people: "nowTwoPeople",
    cant_tell: "cantTell",
  };

  const all = [...entries]
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => factsOf(entry, history))
    .filter((facts): facts is Facts => facts !== null);
  let end = 0;
  /** Whether `next` may be from the same contractor stage as `previous`, the decision just before it. */
  const sameStage = (previous: Facts, next: Facts) => {
    if (next.source !== "milestone" || Date.parse(next.ts) < from) return false;
    // Within a stage, every entry written as decided comes before every release written once sent.
    if (previous.order === "last" && next.order === "first") return false;
    while (end < ends.length && ends[end] < previous.seq) end++;
    return !(end < ends.length && ends[end] < next.seq);
  };

  for (let index = 0; index < all.length; ) {
    const facts = all[index];
    if (Date.parse(facts.ts) < from) {
      // Before the window: what it paid, as recorded, in both columns.
      before.spend.add(facts.day, facts.paidUsdc, facts.paidUsdc);
      after.spend.add(facts.day, facts.paidUsdc, facts.paidUsdc);
      index += 1;
      continue;
    }
    let stop = index + 1;
    if (facts.source === "milestone") while (stop < all.length && sameStage(all[stop - 1], all[stop])) stop += 1;
    const group = all.slice(index, stop);
    const was = replayStage(group, before);
    const would = replayStage(group, after);
    for (const [position, decided] of group.entries()) {
      const change = changeOf(was[position], would[position]);
      counts.decisions += 1;
      counts[COUNT_KEY[change]] += 1;
      decisions.push({
        seq: decided.seq,
        ts: decided.ts,
        source: decided.source,
        sourceId: decided.sourceId,
        counterpartyId: decided.counterpartyId,
        amount: decided.amount,
        currency: decided.currency,
        amountUsdc: decided.amountUsdc,
        shadow: decided.shadow,
        before: was[position],
        after: would[position],
        change,
      });
    }
    index = stop;
  }
  return { decisions, counts };
}

/** What a setting's signed change records of the replay it was applied after (P10). */
export interface ReplaySummary extends ReplayCounts {
  windowDays: number;
  from: string;
  to: string;
}

export function replaySummary(result: ReplayResult, window: { days: number; from: string; to: string }): ReplaySummary {
  return { windowDays: window.days, from: window.from, to: window.to, ...result.counts };
}

/** Whether a figure read now is the one a replay ran against (P10): both none, or the same to the micro-USDC. */
export function sameFigure(now: number | null, tried: number | null): boolean {
  if (now === null || tried === null) return now === tried;
  return Math.abs(now - tried) < 0.0000005;
}
