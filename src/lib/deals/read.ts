import { db, type OrgDb } from "../dal";
import { inForce, type DealFacts, type DealLine } from "./lines";
import { minorToNumber } from "./money";
import type { RevisionChange } from "./revision";
import type { DealTemplate } from "./schedule";

/**
 * Deals as the workspace in scope keeps them (docs/superpowers/specs/2026-10-12-deal-schedule-design.md): each deal with
 * its versions, every line it ever had and the receivable each released line became. Until migration 0104 runs, every
 * read answers that deals are not set up (D15), so Bills & receivables, Treasury and the payment plan never fail for it.
 */

type PostgrestError = { code?: string; message?: string } | null;

/** PostgREST's or Postgres's word that a table, a column or a function of 0104 is not there yet. */
export function dealsNotReady(error: PostgrestError): boolean {
  if (!error) return false;
  if (["PGRST205", "42P01", "PGRST204", "42703", "PGRST202", "42883"].includes(error.code ?? "")) return true;
  return /deal/.test(error.message ?? "") && /schema cache|does not exist/.test(error.message ?? "");
}

export interface DealVersion {
  version: number;
  kind: "signed" | "revised" | "cancelled" | "reopened";
  totalMinor: number;
  reason: string | null;
  changes: RevisionChange[];
  createdBy: string | null;
  createdAt: string;
}

export interface DealRecord {
  facts: DealFacts;
  title: string;
  customer: { id: string; name: string };
  digits: 0 | 2;
  externalRef: string | null;
  template: DealTemplate;
  createdBy: string | null;
  createdAt: string;
  autoReleaseBy: string | null;
  autoReleaseAt: string | null;
  /** Oldest first. */
  versions: DealVersion[];
}

export type DealsRead = { available: false } | { available: true; deals: DealRecord[] };

const DEAL_COLUMNS =
  "id, counterparty_id, title, currency, minor_digits, total_minor, starts_on, terms_days, external_ref, template, status, current_version, auto_release, auto_release_by, auto_release_at, created_by, created_at, counterparties(name)";
const LINE_COLUMNS =
  "id, deal_id, added_in, position, kind, label, invoice_on, due_on, amount_minor, rounding_minor, replaces, status, ended_in, released_at, released_via";

interface DealRow {
  id: string;
  counterparty_id: string;
  title: string;
  currency: string;
  minor_digits: number;
  total_minor: number | string;
  starts_on: string;
  terms_days: number;
  external_ref: string | null;
  template: DealTemplate;
  status: "active" | "cancelled";
  current_version: number;
  auto_release: boolean;
  auto_release_by: string | null;
  auto_release_at: string | null;
  created_by: string | null;
  created_at: string;
  counterparties: { name: string } | null;
}

interface LineRow {
  id: string;
  deal_id: string;
  added_in: number;
  position: number;
  kind: "charge" | "credit";
  label: string;
  invoice_on: string;
  due_on: string;
  amount_minor: number | string;
  rounding_minor: number | string;
  replaces: string | null;
  status: DealLine["status"];
  ended_in: number | null;
  released_at: string | null;
  released_via: "person" | "schedule" | null;
}

interface VersionRow {
  deal_id: string;
  version: number;
  kind: DealVersion["kind"];
  total_minor: number | string;
  reason: string | null;
  changes: unknown;
  created_by: string | null;
  created_at: string;
}

interface ReceivableRow {
  id: string;
  status: string;
  due_date: string;
  deal_line_id: string;
}

const PAGE = 1000;

/** Every row of a read, a page at a time, or the first error. */
async function all<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PostgrestError }>): Promise<{ rows: T[]; error: PostgrestError }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await read(from, from + PAGE - 1);
    if (page.error) return { rows, error: page.error };
    const data = (page.data ?? []) as T[];
    rows.push(...data);
    if (data.length < PAGE) return { rows, error: null };
  }
}

