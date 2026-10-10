import { AgentBudgetError } from "./agent-budget";
import { budgetWindows, parseBudgetForm, readOutflowBudget, type OutflowBudget } from "./agent/outflow-budget";
import { ApprovalPolicyError, readTwoApprovalsAbove, unchangedTwoApprovalsMessage } from "./approval-policy";
import { CounterpartyLimitError, parseLimitInput } from "./counterparty-limit";
import { db, unwrap } from "./dal";
import { LEDGER_PAGE_SIZE } from "./ledger";
import {
  replayDecisions,
  replaySummary,
  withCandidate,
  type CantTellReason,
  type ReplayChange,
  type ReplayCounts,
  type ReplayedDecision,
  type ReplayEntry,
  type ReplayResult,
  type ReplaySummary,
  type ReplayVerdict,
  type RuleCandidate,
  type RuleFigures,
  type RuleKind,
} from "./policy-replay";
import { parseTwoApprovalsForm } from "./two-approvals";
import { workspaceNetwork } from "./workspace-network";

/**
 * Trying a rule figure on the workspace's own decisions (docs/superpowers/specs/2026-10-10-policy-replay-design.md):
 * the candidate read with the setting's own parser, the figures in force, the window's agent decisions read in pages,
 * the replay (./policy-replay.ts), and names for what changed. Read-only; every export runs inside an organization
 * scope, and who may try a setting (the permission that changes it) is the caller's check.
 */

export const REPLAY_WINDOWS = [30, 90] as const;
export type ReplayWindow = (typeof REPLAY_WINDOWS)[number];

/** The ledger actions an agent's decision on a bill or a milestone is written as. */
export const DECISION_ACTIONS = ["ap_pay", "ap_schedule", "ap_hold", "ap_flag_fraud", "ap_request_info", "milestone_release", "milestone_hold"] as const;

/** The most pages of 1,000 entries one replay reads (P9). */
export const MAX_REPLAY_PAGES = 20;

/** The most decisions the result lists; the rest are counted. */
export const REPLAY_ROWS_SHOWN = 100;

const DAY_MS = 86_400_000;

export type RuleReplayErrorCode = "invalid" | "unchanged" | "not_found" | "too_many";

export class RuleReplayError extends Error {
  constructor(
    readonly code: RuleReplayErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RuleReplayError";
  }
}

/** What a person asked to try: a setting, its figures as typed in its form, and the window. */
export interface RuleTrialInput {
  rule: RuleKind;
  counterpartyId?: string;
  values: { paymentLimit?: string; above?: string; daily?: string; weekly?: string };
  days: ReplayWindow;
}

/** One decision whose outcome changes, or that the replay cannot tell, as the result lists it. */
export interface RuleReplayRow {
  seq: number;
  /** The UTC day it was decided. */
  date: string;
  source: "bill" | "milestone";
  /** The invoice's memo or the milestone's title; its kind when neither can be read. */
  bill: string;
  counterparty: string;
  amount: number | null;
  currency: "USDC" | "EURC";
  change: Exclude<ReplayChange, "unchanged">;
  /** What code does under the figures in force, and under the candidate, in words. */
  before: string;
  after: string;
}

