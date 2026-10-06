import { CYCLE_IN_PROGRESS_MS } from "./agent/balances";
import { readSpendingLimitContract, setLimitsOnChain } from "./circle/spending-limit-setup";
import { agentSpent, budgetRoom, parseBudgetForm, readOutflowBudget, type BudgetRoom, type BudgetSpent, type OutflowBudget } from "./agent/outflow-budget";
import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { workspaceNetwork } from "./workspace-network";

/**
 * Setting the agent's spending limit (docs/superpowers/specs/2026-10-02-outflow-budget-design.md R7),
 * and reading it with what the agent has paid against it. Every export runs inside an organization
 * scope; who may change it (`agent.budget`) is the caller's check.
 *
 * It is refused while a cycle is running, as a counterparty's limit is: the cycle read the limit
 * once when it began, so a change in the middle would apply to part of it only.
 *
 * While the limit is enforced on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md R10),
 * the contract is changed first, and the figures are saved only once Circle confirms it; removing both figures is
 * refused then, since the contract always holds one.
 */

export type AgentBudgetErrorCode = "invalid" | "unchanged" | "cycle_running" | "enforced_needs_figure" | "onchain" | "mainnet_needs_figure";

const MESSAGES: Record<Exclude<AgentBudgetErrorCode, "invalid" | "onchain">, string> = {
  unchanged: "That is already the agent's spending limit.",
  cycle_running: "A cycle is running. Try again in a minute, once it has finished.",
  enforced_needs_figure: "Keep a daily or 7-day figure while the limit is enforced on Arc, or turn that off first.",
  mainnet_needs_figure: "A workspace on Arc mainnet keeps a daily or 7-day limit.",
};

export class AgentBudgetError extends Error {
  constructor(
    readonly code: AgentBudgetErrorCode,
    message: string = MESSAGES[code as Exclude<AgentBudgetErrorCode, "invalid" | "onchain">]
  ) {
    super(message);
    this.name = "AgentBudgetError";
  }
}

const NONE: OutflowBudget = { dailyUsdc: null, weeklyUsdc: null };

/** Whether a figure rose or was removed: a payment held under the old limit may fit the new one. */
export function budgetLoosened(from: OutflowBudget, to: OutflowBudget): boolean {
  const looser = (before: number | null, after: number | null) => before !== null && (after === null || after > before);
  return looser(from.dailyUsdc, to.dailyUsdc) || looser(from.weeklyUsdc, to.weeklyUsdc);
}

function describe(budget: OutflowBudget): string {
  const daily = budget.dailyUsdc === null ? "no daily limit" : `${budget.dailyUsdc} USDC a day`;
  const weekly = budget.weeklyUsdc === null ? "no 7-day limit" : `${budget.weeklyUsdc} USDC in 7 days`;
  return `${daily} and ${weekly}`;
}

function summary(from: OutflowBudget, to: OutflowBudget): string {
  const unset = (budget: OutflowBudget) => budget.dailyUsdc === null && budget.weeklyUsdc === null;
  if (unset(from)) return `Set the agent's spending limit to ${describe(to)}`;
  if (unset(to)) return `Removed the agent's spending limit of ${describe(from)}`;
  return `Changed the agent's spending limit from ${describe(from)} to ${describe(to)}`;
}

export async function changeAgentBudget(input: {
  actorId: string;
  daily: string;
  weekly: string;
}): Promise<{ from: OutflowBudget; to: OutflowBudget; loosened: boolean }> {
  const parsed = parseBudgetForm({ daily: input.daily, weekly: input.weekly });
  if (!parsed.ok) throw new AgentBudgetError("invalid", parsed.message);
  const to = parsed.budget;
  // On Arc mainnet the agent always pays within a figure (mainnet go-live M9).
  if (to.dailyUsdc === null && to.weeklyUsdc === null && workspaceNetwork().id === "arc-mainnet") throw new AgentBudgetError("mainnet_needs_figure");

  const from = (await readOutflowBudget(db())) ?? NONE;
  if (from.dailyUsdc === to.dailyUsdc && from.weeklyUsdc === to.weeklyUsdc) throw new AgentBudgetError("unchanged");

  const running = unwrap(
    await db()
      .from("cycle_runs")
      .select("id")
      .eq("status", "running")
      .gt("started_at", new Date(Date.now() - CYCLE_IN_PROGRESS_MS).toISOString())
      .limit(1)
  ) as Array<{ id: string }>;
  if (running.length > 0) throw new AgentBudgetError("cycle_running");

  // The contract first, when the limit is enforced on Arc: the figures are saved only once it holds them (R10).
  let onChain: { contract: string; txHash: string | null } | null = null;
  const contract = await readSpendingLimitContract();
  if (contract?.enforced) {
    if (to.dailyUsdc === null && to.weeklyUsdc === null) throw new AgentBudgetError("enforced_needs_figure");
    try {
      onChain = await setLimitsOnChain(to);
    } catch (error) {
      throw new AgentBudgetError("onchain", error instanceof Error ? error.message : "Circle did not change the figures on the contract. The limit was not changed.");
    }
  }

  // A write that asks for nothing back: only its error says whether it happened.
  const write = await db()
    .from("agent_budgets")
    .upsert(
      { daily_usdc: to.dailyUsdc, weekly_usdc: to.weeklyUsdc, updated_by: input.actorId, updated_at: new Date().toISOString() },
      { onConflict: "org_id" }
    );
  if (write.error) throw new Error(write.error.message);

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "system",
    action: "agent_budget_changed",
    summary: summary(from, to),
    detail: { by: input.actorId, from, to, ...(onChain ? { onChain } : {}) },
  });

  return { from, to, loosened: budgetLoosened(from, to) };
}

export interface AgentBudgetStatus {
  /** Null when the workspace has never set one. */
  budget: OutflowBudget | null;
  /** What the agent paid on its own today and in the last 7 days, limit or not. */
  spent: BudgetSpent;
  /** What the limit leaves now; null with no figure set. */
  room: BudgetRoom | null;
}

/** The limit and what the agent paid against it, for the console. */
export async function agentBudgetStatus(now: Date = new Date()): Promise<AgentBudgetStatus> {
  const [budget, spent] = await Promise.all([readOutflowBudget(db()), agentSpent(db(), now)]);
  return { budget, spent, room: budgetRoom(budget, spent) };
}
