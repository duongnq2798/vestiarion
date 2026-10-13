import { db, type OrgDb } from "../dal";
import type { CostLink, DealCost } from "./costs";
import { paidOnArc } from "./money";
import type { DealRecord } from "./read";

/**
 * A deal's planned costs as the workspace in scope keeps them (docs/superpowers/specs/2026-10-13-deal-cash-readiness-
 * design.md K1, K2, K9), each with the payable or milestone it became, read now and in the deal's currency's minor units.
 * Until migration 0108 runs, every read answers that costs are not set up, so the deal page and the deals list stand
 * without them.
 */

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's or Postgres's word that 0108's table is not there yet. */
export function costsNotReady(error: PostgrestError): boolean {
  if (!error) return false;
  if (["PGRST205", "42P01", "PGRST204", "42703", "PGRST200"].includes(error.code ?? "")) return true;
  return /deal_costs/.test(error.message ?? "") && /schema cache|does not exist/.test(error.message ?? "");
}

export const COST_COLUMNS = "id, deal_id, label, counterparty_id, amount_minor, expected_on, no_document, invoice_id, milestone_id, removed_at, created_by, created_at, counterparties(name)";

export interface CostRow {
  id: string;
  deal_id: string;
  label: string;
  counterparty_id: string | null;
  amount_minor: number | string;
  expected_on: string;
  no_document: boolean;
  invoice_id: string | null;
  milestone_id: string | null;
  removed_at: string | null;
  created_by: string | null;
  created_at: string;
  counterparties: { name: string } | null;
}

export interface LinkedPayableRow {
  id: string;
  amount: number | string;
  currency: string | null;
  original_amount?: number | string | null;
  original_currency?: string | null;
  status: string;
  due_date: string;
  scheduled_for: string | null;
  settled_at: string | null;
  paid_amount?: number | string | null;
  memo: string | null;
  counterparties: { name: string } | null;
}

export interface LinkedMilestoneRow {
  id: string;
  title: string;
  amount: number | string;
  status: string;
  settled_at: string | null;
  counterparties: { name: string } | null;
}

export const PAYABLE_COLUMNS = "id, amount, currency, original_amount, original_currency, status, due_date, scheduled_for, settled_at, paid_amount, memo, counterparties(name)";
export const MILESTONE_COLUMNS = "id, title, amount, status, settled_at, counterparties(name)";

const toMinor = (amount: number | string, digits: number) => Math.round(Number(amount) * 10 ** digits);

/**
 * A payable's amount in the deal's currency's minor units: its own amount when it is in that currency, the amount it was
 * written in when a shadow-mode bill was written in it; null otherwise (K2).
 */
export function payableMinor(row: Pick<LinkedPayableRow, "amount" | "currency" | "original_amount" | "original_currency">, deal: { currency: string; digits: number }): number | null {
  if (paidOnArc(deal.currency)) return (row.currency ?? "USDC") === deal.currency ? toMinor(row.amount, deal.digits) : null;
  return row.original_currency === deal.currency && row.original_amount != null ? toMinor(row.original_amount, deal.digits) : null;
}

export function linkOfPayable(row: LinkedPayableRow, deal: { currency: string; digits: number }): CostLink {
  const amountMinor = payableMinor(row, deal);
  // What left on Arc, after a discount, is in the payable's own currency: the deal's when that is USDC or EURC.
  const paidMinor = row.paid_amount != null && paidOnArc(deal.currency) && amountMinor !== null ? toMinor(row.paid_amount, deal.digits) : null;
  return {
    kind: "payable",
    id: row.id,
    counterpartyName: row.counterparties?.name ?? "a vendor",
    memo: row.memo,
    status: row.status,
    dueOn: row.due_date.slice(0, 10),
    scheduledFor: row.scheduled_for ? row.scheduled_for.slice(0, 10) : null,
    settledOn: row.settled_at ? row.settled_at.slice(0, 10) : null,
    amountMinor,
    paidMinor,
  };
}

export function linkOfMilestone(row: LinkedMilestoneRow, deal: { currency: string; digits: number }): CostLink {
  return {
    kind: "milestone",
    id: row.id,
    title: row.title,
    contractorName: row.counterparties?.name ?? "a contractor",
    status: row.status,
    settledOn: row.settled_at ? row.settled_at.slice(0, 10) : null,
    // A milestone is paid in USDC.
    amountMinor: deal.currency === "USDC" ? toMinor(row.amount, deal.digits) : null,
  };
}

export function toCost(row: CostRow, link: CostLink | null): DealCost {
  return {
    id: row.id,
    label: row.label,
    counterparty: row.counterparty_id ? { id: row.counterparty_id, name: row.counterparties?.name ?? "a counterparty" } : null,
    amountMinor: Number(row.amount_minor),
    expectedOn: row.expected_on,
    noDocument: row.no_document,
    createdAt: row.created_at,
    createdBy: row.created_by,
    removedAt: row.removed_at,
    link,
  };
}

export type CostsRead = { available: false } | { available: true; byDeal: Map<string, DealCost[]> };

const PAGE = 1000;

