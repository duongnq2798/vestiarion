import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/o/acme/invoices",
}));
vi.mock("@/app/actions/intake", () => ({ createInvoiceAction: vi.fn() }));
vi.mock("@/app/actions/invoice-document", () => ({ readInvoiceDocumentAction: vi.fn() }));
vi.mock("@/app/actions/bill-import", () => ({ checkBillListAction: vi.fn(), importBillListAction: vi.fn() }));
vi.mock("@/app/actions/recurring", () => ({ createRecurringPayableAction: vi.fn(), stopRecurringPayableAction: vi.fn() }));
vi.mock("@/app/actions/deals", () => ({ createDealAction: vi.fn() }));

import { BillsList } from "@/components/bills/BillsList";
import { BillsScreen, type BillsScreenProps } from "@/components/bills/BillsScreen";
import { BillsTabs } from "@/components/bills/BillsTabs";
import { NEW_ITEMS, NewMenu, newItemsFor } from "@/components/bills/NewMenu";
import { nextTabIndex } from "@/components/bills/tab-keys";
import type { BillRowItem, ListData } from "@/components/bills/types";
import { pageOf } from "@/lib/bills-view";

/**
 * Bills & receivables as a summary, three tabs and one New menu (docs/superpowers/specs/2026-10-12-bills-tabs-design.md):
 * the tabs are WAI-ARIA tabs that are links, the filters are links that say which is shown and how many each holds, a
 * row says what is in its way and what to do next before it is opened, the strip shows only when something waits, and
 * New ▾ offers each form the page had.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const slugHref = (path: string) => `/o/acme${path}`;
/** The opening tags of a kind that carry every attribute given, in any order. */
const tags = (markup: string, name: string, ...attributes: string[]) => (markup.match(new RegExp(`<${name}(?:\\s[^>]*)?>`, "g")) ?? []).filter((tag) => attributes.every((attribute) => tag.includes(attribute)));

const TABS: BillsScreenProps["tabs"] = [
  { key: "bills", label: "Bills", href: "/o/acme/invoices", count: 2 },
  { key: "plan", label: "Payment plan", href: "/o/acme/invoices?tab=plan" },
  { key: "receivables", label: "Receivables", href: "/o/acme/invoices?tab=receivables" },
];

const row = (over: Partial<BillRowItem> = {}): BillRowItem => ({
  id: "inv-1",
  name: "Northwind Hosting",
  reference: "INV-104 · Servers, October",
  amount: 1250,
  token: "USDC",
  struck: false,
  date: { label: "Overdue Oct 9, 2026", tone: "held" },
  outcome: "held",
  outcomeLabel: undefined,
  blockers: ["No PO", "Not received"],
  why: null,
  next: { text: "Add the purchase order and goods receipt", tone: "held", opens: "detail" },
  href: "/o/acme/invoices?tab=bills&filter=needs-you&open=inv-1",
  ...over,
});

const list = (over: Partial<ListData> = {}): ListData => ({
  label: "Bills",
  filters: [
    { key: "needs-you", label: "Needs you", count: 2, href: "/o/acme/invoices?tab=bills&filter=needs-you", current: true },
    { key: "upcoming", label: "Upcoming", count: 8, href: "/o/acme/invoices?tab=bills&filter=upcoming", current: false },
    { key: "paid", label: "Paid and closed", count: 40, href: "/o/acme/invoices?tab=bills&filter=paid", current: false },
  ],
  q: null,
  keep: { tab: "bills", filter: "needs-you" },
  clearSearchHref: "/o/acme/invoices?tab=bills&filter=needs-you",
  sort: "due",
  sorts: [
    { value: "due", label: "Due date", href: "/o/acme/invoices?tab=bills&filter=needs-you&sort=due" },
    { value: "amount", label: "Largest amount", href: "/o/acme/invoices?tab=bills&filter=needs-you&sort=amount" },
  ],
  page: pageOf([row(), row({ id: "inv-2", name: "Acme Supplies", blockers: [], why: "Code stopped it: above Acme Supplies's payment limit.", next: { text: "Decide in Approvals", tone: "held", href: "/approvals#payable-inv-2" } })], 1),
  previousHref: null,
  nextHref: null,
  empty: { title: "Nothing needs you", body: "No bill waits for a person." },
  ...over,
});

const SUMMARY: BillsScreenProps["summary"] = {
  needsYou: { count: 2, href: "/o/acme/invoices?tab=bills&filter=needs-you" },
  dueSoon: { count: 1, totals: { usdc: 120, eurc: 0 }, href: "/o/acme/invoices?tab=bills&filter=due-7" },
  overdue: { count: 1, totals: { usdc: 1250, eurc: 40 }, href: "/o/acme/invoices?tab=bills&filter=overdue" },
  receivables: { open: 3, overdue: 1, owed: { usdc: 4200, eurc: 0 }, href: "/o/acme/invoices?tab=receivables&filter=outstanding" },
};

