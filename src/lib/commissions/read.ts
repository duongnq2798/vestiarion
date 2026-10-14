import { db, type OrgDb } from "../dal";
import { toMicros } from "../allocations/model";
import {
  commissionsNotReady,
  type CommissionBasis,
  type CommissionCurrency,
  type CommissionLine,
  type CommissionPayout,
  type CommissionPlan,
  type CommissionScope,
  type CommissionSource,
} from "./model";

/**
 * A workspace's commissions, read in its own scope (docs/superpowers/specs/2026-10-14-commissions-design.md C10): every
 * version of every plan, every accrual and adjustment, every payout with its payable's status, and the names the page
 * shows beside them. Until migration 0118 runs, the read answers that commissions are not set up, and the page says so.
 */

export const PLAN_COLUMNS = "id, beneficiary_id, beneficiary_member, rate_bps, basis, scope, hold_days, reference, started_at, ended_at, replaces, created_by";
export const LINE_COLUMNS =
  "id, kind, plan_id, beneficiary_id, invoice_id, deal_id, source, allocation_id, transfer_id, adjusts, basis, base_amount, rate_bps, amount, currency, applied_at, due_at, reason, payout_id";
export const PAYOUT_COLUMNS = "id, beneficiary_id, invoice_id, statement, currency, amount, line_count, created_by, created_at";

/** How many lines a page reads: a small business's years of commissions. */
export const LINES_READ = 5000;

export interface PlanDbRow {
  id: string;
  beneficiary_id: string;
  beneficiary_member: string | null;
  rate_bps: number;
  basis: CommissionBasis;
  scope: CommissionScope;
  hold_days: number;
  reference: string | null;
  started_at: string;
  ended_at: string | null;
  replaces: string | null;
  created_by: string | null;
}

export interface LineDbRow {
  id: string;
  kind: "accrual" | "adjustment";
  plan_id: string;
  beneficiary_id: string;
  invoice_id: string;
  deal_id: string;
  source: CommissionSource;
  allocation_id: string | null;
  transfer_id: string | null;
  adjusts: string | null;
  basis: CommissionBasis;
  base_amount: string | number;
  rate_bps: number;
  amount: string | number;
  currency: CommissionCurrency;
  applied_at: string;
  due_at: string;
  reason: CommissionLine["reason"];
  payout_id: string | null;
}

interface PayoutDbRow {
  id: string;
  beneficiary_id: string;
  invoice_id: string;
  statement: string;
  currency: CommissionCurrency;
  amount: string | number;
  line_count: number;
  created_by: string | null;
  created_at: string;
}

export const toPlan = (row: PlanDbRow, dealIds: string[] = []): CommissionPlan => ({
  id: row.id,
  beneficiaryId: row.beneficiary_id,
  memberId: row.beneficiary_member,
  rateBps: row.rate_bps,
  basis: row.basis,
  scope: row.scope,
  dealIds,
  holdDays: row.hold_days,
  reference: row.reference,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  replaces: row.replaces,
  createdBy: row.created_by,
});

/** Postgres answers timestamps in its own form; the model compares ISO strings. */
const iso = (value: string) => new Date(value).toISOString();

export const toLine = (row: LineDbRow): CommissionLine => ({
  id: row.id,
  kind: row.kind,
  planId: row.plan_id,
  beneficiaryId: row.beneficiary_id,
  invoiceId: row.invoice_id,
  dealId: row.deal_id,
  source: row.source,
  allocationId: row.allocation_id,
  transferId: row.transfer_id,
  adjusts: row.adjusts,
  basis: row.basis,
  base: toMicros(row.base_amount),
  rateBps: row.rate_bps,
  amount: toMicros(row.amount),
  currency: row.currency,
  appliedAt: iso(row.applied_at),
  dueAt: iso(row.due_at),
  reason: row.reason,
  payoutId: row.payout_id,
});

/** A receivable a line is on, as the page names it. */
export interface CommissionReceivable {
  id: string;
  label: string;
  amount: number;
  currency: string;
  customer: string;
}

export interface CommissionsData {
  available: true;
  plans: CommissionPlan[];
  lines: CommissionLine[];
  payouts: CommissionPayout[];
  /** Every counterparty a plan may name or names: its name and role. */
  counterparties: Array<{ id: string; name: string; role: string }>;
  /** Every deal, for the plan form and the lines. */
  deals: Array<{ id: string; title: string; customer: string; status: string }>;
  receivables: Map<string, CommissionReceivable>;
}