export interface RuleReplayView {
  rule: RuleKind;
  /** The setting, in words: "Northwind Supplies' payment limit". */
  setting: string;
  /** The figure in force and the candidate, in words. */
  from: string;
  to: string;
  /** What Apply posts back with the form: the window, and the figure in force when the replay ran (P10). */
  apply: Record<string, string>;
  windowDays: ReplayWindow;
  windowFrom: string;
  windowTo: string;
  counts: ReplayCounts;
  rows: RuleReplayRow[];
  /** How many more decisions changed, or could not be told, than the list shows. */
  more: number;
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const usdc = (value: number) => `${AMOUNT.format(value)} USDC`;
const figureField = (value: number | null) => (value === null ? "" : String(value));
const numeric = (value: string | number | null | undefined) => (value == null || value === "" ? null : Number(value));

/** The rule that stops a payment, in a few words (P8). */
const RULE_WORDS: Record<string, string> = {
  "counterparty.payment_limit": "above the payment limit",
  "workspace.two_approvals": "needs two people's approval",
  "workspace.outflow_budget": "past the agent's spending limit",
  "counterparty.high_risk": "screened high risk",
  "counterparty.unscreened": "not screened yet",
  "counterparty.client_payable": "the counterparty is a client",
  "counterparty.no_address": "no payment address",
  "counterparty.address_unconfirmed": "address not confirmed",
  "counterparty.new_payee": "first payment to an address one person stands behind",
  "invoice.duplicate_of_settled": "repeats a bill already paid",
  "invoice.match_incomplete": "three-way match incomplete",
  "fx.rate_unavailable": "no EURC rate",
  "fx.swap_cost_above_cap": "the EURC swap costs too much",
  "fx.swap_usdc_short": "the EURC swap leaves too little USDC",
  "treasury.insufficient_eurc": "not enough EURC",
  "bridge.unsupported_token": "EURC cannot cross chains",
  "bridge.fee_unavailable": "no cross-chain fee",
  "bridge.fee_above_cap": "the cross-chain fee is too high",
  "bridge.gateway_balance_short": "the Gateway balance is short",
  "workspace.onchain_limit_route": "the spending-limit contract on Arc cannot carry it",
  "workspace.onchain_limit": "the spending-limit contract on Arc refuses it",
};

/** Why a decision cannot be told, in a few words (P7). */
const CANT_TELL_WORDS: Record<CantTellReason, string> = {
  facts_missing: "its entry lacks the amount or the decision",
  rule_unknown: "its entry names no rule this replay knows",
  risk_missing: "its entry has no risk level",
  stage_unsettled: "it reaches a check its entry does not settle",
  budget_unsettled: "the spending limit depends on a decision it cannot tell",
  contract_unsettled: "the contract on Arc, under other figures",
  earlier_unsettled: "an earlier decision on it cannot be told",
};

function verdictWords(verdict: ReplayVerdict, source: "bill" | "milestone", action: string): string {
  switch (verdict.kind) {
    case "goes_ahead":
      return source === "milestone" ? "The agent releases it" : action === "ap_schedule" ? "The agent schedules it" : "The agent pays it";
    case "paid_earlier":
      return "Paid by an earlier decision";
    case "stopped":
      return `Held: ${RULE_WORDS[verdict.rule] ?? verdict.rule}`;
    case "agent_held":
      return "The agent chose not to pay it";
    case "cant_tell":
      return `Can't tell: ${CANT_TELL_WORDS[verdict.because]}`;
  }
}

function spendingLimitWords(budget: OutflowBudget): string {
  if (budget.dailyUsdc === null && budget.weeklyUsdc === null) return "No limit";
  const daily = budget.dailyUsdc === null ? "no daily limit" : `${usdc(budget.dailyUsdc)} a day`;
  const weekly = budget.weeklyUsdc === null ? "no 7-day limit" : `${usdc(budget.weeklyUsdc)} in 7 days`;
  return `${daily}, ${weekly}`;
}

/** The setting a trial changes: its candidate, and the words and fields the result shows and Apply posts. */
export interface TrialSetting {
  candidate: RuleCandidate;
  setting: string;
  from: string;
  to: string;
  apply: Record<string, string>;
}

/** Each counterparty's name and role, by id. */
export type CounterpartyNames = Map<string, { name: string; role: string }>;

/** The candidate, read with the setting's own parser, against the figures in force; refused as Save would refuse it. */
export function trialSetting(input: RuleTrialInput, current: RuleFigures, names: CounterpartyNames): TrialSetting {
  const replayDays = String(input.days);
  switch (input.rule) {
    case "counterparty_limit": {
      const id = input.counterpartyId ?? "";
      const counterparty = names.get(id);
      if (!counterparty) throw new RuleReplayError("not_found", new CounterpartyLimitError("not_found").message);
      const parsed = parseLimitInput(input.values.paymentLimit ?? "", counterparty.role);
      if (!parsed.ok) throw new RuleReplayError("invalid", parsed.message);
      const from = current.counterpartyLimits[id] ?? null;
      const to = numeric(parsed.limit);
      if (from === to) throw new RuleReplayError("unchanged", new CounterpartyLimitError("unchanged").message);
      return {
        candidate: { kind: "counterparty_limit", counterpartyId: id, limit: to },
        setting: `${counterparty.name}'s payment limit`,
        from: from === null ? "No limit" : usdc(from),
        to: to === null ? "No limit" : usdc(to),
        apply: { replayDays, expectedLimit: figureField(from) },
      };
    }
    case "two_approvals": {
      const parsed = parseTwoApprovalsForm(input.values.above ?? "");
      if (!parsed.ok) throw new RuleReplayError("invalid", parsed.message);
      if (parsed.above === null && workspaceNetwork().id === "arc-mainnet") {
        throw new RuleReplayError("invalid", new ApprovalPolicyError("mainnet_keeps_figure").message);
      }
      const from = current.twoApprovalsAbove;
      if (from === parsed.above) throw new RuleReplayError("unchanged", unchangedTwoApprovalsMessage(parsed.above));
      return {
        candidate: { kind: "two_approvals", above: parsed.above },
        setting: "Two approvals above a figure",
        from: from === null ? "Off" : `Above ${usdc(from)}`,
        to: parsed.above === null ? "Off" : `Above ${usdc(parsed.above)}`,
        apply: { replayDays, expectedAbove: figureField(from) },
      };
    }
    case "spending_limit": {
      const parsed = parseBudgetForm({ daily: input.values.daily ?? "", weekly: input.values.weekly ?? "" });
      if (!parsed.ok) throw new RuleReplayError("invalid", parsed.message);
      const to = parsed.budget;
      if (to.dailyUsdc === null && to.weeklyUsdc === null && workspaceNetwork().id === "arc-mainnet") {
        throw new RuleReplayError("invalid", new AgentBudgetError("mainnet_needs_figure").message);
      }
      const from = current.spendingLimit;
      if (from.dailyUsdc === to.dailyUsdc && from.weeklyUsdc === to.weeklyUsdc) throw new RuleReplayError("unchanged", new AgentBudgetError("unchanged").message);
      return {
        candidate: { kind: "spending_limit", dailyUsdc: to.dailyUsdc, weeklyUsdc: to.weeklyUsdc },
        setting: "Agent spending limit",
        from: spendingLimitWords(from),
        to: spendingLimitWords(to),
        apply: { replayDays, expectedDaily: figureField(from.dailyUsdc), expectedWeekly: figureField(from.weeklyUsdc) },
      };
    }
  }
}

/** The agent's decisions from `since` on, oldest first, in pages; refused past `MAX_REPLAY_PAGES` (P9). */
async function readDecisions(since: string): Promise<ReplayEntry[]> {
  const entries: ReplayEntry[] = [];
  let after = 0;
  for (let page = 0; ; page++) {
    if (page === MAX_REPLAY_PAGES) {
      throw new RuleReplayError("too_many", "This window holds too many decisions to try at once. Try the last 30 days.");
    }
    const rows = unwrap(
      await db()
        .from("ledger_entries")
        .select("seq, ts, action, detail")
        .eq("actor", "agent")
        .in("action", [...DECISION_ACTIONS])
        .gte("ts", since)
        .gt("seq", after)
        .order("seq", { ascending: true })
        .limit(LEDGER_PAGE_SIZE)
    ) as ReplayEntry[];
    entries.push(...rows);
    if (rows.length < LEDGER_PAGE_SIZE) return entries;
    after = rows[rows.length - 1].seq;
  }
}

interface Replayed {
  setting: TrialSetting;
  result: ReplayResult;
  entries: ReplayEntry[];
  names: CounterpartyNames;
  window: ReplayWindowSpan;
}

export interface ReplayWindowSpan {
  days: ReplayWindow;
  from: string;
  to: string;
}

/** The window ending `now`. */
export function windowSpan(days: ReplayWindow, now: Date): ReplayWindowSpan {
  return { days, from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() };
}

async function replay(input: RuleTrialInput, now: Date): Promise<Replayed> {
  const [counterparties, twoApprovalsAbove, budget] = await Promise.all([
    db().from("counterparties").select("id, name, role, baseline_payment_limit"),
    readTwoApprovalsAbove(db()),
    readOutflowBudget(db()),
  ]);
  const rows = unwrap(counterparties) as Array<{ id: string; name: string; role: string; baseline_payment_limit: string | number | null }>;
  const names = new Map(rows.map((row) => [row.id, { name: row.name, role: row.role }]));
  const current: RuleFigures = {
    counterpartyLimits: Object.fromEntries(rows.map((row) => [row.id, numeric(row.baseline_payment_limit)])),
    twoApprovalsAbove,
    spendingLimit: budget ?? { dailyUsdc: null, weeklyUsdc: null },
  };
  const setting = trialSetting(input, current, names);

  const window = windowSpan(input.days, now);
  // The spending limit's 7 days reach back six UTC days before the window's first day (P6).
  const entries = await readDecisions(budgetWindows(new Date(window.from)).weekStart);
  const result = replayDecisions(entries, { windowStart: window.from, current, candidate: withCandidate(current, setting.candidate) });
  return { setting, result, entries, names, window };
}

/** What the result lists: what changed first, then what it cannot tell, each in ledger order, up to `REPLAY_ROWS_SHOWN`. */
export function listedDecisions(result: ReplayResult): { shown: ReplayedDecision[]; more: number } {
  const listed = [
    ...result.decisions.filter((decision) => decision.change !== "unchanged" && decision.change !== "cant_tell"),
    ...result.decisions.filter((decision) => decision.change === "cant_tell"),
  ];
  const shown = listed.slice(0, REPLAY_ROWS_SHOWN);
  return { shown, more: listed.length - shown.length };
}

/** The result as the setting's form shows it. Pure: the names come from the caller. */
export function replayView(input: {
  rule: RuleKind;
  setting: TrialSetting;
  result: ReplayResult;
  window: ReplayWindowSpan;
  /** Each decision's ledger action, by sequence. */
  actions: Map<number, string>;
  names: CounterpartyNames;
  /** Invoice memos and milestone titles, by id. */
  memos: Map<string, string | null>;
  titles: Map<string, string>;
}): RuleReplayView {
  const { setting, result, window, actions, names, memos, titles } = input;
  const { shown, more } = listedDecisions(result);
  return {
    rule: input.rule,
    setting: setting.setting,
    from: setting.from,
    to: setting.to,
    apply: setting.apply,
    windowDays: window.days,
    windowFrom: window.from,
    windowTo: window.to,
    counts: result.counts,
    rows: shown.map((decision) => {
      const action = actions.get(decision.seq) ?? "";
      const named = decision.sourceId ? (decision.source === "bill" ? memos.get(decision.sourceId) : titles.get(decision.sourceId)) : null;
      return {
        seq: decision.seq,
        date: new Date(Date.parse(decision.ts)).toISOString().slice(0, 10),
        source: decision.source,
        bill: named?.trim() || (decision.source === "bill" ? "Invoice" : "Milestone"),
        counterparty: (decision.counterpartyId ? names.get(decision.counterpartyId)?.name : null) ?? "A counterparty no longer here",
        amount: decision.amount,
        currency: decision.currency,
        change: decision.change as Exclude<ReplayChange, "unchanged">,
        before: verdictWords(decision.before, decision.source, action),
        after: verdictWords(decision.after, decision.source, action),
      };
    }),
    more,
  };
}

/** The replay of a candidate figure, for the setting's form to show (P8). */
export async function ruleReplay(input: RuleTrialInput, now: Date = new Date()): Promise<RuleReplayView> {
  const { setting, result, entries, names, window } = await replay(input, now);
  const { shown } = listedDecisions(result);
  const billIds = [...new Set(shown.filter((d) => d.source === "bill" && d.sourceId).map((d) => d.sourceId as string))];
  const milestoneIds = [...new Set(shown.filter((d) => d.source === "milestone" && d.sourceId).map((d) => d.sourceId as string))];
  const [invoices, milestones] = await Promise.all([
    billIds.length > 0 ? db().from("invoices").select("id, memo").in("id", billIds) : null,
    milestoneIds.length > 0 ? db().from("milestones").select("id, title").in("id", milestoneIds) : null,
  ]);
  return replayView({
    rule: input.rule,
    setting,
    result,
    window,
    actions: new Map(entries.map((entry) => [entry.seq, entry.action])),
    names,
    memos: new Map((invoices ? (unwrap(invoices) as Array<{ id: string; memo: string | null }>) : []).map((row) => [row.id, row.memo])),
    titles: new Map((milestones ? (unwrap(milestones) as Array<{ id: string; title: string }>) : []).map((row) => [row.id, row.title])),
  });
}

/** The replay's summary, for the signed entry of the change applied after it (P10): computed here, never taken from a form. */
export async function replayForApply(input: RuleTrialInput, now: Date = new Date()): Promise<ReplaySummary> {
  const { result, window } = await replay(input, now);
  return replaySummary(result, window);
}

/**
 * A setting's form as a trial: its figure fields, the counterparty, and the window (`days` when trying it, `replayDays`
 * when applying it). `rule` names the setting when the form does not; null for a setting or window it does not know.
 */
export function trialFromForm(formData: FormData, rule?: RuleKind): RuleTrialInput | null {
  const text = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : undefined;
  };
  rule ??= text("rule") as RuleKind | undefined;
  if (rule !== "counterparty_limit" && rule !== "two_approvals" && rule !== "spending_limit") return null;
  const days = Number(text("days") ?? text("replayDays") ?? "30");
  if (!(REPLAY_WINDOWS as readonly number[]).includes(days)) return null;
  return {
    rule,
    counterpartyId: text("counterpartyId"),
    values: { paymentLimit: text("paymentLimit"), above: text("above"), daily: text("daily"), weekly: text("weekly") },
    days: days as ReplayWindow,
  };
}
