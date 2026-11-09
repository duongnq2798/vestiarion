import { db, unwrap } from "./dal";
import type { ScreeningCandidate } from "./compliance";
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
  /** Every match of the latest live screening no one has dismissed, best first (migration 0060); null otherwise. */
  risk_matches?: ScreeningCandidate[] | null;
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
  /** Where the counterparty is emailed when it is paid (payment notices R1, 0063); null for none, or before 0063. */
  notice_email?: string | null;
  /** Whether the agent needs a purchase order on file before it pays (three-way match design M2, 0073); absent before 0073. */
  purchase_order_required?: boolean;
  /** The Circle wallet Vestiarion made as this payee's mirror address in shadow mode (shadow mode S7, 0084); null otherwise. */
  mirror_wallet_id?: string | null;
  /**
   * When its contact on file said they did not make the change to its address (address change check AC3, 0137;
   * `select("*")` reads it): no one confirms it and nothing pays it until an owner or admin unfreezes it. Absent before
   * 0137, null when not frozen.
   */
  frozen_at?: string | null;
}

/** A counterparty row as every reader here returns it: its figures as numbers. */
function counterpartyOf(r: Record<string, unknown>): CounterpartyRow {
  return {
    ...(r as unknown as CounterpartyRow),
    payment_limit: r.payment_limit == null ? null : num(r.payment_limit),
    baseline_payment_limit:
      r.baseline_payment_limit == null ? null : num(r.baseline_payment_limit),
    performance_score: r.performance_score == null ? null : num(r.performance_score),
    performance_inputs:
      (r.performance_inputs as CounterpartyHistoryInputs | null | undefined) ?? null,
    sample: r.sample === true,
  };
}

export async function listCounterparties(): Promise<CounterpartyRow[]> {
  const rows = unwrap(
    await db().from("counterparties").select("*").order("name")
  ) as Record<string, unknown>[];
  return rows.map(counterpartyOf);
}

/**
 * One counterparty of the workspace in scope, or null for an id it does not hold
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL2): `db()` keeps to the workspace, so another
 * workspace's counterparty is null too, like one that does not exist. A read that fails throws.
 */
export async function readCounterparty(id: string): Promise<CounterpartyRow | null> {
  const found = await db().from("counterparties").select("*").eq("id", id).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  return found.data ? counterpartyOf(found.data as Record<string, unknown>) : null;
}

/** A counterparty's address as the payee lock compares it with the others' (PL6): never more of the row. */
export interface AddressBookRow {
  id: string;
  name: string;
  address: string;
  chain: string | null;
}

/**
 * Every counterparty with an address, and the chain it is paid on, a page at a time: what a counterparty's page compares
 * its address with to find a lookalike (counterparty page CL5, payee lock PL6), as Counterparties compares every row.
 */
export async function payeeAddressBook(): Promise<AddressBookRow[]> {
  return everyPage<AddressBookRow>((from, to) =>
    db().from("counterparties").select("id, name, address, chain").not("address", "is", null).order("id", { ascending: true }).range(from, to)
  );
}

/** PostgREST's `max_rows` on Supabase: the most rows one request answers with. */
const PAGE = 1000;

/** Every row of a read, a page at a time; `read` orders its rows so the pages do not overlap. */
async function everyPage<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(await read(from, from + PAGE - 1)) as T[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
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
  /** Its late fee (0141; `select("*")` reads it): absent before it, null without one. */
  late_fee_kind?: string | null;
  late_fee_value?: string | number | null;
  late_fee_starts_on?: string | null;
  /** What actually left when this invoice was paid: the discounted amount when it was paid by the deadline, the full amount otherwise, null until it is paid. */
  paid_amount: number | null;
  /** USDC or EURC (0040); `listInvoices` always sets it. */
  currency?: "USDC" | "EURC";
  /** Who entered it (`select("*")` reads it): they never approve it themselves, unless they are the only approver. */
  created_by?: string | null;
  /**
   * A bill taken in the business's own currency in shadow mode (0084, shadow mode S6): as it was written, and the rate
   * its USDC amount was worked out at. All set, or all null.
   */
  original_currency?: string | null;
  original_amount?: number | null;
  fx_rate?: number | null;
  fx_source?: string | null;
  fx_at?: string | null;
  /** When a receivable's payment arrived, or a payable's left (0001); null while it is open. A payment's lifecycle reads it (settlement lifecycle L5). */
  settled_at?: string | null;
  /** The recurring payment that created this invoice, and the period (`YYYY-MM-DD`) it is for (0055). */
  recurring_id?: string | null;
  recurring_period?: string | null;
  /** When it was added (0001; `select("*")` reads it): Bills & receivables' Newest added order. */
  created_at?: string;
}

