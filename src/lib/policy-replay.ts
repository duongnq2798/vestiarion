import { agentOutflowUsdc, budgetRoom, exceedsBudget, type OutflowBudget } from "./agent/outflow-budget";
import { paymentLimitForRisk } from "./compliance";
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
  before: ReplayVerdict;
  after: ReplayVerdict;
  change: ReplayChange;
}

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
  "invoice.match_incomplete",
  "counterparty.new_payee",
  "fx.rate_unavailable",
  LIMIT,
  "bridge.unsupported_token",
  "bridge.fee_unavailable",
  "bridge.fee_above_cap",
  "bridge.gateway_balance_short",
  TWO_APPROVALS_RULE,
  BUDGET,
  ROUTE,
  CONTRACT,
  "fx.swap_cost_above_cap",
  "fx.swap_usdc_short",
  "treasury.insufficient_eurc",
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
  shadow: boolean;
  crossChain: boolean;
  live: boolean;
  /** The spending-limit contract's check, as recorded; undefined when none was recorded. */
  contract: Record<string, unknown> | undefined;
  /** The spending limit's figures the decision was weighed against; null with none set. */
  recordedBudget: OutflowBudget | null;
  newPayee: { twoParties: boolean } | null;
  /** The entry has what any replay needs: an amount and a decision. */
  complete: boolean;
}

function factsOf(entry: ReplayEntry): Facts | null {
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
    shadow: detail.shadow === true,
    crossChain: record(detail.payout) !== null,
    live: execution?.chainMode === "live",
    contract: record(detail.onChainLimit) ?? undefined,
    recordedBudget: budget ? { dailyUsdc: numeric(budget.dailyUsdc), weeklyUsdc: numeric(budget.weeklyUsdc) } : null,
    newPayee: newPayee ? { twoParties: newPayee.twoParties === true } : null,
    complete: observed !== null && amount !== null && action !== null,
  };
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
  around(day: number): { low: { today: number; week: number }; high: { today: number; week: number } } {
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
  if (EURC_FUNDING.has(stage)) return facts.currency === "EURC" ? { cantTell: "stage_unsettled" } : "passes";
  if (stage === ROUTE || stage === CONTRACT) {
    // A sandbox has no contract. A bill's check is asked before its checks run, so none recorded means none enforced;
    // a release's is asked only once its earlier checks pass, so none recorded says nothing.
    if (!facts.live) return "passes";
    if (facts.contract === undefined && facts.source === "milestone") return { cantTell: "stage_unsettled" };
    return contractAnswer(stage, facts, figures);
  }
  if (stage === "counterparty.new_payee") return facts.newPayee && !facts.newPayee.twoParties ? "fires" : "passes";
  return { cantTell: "stage_unsettled" };
}

function figureAnswer(stage: string, facts: Facts, column: Column): StageAnswer {
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
  const spent = column.spend.around(facts.day);
  const atLow = exceedsBudget(amount, budgetRoom(figures.spendingLimit, spent.low));
  const atHigh = exceedsBudget(amount, budgetRoom(figures.spendingLimit, spent.high));
  if (atLow !== atHigh) return { cantTell: "budget_unsettled" };
  return atLow ? "fires" : "passes";
}

function sourceKey(facts: Facts): string | null {
  return facts.sourceId === null ? null : `${facts.source}:${facts.sourceId}`;
}

/** What code does with one decision in one column. */
function verdictIn(facts: Facts, column: Column): ReplayVerdict {
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
    if (FIGURE_STAGES.has(stage)) answer = figureAnswer(stage, facts, column);
    else if (index < recorded) answer = "passes";
    else if (index === recorded) answer = stage === CONTRACT ? contractAnswer(stage, facts, column.figures) : "fires";
    else answer = settleFromFacts(stage, facts, column.figures);
    if (answer === "fires") return { kind: "stopped", rule: stage };
    if (answer !== "passes") return { kind: "cant_tell", because: answer.cantTell };
  }
  return { kind: "goes_ahead" };
}

/**
 * What a decision the column let through has the agent paying (P6): what it paid if it paid; nothing if something other
 * than a rule stopped it then, or in shadow mode; its full USDC value if a rule stopped it then.
 */
function spendOf(facts: Facts): number {
  if (!facts.now || facts.shadow) return 0;
  if (facts.paidUsdc > 0) return facts.paidUsdc;
  if (facts.recordedRule === null) return 0;
  return facts.amountUsdc ?? Infinity;
}

/** The most a decision the column cannot tell may have the agent paying. */
function mostSpendOf(facts: Facts): number {
  if (facts.paidUsdc > 0) return facts.paidUsdc;
  if (facts.action !== null && (!facts.now || facts.shadow)) return 0;
  if (facts.action !== null && facts.recordedRule === null) return 0;
  return facts.amountUsdc ?? Infinity;
}

function settle(facts: Facts, verdict: ReplayVerdict, column: Column): void {
  const key = sourceKey(facts);
  if (verdict.kind === "goes_ahead") {
    const spent = spendOf(facts);
    column.spend.add(facts.day, spent, spent);
    if (spent > 0 && key !== null) column.paid.set(key, facts.seq);
  } else if (verdict.kind === "cant_tell") {
    const most = mostSpendOf(facts);
    column.spend.add(facts.day, 0, most);
    if (most > 0 && key !== null) column.unsettled.add(key);
  }
}

const ahead = (verdict: ReplayVerdict) => verdict.kind === "goes_ahead" || verdict.kind === "paid_earlier";

function changeOf(before: ReplayVerdict, after: ReplayVerdict): ReplayChange {
  if (before.kind === "cant_tell" || after.kind === "cant_tell") return "cant_tell";
  if (ahead(before) === ahead(after)) return "unchanged";
  if (!ahead(before)) return "now_paid";
  return after.kind === "stopped" && after.rule === TWO_APPROVALS_RULE ? "now_two_people" : "now_held";
}

/**
 * Every decision in the window, in ledger order, with what code does under the figures in force (`current`) and under
 * the candidate's (P3). Entries before `windowStart` count only what they paid, as recorded, toward the spending limit's
 * running totals (P6); the caller passes the six days before the window for that.
 */
export function replayDecisions(entries: ReplayEntry[], options: { windowStart: string; current: RuleFigures; candidate: RuleFigures }): ReplayResult {
  const from = Date.parse(options.windowStart);
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

  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    const facts = factsOf(entry);
    if (!facts) continue;
    if (Date.parse(entry.ts) < from) {
      // Before the window: what it paid, as recorded, in both columns.
      before.spend.add(facts.day, facts.paidUsdc, facts.paidUsdc);
      after.spend.add(facts.day, facts.paidUsdc, facts.paidUsdc);
      continue;
    }
    const was = verdictIn(facts, before);
    const would = verdictIn(facts, after);
    settle(facts, was, before);
    settle(facts, would, after);
    const change = changeOf(was, would);
    counts.decisions += 1;
    counts[COUNT_KEY[change]] += 1;
    decisions.push({
      seq: facts.seq,
      ts: facts.ts,
      source: facts.source,
      sourceId: facts.sourceId,
      counterpartyId: facts.counterpartyId,
      amount: facts.amount,
      currency: facts.currency,
      amountUsdc: facts.amountUsdc,
      before: was,
      after: would,
      change,
    });
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
