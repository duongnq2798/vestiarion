import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/accounting", () => ({
  syncAccountingNowAction: vi.fn(),
  disconnectAccountingAction: vi.fn(),
  loadAccountingAccountsAction: vi.fn(),
  chooseAccountingAccountAction: vi.fn(),
  addAccountingBillsAction: vi.fn(),
  dismissAccountingBillsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import AccountingPanel, { accountingNotices } from "@/components/AccountingPanel";
import { AccountingBillsReview } from "@/components/AccountingBillsReview";
import type { AccountingPanelView } from "@/lib/connectors/panel";
import type { ReviewRowView } from "@/lib/connectors/review";

/**
 * The QuickBooks card in Settings and its review list on Bills & receivables
 * (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q5, Q9, Q15, Q19): its own card and list, in
 * QuickBooks' words, with every form naming the tool; a company held by another workspace said plainly; a partly paid
 * bill offered at what is left, and one partly paid after it was added flagged.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const connected: Extract<AccountingPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-1",
  status: { tone: "ok", title: "Connected to Sandbox Company_US_1", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "Sandbox Company_US_1",
  waiting: 2,
  closedAfterAdded: 1,
  paymentAccount: null,
  sample: null,
};

const render = (view: AccountingPanelView, canManage = true, notice: string | null = null) =>
  decode(renderToStaticMarkup(<AccountingPanel provider="quickbooks" orgSlug="acme" view={view} canManage={canManage} notice={notice} />));

describe("the QuickBooks card", () => {
  it("is its own section, linked from its guide, offering Connect QuickBooks through its connect page", () => {
    const markup = render({ state: "not_connected" });
    expect(markup).toContain('id="quickbooks"');
    expect(markup).toContain('href="/docs/guides/quickbooks"');
    expect(markup).toContain('href="/integrations/quickbooks/connect?org=acme"');
    expect(markup).toContain("Connect QuickBooks");
    expect(markup).toContain("Bring your open bills in from QuickBooks.");
    expect(render({ state: "not_connected" }, false)).toContain("An owner or admin connects QuickBooks.");
    expect(render({ state: "not_set_up" })).toContain("QuickBooks is not set up on this deployment yet.");
  });

  it("names the company, the bills waiting, and sends QuickBooks with every control's form", () => {
    const markup = render(connected);
    expect(markup).toContain("Connected to Sandbox Company_US_1");
    expect(markup).toContain('href="/o/acme/invoices#from-quickbooks"');
    expect(markup).toContain("2 bills waiting for review");
    expect(markup).toContain("1 bill you added was paid, voided or deleted in QuickBooks since.");
    expect(markup).toContain("Disconnect QuickBooks");
    expect(markup.match(/name="provider" value="quickbooks"/g)?.length).toBe(3);
    expect(markup).not.toContain('value="xero"');
  });

  it("says a company another workspace holds plainly, without naming the workspace", () => {
    expect(render({ state: "not_connected" }, true, "other_workspace")).toContain(
      "This QuickBooks company is connected to another Vestiarion workspace. Disconnect it there first, or connect another company."
    );
    expect(render({ state: "not_connected" }, true, "connected")).toContain("QuickBooks is connected. Its open bills are coming in for review on Bills & receivables.");
    expect(Object.keys(accountingNotices("quickbooks"))).toEqual(Object.keys(accountingNotices("xero")));
  });

  it("asks for a reconnect when QuickBooks no longer takes the connection", () => {
    const markup = render({ ...connected, connected: false, status: { tone: "error", title: "QuickBooks needs you to reconnect", detail: ["x"], reconnect: true } });
    expect(markup).toContain("Reconnect QuickBooks");
    expect(markup).not.toContain("Sync now");
  });
});

describe("the QuickBooks review list", () => {
  const rows: ReviewRowView[] = [
    { id: "row-1", supplier: "PowerDirect Ltd", supplierNew: false, number: "PD-4471", amount: "1250", total: "1250", currency: "USD", usdc: "1250", dueOn: "2026-10-28", status: "add", reason: null },
    { id: "row-2", supplier: "Norton Lumber", supplierNew: true, number: "NL-2210", amount: "400", total: "1000", currency: "USD", usdc: "400", dueOn: "2026-10-20", status: "add", reason: null },
  ];

  it("offers a partly paid bill at what is left, and says so", () => {
    const markup = decode(
      renderToStaticMarkup(<AccountingBillsReview provider="quickbooks" orgSlug="acme" connectionId="conn-1" organisation="Sandbox Company_US_1" items={rows} closed={[]} canAdd />)
    );
    expect(markup).toContain('id="from-quickbooks"');
    expect(markup).toContain("From QuickBooks: 2 bills to add");
    expect(markup).toContain("1,250.00 USD · due Oct 28");
    expect(markup).toContain("400.00 USD left of 1,000.00 · due Oct 20");
    expect(markup.match(/Partly paid in QuickBooks/g)?.length).toBe(1);
    expect(markup).toContain("Ready to add, at 400.00 USDC");
    expect(markup).toContain("A bill being open in QuickBooks does not approve its payment: the agent decides it.");
  });

  it("flags bills added before QuickBooks said they were deleted, or partly paid", () => {
    const markup = decode(
      renderToStaticMarkup(
        <AccountingBillsReview
          provider="quickbooks"
          orgSlug="acme"
          connectionId="conn-1"
          organisation={null}
          items={[]}
          closed={[{ id: "row-9", supplier: "Hicks Hardware", number: "HH-301", sourceStatus: "deleted" }]}
          partlyPaidSince={[{ id: "row-8", supplier: "PowerDirect", number: "PD-4471", currency: "USD", left: "400", added: "1250" }]}
          canAdd
        />
      )
    );
    expect(markup).toContain("Closed in QuickBooks after they were added");
    expect(markup).toContain("Hicks Hardware · HH-301: deleted in QuickBooks. Look at it in Bills before the agent pays it.");
    expect(markup).toContain("Partly paid in QuickBooks after they were added");
    expect(markup).toContain("PowerDirect · PD-4471: 400.00 USD left of the 1,250.00 added. Look at it in Bills before the agent pays it.");
  });

  it("shows nothing with nothing to say", () => {
    expect(renderToStaticMarkup(<AccountingBillsReview provider="quickbooks" orgSlug="acme" connectionId="c" organisation={null} items={[]} closed={[]} partlyPaidSince={[]} canAdd />)).toBe("");
  });
});
