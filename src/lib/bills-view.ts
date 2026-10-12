/**
 * Which view of Bills & receivables an address asks for (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B3, B4):
 * the tab, the filter, the search, the sort, the page, the bill whose detail is open, a review list or a New form opened
 * over the page. Pure: the page reads the address once, resolves it against what the workspace holds, and every link on
 * the page is written back with `billsHref`, so a refresh, Back and Forward land on the same view. Addresses the page
 * answered before the tabs (`?history=all`, `?status=…`, `?add`, `?hubspot=…`, `?q=…`) land where they meant.
 */

export const BILLS_TABS = ["bills", "plan", "receivables"] as const;
export type BillsTab = (typeof BILLS_TABS)[number];

/** The quick filters over the bills, in the order shown; `due-7` and `overdue` are reached from the cards above the tabs. */
export const BILL_FILTERS = ["needs-you", "upcoming", "scheduled", "paid", "all", "recurring"] as const;
export const BILL_CARD_FILTERS = ["due-7", "overdue"] as const;
export type BillFilter = (typeof BILL_FILTERS)[number] | (typeof BILL_CARD_FILTERS)[number];

export const RECEIVABLE_FILTERS = ["outstanding", "overdue", "received", "all"] as const;
export type ReceivableFilter = (typeof RECEIVABLE_FILTERS)[number];

export const LIST_SORTS = ["due", "recent", "added", "amount", "name"] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/** The review lists the Waiting for review strip opens over the page. */
export const REVIEW_PANELS = ["xero", "quickbooks", "book-xero", "book-quickbooks", "email"] as const;
export type ReviewPanel = (typeof REVIEW_PANELS)[number];

/** What New ▾ opens. */
export const NEW_KINDS = ["bill", "invoice", "document", "import", "recurring", "deal"] as const;
export type NewKind = (typeof NEW_KINDS)[number];

export const PAGE_SIZE = 25;

export const BILL_FILTER_LABELS: Record<BillFilter, string> = {
  "needs-you": "Needs you",
  upcoming: "Upcoming",
  scheduled: "Scheduled",
  paid: "Paid and closed",
  all: "All",
  recurring: "Recurring",
  "due-7": "Due in 7 days",
  overdue: "Overdue",
};

export const RECEIVABLE_FILTER_LABELS: Record<ReceivableFilter, string> = {
  outstanding: "Outstanding",
  overdue: "Overdue",
  received: "Received",
  all: "All",
};

export const SORT_LABELS: Record<ListSort, string> = {
  due: "Due date",
  recent: "Latest first",
  added: "Newest added",
  amount: "Largest amount",
  name: "Counterparty, A to Z",
};

/** The address as asked, each value checked, before it is resolved against the workspace. */
export interface BillsQuery {
  tab: BillsTab | null;
  filter: string | null;
  q: string | null;
  page: number;
  sort: ListSort | null;
  open: string | null;
  review: ReviewPanel | null;
  new: NewKind | null;
  hubspot: string | null;
  /** `?history=all`, from before the tabs: every settled bill. */
  history: boolean;
  /** `?status=…`, from before the tabs: the invoices of one status. */
  status: string | null;
}

/** What the workspace holds that the address is resolved against. */
export interface BillsFacts {
  /** Whether an invoice of this workspace is a bill or a receivable; null when it is none of this workspace's. */
  directionOf: (id: string) => "payable" | "receivable" | null;
  /** The filter an invoice sits in on its own: Needs you, Upcoming or Paid and closed; Outstanding or Received. */
  homeOf: (id: string) => BillFilter | ReceivableFilter | null;
  billCounts: Record<BillFilter, number>;
  receivableCounts: Record<ReceivableFilter, number>;
  /** What a search finds on each side, for an address with a search and no tab. */
  searchHits?: { payables: number; receivables: number };
}

export interface BillsView {
  tab: BillsTab;
  /** None on the payment plan. */
  filter: BillFilter | ReceivableFilter | null;
  q: string | null;
  page: number;
  sort: ListSort;
  open: string | null;
  review: ReviewPanel | null;
  new: NewKind | null;
  hubspot: string | null;
}

type Raw = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | null => (value !== undefined && (list as readonly string[]).includes(value) ? (value as T) : null);

