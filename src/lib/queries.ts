import { db, unwrap } from "./dal";
import { cycleClockMode, type CycleClockMode } from "./clock";
import type { CounterpartyHistoryInputs } from "./agent/counterparty-history";

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
  /** When `balance` was last read from the chain (migration 0032); null when it never has been. */
  balance_synced_at: string | null;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const rows = unwrap(
    await db().from("accounts").select("*").order("kind", { ascending: true })
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
  address: string | null;
  chain: string | null;
  jurisdiction: string | null;
  risk_level: string;
  risk_notes: string | null;
  /** The screening entity the current verdict matched, when a live screen matched one (migration 0051). */
  risk_entity_id?: string | null;
  payment_limit: number | null;
  baseline_payment_limit: number | null;
  last_screened_at: string | null;
  performance_score: number | null;
  performance_inputs: CounterpartyHistoryInputs | null;
  /** When a person last changed the address; null when it was set as the counterparty was added. */
  address_changed_at: string | null;
  /** When a person last confirmed the address. */
  address_confirmed_at: string | null;
  /** Loaded as sample data (0034): an example, removed with the rest of the sample. */
  sample: boolean;
}

export async function listCounterparties(): Promise<CounterpartyRow[]> {
  const rows = unwrap(
    await db().from("counterparties").select("*").order("name")
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as CounterpartyRow),
    payment_limit: r.payment_limit == null ? null : num(r.payment_limit),
    baseline_payment_limit:
      r.baseline_payment_limit == null ? null : num(r.baseline_payment_limit),
    performance_score: r.performance_score == null ? null : num(r.performance_score),
    performance_inputs:
      (r.performance_inputs as CounterpartyHistoryInputs | null | undefined) ?? null,
    sample: r.sample === true,
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
  /** The day the agent committed to pay (migration 0038); set only while `status` is `scheduled`. */
  scheduled_for: string | null;
  /** The early-payment discount's percent, when the invoice carries one (numeric(5,2) — a string from PostgREST). */
  early_pay_discount_pct: string | number | null;
  /** The last day the discount applies, when there is one. */
  discount_due_date: string | null;
  /** What actually left when this invoice was paid: the discounted amount when it was paid by the deadline, the full amount otherwise, null until it is paid. */
  paid_amount: number | null;
  /** USDC or EURC (0040); `listInvoices` always sets it. */
  currency?: "USDC" | "EURC";
}

export async function listInvoices(): Promise<InvoiceRow[]> {
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("*, counterparties(name)")
      .order("due_date", { ascending: true })
  ) as Array<Record<string, unknown> & { counterparties: { name: string } | null }>;

  return rows.map((r) => ({
    ...(r as unknown as InvoiceRow),
    amount: num(r.amount),
    counterparty_name: r.counterparties?.name ?? "unknown",
    paid_amount: r.paid_amount == null ? null : num(r.paid_amount),
    currency: r.currency === "EURC" ? "EURC" : "USDC",
  }));
}

export interface MilestoneRow {
  id: string;
  contractor_id: string;
  contractor_name: string;
  title: string;
  amount: number;
  verification_source: string | null;
  verification_method: string;
  verification_status: string;
  verification_checked_at: string | null;
  verified_at: string | null;
  verification_detail: Record<string, unknown>;
  verified: boolean;
  status: string;
  agent_reasoning: string | null;
  tx_ref: string | null;
  /** The milestone's hold in the workspace's escrow (milestone escrow E3–E5); null when it has none. */
  escrow_state?: "funding" | "funded" | "released" | "refunded" | null;
  escrow_payee?: string | null;
  escrow_amount?: number | string | null;
  escrow_refund_after?: string | null;
  escrow_fund_tx_hash?: string | null;
  escrow_release_tx_hash?: string | null;
  escrow_refund_tx_hash?: string | null;
  created_by?: string | null;
  /** Closed without paying by a person (held milestone actions R3): when, and why. */
  closed_at?: string | null;
  close_reason?: string | null;
}

export async function listMilestones(): Promise<MilestoneRow[]> {
  const rows = unwrap(
    await db()
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
    await db()
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
    await db()
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
  clockMode: CycleClockMode;
  lastCycleAt: string | null;
  totalPaidOut: number;
  decisionsLogged: number;
  flagged: number;
  onchainTransfers: number;
}

export async function stats(): Promise<DashboardStats> {
  const client = db();

  const [paidInvoices, paidMilestones, clock, decisions, flagged, latestCycle] = await Promise.all([
    client.from("invoices").select("amount, paid_amount, tx_ref, currency").eq("status", "paid"),
    client.from("milestones").select("amount, tx_ref").eq("status", "paid"),
    // No row yet is not an error: an organization that has never run a
    // simulated cycle has no sim_clock row until its first one.
    client.from("sim_clock").select("current_day").maybeSingle(),
    client.from("ledger_entries").select("*", { count: "exact", head: true }).eq("actor", "agent"),
    client.from("invoices").select("*", { count: "exact", head: true }).eq("status", "flagged"),
    client.from("ledger_entries").select("ts").eq("action", "cycle_complete").order("seq", { ascending: false }).limit(1).maybeSingle(),
  ]);

  // What actually left: an invoice paid with an early-payment discount
  // records the transfer's amount in paid_amount (migration 0038); one paid
  // without, or before that column existed, left its full amount.
  // A EURC payment is a payment settled on chain, but never part of a USDC
  // total (EURC invoices design R3). Milestones are always USDC.
  const paid = [
    ...((paidInvoices.data ?? []) as Array<{ amount: unknown; paid_amount: unknown; tx_ref: string | null; currency?: string | null }>).map((row) => ({
      amount: row.paid_amount ?? row.amount,
      tx_ref: row.tx_ref,
      usdc: (row.currency ?? "USDC") === "USDC",
    })),
    ...((paidMilestones.data ?? []) as Array<{ amount: unknown; tx_ref: string | null }>).map((row) => ({ ...row, usdc: true })),
  ];

  return {
    day: (clock.data as { current_day: number } | null)?.current_day ?? 0,
    clockMode: cycleClockMode(),
    lastCycleAt: (latestCycle.data as { ts: string } | null)?.ts ?? null,
    totalPaidOut: paid.filter((r) => r.usdc).reduce((sum, r) => sum + num(r.amount), 0),
    decisionsLogged: decisions.count ?? 0,
    flagged: flagged.count ?? 0,
    onchainTransfers: paid.filter((r) => r.tx_ref && !r.tx_ref.startsWith("sim_")).length,
  };
}
