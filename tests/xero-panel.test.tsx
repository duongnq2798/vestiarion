import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/xero", () => ({
  syncXeroNowAction: vi.fn(),
  disconnectXeroAction: vi.fn(),
  loadXeroAccountsAction: vi.fn(),
  chooseXeroAccountAction: vi.fn(),
  addXeroBillsAction: vi.fn(),
  dismissXeroBillsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import XeroPanel, { XERO_NOTICES } from "@/components/XeroPanel";
import { XeroBillsReview } from "@/components/XeroBillsReview";
import type { AccountingPanelView } from "@/lib/connectors/panel";
import type { ReviewRowView } from "@/lib/connectors/review";

/**
 * The Xero card in Settings and the review list on Bills & receivables (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X15, X16, X19), for each state and role: not set up yet, not connected, connected, failing, needing a reconnect,
 * disconnected; and the bills to add with their fates.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const connected: Extract<AccountingPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-1",
  status: { tone: "ok", title: "Connected to Demo Company (Global)", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "Demo Company (Global)",
  waiting: 3,
  closedAfterAdded: 0,
  paymentAccount: null,
  sample: { supplier: "PowerDirect", number: "PD-4471", amount: "1250", currency: "USD" },
};

const render = (view: AccountingPanelView, canManage = true, notice: string | null = null) =>
  decode(renderToStaticMarkup(<XeroPanel orgSlug="acme" view={view} canManage={canManage} notice={notice} />));

describe("XeroPanel", () => {
  it("says Xero is not set up yet before the migration has run, and offers nothing", () => {
    const markup = render({ state: "not_set_up" });
    expect(markup).toContain("Xero is not set up on this deployment yet.");
    expect(markup).not.toContain("Connect Xero");
  });

  it("offers Connect Xero to an owner or admin, through the connect page, and says what it does", () => {
    const markup = render({ state: "not_connected" });
    expect(markup).toContain('href="/integrations/xero/connect?org=acme"');
    expect(markup).toContain("Connect Xero");
    expect(markup).toContain("becomes a payable only when you add it");
    expect(render({ state: "not_connected" }, false)).toContain("An owner or admin connects Xero.");
  });

  it("says which organisation, when it last synced, and the bills waiting, with Sync now and Disconnect Xero", () => {
    const markup = render(connected);
    expect(markup).toContain("Connected to Demo Company (Global)");
    expect(markup).toContain("Last synced 5 minutes ago.");
    expect(markup).toContain('href="/o/acme/invoices#from-xero"');
    expect(markup).toContain("3 bills waiting for review");
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Disconnect Xero");
    expect(markup).toContain("Not chosen yet. Nothing is booked to an account nobody chose.");
    expect(markup).toContain("Choose the account");
  });

  it("gives a member who does not manage integrations the status and no control", () => {
    const markup = render(connected, false);
    expect(markup).toContain("Connected to Demo Company (Global)");
    expect(markup).not.toContain("Sync now");
    expect(markup).not.toContain("Disconnect Xero");
    expect(markup).not.toContain("Choose the account");
    expect(markup).toContain("An owner or admin manages Xero.");
  });

  it("puts the failure first when the last sync failed, never connected", () => {
    const markup = render({
      ...connected,
      status: { tone: "error", title: "The last sync with Xero failed", detail: ["Xero did not answer. Vestiarion tries again at 14:05 UTC.", "Last synced 2 hours ago."], reconnect: false },
    });
    expect(markup).toContain("The last sync with Xero failed");
    expect(markup).toContain("Xero did not answer. Vestiarion tries again at 14:05 UTC.");
    expect(markup).not.toContain("Connected to");
  });

  it("asks for a reconnect, with the button, when Xero no longer takes the connection", () => {
    const markup = render({
      ...connected,
      connected: false,
      status: { tone: "error", title: "Xero needs you to reconnect", detail: ["Reconnect Xero to go on bringing its bills in."], reconnect: true },
    });
    expect(markup).toContain("Xero needs you to reconnect");
    expect(markup).toContain("Reconnect Xero");
    expect(markup).not.toContain("Sync now");
  });

  it("names the account payments will be booked to, and says when bills added were closed in Xero", () => {
    const markup = render({ ...connected, paymentAccount: { id: "a", code: "091", name: "Arc USDC wallet", currency: "USD" }, closedAfterAdded: 1 });
    expect(markup).toContain("Arc USDC wallet (091), in USD.");
    expect(markup).toContain("Change the account");
    expect(markup).toContain("1 bill you added was paid, voided or deleted in Xero since.");
  });

  it("says a disconnected connection reads nothing more, and offers to connect again", () => {
    const markup = render({ ...connected, connected: false, revoked: true, status: { tone: "off", title: "Disconnected from Demo Company (Global)", detail: ["Bills already added stay in Vestiarion. Nothing more is read from Xero."], reconnect: false } });
    expect(markup).toContain("Disconnected from Demo Company (Global)");
    expect(markup).toContain("Connect Xero");
    expect(markup).not.toContain("Disconnect Xero");
    expect(markup).not.toContain("waiting for review");
  });

  it("says how connecting went, by the code in ?xero=, and nothing for a code it does not know", () => {
    for (const notice of Object.values(XERO_NOTICES)) {
      expect(render({ state: "not_connected" }, true, Object.keys(XERO_NOTICES).find((code) => XERO_NOTICES[code] === notice) ?? null)).toContain(notice.text);
    }
    expect(renderToStaticMarkup(<XeroPanel orgSlug="acme" view={{ state: "not_connected" }} canManage notice="<script>" />)).not.toContain("<script>");
  });
});

describe("XeroBillsReview", () => {
  const rows: ReviewRowView[] = [
    { id: "row-1", supplier: "PowerDirect Ltd", supplierNew: false, number: "PD-4471", amount: "1250", currency: "USD", usdc: "1250", dueOn: "2026-10-28", status: "add", reason: null },
    { id: "row-2", supplier: "Akiba Parts K.K.", supplierNew: true, number: "AK-77", amount: "98000", currency: "JPY", usdc: null, dueOn: "2026-10-24", status: "error", reason: "This workspace's shadow mode takes bills in USD. Convert the amount to USD or USDC." },
    { id: "row-3", supplier: "SMART Agency", supplierNew: false, number: "SMC-0902", amount: "820.5", currency: "USD", usdc: "820.5", dueOn: "2026-09-20", status: "duplicate", reason: "Already in Vestiarion: same counterparty, amount, due date and reference." },
  ];

  it("lists each bill with its fate, ticks the ones that can be added, and offers to add or dismiss them", () => {
    const markup = decode(renderToStaticMarkup(<XeroBillsReview orgSlug="acme" connectionId="conn-1" organisation="Demo Company (Global)" items={rows} closed={[]} canAdd />));
    expect(markup).toContain("From Xero: 3 bills to add");
    expect(markup).toContain("Demo Company (Global) · nothing is added until you add it");
    expect(markup).toContain("PowerDirect Ltd · PD-4471");
    expect(markup).toContain("1,250.00 USD · due Oct 28");
    expect(markup).toContain("Ready to add, at 1,250.00 USDC");
    expect(markup).toContain("This workspace's shadow mode takes bills in USD.");
    expect(markup).toContain("Already in Vestiarion");
    expect(markup).toContain("Add, goods received");
    expect(markup).toContain("Add, not received yet");
    expect(markup).toContain("Dismiss");
    // Only the bill that can be added is ticked, and only it is sent to Add.
    expect(markup.match(/name="billId" value="row-1"/g)?.length).toBe(3);
    expect(markup).not.toContain('name="billId" value="row-2"');
    expect(markup).toContain('name="goodsReceived" value="true"');
    expect(markup).toContain("Xero approving a bill does not approve its payment: the agent decides it.");
  });

  it("shows a role that does not add records the list and no control", () => {
    const markup = decode(renderToStaticMarkup(<XeroBillsReview orgSlug="acme" connectionId="conn-1" organisation={null} items={rows} closed={[]} canAdd={false} />));
    expect(markup).toContain("PowerDirect Ltd · PD-4471");
    expect(markup).not.toContain("Add, goods received");
    expect(markup).toContain("An owner or admin adds bills from Xero.");
  });

  it("says which bills already added were closed in Xero since", () => {
    const markup = decode(
      renderToStaticMarkup(
        <XeroBillsReview orgSlug="acme" connectionId="conn-1" organisation={null} items={[]} closed={[{ id: "row-9", supplier: "PowerDirect", number: "PD-4471", sourceStatus: "paid" }]} canAdd />
      )
    );
    expect(markup).toContain("Closed in Xero after they were added");
    expect(markup).toContain("PowerDirect · PD-4471: paid in Xero. Look at it in Payables before the agent pays it.");
  });

  it("shows nothing with nothing to say", () => {
    expect(renderToStaticMarkup(<XeroBillsReview orgSlug="acme" connectionId="conn-1" organisation={null} items={[]} closed={[]} canAdd />)).toBe("");
  });
});
