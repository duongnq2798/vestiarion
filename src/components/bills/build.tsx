import { billBlockers, billNextStep, collectionState } from "@/components/vx/bill-next-step";
import { stoppedWhy } from "@/components/vx/decision-signals";
import type { Decision } from "@/components/vx/types";
import type { AddedDetails, OnFile } from "@/lib/added-details";
import {
  BILL_CARD_FILTERS,
  BILL_FILTER_LABELS,
  BILL_FILTERS,
  billFilterMatches,
  billsHref,
  LIST_SORTS,
  OPEN_STATUSES,
  OUTSTANDING_STATUSES,
  RECEIVABLE_FILTER_LABELS,
  RECEIVABLE_FILTERS,
  receivableFilterMatches,
  SORT_LABELS,
  type BillFilter,
  type BillsView,
  type ListRow,
  type ListSort,
  type Page,
  type ReceivableFilter,
} from "@/lib/bills-view";
import { plural, utcDay } from "@/lib/copy";
import type { PayLinkState } from "@/lib/platform/pay-links";
import type { InvoiceRow } from "@/lib/queries";
import type { SummaryData, Totals } from "./BillsSummary";
import { NewButton } from "./NewMenu";
import type { BillRowItem, ListData } from "./types";

/**
 * Bills & receivables' rows, lists and figures, from what the page read (docs/superpowers/specs/2026-10-12-bills-tabs-
 * design.md B6, B8–B10). Pure: the page and /docs-shots build them the same way, the one from the workspace, the other
 * from sample data.
 */

/** Rows marked "Just added" while the list shows the newest first. */
export const JUST_ADDED_MS = 10 * 60_000;

/** Sorts by the day that matters: the scheduled day, else the due date. */
export function dueOf(invoice: InvoiceRow): string {
  return (invoice.status === "scheduled" && invoice.scheduled_for ? invoice.scheduled_for : invoice.due_date).slice(0, 10);
}

/** The date a row leads with: the day it is scheduled for, its due date (marked once past), or when it was due. */
export function rowDate(invoice: InvoiceRow, today: string): BillRowItem["date"] {
  if (invoice.status === "scheduled" && invoice.scheduled_for) return { label: `Pays ${utcDay(`${invoice.scheduled_for.slice(0, 10)}T00:00:00Z`)}` };
  if (!OPEN_STATUSES.has(invoice.status)) return { label: `Due ${utcDay(`${invoice.due_date.slice(0, 10)}T00:00:00Z`)}` };
  const due = invoice.due_date.slice(0, 10);
  return due < today ? { label: `Overdue ${utcDay(`${due}T00:00:00Z`)}`, tone: "held" } : { label: `Due ${utcDay(`${due}T00:00:00Z`)}` };
}

/** An invoice as the filters and sorts weigh it, from its decision. */
export function listRowOf(invoice: InvoiceRow, decision: Decision): ListRow {
  return {
    id: invoice.id,
    status: invoice.status,
    refused: decision.outcome === "refused",
    due: dueOf(invoice),
    dueDate: invoice.due_date.slice(0, 10),
    at: decision.at,
    added: invoice.created_at ?? decision.at,
    amount: Number(invoice.amount),
    name: invoice.counterparty_name,
    recurring: Boolean(invoice.recurring_id),
  };
}

export function countBills(rows: readonly ListRow[], today: string, inAWeek: string): Record<BillFilter, number> {
  return Object.fromEntries([...BILL_FILTERS, ...BILL_CARD_FILTERS].map((filter) => [filter, rows.filter((row) => billFilterMatches(filter, row, today, inAWeek)).length])) as Record<BillFilter, number>;
}

export function countReceivables(rows: readonly ListRow[], today: string): Record<ReceivableFilter, number> {
  return Object.fromEntries(RECEIVABLE_FILTERS.map((filter) => [filter, rows.filter((row) => receivableFilterMatches(filter, row, today)).length])) as Record<ReceivableFilter, number>;
}

/** The filter an invoice sits in on its own, for an address that opens it with none named. */
export function homeOf(invoice: InvoiceRow, row: ListRow, today: string, inAWeek: string): BillFilter | ReceivableFilter {
  if (invoice.direction === "receivable") return receivableFilterMatches("outstanding", row, today) ? "outstanding" : "received";
  return billFilterMatches("needs-you", row, today, inAWeek) ? "needs-you" : billFilterMatches("upcoming", row, today, inAWeek) ? "upcoming" : "paid";
}