/** An invoice id as the page writes one: letters, digits and dashes, never anything a link could carry further. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

export function readBillsQuery(raw: Raw): BillsQuery {
  const page = Number(first(raw.page));
  const q = (first(raw.q) ?? "").trim();
  const open = first(raw.open);
  const hubspot = first(raw.hubspot);
  const add = first(raw.add);
  return {
    tab: oneOf(BILLS_TABS, first(raw.tab)),
    filter: first(raw.filter) ?? null,
    q: q === "" ? null : q,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    sort: oneOf(LIST_SORTS, first(raw.sort)),
    open: open !== undefined && ID.test(open) ? open : null,
    review: oneOf(REVIEW_PANELS, first(raw.review)),
    // `?add` is the command palette's "Add a bill" (workspace shell design S9); `?add=deal` opened New deal.
    new: oneOf(NEW_KINDS, first(raw.new)) ?? (add === undefined ? null : add === "deal" ? "deal" : "bill"),
    hubspot: hubspot !== undefined && hubspot !== "" ? hubspot : null,
    history: first(raw.history) === "all",
    status: first(raw.status) ?? null,
  };
}

/** The filter that holds the invoices of a status, as `?status=…` showed them before the tabs. */
function legacyStatus(status: string): { tab: BillsTab; filter: BillFilter | ReceivableFilter } | null {
  if (["held", "flagged", "awaiting_info", "processing"].includes(status)) return { tab: "bills", filter: "needs-you" };
  if (status === "scheduled") return { tab: "bills", filter: "scheduled" };
  if (status === "pending" || status === "matched") return { tab: "bills", filter: "upcoming" };
  if (status === "paid") return { tab: "bills", filter: "paid" };
  if (status === "received" || status === "rejected") return { tab: "receivables", filter: "received" };
  return null;
}

const SETTLED_FILTERS: ReadonlySet<string> = new Set(["paid", "received"]);

export function resolveBillsView(query: BillsQuery, facts: BillsFacts): BillsView {
  const openDirection = query.open ? facts.directionOf(query.open) : null;
  const open = openDirection ? query.open : null;
  const legacy = query.status ? legacyStatus(query.status) : null;
  const searchTab: BillsTab | null =
    query.q && facts.searchHits ? (facts.searchHits.payables === 0 && facts.searchHits.receivables > 0 ? "receivables" : "bills") : null;

  const tab: BillsTab =
    query.tab ??
    (openDirection === "receivable" ? "receivables" : openDirection === "payable" ? "bills" : null) ??
    (query.hubspot || query.new === "deal" ? "receivables" : null) ??
    (query.history ? "bills" : null) ??
    legacy?.tab ??
    searchTab ??
    "bills";

  let filter: BillFilter | ReceivableFilter | null = null;
  if (tab === "bills") {
    const asked = oneOf<BillFilter>([...BILL_FILTERS, ...BILL_CARD_FILTERS], query.filter ?? undefined);
    const home = open && openDirection === "payable" ? (facts.homeOf(open) as BillFilter | null) : null;
    const legacyFilter = legacy?.tab === "bills" ? (legacy.filter as BillFilter) : null;
    filter =
      asked ??
      home ??
      (query.history ? "paid" : null) ??
      legacyFilter ??
      (query.q ? "all" : null) ??
      (facts.billCounts["needs-you"] > 0 ? "needs-you" : facts.billCounts.upcoming > 0 ? "upcoming" : "all");
  } else if (tab === "receivables") {
    const asked = oneOf(RECEIVABLE_FILTERS, query.filter ?? undefined);
    const home = open && openDirection === "receivable" ? (facts.homeOf(open) as ReceivableFilter | null) : null;
    const legacyFilter = legacy?.tab === "receivables" ? (legacy.filter as ReceivableFilter) : null;
    filter = asked ?? home ?? legacyFilter ?? (query.q ? "all" : null) ?? (facts.receivableCounts.outstanding > 0 ? "outstanding" : "all");
  }

  return {
    tab,
    filter,
    q: query.q,
    page: query.page,
    sort: query.sort ?? (filter !== null && SETTLED_FILTERS.has(filter) ? "recent" : "due"),
    open,
    review: query.review,
    new: query.new,
    hubspot: query.hubspot,
  };
}

/**
 * A view's address on the page, relative to the workspace (`orgHref(slug, billsHref(...))`), with only what differs from
 * the start: Bills at its default filter is `/invoices`.
 */
export function billsHref(view: { tab: BillsTab; filter?: string | null; q?: string | null; sort?: ListSort | null; page?: number; open?: string | null; review?: ReviewPanel | null }): string {
  const params = new URLSearchParams();
  if (view.tab !== "bills" || view.filter || view.q || view.sort || (view.page ?? 1) > 1) params.set("tab", view.tab);
  if (view.filter) params.set("filter", view.filter);
  if (view.q) params.set("q", view.q);
  if (view.sort) params.set("sort", view.sort);
  if (view.page && view.page > 1) params.set("page", String(view.page));
  if (view.open) params.set("open", view.open);
  if (view.review) params.set("review", view.review);
  const query = params.toString();
  return query ? `/invoices?${query}` : "/invoices";
}

/** One invoice as the filters and sorts weigh it. */
export interface ListRow {
  id: string;
  status: string;
  /** Code refused it (a guardrail), whatever its status. */
  refused: boolean;
  /** The day that matters, `YYYY-MM-DD`: the day it is scheduled for, else its due date. The list sorts by it. */
  due: string;
  /** Its due date, `YYYY-MM-DD`: what Due in 7 days and Overdue count, as the cards above the tabs always did. */
  dueDate: string;
  /** When the agent last decided it, or when it was added. */
  at: string;
  /** When it was added. */
  added: string;
  amount: number;
  name: string;
  /** Made by a recurring schedule. */
  recurring: boolean;
}

