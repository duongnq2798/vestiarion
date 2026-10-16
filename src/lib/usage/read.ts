import { agentBudgetStatus } from "../agent-budget";
import { SERVICE_DAILY_CAP_USDC, SERVICE_MAX_PRICE_USDC } from "../agent/services";
import { SANDBOX_DAILY_CYCLES } from "../agent/sandbox-cap";
import { connectionStatus } from "../connectors/status";
import { PROVIDER_LABELS } from "../connectors/provider";
import { db, platformDb, type OrgDb } from "../dal";
import { readServiceBudget } from "../service-budget";
import { monthOf, summarizeUsage, usageLimits, type LimitFacts, type UsageLimit, type UsageRow, type UsageSummary } from "./model";

/**
 * Reading what a workspace used this month and where it stands against its limits
 * (docs/superpowers/specs/2026-10-13-accountant-console-design.md U3, U4). Every read runs in the workspace's own scope,
 * through its tenant client; the one platform read, the invitations of the last day, is filtered by the workspace in
 * scope. Each part is best effort: one that cannot be read is left out, and says so, never failing the page.
 */

const PAGE = 1000;
/** Past this many rows a month's figures are floors, and say so. */
const MAX_PAGES = 20;

export type UsageMonthView =
  | { available: false; month: ReturnType<typeof monthOf> }
  | { available: true; month: ReturnType<typeof monthOf>; summary: UsageSummary };

function notSetUp(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

export async function readUsageMonth(orgDb: OrgDb = db(), now: Date = new Date()): Promise<UsageMonthView> {
  const month = monthOf(now);
  const rows: UsageRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await orgDb
      .from("usage_events")
      .select("kind, action, quantity, input_tokens, output_tokens, cost, cost_currency, ok")
      .gte("occurred_at", month.from)
      .lt("occurred_at", month.to)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    // Before migration 0112 there is no table: the panel says usage is not recorded yet.
    if (result.error && notSetUp(result.error)) return { available: false, month };
    if (result.error) throw new Error(result.error.message);
    const batch = (result.data ?? []) as UsageRow[];
    rows.push(...batch);
    if (batch.length < PAGE) return { available: true, month, summary: summarizeUsage(rows) };
  }
  return { available: true, month, summary: summarizeUsage(rows, true) };
}

export interface ConnectorProblem {
  provider: "xero" | "quickbooks" | "hubspot" | "pipedrive" | "zohobooks" | "zohocrm";
  title: string;
  detail: string;
  /** Since when, as well as the row says: the failure's time. */
  since: string | null;
}

/** The connections whose status needs a person: reconnecting, or a failed last sync. A revoked one needs nobody. */
export async function readConnectorProblems(orgDb: OrgDb = db(), now: Date = new Date()): Promise<ConnectorProblem[]> {
  const result = await orgDb
    .from("accounting_connections")
    .select("provider, status, external_org_name, last_synced_at, last_error, last_error_at, connected_at")
    .neq("status", "revoked");
  if (result.error && notSetUp(result.error)) return [];
  if (result.error) throw new Error(result.error.message);
  const rows = (result.data ?? []) as Array<{
    provider: "xero" | "quickbooks" | "hubspot" | "pipedrive" | "zohobooks" | "zohocrm";
    status: "connected" | "needs_reconnect" | "revoked";
    external_org_name: string | null;
    last_synced_at: string | null;
    last_error: string | null;
    last_error_at: string | null;
    connected_at: string;
  }>;
  return rows.flatMap((row) => {
    const label = PROVIDER_LABELS[row.provider];
    if (!label) return [];
    const view = connectionStatus(
      { providerLabel: label, status: row.status, externalOrgName: row.external_org_name, lastSyncedAt: row.last_synced_at, lastError: row.last_error, lastErrorAt: row.last_error_at, syncing: null },
      now.getTime()
    );
    if (view.tone !== "error") return [];
    return [{ provider: row.provider, title: view.title, detail: view.detail[0] ?? "", since: row.last_error_at ?? row.connected_at }];
  });
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

/** Cycles started today (UTC), as `begin_cycle_run` counts them against a sandbox's cap. */
export async function cyclesStartedToday(orgDb: OrgDb = db(), now: Date = new Date()): Promise<number> {
  const result = await orgDb.from("cycle_runs").select("id", { count: "exact", head: true }).gte("started_at", startOfUtcDay(now));
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

/** Invitations created in the last 24 hours, withdrawn ones included, as `invite_member` counts them. */
export async function invitationsInLastDay(orgId: string, now: Date = new Date()): Promise<number> {
  const result = await platformDb()
    .from("invitations")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .gt("created_at", new Date(now.getTime() - 86_400_000).toISOString());
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

const quietly = async <T,>(label: string, read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    console.error(`usage: ${label} not read`, error instanceof Error ? error.message : "unknown error");
    return null;
  }
};

/**
 * Where the workspace stands against each limit, for Settings (U3). `withGateway` also asks Gateway for the service
 * budget's balance, a network call the accountant console leaves out.
 */
export async function readUsageLimits(
  workspace: { orgId: string; mode: "sandbox" | "live" },
  options: { now?: Date; withGateway?: boolean } = {}
): Promise<UsageLimit[]> {
  const now = options.now ?? new Date();
  const [cyclesToday, budget, service, invitationsToday, connectors] = await Promise.all([
    workspace.mode === "sandbox" ? quietly("cycles", () => cyclesStartedToday(db(), now)) : Promise.resolve(null),
    quietly("agent budget", () => agentBudgetStatus(now)),
    options.withGateway === false ? Promise.resolve(null) : quietly("service budget", () => readServiceBudget({ now })),
    quietly("invitations", () => invitationsInLastDay(workspace.orgId, now)),
    quietly("connectors", () => readConnectorProblems(db(), now)),
  ]);
  const facts: LimitFacts = {
    mode: workspace.mode,
    cyclesToday,
    sandboxCap: SANDBOX_DAILY_CYCLES,
    budget: budget?.room
      ? {
          remaining: budget.room.remaining,
          binding: budget.room.binding,
          dailyUsdc: budget.room.dailyUsdc,
          weeklyUsdc: budget.room.weeklyUsdc,
          spentToday: budget.room.spentToday,
          spentThisWeek: budget.room.spentThisWeek,
        }
      : null,
    service: service ? { spentToday: service.spentToday, dailyCapUsdc: SERVICE_DAILY_CAP_USDC, balanceUsdc: service.balanceUsdc, maxPriceUsdc: SERVICE_MAX_PRICE_USDC } : null,
    invitationsToday,
    invitationCap: INVITATIONS_PER_DAY,
    connectors: (connectors ?? []).map(({ provider, title }) => ({ provider, title })),
  };
  return usageLimits(facts);
}

/** `invite_member`'s limit (migration 0021). */
export const INVITATIONS_PER_DAY = 50;