/** The costs of the deals given (of one of them, with `dealId`), each with what it became; oldest first. */
export async function readDealCosts(deals: readonly DealRecord[], orgDb: OrgDb = db(), dealId?: string): Promise<CostsRead> {
  const rows: CostRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const query = orgDb.from("deal_costs").select(COST_COLUMNS);
    const page = await (dealId ? query.eq("deal_id", dealId) : query).order("created_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (costsNotReady(page.error)) return { available: false };
    if (page.error) throw new Error(page.error.message ?? "deal costs not read");
    const data = (page.data ?? []) as unknown as CostRow[];
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  const dealOf = new Map(deals.map((deal) => [deal.facts.id, { currency: deal.facts.currency, digits: deal.digits }]));
  const invoiceIds = [...new Set(rows.flatMap((row) => (row.invoice_id ? [row.invoice_id] : [])))];
  const milestoneIds = [...new Set(rows.flatMap((row) => (row.milestone_id ? [row.milestone_id] : [])))];
  const [payables, milestones] = await Promise.all([
    invoiceIds.length > 0 ? orgDb.from("invoices").select(PAYABLE_COLUMNS).in("id", invoiceIds) : Promise.resolve({ data: [], error: null }),
    milestoneIds.length > 0 ? orgDb.from("milestones").select(MILESTONE_COLUMNS).in("id", milestoneIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (payables.error) throw new Error(payables.error.message ?? "linked bills not read");
  if (milestones.error) throw new Error(milestones.error.message ?? "linked milestones not read");
  const payableById = new Map(((payables.data ?? []) as unknown as LinkedPayableRow[]).map((row) => [row.id, row]));
  const milestoneById = new Map(((milestones.data ?? []) as unknown as LinkedMilestoneRow[]).map((row) => [row.id, row]));

  const byDeal = new Map<string, DealCost[]>();
  for (const row of rows) {
    const deal = dealOf.get(row.deal_id);
    if (!deal) continue;
    const payable = row.invoice_id ? payableById.get(row.invoice_id) : undefined;
    const milestone = row.milestone_id ? milestoneById.get(row.milestone_id) : undefined;
    const link = payable ? linkOfPayable(payable, deal) : milestone ? linkOfMilestone(milestone, deal) : null;
    byDeal.set(row.deal_id, [...(byDeal.get(row.deal_id) ?? []), toCost(row, link)]);
  }
  return { available: true, byDeal };
}

/** A bill or milestone a cost may be linked to (K2): in the deal's currency, not rejected or closed, backing no cost yet. */
export interface LinkCandidate {
  kind: "payable" | "milestone";
  id: string;
  /** "Northwind Hosting · 1,200.00 USDC · due Oct 20, 2026 · held". */
  name: string;
  counterpartyId: string | null;
  amountMinor: number;
}

/** At most this many of each, newest first: the form's lists stay short. */
export const CANDIDATES_READ = 100;

/** The payables and milestones a cost of this deal may be linked to, newest first. */
export async function readLinkCandidates(
  deal: Pick<DealRecord, "facts" | "digits">,
  words: (row: { name: string; amountMinor: number; status: string; dueOn: string | null; kind: "payable" | "milestone" }) => string,
  orgDb: OrgDb = db()
): Promise<{ available: false } | { available: true; candidates: LinkCandidate[] }> {
  const taken = await orgDb.from("deal_costs").select("invoice_id, milestone_id").is("removed_at", null).or("invoice_id.not.is.null,milestone_id.not.is.null").limit(5000);
  if (costsNotReady(taken.error)) return { available: false };
  if (taken.error) throw new Error(taken.error.message ?? "deal cost links not read");
  const takenRows = (taken.data ?? []) as Array<{ invoice_id: string | null; milestone_id: string | null }>;
  const takenIds = new Set(takenRows.flatMap((row) => [row.invoice_id, row.milestone_id].filter((id): id is string => id !== null)));
  const currency = { currency: deal.facts.currency, digits: deal.digits };

  const payableQuery = orgDb.from("invoices").select(`${PAYABLE_COLUMNS}, counterparty_id`).eq("direction", "payable").neq("status", "rejected");
  const payables = await (paidOnArc(deal.facts.currency) ? payableQuery.eq("currency", deal.facts.currency) : payableQuery.eq("original_currency", deal.facts.currency))
    .order("created_at", { ascending: false })
    .limit(CANDIDATES_READ);
  if (payables.error) throw new Error(payables.error.message ?? "bills not read");
  const candidates: LinkCandidate[] = [];
  for (const row of (payables.data ?? []) as unknown as Array<LinkedPayableRow & { counterparty_id: string }>) {
    const amountMinor = payableMinor(row, currency);
    if (takenIds.has(row.id) || amountMinor === null) continue;
    const name = row.counterparties?.name ?? "a vendor";
    candidates.push({ kind: "payable", id: row.id, counterpartyId: row.counterparty_id, amountMinor, name: words({ name, amountMinor, status: row.status, dueOn: row.due_date.slice(0, 10), kind: "payable" }) });
  }
  if (deal.facts.currency === "USDC") {
    const milestones = await orgDb.from("milestones").select(`${MILESTONE_COLUMNS}, contractor_id`).neq("status", "closed").order("created_at", { ascending: false }).limit(CANDIDATES_READ);
    if (milestones.error) throw new Error(milestones.error.message ?? "milestones not read");
    for (const row of (milestones.data ?? []) as unknown as Array<LinkedMilestoneRow & { contractor_id: string }>) {
      if (takenIds.has(row.id)) continue;
      const amountMinor = toMinor(row.amount, deal.digits);
      const name = `${row.counterparties?.name ?? "a contractor"}: ${row.title}`;
      candidates.push({ kind: "milestone", id: row.id, counterpartyId: row.contractor_id, amountMinor, name: words({ name, amountMinor, status: row.status, dueOn: null, kind: "milestone" }) });
    }
  }
  return { available: true, candidates };
}
