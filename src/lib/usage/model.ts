/**
 * What a workspace used, and what stops when a limit is reached
 * (docs/superpowers/specs/2026-10-13-accountant-console-design.md U1 to U4). Pure: the reading and the recording are in
 * `read.ts` and `record.ts`.
 *
 * Attribution and display only. Nothing here charges anyone or stops anything: the limits it lists are the ones the
 * product already enforces elsewhere, said where people look, with who must act.
 */

export const USAGE_KINDS = ["model_call", "circle_transfer", "x402_purchase", "email", "connector_sync"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** A cost in its own currency: USD for a model's price, USDC (or EURC) for what was paid on Arc. Never converted. */
export const COST_CURRENCIES = ["USD", "USDC", "EURC"] as const;
export type CostCurrency = (typeof COST_CURRENCIES)[number];

export const KIND_LABELS: Record<UsageKind, { title: string; unit: [string, string] }> = {
  model_call: { title: "Model calls", unit: ["call", "calls"] },
  circle_transfer: { title: "Circle transfers", unit: ["transfer", "transfers"] },
  x402_purchase: { title: "x402 purchases", unit: ["purchase", "purchases"] },
  email: { title: "Emails", unit: ["email", "emails"] },
  connector_sync: { title: "Connector syncs", unit: ["sync", "syncs"] },
};

/** The words a row's `action` is shown with; anything else is shown as it is, with underscores as spaces. */
export const ACTION_LABELS: Record<string, string> = {
  decision: "Payment and treasury decisions",
  payable: "Bill decisions",
  milestone: "Milestone decisions",
  treasury: "Treasury",
  proposal: "Limit proposals",
  reminder: "Payment reminders",
  extraction: "Reading invoice documents",
  chat: "Chat messages",
  payment: "Payments",
  payment_batch: "Batched payments",
  swap: "Currency swaps",
  gateway: "Gateway funding",
  payee_history: "Payee history checks",
  invitation: "Invitations",
  digest: "Waiting decisions",
  escalation: "Escalations",
  stuck_payment: "Stuck payment alerts",
  payment_notice: "Payment notices",
  freelancer: "Freelancer setup",
  payee_address: "Payee address requests",
  customer_wrote: "Customer messages",
  xero: "Xero",
  quickbooks: "QuickBooks",
  hubspot: "HubSpot",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll("_", " ");
}

/** One row as `usage_events` keeps it, the columns the summary reads. */
export interface UsageRow {
  kind: UsageKind;
  action: string;
  quantity: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: string | number | null;
  cost_currency: CostCurrency | null;
  ok: boolean;
}

export interface CostTotal {
  currency: CostCurrency;
  /** A decimal string with up to six places, summed exactly. */
  amount: string;
}

export interface UsageLine {
  action: string;
  count: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** One total per currency, never added across currencies. */
  costs: CostTotal[];
  /** How many of `count` had no cost recorded: a provider that reported no usage, or a price nobody set. */
  costUnknown: number;
}

export interface UsageKindSummary extends UsageLine {
  kind: UsageKind;
  lines: UsageLine[];
}

export interface UsageSummary {
  kinds: UsageKindSummary[];
  /** True when more rows were recorded than were read: every figure is then a floor. */
  partial: boolean;
}

/** Six decimal places, as `numeric(20, 6)` keeps them, in integer millionths: exact sums without floating point. */
export function toMicros(value: string | number): number {
  const text = typeof value === "number" ? value.toFixed(6) : value.trim();
  const match = /^(\d+)(?:\.(\d{0,6})\d*)?$/.exec(text);
  if (!match) return 0;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
}

export function fromMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, "0");
  return `${whole}.${fraction}`;
}

/** A cost for display: at least two places, more only where the figure needs them (a model call costs fractions of a cent). */
export function costWords(cost: CostTotal): string {
  const [whole, fraction = ""] = cost.amount.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const shown = trimmed.length <= 2 ? fraction.slice(0, 2).padEnd(2, "0") : trimmed;
  const grouped = Number(whole).toLocaleString("en-US");
  return cost.currency === "USD" ? `$${grouped}.${shown}` : `${grouped}.${shown} ${cost.currency}`;
}

type Totals = Omit<UsageLine, "action">;

function emptyTotals(): Totals & { micros: Map<CostCurrency, number> } {
  return { count: 0, failed: 0, inputTokens: 0, outputTokens: 0, costs: [], costUnknown: 0, micros: new Map() };
}