function toRecords(deals: DealRow[], versions: VersionRow[], lines: LineRow[], receivables: ReceivableRow[]): DealRecord[] {
  const byLine = new Map(receivables.map((row) => [row.deal_line_id, row]));
  return deals.map((deal) => {
    const own = lines.filter((line) => line.deal_id === deal.id);
    return {
      facts: {
        id: deal.id,
        status: deal.status,
        version: deal.current_version,
        totalMinor: Number(deal.total_minor),
        currency: deal.currency,
        startsOn: deal.starts_on,
        termsDays: deal.terms_days,
        autoRelease: deal.auto_release,
        lines: own
          .map((line): DealLine => {
            const receivable = byLine.get(line.id);
            return {
              id: line.id,
              position: line.position,
              kind: line.kind,
              label: line.label,
              invoiceOn: line.invoice_on,
              dueOn: line.due_on,
              amountMinor: Number(line.amount_minor),
              roundingMinor: Number(line.rounding_minor),
              status: line.status,
              addedIn: line.added_in,
              endedIn: line.ended_in,
              replaces: line.replaces,
              releasedAt: line.released_at,
              releasedVia: line.released_via,
              receivable: receivable ? { id: receivable.id, status: receivable.status, dueDate: receivable.due_date } : null,
            };
          })
          .sort((a, b) => a.position - b.position),
      },
      title: deal.title,
      customer: { id: deal.counterparty_id, name: deal.counterparties?.name ?? "a customer" },
      digits: deal.minor_digits === 0 ? 0 : 2,
      externalRef: deal.external_ref,
      template: deal.template,
      createdBy: deal.created_by,
      createdAt: deal.created_at,
      autoReleaseBy: deal.auto_release_by,
      autoReleaseAt: deal.auto_release_at,
      versions: versions
        .filter((version) => version.deal_id === deal.id)
        .map((version) => ({
          version: version.version,
          kind: version.kind,
          totalMinor: Number(version.total_minor),
          reason: version.reason,
          changes: Array.isArray(version.changes) ? (version.changes as RevisionChange[]) : [],
          createdBy: version.created_by,
          createdAt: version.created_at,
        }))
        .sort((a, b) => a.version - b.version),
    };
  });
}

/** The deals named, or every deal of the workspace, newest first; `available: false` before 0104 runs. */
async function readRecords(orgDb: OrgDb, dealId?: string): Promise<DealsRead> {
  const deals = await all<DealRow>((from, to) => {
    const query = orgDb.from("deals").select(DEAL_COLUMNS);
    return (dealId ? query.eq("id", dealId) : query).order("created_at", { ascending: false }).order("id", { ascending: true }).range(from, to);
  });
  if (dealsNotReady(deals.error)) return { available: false };
  if (deals.error) throw new Error(deals.error.message ?? "deals not read");
  if (deals.rows.length === 0) return { available: true, deals: [] };
  const ids = deals.rows.map((deal) => deal.id);
  const [versions, lines, receivables] = await Promise.all([
    all<VersionRow>((from, to) =>
      (dealId ? orgDb.from("deal_versions").select("deal_id, version, kind, total_minor, reason, changes, created_by, created_at").eq("deal_id", dealId) : orgDb.from("deal_versions").select("deal_id, version, kind, total_minor, reason, changes, created_by, created_at"))
        .order("version", { ascending: true })
        .range(from, to)
    ),
    all<LineRow>((from, to) => (dealId ? orgDb.from("deal_lines").select(LINE_COLUMNS).eq("deal_id", dealId) : orgDb.from("deal_lines").select(LINE_COLUMNS)).order("position", { ascending: true }).range(from, to)),
    all<ReceivableRow>((from, to) =>
      (dealId ? orgDb.from("invoices").select("id, status, due_date, deal_line_id").eq("deal_id", dealId) : orgDb.from("invoices").select("id, status, due_date, deal_line_id").not("deal_line_id", "is", null))
        .order("id", { ascending: true })
        .range(from, to)
    ),
  ]);
  for (const read of [versions, lines, receivables]) {
    if (dealsNotReady(read.error)) return { available: false };
    if (read.error) throw new Error(read.error.message ?? "deals not read");
  }
  const known = new Set(ids);
  return { available: true, deals: toRecords(deals.rows, versions.rows.filter((row) => known.has(row.deal_id)), lines.rows.filter((row) => known.has(row.deal_id)), receivables.rows) };
}

