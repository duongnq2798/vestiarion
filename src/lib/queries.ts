import { supabase, unwrap } from "./supabase";

/**
 * PostgREST serialises `numeric` as a string so it can't lose precision in
 * JSON. Amounts here are USDC (6dp) well under 10^9, so float64 represents
 * them exactly and this coercion is safe for display and comparison. Any
 * arithmetic that must round-trip to the database goes back as a string.
 */
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export interface AccountRow {
  id: string;
  name: string;
  kind: "operating" | "reserve" | "chain";
  chain: string;
  token: string;
  address: string | null;
  circle_wallet_id: string | null;
  balance: number;
  apy: number;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const rows = unwrap(
    await supabase().from("accounts").select("*").order("kind", { ascending: true })
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as AccountRow),
    balance: num(r.balance),
    apy: num(r.apy),
  }));
}

export interface CounterpartyRow {
  id: string;
  name: string;
  role: string;
  risk_level: string;
  risk_notes: string | null;
  payment_limit: number | null;
  baseline_payment_limit: number | null;
  last_screened_at: string | null;
  performance_score: number;
}

export async function listCounterparties(): Promise<CounterpartyRow[]> {
  const rows = unwrap(
    await supabase().from("counterparties").select("*").order("name")
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as CounterpartyRow),
    payment_limit: r.payment_limit == null ? null : num(r.payment_limit),
    baseline_payment_limit:
      r.baseline_payment_limit == null ? null : num(r.baseline_payment_limit),
    performance_score: num(r.performance_score),
  }));
}

export interface InvoiceRow {
  id: string;
  direction: string;
  counterparty_id: string;
  counterparty_name: string;
  amount: number;
  memo: string | null;
  po_reference: string | null;
  goods_received: boolean;
  due_date: string;
  status: string;
  agent_reasoning: string | null;
  tx_ref: string | null;
}

export async function listInvoices(): Promise<InvoiceRow[]> {
  const rows = unwrap(
    await supabase()
      .from("invoices")
      .select("*, counterparties(name)")
      .order("due_date", { ascending: true })
  ) as Array<Record<string, unknown> & { counterparties: { name: string } | null }>;

  return rows.map((r) => ({
    ...(r as unknown as InvoiceRow),
    amount: num(r.amount),
    counterparty_name: r.counterparties?.name ?? "unknown",
  }));
}

export interface MilestoneRow {
  id: string;
  contractor_id: string;
  contractor_name: string;
  title: string;
  amount: number;
  verification_source: string | null;
  verified: boolean;
  status: string;
  agent_reasoning: string | null;
  tx_ref: string | null;
}

export async function listMilestones(): Promise<MilestoneRow[]> {
  const rows = unwrap(
    await supabase()
      .from("milestones")
      .select("*, counterparties(name)")
      .order("created_at", { ascending: true })
  ) as Array<Record<string, unknown> & { counterparties: { name: string } | null }>;

  return rows.map((r) => ({
    ...(r as unknown as MilestoneRow),
    amount: num(r.amount),
    contractor_name: r.counterparties?.name ?? "unknown",
  }));
}

export interface TreasuryActionRow {
  id: string;
  action: string;
  amount: number;
  reasoning: string;
  created_at: string;
}

export async function listTreasuryActions(): Promise<TreasuryActionRow[]> {
  const rows = unwrap(
    await supabase()
      .from("treasury_actions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20)
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as TreasuryActionRow),
    amount: num(r.amount),
  }));
}

export interface ForecastRow {
  as_of: string;
  horizon_days: number;
  projected_inflow: number;
  projected_outflow: number;
  liquid_balance: number;
  recommendation: string | null;
}

export async function latestForecast(): Promise<ForecastRow | undefined> {
  const rows = unwrap(
    await supabase()
      .from("forecasts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
  ) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return undefined;
  return {
    ...(r as unknown as ForecastRow),
    projected_inflow: num(r.projected_inflow),
    projected_outflow: num(r.projected_outflow),
    liquid_balance: num(r.liquid_balance),
  };
}

export interface DashboardStats {
  day: number;
  totalPaidOut: number;
  decisionsLogged: number;
  flagged: number;
  onchainTransfers: number;
}

export async function stats(): Promise<DashboardStats> {
  const db = supabase();

  const [paidInvoices, paidMilestones, clock, decisions, flagged] = await Promise.all([
    db.from("invoices").select("amount, tx_ref").eq("status", "paid"),
    db.from("milestones").select("amount, tx_ref").eq("status", "paid"),
    db.from("sim_clock").select("current_day").eq("id", 1).single(),
    db.from("ledger_entries").select("*", { count: "exact", head: true }).eq("actor", "agent"),
    db.from("invoices").select("*", { count: "exact", head: true }).eq("status", "flagged"),
  ]);

  const paid = [
    ...((paidInvoices.data ?? []) as Array<{ amount: unknown; tx_ref: string | null }>),
    ...((paidMilestones.data ?? []) as Array<{ amount: unknown; tx_ref: string | null }>),
  ];

  return {
    day: (clock.data as { current_day: number } | null)?.current_day ?? 0,
    totalPaidOut: paid.reduce((sum, r) => sum + num(r.amount), 0),
    decisionsLogged: decisions.count ?? 0,
    flagged: flagged.count ?? 0,
    onchainTransfers: paid.filter((r) => r.tx_ref && !r.tx_ref.startsWith("sim_")).length,
  };
}