/** Bills still to be paid, decided or not, held or scheduled. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "matched", "scheduled", "held", "flagged", "awaiting_info"]);
/** Bills waiting for a person (Approvals). */
export const WAITING_STATUSES: ReadonlySet<string> = new Set(["held", "flagged", "awaiting_info"]);
/** Receivables still owed. */
export const OUTSTANDING_STATUSES: ReadonlySet<string> = new Set(["pending", "matched"]);

/** Whether a bill is in a filter. Due in 7 days and Overdue count every open bill, as the cards above the tabs do. */
export function billFilterMatches(filter: BillFilter, row: ListRow, today: string, inAWeek: string): boolean {
  const open = OPEN_STATUSES.has(row.status);
  switch (filter) {
    case "needs-you":
      return row.refused || WAITING_STATUSES.has(row.status);
    case "upcoming":
      return !row.refused && open && !WAITING_STATUSES.has(row.status);
    case "scheduled":
      return !row.refused && row.status === "scheduled";
    case "paid":
      return !row.refused && !open;
    case "all":
      return true;
    case "recurring":
      return row.recurring;
    case "due-7":
      return open && row.dueDate >= today && row.dueDate <= inAWeek;
    case "overdue":
      return open && row.dueDate < today;
  }
}

export function receivableFilterMatches(filter: ReceivableFilter, row: ListRow, today: string): boolean {
  const outstanding = OUTSTANDING_STATUSES.has(row.status);
  switch (filter) {
    case "outstanding":
      return outstanding;
    case "overdue":
      return outstanding && row.dueDate < today;
    case "received":
      return !outstanding;
    case "all":
      return true;
  }
}

const COMPARE: Record<ListSort, (a: ListRow, b: ListRow) => number> = {
  due: (a, b) => a.due.localeCompare(b.due),
  recent: (a, b) => b.at.localeCompare(a.at),
  added: (a, b) => b.added.localeCompare(a.added),
  amount: (a, b) => b.amount - a.amount,
  name: (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
};

/** A sorted copy; ties keep the order given, which is the due date's. */
export function sortRows<T extends ListRow>(rows: readonly T[], sort: ListSort): T[] {
  return [...rows].sort(COMPARE[sort]);
}

export interface Page<T> {
  rows: T[];
  page: number;
  pages: number;
  /** The first and last row shown, counted from 1; 0 and 0 when there is none. */
  from: number;
  to: number;
  total: number;
}

/** One page of rows; a page past the end shows the last. */
export function pageOf<T>(rows: readonly T[], page: number, size = PAGE_SIZE): Page<T> {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const shown = Math.min(Math.max(1, page), pages);
  const start = (shown - 1) * size;
  const slice = rows.slice(start, start + size);
  return { rows: slice, page: shown, pages, from: slice.length === 0 ? 0 : start + 1, to: start + slice.length, total: rows.length };
}

/** A bill's detail, opened over the list that holds it, at a section of its card: how it was decided, where the payment is. */
export function invoiceHref(id: string, section?: "trail" | "settlement"): string {
  const href = `/invoices?open=${encodeURIComponent(id)}`;
  return section ? `${href}#${section}-${id}` : href;
}

const REVIEW_ANCHORS: Readonly<Record<string, ReviewPanel>> = {
  "from-xero": "xero",
  "from-quickbooks": "quickbooks",
  "to-book-xero": "book-xero",
  "to-book-quickbooks": "book-quickbooks",
  "email-inbox": "email",
};

/** The Receivables tab's sections that links name; `plan-from-hubspot` comes with `?hubspot=`, which opens Receivables itself. */
const RECEIVABLE_ANCHORS: ReadonlySet<string> = new Set(["deals", "from-hubspot", "plan-from-hubspot"]);

/**
 * Where a fragment from before the tabs lands (B4): `#trail-<id>` and `#settlement-<id>` open that bill's detail at that
 * section, a review list's anchor opens it over the page, a Receivables section's anchor opens Receivables, and
 * `#payment-plan` the Payment plan. The fragment never reaches the server, so the page rewrites its own address once
 * loaded: the new search and fragment (`?…#…`), or null when the address already says it.
 */
export function legacyHashHref(hash: string, search: string): string | null {
  const anchor = decodeURIComponent(hash.replace(/^#/, ""));
  if (anchor === "") return null;
  const params = new URLSearchParams(search);
  const write = (keepHash: boolean) => `?${params.toString()}${keepHash ? `#${anchor}` : ""}`;

  const card = /^(trail|settlement)-([A-Za-z0-9-]{1,64})$/.exec(anchor);
  if (card) {
    if (params.get("open") === card[2]) return null;
    params.delete("history");
    params.set("open", card[2]);
    return write(true);
  }
  const review = REVIEW_ANCHORS[anchor];
  if (review) {
    if (params.get("review") === review) return null;
    params.set("review", review);
    return write(false);
  }
  if (RECEIVABLE_ANCHORS.has(anchor)) {
    if (params.get("tab") === "receivables" || params.has("hubspot")) return null;
    params.set("tab", "receivables");
    return write(true);
  }
  if (anchor === "payment-plan") {
    if (params.get("tab") === "plan") return null;
    params.set("tab", "plan");
    return write(false);
  }
  return null;
}