export interface RowFacts {
  invoice: InvoiceRow;
  /** Its decision with its payment's track, as its card shows it. */
  decision: Decision;
  row: ListRow;
  today: string;
  inAWeek: string;
  /** A bill waiting for a person: what is on file and what was added since the agent's decision. */
  waiting?: { onFile: OnFile; added: AddedDetails | null };
  rule: string | null;
  /** An owner or admin, on a bill with no transfer recorded against it. */
  canWrite: boolean;
  canDecide: boolean;
  /** A receivable: what it still owes when part paid, the deal it came from, its pay link. */
  owedNote?: string | null;
  dealContext?: string | null;
  link?: PayLinkState | null;
  justAdded?: boolean;
  /** Its detail's address. */
  href: string;
}

/** A row before it is opened (B6): who, what, when, how much, where it stands, what is in its way, what to do next. */
export function billRowItem(facts: RowFacts): BillRowItem {
  const { invoice, decision, row } = facts;
  const payable = invoice.direction === "payable";
  const needsYou = payable && billFilterMatches("needs-you", row, facts.today, facts.inAWeek);
  return {
    id: row.id,
    name: invoice.counterparty_name,
    reference: invoice.memo,
    amount: decision.amount ?? null,
    token: decision.token ?? "USDC",
    struck: decision.outcome === "refused",
    date: rowDate(invoice, facts.today),
    outcome: decision.outcome,
    outcomeLabel: decision.outcomeLabel,
    blockers: needsYou ? billBlockers(decision) : [],
    why: needsYou ? stoppedWhy(decision) : null,
    note: payable ? null : (facts.owedNote ?? null),
    context: payable ? null : (facts.dealContext ?? null),
    next: payable
      ? billNextStep(decision, {
          status: invoice.status,
          waiting: facts.waiting,
          rule: facts.rule,
          canWrite: facts.canWrite,
          canDecide: facts.canDecide,
          counterparty: { id: invoice.counterparty_id, name: invoice.counterparty_name },
        })
      : null,
    collection: payable ? null : collectionState(facts.link, facts.today),
    justAdded: facts.justAdded ?? false,
    href: facts.href,
  };
}

/** The address of a view with something changed, in the workspace: every link on the page is written from it. */
export function viewHref(slugHref: (path: string) => string, view: BillsView, sortAsked: ListSort | null) {
  return (change: { filter?: string | null; q?: string | null; sort?: ListSort | null; page?: number; open?: string | null }) =>
    slugHref(billsHref({ tab: view.tab, filter: view.filter, q: view.q, sort: sortAsked, ...change }));
}

export interface ListInput {
  tab: "bills" | "receivables";
  view: BillsView;
  sortAsked: ListSort | null;
  page: Page<BillRowItem>;
  counts: Record<string, number>;
  slugHref: (path: string) => string;
  canWrite: boolean;
  /** Every bill and receivable of the workspace, whatever is shown: what an empty list says. */
  totals: { payables: number; receivables: number };
  /** What the search finds on the other tab. */
  otherMatches: number;
}

