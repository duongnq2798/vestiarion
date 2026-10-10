import "server-only";
import { z } from "zod";
import { platformDb, type PlatformTable } from "@/lib/dal";
import { NETWORK_IDS, type Network } from "@/lib/network";
import { readFunnel, type FunnelSide } from "@/lib/platform/funnel";
import type { SideKey } from "@/lib/platform/open-numbers";
import type { LeadCsvHeader } from "./csv";
import type { CampaignStatus, RevenueKind, Stage } from "./fields";
import type { LeadEvent, LeadRow, SpendRow, WorkspaceRow } from "./metrics";

/**
 * Everything the founder dashboard shows, read through the platform database (migration 0099's tables and functions,
 * and open_funnel from 0089). Only the dashboard and its export call this, after the team gate. Rows are read whole,
 * a thousand at a time, since PostgREST answers at most that many per request; the figures are worked out from them in
 * src/lib/growth/metrics.ts.
 */

export interface Campaign {
  id: string;
  name: string;
  strategies: number[];
  segment: string | null;
  offer: string | null;
  starts_on: string | null;
  ends_on: string | null;
  cash_budget_usd: number | null;
  hour_budget: number | null;
  status: CampaignStatus;
  created_at: string;
}

export type Lead = LeadRow & Record<Exclude<LeadCsvHeader, "business_name" | "source" | "segment" | "campaign_id" | "size_uncertain">, string | null> & {
  size_uncertain: boolean;
  dedupe_key: string;
  updated_at: string;
};

export interface LeadEventRow extends LeadEvent {
  id: number;
  note: string | null;
  by_user: string | null;
}

export interface Spend extends SpendRow {
  id: number;
  note: string | null;
}

export interface Revenue {
  id: number;
  lead_id: string | null;
  org_id: string | null;
  kind: RevenueKind;
  amount: number | null;
  currency: string | null;
  occurred_on: string;
  reference: string | null;
  note: string | null;
}

export interface GrowthData {
  /** False when the growth tables could not be read (before migration 0099 runs): the page says so and shows the rest. */
  ready: boolean;
  campaigns: Campaign[];
  leads: Lead[];
  events: LeadEventRow[];
  spend: Spend[];
  revenue: Revenue[];
  /** Null when growth_workspaces could not be read. */
  workspaces: WorkspaceRow[] | null;
  /** Each network's funnel from open_funnel, null where it could not be read. */
  funnels: Record<Network, Record<SideKey, FunnelSide> | null>;
  /** The slug of each workspace a lead or a revenue event is linked to. */
  workspaceSlugs: Record<string, string>;
}

const PAGE = 1000;

/** Every row of a growth table, a page at a time, in a stable order. */
export async function readAll<T>(table: PlatformTable, order: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await platformDb()
      .from(table)
      .select("*")
      .order(order, { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

const count = z.coerce.number();
const instant = z.string();
const workspaceSchema = z.object({
  orgId: z.string(),
  slug: z.string(),
  network: z.string(),
  side: z.enum(["customers", "ours"]),
  createdAt: instant,
  mode: z.string(),
  shadow: z.boolean(),
  attribution: z
    .object({
      utmSource: z.string().nullable(),
      utmMedium: z.string().nullable(),
      utmCampaign: z.string().nullable(),
      ref: z.string().nullable(),
      referrerHost: z.string().nullable(),
      landingPath: z.string().nullable(),
    })
    .nullable(),
  lead: z.object({ id: z.string(), source: z.string(), campaignId: z.string().nullable() }).nullable(),
  firstRealBillAt: instant.nullable(),
  realBills: count,
  realBillsWithin7dOfFirst: count,
  firstDecisionAt: instant.nullable(),
  verdictsGiven: count,
  verdictsAgreed: count,
  livePayments: count,
  liveUsdc: count,
  members: count,
});

/** The workspaces opened since `since`, newest first, or null when growth_workspaces could not be read. */
export async function readWorkspaces(since: Date): Promise<WorkspaceRow[] | null> {
  try {
    const { data, error } = await platformDb().rpc("growth_workspaces", { p_since: since.toISOString() });
    if (error) throw new Error(error.message);
    return z.array(workspaceSchema).parse(data);
  } catch (error) {
    console.error("growth: growth_workspaces not read", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

/** The slugs of these workspaces, by id. */
async function readSlugs(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data, error } = await platformDb().from("orgs").select("id, slug").in("id", ids);
  if (error) throw new Error(`orgs: ${error.message}`);
  return Object.fromEntries(((data ?? []) as Array<{ id: string; slug: string }>).map((row) => [row.id, row.slug]));
}

const money = (value: unknown) => (value === null || value === undefined ? null : Number(value));

export async function readGrowth(since: Date): Promise<GrowthData> {
  const funnelOf = (network: Network) =>
    readFunnel(since, network).catch((error: unknown) => {
      console.error(`growth: open_funnel ${network} not read`, error instanceof Error ? error.message : "unknown error");
      return null;
    });
  const [testnet, mainnet, workspaces] = await Promise.all([funnelOf(NETWORK_IDS[0]), funnelOf(NETWORK_IDS[1]), readWorkspaces(since)]);
  const funnels = { [NETWORK_IDS[0]]: testnet, [NETWORK_IDS[1]]: mainnet } as GrowthData["funnels"];
  try {
    const [campaigns, leads, events, spend, revenue] = await Promise.all([
      readAll<Campaign>("growth_campaigns", "created_at"),
      readAll<Lead>("growth_leads", "created_at"),
      readAll<LeadEventRow>("growth_lead_events", "at"),
      readAll<Spend>("growth_spend", "spent_on"),
      readAll<Revenue>("growth_revenue", "occurred_on"),
    ]);
    const linked = [...new Set([...leads, ...revenue].map((row) => row.org_id).filter((id): id is string => id !== null))];
    return {
      ready: true,
      workspaceSlugs: await readSlugs(linked),
      campaigns: campaigns.map((row) => ({ ...row, strategies: row.strategies ?? [], cash_budget_usd: money(row.cash_budget_usd), hour_budget: money(row.hour_budget) })),
      leads: leads.map((row) => ({ ...row, stage: row.stage as Stage })),
      events,
      spend: spend.map((row) => ({ ...row, usd: Number(row.usd), founder_hours: Number(row.founder_hours) })),
      revenue: revenue.map((row) => ({ ...row, amount: money(row.amount) })),
      workspaces,
      funnels,
    };
  } catch (error) {
    console.error("growth: tables not read", error instanceof Error ? error.message : "unknown error");
    return { ready: false, campaigns: [], leads: [], events: [], spend: [], revenue: [], workspaces, funnels, workspaceSlugs: {} };
  }
}