function add(totals: ReturnType<typeof emptyTotals>, row: UsageRow): void {
  const quantity = Math.max(1, row.quantity ?? 1);
  totals.count += quantity;
  if (!row.ok) totals.failed += quantity;
  totals.inputTokens += row.input_tokens ?? 0;
  totals.outputTokens += row.output_tokens ?? 0;
  if (row.cost !== null && row.cost !== undefined && row.cost_currency) {
    totals.micros.set(row.cost_currency, (totals.micros.get(row.cost_currency) ?? 0) + toMicros(row.cost));
  } else {
    totals.costUnknown += quantity;
  }
}

function settle(totals: ReturnType<typeof emptyTotals>): Totals {
  const { micros, ...rest } = totals;
  const costs = COST_CURRENCIES.filter((currency) => micros.has(currency)).map((currency) => ({ currency, amount: fromMicros(micros.get(currency) ?? 0) }));
  return { ...rest, costs };
}

/** This month's rows, by kind and then by what they were for, in the order of `USAGE_KINDS`; kinds with no rows are kept, at zero. */
export function summarizeUsage(rows: readonly UsageRow[], partial = false): UsageSummary {
  const kinds = USAGE_KINDS.map((kind) => {
    const ofKind = rows.filter((row) => row.kind === kind);
    const total = emptyTotals();
    const byAction = new Map<string, ReturnType<typeof emptyTotals>>();
    for (const row of ofKind) {
      add(total, row);
      const line = byAction.get(row.action) ?? emptyTotals();
      add(line, row);
      byAction.set(row.action, line);
    }
    const lines = [...byAction.entries()]
      .map(([action, line]) => ({ action, ...settle(line) }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action));
    return { kind, action: kind, ...settle(total), lines };
  });
  return { kinds, partial };
}

