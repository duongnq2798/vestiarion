import { describe, expect, it } from "vitest";
import {
  billFilterMatches,
  invoiceHref,
  legacyHashHref,
  billsHref,
  PAGE_SIZE,
  pageOf,
  readBillsQuery,
  receivableFilterMatches,
  resolveBillsView,
  sortRows,
  type BillFilter,
  type BillsFacts,
  type ListRow,
} from "@/lib/bills-view";

/**
 * Bills & receivables as three tabs (docs/superpowers/specs/2026-10-12-bills-tabs-design.md): the address says which
 * tab, which filter, which search, which page and which bill is open, so a refresh, Back and a link all land on the same
 * view; every address the page answered before still lands where it meant.
 */

const COUNTS: Record<BillFilter, number> = { "needs-you": 2, upcoming: 3, scheduled: 1, paid: 9, all: 14, recurring: 1, "due-7": 2, overdue: 1 };

const facts = (over: Partial<BillsFacts> = {}): BillsFacts => ({
  directionOf: (id) => (id === "pay-1" ? "payable" : id === "rec-1" ? "receivable" : null),
  homeOf: (id) => (id === "pay-1" ? "paid" : id === "rec-1" ? "received" : null),
  billCounts: COUNTS,
  receivableCounts: { outstanding: 2, overdue: 1, received: 4, all: 6 },
  ...over,
});

const view = (raw: Record<string, string | string[] | undefined>, over: Partial<BillsFacts> = {}) => resolveBillsView(readBillsQuery(raw), facts(over));

describe("the address of a view", () => {
  it("opens on Bills, at what needs a person, sorted by the day that matters", () => {
    expect(view({})).toMatchObject({ tab: "bills", filter: "needs-you", sort: "due", page: 1, q: null, open: null });
  });

  it("opens on what is upcoming when nothing needs a person, and on everything when nothing is open", () => {
    expect(view({}, { billCounts: { ...COUNTS, "needs-you": 0 } }).filter).toBe("upcoming");
    expect(view({}, { billCounts: { ...COUNTS, "needs-you": 0, upcoming: 0 } }).filter).toBe("all");
  });

  it("keeps the tab, filter, search, sort and page it names", () => {
    expect(view({ tab: "bills", filter: "paid", q: "acme", sort: "amount", page: "3" })).toMatchObject({ tab: "bills", filter: "paid", q: "acme", sort: "amount", page: 3 });
    expect(view({ tab: "receivables", filter: "overdue" })).toMatchObject({ tab: "receivables", filter: "overdue", sort: "due" });
    expect(view({ tab: "plan" })).toMatchObject({ tab: "plan", filter: null });
  });

  it("lists settled bills and received money latest first unless a sort is named", () => {
    expect(view({ tab: "bills", filter: "paid" }).sort).toBe("recent");
    expect(view({ tab: "receivables", filter: "received" }).sort).toBe("recent");
  });

  it("ignores what it does not know: an unknown tab, filter, sort or page", () => {
    expect(view({ tab: "nope", filter: "outstanding", sort: "sideways", page: "-2" })).toMatchObject({ tab: "bills", filter: "needs-you", sort: "due", page: 1 });
    expect(view({ tab: "receivables", filter: "needs-you" }).filter).toBe("outstanding");
    expect(view({ page: "2.5" }).page).toBe(1);
    expect(view({ tab: ["plan", "bills"] }).tab).toBe("plan");
  });

  it("writes an address with only what differs from the start", () => {
    expect(billsHref({ tab: "bills" })).toBe("/invoices");
    expect(billsHref({ tab: "plan" })).toBe("/invoices?tab=plan");
    expect(billsHref({ tab: "bills", filter: "paid", page: 2 })).toBe("/invoices?tab=bills&filter=paid&page=2");
    expect(billsHref({ tab: "receivables", filter: "overdue", q: "INV 7&8", sort: "amount", open: "rec-1" })).toBe(
      "/invoices?tab=receivables&filter=overdue&q=INV+7%268&sort=amount&open=rec-1"
    );
    expect(billsHref({ tab: "bills", page: 1 })).toBe("/invoices");
  });
});

