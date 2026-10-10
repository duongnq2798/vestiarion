import { STAGES, type OrderedStage, type RevenueKind, type Stage } from "./fields";

/**
 * The founder dashboard's figures, worked out from rows already read (src/lib/growth/read.ts). Pure, so every rule is
 * tested here: how far a lead got, each rate with its numerator and denominator, the median, and "not enough data" where
 * a denominator is 0, which is never shown as 0%.
 *
 * Time: every instant is UTC. The window is the dashboard's `since`: leads added, workspaces opened, spend and revenue
 * dated on or after it; a lead's stage events count whenever they happened, so a lead added in the window keeps the
 * stages it reached since.
 */

export interface LeadRow {
  id: string;
  business_name: string;
  stage: Stage;
  review_status: string;
  source: string;
  segment: string | null;
  campaign_id: string | null;
  org_id: string | null;
  created_at: string;
}

export interface LeadEvent {
  lead_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  at: string;
}

/** One workspace from growth_workspaces (0099), its counts as numbers. */
export interface WorkspaceRow {
  orgId: string;
  slug: string;
  network: string;
  side: "customers" | "ours";
  createdAt: string;
  mode: string;
  shadow: boolean;
  attribution: { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; ref: string | null; referrerHost: string | null; landingPath: string | null } | null;
  lead: { id: string; source: string; campaignId: string | null } | null;
  firstRealBillAt: string | null;
  realBills: number;
  realBillsWithin7dOfFirst: number;
  firstDecisionAt: string | null;
  verdictsGiven: number;
  verdictsAgreed: number;
  livePayments: number;
  liveUsdc: number;
  members: number;
}

export interface SpendRow {
  campaign_id: string | null;
  spent_on: string;
  usd: number;
  founder_hours: number;
}

export interface RevenueRow {
  kind: RevenueKind;
  amount: number | null;
  currency: string | null;
  occurred_on: string;
}

/** A rate kept as its parts: `value` is null when the denominator is 0, so it reads "not enough data", never 0%. */
export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null;
}

export const NOT_ENOUGH_DATA = "Not enough data yet";

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

/** "3 / 10 · 30%", or "Not enough data yet" when nothing can be divided. */
export function formatRatio(rate: Ratio): string {
  if (rate.value === null) return NOT_ENOUGH_DATA;
  return `${rate.numerator} / ${rate.denominator} · ${Math.round(rate.value * 100)}%`;
}

/** The middle value, or the mean of the two middle ones; null for no values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A stage's place in the order, or -1 for a side state (disqualified, lost) or anything else. */
export function stageIndex(stage: string | null | undefined): number {
  return stage ? (STAGES as readonly string[]).indexOf(stage) : -1;
}

/**
 * How far each lead got: the furthest ordered stage among its current stage and every stage it was moved from or to
 * (its 'stage' events, and the stage it was created at). A disqualified or lost lead keeps the furthest it reached.
 */
export function furthestStages(leads: LeadRow[], events: LeadEvent[]): Map<string, number> {
  const furthest = new Map(leads.map((lead) => [lead.id, stageIndex(lead.stage)]));
  for (const event of events) {
    if (event.field !== "stage" && event.field !== "created") continue;
    const now = furthest.get(event.lead_id);
    if (now === undefined) continue;
    furthest.set(event.lead_id, Math.max(now, stageIndex(event.new_value), event.field === "stage" ? stageIndex(event.old_value) : -1));
  }
  return furthest;
}

/** Whether a lead got as far as `stage` or further, by `furthestStages`. */
export function reached(furthest: Map<string, number>, leadId: string, stage: OrderedStage): boolean {
  return (furthest.get(leadId) ?? -1) >= stageIndex(stage);
}

/** The steps the breakdowns count, after "sourced" (every lead). */
export const FUNNEL_STAGES = ["qualified", "contacted", "replied", "conversation", "workspace_created", "real_invoice_reviewed", "paid_pilot", "paying_customer"] as const satisfies readonly OrderedStage[];
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type LeadFunnel = { sourced: number } & Record<FunnelStage, number>;

export function leadFunnel(leads: LeadRow[], furthest: Map<string, number>): LeadFunnel {
  const counts = { sourced: leads.length } as LeadFunnel;
  for (const stage of FUNNEL_STAGES) counts[stage] = leads.filter((lead) => reached(furthest, lead.id, stage)).length;
  return counts;
}

