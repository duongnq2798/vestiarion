import { unwrap, type OrgDb } from "../dal";
import { parseFigure } from "../usdc-figure";

/**
 * The agent's spending limit (docs/superpowers/specs/2026-10-02-outflow-budget-design.md): what it
 * may pay on its own per UTC day and per 7 days, in USDC. A payment past either is held for a person
 * (`workspace.outflow_budget` in ./guardrails.ts). Only the agent's own payments count (R1).
 */

export interface OutflowBudget {
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
}

/** What the agent has paid on its own, in USDC: today (UTC), and today with the six UTC days before it. */
export interface BudgetSpent {
  today: number;
  week: number;
}

export interface BudgetRoom {
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
  spentToday: number;
  spentThisWeek: number;
  /** What the agent may still pay on its own now: the least either figure leaves, never below zero. */
  remaining: number;
  /** The figure that leaves the least. */
  binding: "day" | "week";
}

/** `execution.heldBecause` on a decision held only for the limit (R6), read by the follow-up stage. */
export const HELD_FOR_BUDGET = "outflow_budget";

/** The agent decisions that can send money (R1). */
export const AGENT_PAYMENT_ACTIONS = ["ap_pay", "milestone_release"] as const;

const DAY_MS = 86_400_000;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function numeric(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What a payment that sent `amountPaid` counts, in USDC (R2): a EURC one at the USDC value its decision weighed. */
export function countedUsdc(amountPaid: number, currency: string | undefined, usdcValue: number | null, amount: number | null): number {
  if (currency !== "EURC") return amountPaid;
  return usdcValue !== null && amount ? round6((amountPaid * usdcValue) / amount) : amountPaid;
}

/**
 * What one ledger entry counts against the limit, in USDC (R1, R2): an agent's `ap_pay` or
 * `milestone_release` that sent money, settled (`paid`) or in flight (`matched`). A EURC payment
 * counts at the USDC value its decision recorded. Anything else counts nothing.
 */
export function agentOutflowUsdc(entry: { actor: string; action: string; detail: Record<string, unknown> }): number {
  if (entry.actor !== "agent") return 0;
  const detail = entry.detail;
  const status = record(detail.execution)?.resultingStatus;
  if (status !== "paid" && status !== "matched") return 0;
  if (entry.action === "milestone_release") return numeric(record(detail.observed)?.amount) ?? 0;
  if (entry.action !== "ap_pay") return 0;
  const paid = numeric(detail.amountPaid);
  if (paid === null) return 0;
  return countedUsdc(paid, typeof detail.currency === "string" ? detail.currency : undefined, numeric(detail.usdcValue), numeric(record(detail.observed)?.amount));
}

/** Where today (UTC) and the 7-day window, today and the six UTC days before it, begin (R3). */
export function budgetWindows(now: Date): { dayStart: string; weekStart: string } {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { dayStart: new Date(day).toISOString(), weekStart: new Date(day - 6 * DAY_MS).toISOString() };
}

/** Whether paying `amountUsdc` now would take the agent past its limit (R4); never with no limit set. */
export function exceedsBudget(amountUsdc: number, room: BudgetRoom | null): room is BudgetRoom {
  return room !== null && amountUsdc > room.remaining + 0.0000005;
}

/** What the limit leaves, or null when no figure is set. */
export function budgetRoom(budget: OutflowBudget | null, spent: BudgetSpent): BudgetRoom | null {
  if (!budget || (budget.dailyUsdc === null && budget.weeklyUsdc === null)) return null;
  const dayLeft = budget.dailyUsdc === null ? Infinity : budget.dailyUsdc - spent.today;
  const weekLeft = budget.weeklyUsdc === null ? Infinity : budget.weeklyUsdc - spent.week;
  const binding = dayLeft <= weekLeft ? "day" : "week";
  return {
    dailyUsdc: budget.dailyUsdc,
    weeklyUsdc: budget.weeklyUsdc,
    spentToday: round6(spent.today),
    spentThisWeek: round6(spent.week),
    remaining: round6(Math.max(0, Math.min(dayLeft, weekLeft))),
    binding,
  };
}

/** The workspace's limit, or null when it has never set one. */
export async function readOutflowBudget(orgDb: OrgDb): Promise<OutflowBudget | null> {
  const rows = unwrap(await orgDb.from("agent_budgets").select("daily_usdc, weekly_usdc").limit(1)) as Array<{
    daily_usdc: string | number | null;
    weekly_usdc: string | number | null;
  }>;
  const row = rows[0];
  return row ? { dailyUsdc: numeric(row.daily_usdc), weeklyUsdc: numeric(row.weekly_usdc) } : null;
}

/** What the agent paid on its own today and in the 7-day window, from its signed decisions (R1, R3). */
export async function agentSpent(orgDb: OrgDb, now: Date): Promise<BudgetSpent> {
  const { dayStart, weekStart } = budgetWindows(now);
  const entries = unwrap(
    await orgDb
      .from("ledger_entries")
      .select("ts, actor, action, detail")
      .eq("actor", "agent")
      .in("action", [...AGENT_PAYMENT_ACTIONS])
      .gte("ts", weekStart)
  ) as Array<{ ts: string; actor: string; action: string; detail: Record<string, unknown> }>;
  const dayFrom = Date.parse(dayStart);
  let today = 0;
  let week = 0;
  for (const entry of entries) {
    const usdc = agentOutflowUsdc(entry);
    if (usdc === 0) continue;
    week += usdc;
    if (Date.parse(entry.ts) >= dayFrom) today += usdc;
  }
  return { today: round6(today), week: round6(week) };
}

/**
 * The limit as one cycle sees it (R5): read once, on first use, then every payment the cycle makes
 * is added, so the next decision sees it. A read that fails throws (R8): the stage fails and nothing
 * is paid past a limit no one could read.
 */
export interface BudgetGate {
  room(): Promise<BudgetRoom | null>;
  spend(usdc: number): void;
}

export function budgetGate(orgDb: OrgDb, now: () => Date = () => new Date()): BudgetGate {
  let loaded: Promise<{ budget: OutflowBudget | null; spent: BudgetSpent }> | null = null;
  let spentThisCycle = 0;
  const load = () =>
    (loaded ??= (async () => {
      const budget = await readOutflowBudget(orgDb);
      if (!budget || (budget.dailyUsdc === null && budget.weeklyUsdc === null)) return { budget: null, spent: { today: 0, week: 0 } };
      return { budget, spent: await agentSpent(orgDb, now()) };
    })());
  return {
    async room() {
      const { budget, spent } = await load();
      return budgetRoom(budget, { today: spent.today + spentThisCycle, week: spent.week + spentThisCycle });
    },
    spend(usdc) {
      if (usdc > 0) spentThisCycle = round6(spentThisCycle + usdc);
    },
  };
}

/** The settings form (R7): each figure optional, the 7-day one no lower than the daily one. */
export function parseBudgetForm(input: { daily: string; weekly: string }): { ok: true; budget: OutflowBudget } | { ok: false; message: string } {
  const daily = parseFigure(input.daily, "daily limit");
  if (!daily.ok) return daily;
  const weekly = parseFigure(input.weekly, "7-day limit");
  if (!weekly.ok) return weekly;
  if (daily.value !== null && weekly.value !== null && weekly.value < daily.value) {
    return { ok: false, message: "The 7-day limit cannot be lower than the daily limit." };
  }
  return { ok: true, budget: { dailyUsdc: daily.value, weeklyUsdc: weekly.value } };
}