describe("every address the page answered before", () => {
  it("?history=all: every paid and closed bill", () => {
    expect(view({ history: "all" })).toMatchObject({ tab: "bills", filter: "paid", sort: "recent" });
  });

  it("?status=…: the filter that holds that status", () => {
    expect(view({ status: "held" })).toMatchObject({ tab: "bills", filter: "needs-you" });
    expect(view({ status: "awaiting_info" })).toMatchObject({ tab: "bills", filter: "needs-you" });
    expect(view({ status: "flagged" })).toMatchObject({ tab: "bills", filter: "needs-you" });
    expect(view({ status: "scheduled" })).toMatchObject({ tab: "bills", filter: "scheduled" });
    expect(view({ status: "pending" })).toMatchObject({ tab: "bills", filter: "upcoming" });
    expect(view({ status: "paid" })).toMatchObject({ tab: "bills", filter: "paid" });
    expect(view({ status: "received" })).toMatchObject({ tab: "receivables", filter: "received" });
  });

  it("?q=…: the search, on the tab where it finds something", () => {
    expect(view({ q: "acme" }, { searchHits: { payables: 2, receivables: 1 } })).toMatchObject({ tab: "bills", q: "acme", filter: "all" });
    expect(view({ q: "0xabc" }, { searchHits: { payables: 0, receivables: 1 } })).toMatchObject({ tab: "receivables", q: "0xabc", filter: "all" });
    expect(view({ q: "nothing" }, { searchHits: { payables: 0, receivables: 0 } })).toMatchObject({ tab: "bills", filter: "all" });
  });

  it("?add (the command palette's Add a bill): Bills with the bill form open; ?add=deal: Receivables with the deal form", () => {
    expect(view({ add: "1" })).toMatchObject({ tab: "bills", new: "bill" });
    expect(view({ add: "" })).toMatchObject({ tab: "bills", new: "bill" });
    expect(view({ add: "deal" })).toMatchObject({ tab: "receivables", new: "deal" });
    expect(view({ new: "import" })).toMatchObject({ tab: "bills", new: "import" });
    expect(view({ new: "rocket" }).new).toBeNull();
  });

  it("?hubspot=… (Plan collections from HubSpot): Receivables, with the deal it names", () => {
    expect(view({ hubspot: "row-9" })).toMatchObject({ tab: "receivables", hubspot: "row-9" });
  });

  it("?open=…: the tab and filter that hold that invoice, with its detail open", () => {
    expect(view({ open: "pay-1" })).toMatchObject({ tab: "bills", filter: "paid", open: "pay-1" });
    expect(view({ open: "rec-1" })).toMatchObject({ tab: "receivables", filter: "received", open: "rec-1" });
    expect(view({ tab: "bills", filter: "all", open: "pay-1" })).toMatchObject({ tab: "bills", filter: "all", open: "pay-1" });
    expect(view({ open: "someone-elses" })).toMatchObject({ tab: "bills", open: null });
  });

  it("?review=…: a review list opened over the page", () => {
    expect(view({ review: "xero" }).review).toBe("xero");
    expect(view({ review: "book-quickbooks" }).review).toBe("book-quickbooks");
    expect(view({ review: "elsewhere" }).review).toBeNull();
  });
});