/** The lead funnel per value of `key` (a source, a segment, a campaign), the largest group first; a missing value is "none". */
export function breakdown(leads: LeadRow[], furthest: Map<string, number>, key: (lead: LeadRow) => string | null): Array<{ key: string; funnel: LeadFunnel }> {
  const groups = new Map<string, LeadRow[]>();
  for (const lead of leads) {
    const value = key(lead) ?? "none";
    groups.set(value, [...(groups.get(value) ?? []), lead]);
  }
  return [...groups.entries()]
    .map(([value, group]) => ({ key: value, funnel: leadFunnel(group, furthest) }))
    .sort((a, b) => b.funnel.sourced - a.funnel.sourced || a.key.localeCompare(b.key));
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Minutes from a workspace's opening to the agent's first decision on a real bill; null before one. */
export function minutesToFirstDecision(workspace: WorkspaceRow): number | null {
  if (!workspace.firstDecisionAt) return null;
  return Math.max(0, Math.round((Date.parse(workspace.firstDecisionAt) - Date.parse(workspace.createdAt)) / MINUTE_MS));
}

/** Whether 7 days have passed since an instant. */
const sevenDaysOld = (iso: string, now: Date) => now.getTime() - Date.parse(iso) >= 7 * DAY_MS;

/**
 * A second real bill within 7 days of the first: "yes" once there is one; "too early" while the workspace, or its first
 * real bill, is under 7 days old, since one may still come; otherwise "no" (a workspace 7 days old with no real bill
 * included).
 */
export function secondBillWithin7Days(workspace: WorkspaceRow, now: Date): "yes" | "no" | "too_early" {
  if (workspace.realBillsWithin7dOfFirst >= 2) return "yes";
  if (!sevenDaysOld(workspace.createdAt, now)) return "too_early";
  if (workspace.firstRealBillAt && !sevenDaysOld(workspace.firstRealBillAt, now)) return "too_early";
  return "no";
}

/** Where a workspace came from: its first touch's tags, else the linked lead's source; null when neither is known. */
export function workspaceSource(workspace: WorkspaceRow): string | null {
  const touch = workspace.attribution;
  const tags = touch ? [touch.utmSource, touch.utmCampaign && `campaign ${touch.utmCampaign}`, touch.ref && `ref ${touch.ref}`].filter(Boolean) : [];
  if (tags.length > 0) return tags.join(" · ");
  if (workspace.lead) return `lead: ${workspace.lead.source.replaceAll("_", " ")}`;
  if (touch?.referrerHost) return `from ${touch.referrerHost}`;
  return null;
}

/** Sums money in cents, so 0.1 + 0.2 stays 0.30. */
function sumMoney(values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value * 100), 0) / 100;
}

export interface GrowthMetrics {
  leadsSourced: number;
  qualified: number;
  contacted: number;
  responseRate: Ratio;
  conversationRate: Ratio;
  signupConversion: Ratio;
  activation: Ratio;
  activationByNetwork: Array<{ network: string; rate: Ratio }>;
  medianMinutesToFirstDecision: { value: number | null; workspaces: number };
  repeat7d: Ratio;
  paidPilotConversion: Ratio;
  /** Payments received, per currency, never converted and never mixed with payment volume. */
  revenue: Array<{ currency: string; amount: number; payments: number }>;
  cashSpendUsd: number;
  founderHours: number;
  costPerActivated: { spendUsd: number; activated: number; value: number | null };
}

export interface MetricsInput {
  leads: LeadRow[];
  events: LeadEvent[];
  workspaces: WorkspaceRow[];
  spend: SpendRow[];
  revenue: RevenueRow[];
  now: Date;
}

export function growthMetrics({ leads, events, workspaces, spend, revenue, now }: MetricsInput): GrowthMetrics {
  const furthest = furthestStages(leads, events);
  const funnel = leadFunnel(leads, furthest);
  const reachedCount = (stage: OrderedStage) => leads.filter((lead) => reached(furthest, lead.id, stage)).length;

  const customers = workspaces.filter((workspace) => workspace.side === "customers");
  const decided = customers.filter((workspace) => workspace.firstDecisionAt !== null);
  const networks = [...new Set(customers.map((workspace) => workspace.network))].sort();
  const minutes = customers.map(minutesToFirstDecision).filter((value): value is number => value !== null);
  // Only workspaces whose first real bill is 7 days old can have shown a repeat, so only they are counted, on both sides.
  const repeatable = customers.filter((workspace) => workspace.firstRealBillAt !== null && sevenDaysOld(workspace.firstRealBillAt, now));

  const received = revenue.filter((row) => row.kind === "payment_received" && row.amount !== null);
  const currencies = [...new Set(received.map((row) => (row.currency ?? "").trim().toUpperCase() || "unknown currency"))].sort();
  const cashSpendUsd = sumMoney(spend.map((row) => row.usd));
  const activated = reachedCount("real_invoice_reviewed");

  return {
    leadsSourced: funnel.sourced,
    qualified: funnel.qualified,
    contacted: funnel.contacted,
    responseRate: ratio(funnel.replied, funnel.contacted),
    conversationRate: ratio(funnel.conversation, funnel.contacted),
    signupConversion: ratio(funnel.workspace_created, funnel.contacted),
    activation: ratio(decided.length, customers.length),
    activationByNetwork: networks.map((network) => {
      const on = customers.filter((workspace) => workspace.network === network);
      return { network, rate: ratio(on.filter((workspace) => workspace.firstDecisionAt !== null).length, on.length) };
    }),
    medianMinutesToFirstDecision: { value: median(minutes), workspaces: minutes.length },
    repeat7d: ratio(repeatable.filter((workspace) => workspace.realBillsWithin7dOfFirst >= 2).length, repeatable.length),
    paidPilotConversion: ratio(funnel.paid_pilot, funnel.conversation),
    revenue: currencies.map((currency) => {
      const rows = received.filter((row) => ((row.currency ?? "").trim().toUpperCase() || "unknown currency") === currency);
      return { currency, amount: sumMoney(rows.map((row) => row.amount ?? 0)), payments: rows.length };
    }),
    cashSpendUsd,
    founderHours: Math.round(spend.reduce((total, row) => total + row.founder_hours * 10, 0)) / 10,
    costPerActivated: { spendUsd: cashSpendUsd, activated, value: activated > 0 ? Math.round((cashSpendUsd / activated) * 100) / 100 : null },
  };
}