const screen = (over: Partial<BillsScreenProps> = {}) =>
  renderToStaticMarkup(
    <BillsScreen slugHref={slugHref} tab="bills" tabs={TABS} summary={SUMMARY} waiting={[]} reviews={{}} details={{}} bills={{ list: list() }} {...over} />
  );

describe("the tabs", () => {
  it("are WAI-ARIA tabs: a labelled tab list, each tab selected or not and naming its panel, only the selected one in the tab order", () => {
    const markup = renderToStaticMarkup(<BillsTabs tabs={TABS} active="plan" />);
    expect(markup).toMatch(/role="tablist"[^>]*aria-label="Bills and receivables"/);
    const tabs = markup.match(/<a[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(3);
    expect(tabs[1]).toContain('aria-selected="true"');
    expect(tabs[1]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('aria-controls="bills-panel-plan"');
    expect(tabs[1]).toContain('href="/o/acme/invoices?tab=plan"');
    for (const other of [tabs[0], tabs[2]]) {
      expect(other).toContain('aria-selected="false"');
      expect(other).toContain('tabindex="-1"');
    }
    expect(text(markup)).toContain("Bills 2");
  });

  it("move focus with the arrow keys, wrapping, and to the ends with Home and End", () => {
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("Enter", 1, 3)).toBeNull();
  });

  it("show one panel, labelled by its tab, and keep the others present and hidden for the tabs that name them", () => {
    const markup = screen();
    expect(markup).toMatch(/<div role="tabpanel" id="bills-panel-bills" aria-labelledby="bills-tab-bills" tabindex="0"/);
    expect(markup).toMatch(/<div role="tabpanel" id="bills-panel-plan" aria-labelledby="bills-tab-plan" hidden=""><\/div>/);
    expect(markup).toMatch(/<div role="tabpanel" id="bills-panel-receivables" aria-labelledby="bills-tab-receivables" hidden=""><\/div>/);
  });
});

describe("the summary and Waiting for review", () => {
  it("open each figure's tab and filter, and never add USDC and EURC together", () => {
    const markup = screen();
    expect(markup).toContain('href="/o/acme/invoices?tab=bills&amp;filter=needs-you"');
    expect(markup).toContain('href="/o/acme/invoices?tab=bills&amp;filter=due-7"');
    expect(markup).toContain('href="/o/acme/invoices?tab=bills&amp;filter=overdue"');
    expect(markup).toContain('href="/o/acme/invoices?tab=receivables&amp;filter=outstanding"');
    const words = text(markup);
    expect(words).toContain("Due in 7 days");
    expect(words).toContain("1,250.00 USDC + 40.00 EURC");
    expect(words).toContain("Owed to you · 3 open, 1 overdue");
    expect(words).not.toMatch(/cash/i);
  });

  it("shows the strip only when something waits, each item opening its review", () => {
    expect(text(screen())).not.toContain("Waiting for review");
    const markup = screen({
      waiting: [
        { key: "xero", label: "6 from Xero", review: "xero" },
        { key: "book-xero", label: "1 to book in Xero", review: "book-xero" },
        { key: "hubspot", label: "1 won deal in HubSpot", href: "/o/acme/invoices?tab=receivables#from-hubspot" },
      ],
    });
    expect(markup).toMatch(/role="region" aria-label="Waiting for review"/);
    expect(text(markup)).toContain("Waiting for review 6 from Xero · 1 to book in Xero · 1 won deal in HubSpot");
    expect(markup).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>6 from Xero<\/button>/);
    expect(markup).toContain('href="/o/acme/invoices?tab=receivables#from-hubspot"');
  });
});

describe("a tab's list", () => {
  it("names its filters with their counts, marking the one shown", () => {
    const markup = renderToStaticMarkup(<BillsList list={list()} slugHref={slugHref} />);
    expect(markup).toMatch(/<nav aria-label="Filter bills"/);
    expect(tags(markup, "a", 'href="/o/acme/invoices?tab=bills&amp;filter=needs-you"', 'aria-current="true"')).toHaveLength(1);
    expect(tags(markup, "a", "filter=upcoming", "aria-current")).toHaveLength(0);
    expect(text(markup)).toContain("Needs you 2 Upcoming 8 Paid and closed 40");
  });

  it("keeps the tab, filter and sort through a search, and labels the order", () => {
    const markup = renderToStaticMarkup(<BillsList list={list({ keep: { tab: "bills", filter: "paid", sort: "amount" } })} slugHref={slugHref} />);
    expect(tags(markup, "form", 'method="get"', 'role="search"', 'aria-label="Search bills"')).toHaveLength(1);
    expect(markup).toContain('<input type="hidden" name="tab" value="bills"/>');
    expect(markup).toContain('<input type="hidden" name="filter" value="paid"/>');
    expect(markup).toContain('<input type="hidden" name="sort" value="amount"/>');
    expect(markup).toMatch(/<label for="[^"]+"[^>]*>Sort<\/label>/);
  });

  it("puts on each row who, what, when, how much, where it stands, what is in the way and the next action", () => {
    const words = text(renderToStaticMarkup(<BillsList list={list()} slugHref={slugHref} />));
    expect(words).toContain("Northwind Hosting , details");
    expect(words).toContain("INV-104 · Servers, October");
    expect(words).toContain("Overdue Oct 9, 2026");
    expect(words).toContain("1,250.00 USDC");
    expect(words).toContain("Held for you");
    expect(words).toContain("No PO Not received");
    expect(words).toContain("Add the purchase order and goods receipt");
    // A bill with no check in the way says why it waits instead.
    expect(words).toContain("Code stopped it: above Acme Supplies's payment limit.");
  });

  it("opens a row's detail from its name, a link to the detail's own address", () => {
    const markup = renderToStaticMarkup(<BillsList list={list()} slugHref={slugHref} />);
    expect(tags(markup, "a", 'href="/o/acme/invoices?tab=bills&amp;filter=needs-you&amp;open=inv-1"', 'aria-haspopup="dialog"', 'data-row-open="inv-1"')).toHaveLength(1);
    // The next action that is a page of its own links there, in the workspace.
    expect(tags(markup, "a", 'href="/o/acme/approvals#payable-inv-2"')).toHaveLength(1);
  });

  it("says where a page is in the list, with Previous and Next", () => {
    const rows = Array.from({ length: 60 }, (_, index) => row({ id: `inv-${index}` }));
    const words = text(
      renderToStaticMarkup(
        <BillsList list={list({ page: { ...pageOf(rows, 2), rows: pageOf(rows, 2).rows }, previousHref: "/o/acme/invoices?page=1", nextHref: "/o/acme/invoices?tab=bills&page=3" })} slugHref={slugHref} />
      )
    );
    expect(words).toContain("26–50 of 60");
    expect(words).toContain("Page 2 of 3");
    expect(words).toContain("Previous");
    expect(words).toContain("Next");
  });

  it("says what a search found, and how to clear it", () => {
    const words = text(renderToStaticMarkup(<BillsList list={list({ q: "acme", elsewhere: { text: "1 receivable matches too", href: "/o/acme/invoices?tab=receivables&q=acme" } })} slugHref={slugHref} />));
    expect(words).toContain("Showing what matches acme : 2 invoices · 1 receivable matches too");
    expect(words).toContain("Clear search");
  });

  it("says so when a list is empty", () => {
    const words = text(renderToStaticMarkup(<BillsList list={list({ page: pageOf([], 1) })} slugHref={slugHref} />));
    expect(words).toContain("Nothing needs you");
    expect(words).not.toContain("0–0");
  });
});

describe("New ▾", () => {
  it("offers each way to add something the page had, in this order", () => {
    expect(NEW_ITEMS.map((item) => item.label)).toEqual(["Bill to pay", "Invoice to a customer", "From a document", "Import a list", "Recurring", "Deal"]);
  });

  it("offers Deal only where deals are set up", () => {
    expect(newItemsFor(null).map((item) => item.kind)).not.toContain("deal");
    expect(newItemsFor({ customers: [], currencies: ["USDC"], idempotencyKey: "k", today: "2026-10-12" }).map((item) => item.kind)).toContain("deal");
  });

  it("is one button that opens a menu, with no form on the page until one is chosen", () => {
    const markup = renderToStaticMarkup(
      <NewMenu orgSlug="acme" counterparties={[]} importWorkspace={{ shadowOn: false, shadowCurrency: null, network: "arc-testnet" }} deal={null} />
    );
    expect(markup).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*>/);
    expect(text(markup)).toBe("New");
    expect(markup).not.toContain("<form");
  });

  it("is shown to an owner or admin; anyone else reads who adds bills", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/o/[slug]/invoices/page.tsx"), "utf8");
    expect(page).toMatch(/canWrite \? \(\s*\/\/ New ▾[^\n]*\n\s*<NewMenu/);
    expect(page).toContain("Only an owner or admin of this workspace can add or import invoices.");
  });
});