describe("filters", () => {
  const today = "2026-10-12";
  const inAWeek = "2026-10-19";
  const bill = (over: Partial<ListRow> = {}): ListRow => ({ id: "b", status: "pending", refused: false, due: "2026-10-30", at: "2026-10-01T00:00:00Z", added: "2026-10-01T00:00:00Z", amount: 10, name: "Acme", recurring: false, ...over });

  it("Needs you: waiting for a person, or refused by a rule", () => {
    expect(billFilterMatches("needs-you", bill({ status: "held" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("needs-you", bill({ status: "awaiting_info" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("needs-you", bill({ refused: true, status: "pending" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("needs-you", bill(), today, inAWeek)).toBe(false);
  });

  it("Upcoming: open and not waiting; Scheduled: given a day by the agent; Paid and closed: neither", () => {
    expect(billFilterMatches("upcoming", bill(), today, inAWeek)).toBe(true);
    expect(billFilterMatches("upcoming", bill({ status: "scheduled" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("upcoming", bill({ status: "held" }), today, inAWeek)).toBe(false);
    expect(billFilterMatches("scheduled", bill({ status: "scheduled" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("scheduled", bill({ status: "scheduled", refused: true }), today, inAWeek)).toBe(false);
    expect(billFilterMatches("paid", bill({ status: "paid" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("paid", bill({ status: "paid", refused: true }), today, inAWeek)).toBe(false);
  });

  it("Due in 7 days and Overdue count every open bill, as the cards above do", () => {
    expect(billFilterMatches("due-7", bill({ due: "2026-10-12" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("due-7", bill({ due: "2026-10-19", status: "held" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("due-7", bill({ due: "2026-10-20" }), today, inAWeek)).toBe(false);
    expect(billFilterMatches("overdue", bill({ due: "2026-10-11" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("overdue", bill({ due: "2026-10-11", status: "paid" }), today, inAWeek)).toBe(false);
  });

  it("Recurring: made by a recurring schedule; All: everything", () => {
    expect(billFilterMatches("recurring", bill({ recurring: true, status: "paid" }), today, inAWeek)).toBe(true);
    expect(billFilterMatches("recurring", bill(), today, inAWeek)).toBe(false);
    expect(billFilterMatches("all", bill({ status: "paid", refused: true }), today, inAWeek)).toBe(true);
  });

  it("Receivables: outstanding until paid, overdue past its date, received once closed", () => {
    expect(receivableFilterMatches("outstanding", bill({ status: "matched" }), today)).toBe(true);
    expect(receivableFilterMatches("overdue", bill({ due: "2026-10-01" }), today)).toBe(true);
    expect(receivableFilterMatches("overdue", bill({ due: "2026-10-01", status: "received" }), today)).toBe(false);
    expect(receivableFilterMatches("received", bill({ status: "received" }), today)).toBe(true);
    expect(receivableFilterMatches("all", bill({ status: "rejected" }), today)).toBe(true);
  });
});

describe("sorting and pages", () => {
  const rows: ListRow[] = [
    { id: "a", status: "pending", refused: false, due: "2026-10-20", at: "2026-10-03T00:00:00Z", added: "2026-10-01T00:00:00Z", amount: 50, name: "beta", recurring: false },
    { id: "b", status: "scheduled", refused: false, due: "2026-10-14", at: "2026-10-05T00:00:00Z", added: "2026-10-04T00:00:00Z", amount: 900, name: "Alpha", recurring: false },
    { id: "c", status: "paid", refused: false, due: "2026-10-16", at: "2026-10-09T00:00:00Z", added: "2026-09-30T00:00:00Z", amount: 50, name: "gamma", recurring: false },
  ];
  const ids = (list: ListRow[]) => list.map((row) => row.id);

  it("by the day that matters, latest first, newest added, largest amount, or by name", () => {
    expect(ids(sortRows(rows, "due"))).toEqual(["b", "c", "a"]);
    expect(ids(sortRows(rows, "recent"))).toEqual(["c", "b", "a"]);
    expect(ids(sortRows(rows, "added"))).toEqual(["b", "a", "c"]);
    expect(ids(sortRows(rows, "amount"))).toEqual(["b", "a", "c"]);
    expect(ids(sortRows(rows, "name"))).toEqual(["b", "a", "c"]);
  });

  it("never sorts in place", () => {
    sortRows(rows, "amount");
    expect(ids(rows)).toEqual(["a", "b", "c"]);
  });

  it("cuts 25 to a page, and keeps a page past the end on the last one", () => {
    const many = Array.from({ length: 60 }, (_, index) => index);
    expect(PAGE_SIZE).toBe(25);
    expect(pageOf(many, 1)).toMatchObject({ page: 1, pages: 3, from: 1, to: 25, total: 60 });
    expect(pageOf(many, 3)).toMatchObject({ page: 3, from: 51, to: 60 });
    expect(pageOf(many, 3).rows).toHaveLength(10);
    expect(pageOf(many, 9)).toMatchObject({ page: 3 });
    expect(pageOf([], 4)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0, total: 0, rows: [] });
  });
});

describe("anchors from before the tabs (the fragment never reaches the server: the page rewrites it once loaded)", () => {
  it("#trail-… and #settlement-… (toasts, Slack, Telegram, emails, Treasury, evidence): that bill's detail, at that section", () => {
    expect(legacyHashHref("#trail-inv-1", "")).toBe("?open=inv-1#trail-inv-1");
    expect(legacyHashHref("#trail-inv-1", "?history=all")).toBe("?open=inv-1#trail-inv-1");
    expect(legacyHashHref("#settlement-inv-2", "")).toBe("?open=inv-2#settlement-inv-2");
    expect(legacyHashHref("#trail-inv-1", "?open=inv-1")).toBeNull();
  });

  it("#from-xero, #from-quickbooks, #to-book-…, #email-inbox (Settings, Slack): that review list, opened over the page", () => {
    expect(legacyHashHref("#from-xero", "")).toBe("?review=xero");
    expect(legacyHashHref("#from-quickbooks", "")).toBe("?review=quickbooks");
    expect(legacyHashHref("#to-book-xero", "")).toBe("?review=book-xero");
    expect(legacyHashHref("#to-book-quickbooks", "")).toBe("?review=book-quickbooks");
    expect(legacyHashHref("#email-inbox", "")).toBe("?review=email");
    expect(legacyHashHref("#from-xero", "?review=xero")).toBeNull();
  });

  it("#deals, #from-hubspot, #plan-from-hubspot (a deal's page, Settings, Plan collections): Receivables, at that section", () => {
    expect(legacyHashHref("#deals", "")).toBe("?tab=receivables#deals");
    expect(legacyHashHref("#from-hubspot", "")).toBe("?tab=receivables#from-hubspot");
    expect(legacyHashHref("#plan-from-hubspot", "?hubspot=row-1")).toBeNull();
    expect(legacyHashHref("#deals", "?tab=receivables")).toBeNull();
  });

  it("#payment-plan: the Payment plan tab", () => {
    expect(legacyHashHref("#payment-plan", "")).toBe("?tab=plan");
  });

  it("leaves any other fragment alone", () => {
    expect(legacyHashHref("", "")).toBeNull();
    expect(legacyHashHref("#apply-payments-title", "?tab=receivables")).toBeNull();
    expect(legacyHashHref("#trail-<script>", "")).toBeNull();
  });

  it("writes a bill's detail address for the links that open one", () => {
    expect(invoiceHref("inv-1")).toBe("/invoices?open=inv-1");
    expect(invoiceHref("inv-1", "trail")).toBe("/invoices?open=inv-1#trail-inv-1");
    expect(invoiceHref("inv-1", "settlement")).toBe("/invoices?open=inv-1#settlement-inv-1");
  });
});