export type CommissionsRead = { available: false } | CommissionsData;

class NotReady extends Error {}

function rowsOf<T>(result: { data: unknown; error: { code?: string; message?: string } | null }): T[] {
  if (result.error) {
    if (commissionsNotReady(result.error)) throw new NotReady();
    throw new Error(result.error.message ?? "commissions not read");
  }
  return (result.data ?? []) as T[];
}

/** How a receivable is named on the page: its memo's first words, else its short id. */
export function receivableLabel(invoice: { id: string; memo: string | null }): string {
  const memo = invoice.memo?.trim();
  return memo ? (memo.length > 60 ? `${memo.slice(0, 57)}…` : memo) : `Invoice ${invoice.id.slice(0, 8)}`;
}

/** Everything the commissions page shows, in the organization in scope. */
export async function readCommissions(orgDb: OrgDb = db()): Promise<CommissionsRead> {
  try {
    const [planRows, dealRows, lineRows, payoutRows] = await Promise.all([
      orgDb.from("commission_plans").select(PLAN_COLUMNS).order("started_at", { ascending: false }).then(rowsOf<PlanDbRow>),
      orgDb.from("commission_plan_deals").select("plan_id, deal_id").then(rowsOf<{ plan_id: string; deal_id: string }>),
      orgDb.from("commission_lines").select(LINE_COLUMNS).order("applied_at", { ascending: true }).limit(LINES_READ).then(rowsOf<LineDbRow>),
      orgDb.from("commission_payouts").select(PAYOUT_COLUMNS).order("created_at", { ascending: false }).then(rowsOf<PayoutDbRow>),
    ]);
    const lines = lineRows.map(toLine);
    const payoutInvoices = payoutRows.map((row) => row.invoice_id);
    const receivableIds = [...new Set(lines.map((line) => line.invoiceId))];
    const [statuses, receivableRows, counterpartyRows, deals] = await Promise.all([
      payoutInvoices.length > 0 ? orgDb.from("invoices").select("id, status").in("id", payoutInvoices).then(rowsOf<{ id: string; status: string }>) : [],
      receivableIds.length > 0
        ? orgDb.from("invoices").select("id, memo, amount, currency, counterparty_id").in("id", receivableIds).then(rowsOf<{ id: string; memo: string | null; amount: string; currency: string | null; counterparty_id: string }>)
        : [],
      orgDb.from("counterparties").select("id, name, role").order("name", { ascending: true }).then(rowsOf<{ id: string; name: string; role: string }>),
      orgDb
        .from("deals")
        .select("id, title, status, counterparty_id, created_at")
        .order("created_at", { ascending: false })
        .then((result) => (result.error ? [] : ((result.data ?? []) as Array<{ id: string; title: string; status: string; counterparty_id: string }>))),
    ]);
    const statusOf = new Map(statuses.map((row) => [row.id, row.status]));
    const names = new Map(counterpartyRows.map((row) => [row.id, row.name]));
    const dealsOf = new Map<string, string[]>();
    for (const row of dealRows) dealsOf.set(row.plan_id, [...(dealsOf.get(row.plan_id) ?? []), row.deal_id]);
    return {
      available: true,
      plans: planRows.map((row) => toPlan(row, dealsOf.get(row.id) ?? [])),
      lines,
      payouts: payoutRows.map((row) => ({
        id: row.id,
        beneficiaryId: row.beneficiary_id,
        invoiceId: row.invoice_id,
        statement: row.statement,
        currency: row.currency,
        amount: toMicros(row.amount),
        lineCount: row.line_count,
        createdBy: row.created_by,
        createdAt: iso(row.created_at),
        invoiceStatus: statusOf.get(row.invoice_id) ?? null,
      })),
      counterparties: counterpartyRows,
      deals: deals.map((deal) => ({ id: deal.id, title: deal.title, status: deal.status, customer: names.get(deal.counterparty_id) ?? "a customer" })),
      receivables: new Map(
        receivableRows.map((row) => [
          row.id,
          { id: row.id, label: receivableLabel(row), amount: toMicros(row.amount), currency: row.currency ?? "USDC", customer: names.get(row.counterparty_id) ?? "a customer" },
        ])
      ),
    };
  } catch (error) {
    if (error instanceof NotReady) return { available: false };
    throw error;
  }
}