/** An invoice or a milestone row as read with its counterparty's name. */
type WithName = Record<string, unknown> & { counterparties: { name: string } | null };

/** An invoice row as every reader here returns it: its amounts as numbers, its currency USDC unless EURC. */
function invoiceOf(r: WithName): InvoiceRow {
  return {
    ...(r as unknown as InvoiceRow),
    amount: num(r.amount),
    counterparty_name: r.counterparties?.name ?? "unknown",
    paid_amount: r.paid_amount == null ? null : num(r.paid_amount),
    currency: r.currency === "EURC" ? "EURC" : "USDC",
    original_amount: r.original_amount == null ? null : num(r.original_amount),
    fx_rate: r.fx_rate == null ? null : num(r.fx_rate),
  };
}

export async function listInvoices(): Promise<InvoiceRow[]> {
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("*, counterparties(name)")
      .order("due_date", { ascending: true })
  ) as WithName[];

  return rows.map(invoiceOf);
}

/**
 * One counterparty's invoices, both ways, by due date, a page at a time, read and mapped as `listInvoices` reads them
 * (counterparty page CL13): every one, however many, so its totals count them all.
 */
export async function listInvoicesOf(counterpartyId: string): Promise<InvoiceRow[]> {
  const rows = await everyPage<WithName>((from, to) =>
    db()
      .from("invoices")
      .select("*, counterparties(name)")
      .eq("counterparty_id", counterpartyId)
      .order("due_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  );
  return rows.map(invoiceOf);
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
  /** When it was marked paid; null before (settlement lifecycle L5). */
  settled_at?: string | null;
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
  /** What the work is held to, from the agreement, written by a person (Asana acceptance A5, 0115); absent before it. */
  acceptance_criteria?: string | null;
}

/** A milestone row as every reader here returns it: its amount as a number, with its contractor's name. */
function milestoneOf(r: WithName): MilestoneRow {
  return {
    ...(r as unknown as MilestoneRow),
    amount: num(r.amount),
    contractor_name: r.counterparties?.name ?? "unknown",
  };
}

export async function listMilestones(): Promise<MilestoneRow[]> {
  const rows = unwrap(
    await db()
      .from("milestones")
      .select("*, counterparties(name)")
      .order("created_at", { ascending: true })
  ) as WithName[];

  return rows.map(milestoneOf);
}

/**
 * One payee's milestones, oldest first, a page at a time, read and mapped as `listMilestones` reads them (counterparty
 * page CL13).
 */
export async function listMilestonesOf(counterpartyId: string): Promise<MilestoneRow[]> {
  const rows = await everyPage<WithName>((from, to) =>
    db()
      .from("milestones")
      .select("*, counterparties(name)")
      .eq("contractor_id", counterpartyId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  );
  return rows.map(milestoneOf);
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

/** What the shell's header shows of the cycle: the simulated day, the clock it runs on, and when a cycle last ran. */
export type ShellClock = Pick<DashboardStats, "day" | "clockMode" | "lastCycleAt">;

/**
 * The header's clock alone, in two reads (docs/superpowers/specs/2026-10-26-close-pack-page-speed-design.md CS4): for a
 * page that needs nothing else of `stats()`, which also adds up every paid bill and counts the agent's entries.
 */
export async function shellClock(): Promise<ShellClock> {
  const client = db();
  const [clock, latestCycle] = await Promise.all([
    // No row yet is not an error: an organization that has never run a
    // simulated cycle has no sim_clock row until its first one.
    client.from("sim_clock").select("current_day").maybeSingle(),
    client.from("ledger_entries").select("ts").eq("action", "cycle_complete").order("seq", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return {
    day: (clock.data as { current_day: number } | null)?.current_day ?? 0,
    clockMode: cycleClockMode(),
    lastCycleAt: (latestCycle.data as { ts: string } | null)?.ts ?? null,
  };
}

export async function stats(): Promise<DashboardStats> {
  const client = db();

  const [paidInvoices, paidMilestones, decisions, flagged, clock] = await Promise.all([
    client.from("invoices").select("amount, paid_amount, tx_ref, currency").eq("status", "paid"),
    client.from("milestones").select("amount, tx_ref").eq("status", "paid"),
    client.from("ledger_entries").select("*", { count: "exact", head: true }).eq("actor", "agent"),
    client.from("invoices").select("*", { count: "exact", head: true }).eq("status", "flagged"),
    shellClock(),
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
    ...clock,
    totalPaidOut: paid.filter((r) => r.usdc).reduce((sum, r) => sum + num(r.amount), 0),
    decisionsLogged: decisions.count ?? 0,
    flagged: flagged.count ?? 0,
    onchainTransfers: paid.filter((r) => r.tx_ref && !r.tx_ref.startsWith("sim_")).length,
  };
}