/** A tab's list: its filters and their counts, the search, the order, the page shown and the way to the others. */
export function listData({ tab, view, sortAsked, page, counts, slugHref, canWrite, totals, otherMatches }: ListInput): ListData {
  const bills = tab === "bills";
  const here = viewHref(slugHref, view, sortAsked);
  const filter = view.filter as string;
  const keys: readonly string[] = bills ? [...BILL_FILTERS, ...(BILL_CARD_FILTERS as readonly string[]).filter((key) => key === filter)] : RECEIVABLE_FILTERS;
  const labels: Record<string, string> = bills ? BILL_FILTER_LABELS : RECEIVABLE_FILTER_LABELS;
  const noun = bills ? "bill" : "receivable";
  return {
    label: bills ? "Bills" : "Receivables",
    filters: keys.map((key) => ({ key, label: labels[key], count: counts[key] ?? 0, href: here({ filter: key, page: 1, open: null }), current: key === filter })),
    q: view.q,
    keep: { tab, filter, ...(sortAsked ? { sort: sortAsked } : {}) },
    clearSearchHref: here({ q: null, page: 1, open: null }),
    sort: view.sort,
    sorts: LIST_SORTS.map((value) => ({ value, label: SORT_LABELS[value], href: here({ sort: value, page: 1, open: null }) })),
    page,
    previousHref: page.page > 1 ? here({ page: page.page - 1, open: null }) : null,
    nextHref: page.page < page.pages ? here({ page: page.page + 1, open: null }) : null,
    elsewhere:
      view.q && otherMatches > 0
        ? {
            text: bills ? `${otherMatches} ${plural(otherMatches, "receivable matches", "receivables match")} too` : `${otherMatches} ${plural(otherMatches, "bill matches", "bills match")} too`,
            href: slugHref(billsHref({ tab: bills ? "receivables" : "bills", q: view.q })),
          }
        : null,
    empty: view.q
      ? { title: "Nothing matches", body: `No ${noun} under ${labels[filter]} matches this search.` }
      : bills && totals.payables === 0
        ? {
            title: "No bills yet",
            body: canWrite
              ? "Add a bill, have one read from a document, or import a list. The agent decides each one at its next cycle."
              : "An owner or admin of this workspace adds the bills.",
            action: canWrite ? (
              <div className="flex flex-wrap gap-2">
                <NewButton kind="bill">Add a bill</NewButton>
                <NewButton kind="import" variant="secondary">
                  Import a list
                </NewButton>
              </div>
            ) : undefined,
          }
        : !bills && totals.receivables === 0
          ? {
              title: "No receivables yet",
              body: "An invoice to a customer, or a deal's line once released, is listed here until it is paid.",
              action: canWrite ? <NewButton kind="invoice">Invoice a customer</NewButton> : undefined,
            }
          : filter === "all"
            ? { title: `No ${noun}s here`, body: `No ${noun} is listed now.` }
            : { title: `Nothing under ${labels[filter]}`, body: `No ${noun} is in this list now.` },
  };
}

/** An amount in USDC, with any EURC beside it: the two are never added together. */
export function totalsOf(invoices: readonly InvoiceRow[], amountOf: (invoice: InvoiceRow) => number = (invoice) => Number(invoice.amount)): Totals {
  return invoices.reduce((sum, invoice) => (invoice.currency === "EURC" ? { ...sum, eurc: sum.eurc + amountOf(invoice) } : { ...sum, usdc: sum.usdc + amountOf(invoice) }), { usdc: 0, eurc: 0 });
}

/**
 * The figures above the tabs (B10), over every bill and receivable whatever the tab, filter or search shows: what needs
 * a person, what falls due within 7 days, what is overdue, and what customers still owe (`owedOf`, part payments taken off).
 */
export function summaryData(input: {
  payableRows: readonly ListRow[];
  receivableRows: readonly ListRow[];
  invoicesById: ReadonlyMap<string, InvoiceRow>;
  today: string;
  inAWeek: string;
  owedOf: (invoice: InvoiceRow) => number;
  slugHref: (path: string) => string;
}): SummaryData {
  const { today, inAWeek, slugHref } = input;
  const invoicesOf = (rows: readonly ListRow[]) => rows.map((row) => input.invoicesById.get(row.id) as InvoiceRow);
  const needsYou = input.payableRows.filter((row) => billFilterMatches("needs-you", row, today, inAWeek));
  const dueSoon = input.payableRows.filter((row) => billFilterMatches("due-7", row, today, inAWeek));
  const overdue = input.payableRows.filter((row) => billFilterMatches("overdue", row, today, inAWeek));
  const outstanding = input.receivableRows.filter((row) => OUTSTANDING_STATUSES.has(row.status));
  return {
    needsYou: { count: needsYou.length, href: slugHref(billsHref({ tab: "bills", filter: "needs-you" })) },
    dueSoon: { count: dueSoon.length, totals: totalsOf(invoicesOf(dueSoon)), href: slugHref(billsHref({ tab: "bills", filter: "due-7" })) },
    overdue: { count: overdue.length, totals: totalsOf(invoicesOf(overdue)), href: slugHref(billsHref({ tab: "bills", filter: "overdue" })) },
    receivables: {
      open: outstanding.length,
      overdue: outstanding.filter((row) => row.dueDate < today).length,
      owed: totalsOf(invoicesOf(outstanding), input.owedOf),
      href: slugHref(billsHref({ tab: "receivables", filter: "outstanding" })),
    },
  };
}
