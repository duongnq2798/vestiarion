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

/** PostgREST's `max_rows`: a page of rows is at most this many (as `LEDGER_PAGE_SIZE`). */
export const PAGE_SIZE = 1000;
/** How many pages of one list a read takes, at most: tens of thousands of lines, years of a small business's commissions. */
export const PAGES_READ = 50;
/** How many ids one `in` filter names, so its address stays short. */
export const IDS_PER_READ = 100;

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
  invoice_id: string | null;
  deal_id: string | null;
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
  /** The payable, embedded through the payout's foreign key. */
  invoices?: { status: string } | null;
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

/** Commissions are not set up yet (before 0118): every read says so rather than fail. */
export class NotReady extends Error {}

type Answer = { data: unknown; error: { code?: string; message?: string } | null };

function rowsOf<T>(result: Answer): T[] {
  if (result.error) {
    if (commissionsNotReady(result.error)) throw new NotReady();
    throw new Error(result.error.message ?? "commissions not read");
  }
  return (result.data ?? []) as T[];
}

/**
 * Every row of an ordered list, a page of `PAGE_SIZE` at a time, since PostgREST answers no more than that to one read:
 * a list past it would otherwise lose its newest rows without a word. Up to `PAGES_READ` pages.
 */
export async function everyPage<T>(page: (from: number, to: number) => PromiseLike<Answer>): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < PAGES_READ; index += 1) {
    const batch = rowsOf<T>(await page(index * PAGE_SIZE, (index + 1) * PAGE_SIZE - 1));
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Rows by id, `IDS_PER_READ` ids to a read, so no address grows past what a server takes. */
export async function byIds<T>(ids: readonly string[], read: (some: string[]) => PromiseLike<Answer>): Promise<T[]> {
  const unique = [...new Set(ids)];
  const reads: Array<PromiseLike<Answer>> = [];
  for (let start = 0; start < unique.length; start += IDS_PER_READ) reads.push(read(unique.slice(start, start + IDS_PER_READ)));
  return (await Promise.all(reads)).flatMap((answer) => rowsOf<T>(answer));
}

/** How a receivable is named on the page: its memo's first words, else its short id. */
export function receivableLabel(invoice: { id: string; memo: string | null }): string {
  const memo = invoice.memo?.trim();
  return memo ? (memo.length > 60 ? `${memo.slice(0, 57)}…` : memo) : `Invoice ${invoice.id.slice(0, 8)}`;
}

/** Everything the commissions page shows, in the organization in scope. */
export async function readCommissions(orgDb: OrgDb = db()): Promise<CommissionsRead> {
  try {
    // Only what the review shows: every payout (with its payable's status), and the open lines, those in no payout and
    // those in a payout whose payable was rejected. A line in a live payout is counted by the payout's own line_count.
    const [planRows, dealRows, payoutRows, freeLines] = await Promise.all([
      everyPage<PlanDbRow>((from, to) => orgDb.from("commission_plans").select(PLAN_COLUMNS).order("started_at", { ascending: false }).order("id").range(from, to)),
      everyPage<{ plan_id: string; deal_id: string }>((from, to) => orgDb.from("commission_plan_deals").select("plan_id, deal_id").order("id").range(from, to)),
      everyPage<PayoutDbRow>((from, to) =>
        orgDb.from("commission_payouts").select(`${PAYOUT_COLUMNS}, invoices(status)`).order("created_at", { ascending: false }).order("id").range(from, to)
      ),
      everyPage<LineDbRow>((from, to) => orgDb.from("commission_lines").select(LINE_COLUMNS).is("payout_id", null).order("applied_at").order("id").range(from, to)),
    ]);
    const rejected = payoutRows.filter((row) => row.invoices?.status === "rejected").map((row) => row.id);
    const reopened = (
      await Promise.all(
        [...new Set(rejected)].map((payoutId) =>
          everyPage<LineDbRow>((from, to) => orgDb.from("commission_lines").select(LINE_COLUMNS).eq("payout_id", payoutId).order("id").range(from, to))
        )
      )
    ).flat();
    const lines = [...freeLines, ...reopened].map(toLine);
    const receivableIds = lines.flatMap((line) => (line.invoiceId ? [line.invoiceId] : []));
    const [receivableRows, counterpartyRows, deals] = await Promise.all([
      byIds<{ id: string; memo: string | null; amount: string; currency: string | null; counterparty_id: string }>(receivableIds, (some) =>
        orgDb.from("invoices").select("id, memo, amount, currency, counterparty_id").in("id", some)
      ),
      everyPage<{ id: string; name: string; role: string }>((from, to) => orgDb.from("counterparties").select("id, name, role").order("name").order("id").range(from, to)),
      everyPage<{ id: string; title: string; status: string; counterparty_id: string }>((from, to) =>
        orgDb.from("deals").select("id, title, status, counterparty_id, created_at").order("created_at", { ascending: false }).order("id").range(from, to)
      ).catch((error: unknown) => {
        // Deals not read (before 0104, say) leave the plan form without deals; the page still shows the commissions.
        if (error instanceof NotReady) return [];
        throw error;
      }),
    ]);
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
        invoiceStatus: row.invoices?.status ?? null,
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