/** Every deal of the workspace, newest first. */
export async function readDeals(orgDb: OrgDb = db()): Promise<DealsRead> {
  return readRecords(orgDb);
}

/** One deal; null inside `available: true` when the workspace has no such deal (another workspace's included). */
export async function readDeal(dealId: string, orgDb: OrgDb = db()): Promise<{ available: false } | { available: true; deal: DealRecord | null }> {
  // A malformed id is no deal, never a query Postgres refuses.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dealId)) {
    const ready = await readRecords(orgDb, "00000000-0000-4000-8000-000000000000");
    return ready.available ? { available: true, deal: null } : ready;
  }
  const read = await readRecords(orgDb, dealId);
  if (!read.available) return read;
  return { available: true, deal: read.deals[0] ?? null };
}

/** A line not invoiced yet, as the cash outlook, the cash scenarios and the payment plan list it apart (D14). */
export interface PlannedDealLine {
  id: string;
  dealId: string;
  /** "Customer: deal title". */
  label: string;
  line: string;
  customerId: string;
  invoiceOn: string;
  dueOn: string;
  /** In the deal's currency. */
  amount: number;
  currency: string;
}

/** The planned charges of every active deal, from records already read. */
export function plannedLinesOf(deals: DealRecord[]): PlannedDealLine[] {
  return deals
    .filter((deal) => deal.facts.status === "active")
    .flatMap((deal) =>
      inForce(deal.facts.lines)
        .filter((line) => line.status === "planned" && line.kind === "charge")
        .map((line) => ({
          id: line.id,
          dealId: deal.facts.id,
          label: `${deal.customer.name}: ${deal.title}`,
          line: line.label,
          customerId: deal.customer.id,
          invoiceOn: line.invoiceOn,
          dueOn: line.dueOn,
          amount: minorToNumber(line.amountMinor, deal.digits),
          currency: deal.facts.currency,
        }))
    )
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/** The planned lines of the workspace's deals; null when they could not be read or deals are not set up. Best effort. */
export async function readPlannedDealLines(orgDb: OrgDb = db()): Promise<PlannedDealLine[] | null> {
  try {
    const read = await readDeals(orgDb);
    return read.available ? plannedLinesOf(read.deals) : null;
  } catch (error) {
    console.error("deals: planned lines not read", error instanceof Error ? error.message : error);
    return null;
  }
}

/** What a receivable made from a deal line shows of its deal: the deal, the line, and its place among the deal's charges. */
export interface DealLink {
  dealId: string;
  title: string;
  line: string;
  /** 1-based, among the charges in force by invoice day. */
  index: number;
  count: number;
}

/** Each receivable made from a deal line, by the receivable's id, from records already read. */
export function dealLinksOf(deals: DealRecord[]): Map<string, DealLink> {
  const links = new Map<string, DealLink>();
  for (const deal of deals) {
    const charges = inForce(deal.facts.lines)
      .filter((line) => line.kind === "charge")
      .sort((a, b) => a.invoiceOn.localeCompare(b.invoiceOn) || a.position - b.position);
    for (const line of deal.facts.lines) {
      if (!line.receivable) continue;
      const index = charges.findIndex((charge) => charge.id === line.id);
      links.set(line.receivable.id, { dealId: deal.facts.id, title: deal.title, line: line.label, index: index + 1, count: charges.length });
    }
  }
  return links;
}