/** The calendar month (UTC) `now` falls in: its first instant, the next month's first instant, and its name. */
export function monthOf(now: Date): { from: string; to: string; label: string; key: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(from);
  return { from: from.toISOString(), to: to.toISOString(), label, key: from.toISOString().slice(0, 7) };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Model prices (U2)                                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

/** US dollars per million tokens, input and output. */
export interface TokenPrice {
  input: number;
  output: number;
}

/**
 * Anthropic's list prices for the Claude models the agent may be set to, per million tokens. Any other model's cost
 * stays unknown unless the deployment names its price in `AGENT_LLM_PRICES`, which also overrides these.
 */
export const CLAUDE_PRICES: Record<string, TokenPrice> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * `AGENT_LLM_PRICES`: `model=input/output` pairs, comma separated, in US dollars per million tokens, such as
 * `deepseek-chat=0.28/0.42,gpt-5=1.25/10`. An entry that does not read is left out, never guessed.
 */
export function parseModelPrices(raw: string | undefined): Record<string, TokenPrice> {
  const prices: Record<string, TokenPrice> = {};
  for (const entry of (raw ?? "").split(",")) {
    const match = /^\s*([A-Za-z0-9._:/-]{1,80})\s*=\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(entry);
    if (match) prices[match[1]] = { input: Number(match[2]), output: Number(match[3]) };
  }
  return prices;
}

/** What a model call cost in US dollars, to the millionth, or null when its tokens or its price are not known. */
export function modelCallCost(
  model: string | null | undefined,
  tokens: { input: number | null; output: number | null } | null,
  prices: Record<string, TokenPrice> = {}
): string | null {
  if (!model || !tokens || tokens.input === null || tokens.output === null) return null;
  const price = prices[model] ?? CLAUDE_PRICES[model];
  if (!price) return null;
  const dollars = (tokens.input * price.input + tokens.output * price.output) / 1_000_000;
  return fromMicros(Math.round(dollars * 1_000_000));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Limits (U3): what stops, and who must act                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

export type LimitState = "ok" | "near" | "reached";

export interface UsageLimit {
  key: "sandbox_cycles" | "agent_budget" | "service_budget" | "invitations" | "connector";
  title: string;
  /** e.g. "14 of 20 today". */
  used: string;
  state: LimitState;
  /** What stops when it is reached, said whatever the state, so nobody learns it by surprise. */
  stops: string;
  /** Who acts, and what they do. */
  who: string;
  /** The workspace page where they do it, relative to the workspace. */
  path: string;
}

export interface LimitFacts {
  mode: "sandbox" | "live";
  /** Cycles started today (UTC), and the cap a sandbox has; null where it could not be read. */
  cyclesToday: number | null;
  sandboxCap: number;
  /** The agent's spending limit: what the limit leaves, or null with no figure set (or unread). */
  budget: { remaining: number; binding: "day" | "week"; dailyUsdc: number | null; weeklyUsdc: number | null; spentToday: number; spentThisWeek: number } | null;
  /** The payee history checks' daily most and Gateway balance; null with no Gateway signer. */
  service: { spentToday: number; dailyCapUsdc: number; balanceUsdc: number | null; maxPriceUsdc: number } | null;
  /** Invitations created in the last 24 hours, and the most a day allows; null where unread. */
  invitationsToday: number | null;
  invitationCap: number;
  /** A connector whose status needs a person (needs reconnecting, or its last sync failed). */
  connectors: Array<{ provider: "xero" | "quickbooks" | "hubspot"; title: string }>;
}

const NEAR = 0.8;

function stateOf(used: number, cap: number): LimitState {
  if (cap <= 0) return "reached";
  if (used >= cap) return "reached";
  return used / cap >= NEAR ? "near" : "ok";
}

function usdc(value: number): string {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
}

const PROVIDER_NAMES = { xero: "Xero", quickbooks: "QuickBooks", hubspot: "HubSpot" } as const;

/** Each limit the workspace can hit, reached ones first, then near, then the rest. */
export function usageLimits(facts: LimitFacts): UsageLimit[] {
  const limits: UsageLimit[] = [];
  if (facts.mode === "sandbox" && facts.cyclesToday !== null) {
    limits.push({
      key: "sandbox_cycles",
      title: "Agent cycles today",
      used: `${Math.min(facts.cyclesToday, facts.sandboxCap)} of ${facts.sandboxCap} today`,
      state: stateOf(facts.cyclesToday, facts.sandboxCap),
      stops: "A sandbox runs at most this many cycles a day (UTC). Past it, Run cycle and the cycles that events start do nothing until midnight UTC.",
      who: "Nobody needs to act: it starts again at midnight UTC. An owner can take the workspace live, where the schedule runs it instead.",
      path: "/console",
    });
  }
  if (facts.budget) {
    const { binding, remaining } = facts.budget;
    const figure = binding === "day" ? facts.budget.dailyUsdc : facts.budget.weeklyUsdc;
    const spent = binding === "day" ? facts.budget.spentToday : facts.budget.spentThisWeek;
    limits.push({
      key: "agent_budget",
      title: "Agent spending limit",
      used: figure === null ? usdc(spent) : `${usdc(spent)} of ${usdc(figure)} ${binding === "day" ? "today" : "this week"}`,
      state: figure === null ? "ok" : remaining <= 0 ? "reached" : stateOf(spent, figure),
      stops: "Past it, the agent pays nothing on its own: each payment waits in Approvals for a person, held for the limit.",
      who: "An owner or admin raises the limit on the console, or an owner, admin or approver pays the held bills in Approvals.",
      path: "/console#agent-budget",
    });
  }
  if (facts.service) {
    const { spentToday, dailyCapUsdc, balanceUsdc, maxPriceUsdc } = facts.service;
    const purseShort = balanceUsdc !== null && balanceUsdc < maxPriceUsdc;
    limits.push({
      key: "service_budget",
      title: "Payee history checks (x402)",
      used: `${usdc(spentToday)} of ${usdc(dailyCapUsdc)} today`,
      state: purseShort ? "reached" : stateOf(spentToday, dailyCapUsdc),
      stops: purseShort
        ? "The Gateway balance is below one check's price, so the agent buys no payee history: it decides without it."
        : "Past the daily most, the agent buys no more payee history today: it decides without it.",
      who: purseShort ? "An owner or admin funds the Gateway balance in Treasury." : "Nobody needs to act: it starts again at midnight UTC.",
      path: "/console",
    });
  }
  if (facts.invitationsToday !== null) {
    limits.push({
      key: "invitations",
      title: "Invitations",
      used: `${Math.min(facts.invitationsToday, facts.invitationCap)} of ${facts.invitationCap} in the last 24 hours`,
      state: stateOf(facts.invitationsToday, facts.invitationCap),
      stops: "Past it, no new invitation is sent until the oldest of the day is 24 hours old. Withdrawn ones count.",
      who: "Nobody needs to act: wait for the day to pass. Members already in the workspace are not affected.",
      path: "/members",
    });
  }
  for (const connector of facts.connectors) {
    limits.push({
      key: "connector",
      title: PROVIDER_NAMES[connector.provider],
      used: connector.title,
      state: "reached",
      stops: `Nothing new comes in from ${PROVIDER_NAMES[connector.provider]} and nothing is written to it until it works again.`,
      who: `An owner or admin reconnects ${PROVIDER_NAMES[connector.provider]} in Settings.`,
      path: `/settings#${connector.provider}`,
    });
  }
  const order: Record<LimitState, number> = { reached: 0, near: 1, ok: 2 };
  return limits.sort((a, b) => order[a.state] - order[b.state]);
}
