import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/hubspot", () => ({
  syncHubSpotNowAction: vi.fn(),
  disconnectHubSpotAction: vi.fn(),
  keepCrmChangeAction: vi.fn(),
  fillCrmEmailAction: vi.fn(),
}));
vi.mock("@/app/actions/deals", () => ({ createDealAction: vi.fn(), changeDealAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CrmDealChanges } from "@/components/CrmDealChanges";
import { DealForm } from "@/components/deals/DealForm";
import { HubSpotDeals } from "@/components/HubSpotDeals";
import HubSpotPanel, { HUBSPOT_NOTICES } from "@/components/HubSpotPanel";
import type { CrmPanelView, CrmRowView } from "@/lib/connectors/crm-review";

/**
 * The HubSpot card in Settings, the list on Bills & receivables, the prefilled New deal form and a deal's changes
 * (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H11, H12, H13, H16, H17, H20), for each state and
 * role.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const connected: Extract<CrmPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-1",
  status: { tone: "ok", title: "Connected to northstar-studio.example", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "northstar-studio.example",
  toPlan: 2,
  changed: 1,
};

const panel = (view: CrmPanelView, canManage = true, notice: string | null = null) =>
  decode(renderToStaticMarkup(<HubSpotPanel orgSlug="acme" view={view} canManage={canManage} notice={notice} />));

describe("HubSpotPanel", () => {
  it("says HubSpot is not set up yet before the migration has run, and offers nothing", () => {
    const markup = panel({ state: "not_set_up" });
    expect(markup).toContain("HubSpot is not set up on this deployment yet.");
    expect(markup).not.toContain("Connect HubSpot");
  });

  it("offers Connect HubSpot to an owner or admin through the connect page, and says what it does", () => {
    const markup = panel({ state: "not_connected" });
    expect(markup).toContain('href="/integrations/hubspot/connect?org=acme"');
    expect(markup).toContain("Bring your customers and won deals in from HubSpot.");
    expect(panel({ state: "not_connected" }, false)).toContain("An owner or admin connects HubSpot.");
  });

  it("says which account, the won deals to plan and the planned deals changed, with Sync now and Disconnect HubSpot", () => {
    const markup = panel(connected);
    expect(markup).toContain("Connected to northstar-studio.example");
    expect(markup).toContain("2 won deals to plan");
    expect(markup).toContain('href="/o/acme/invoices?tab=receivables#from-hubspot"');
    expect(markup).toContain("1 planned deal changed in HubSpot since.");
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Disconnect HubSpot");
    const member = panel(connected, false);
    expect(member).toContain("An owner or admin manages HubSpot.");
    expect(member).not.toContain("Sync now");
  });

  it("asks for a reconnect, and says a disconnected account is disconnected", () => {
    const reconnect = panel({ ...connected, connected: false, status: { tone: "error", title: "HubSpot needs you to reconnect", detail: ["x"], reconnect: true } });
    expect(reconnect).toContain("Reconnect HubSpot");
    expect(reconnect).not.toContain("Sync now");
    const revoked = panel({ ...connected, connected: false, revoked: true, status: { tone: "off", title: "Disconnected from northstar-studio.example", detail: [], reconnect: false } });
    expect(revoked).toContain("Connect HubSpot");
    expect(revoked).not.toContain("won deals to plan");
  });

  it("says how connecting went, an account another workspace holds included", () => {
    expect(panel({ state: "not_connected" }, true, "connected")).toContain(HUBSPOT_NOTICES.connected.text);
    expect(panel({ state: "not_connected" }, true, "other_workspace")).toContain("connected to another Vestiarion workspace");
  });
});

const row = (fields: Partial<CrmRowView> = {}): CrmRowView => ({
  id: "row-1",
  name: "Website rebuild",
  company: "Northwind Labs",
  amount: "12,500 USD",
  closeOn: "2026-10-01",
  stage: "Closed Won",
  plan: { ok: true },
  linkedDeal: null,
  changes: [],
  ...fields,
});

const list = (fields: Partial<Parameters<typeof HubSpotDeals>[0]> = {}) =>
  decode(
    renderToStaticMarkup(
      <HubSpotDeals
        orgSlug="acme"
        organisation="northstar-studio.example"
        won={[
          row(),
          row({ id: "row-2", name: "Brand refresh", plan: { ok: false, reason: "No amount in HubSpot" }, amount: null }),
          row({ id: "row-3", name: "Retainer", linkedDeal: { id: "deal-1", title: "Retainer", status: "active" }, plan: { ok: false, reason: "Planned already" }, changes: ["Amount: 12,500 USD to 15,000 USD."] }),
        ]}
        open={[row({ id: "row-4", name: "Discovery sprint", stage: "Contract Sent", plan: { ok: false, reason: "Not won yet" } })]}
        emails={[{ counterpartyId: "cp-1", name: "Northwind Labs", email: "jane.ito@northwind.example" }]}
        canWrite
        {...fields}
      />
    )
  );

describe("HubSpotDeals", () => {
  it("lists the won deals, with Plan collections for one that can be planned and why for one that cannot", () => {
    const markup = list();
    expect(markup).toContain("From HubSpot: 3 won deals");
    expect(markup).toContain("Website rebuild");
    expect(markup).toContain("12,500 USD · closed Oct 1, 2026 · Closed Won");
    expect(markup).toContain('href="/o/acme/invoices?hubspot=row-1#plan-from-hubspot"');
    expect(markup).toContain("Plan collections");
    expect(markup).toContain("No amount in HubSpot");
  });

  it("shows a planned deal as linked, with what HubSpot changed, never planned twice", () => {
    const markup = list();
    expect(markup).toContain("Planned");
    expect(markup).toContain('href="/o/acme/invoices/deals/deal-1?from=hubspot#change"');
    expect(markup).toContain("Changed in HubSpot");
    expect(markup).toContain("Amount: 12,500 USD to 15,000 USD.");
    expect(markup).toContain("1 planned deal changed in HubSpot since.");
    expect(markup.match(/Plan collections/g)).toHaveLength(1);
  });

  it("lists deals not won yet read-only, and the billing emails to confirm", () => {
    const markup = list();
    expect(markup).toContain("Not won yet: 1 deal in HubSpot");
    expect(markup).toContain("Use this email");
    expect(markup).toContain("jane.ito@northwind.example");
    const viewer = list({ canWrite: false });
    expect(viewer).not.toContain("Plan collections");
    expect(viewer).not.toContain("Use this email");
    expect(viewer).toContain("An owner or admin plans it.");
  });
});

describe("the New deal form, filled in from HubSpot", () => {
  it("starts from the deal's customer, title, total, currency, start and reference, and carries its row", () => {
    const markup = decode(
      renderToStaticMarkup(
        <DealForm
          orgSlug="acme"
          customers={[{ id: "c1", name: "Northwind Labs" }]}
          currencies={["USDC", "EURC"]}
          idempotencyKey="key-12345678"
          today="2026-10-12"
          prefill={{
            crmRowId: "row-1",
            label: "HubSpot",
            customerId: "c1",
            customerName: "",
            title: "Website rebuild",
            total: "12500.00",
            currency: "USDC",
            startsOn: "2026-10-01",
            externalRef: "30117482911",
            notes: ["HubSpot says 12,500 USD: planned as 12,500.00 USDC, one for one."],
          }}
        />
      )
    );
    expect(markup).toContain('name="crmRowId" value="row-1"');
    expect(markup).toContain('value="Website rebuild"');
    expect(markup).toContain('value="12500.00"');
    expect(markup).toContain('value="2026-10-01"');
    expect(markup).toContain('value="30117482911"');
    expect(markup).toContain("readOnly");
    expect(markup).toContain("Filled in from HubSpot");
    expect(markup).toContain("HubSpot says 12,500 USD: planned as 12,500.00 USDC, one for one.");
  });
});

describe("CrmDealChanges", () => {
  it("says what changed, that nothing in Vestiarion did, and offers Change deal and Keep the deal as it is", () => {
    const markup = decode(
      renderToStaticMarkup(
        <CrmDealChanges orgSlug="acme" dealId="deal-1" label="HubSpot" words={["Marked lost in HubSpot (Closed Lost). Nothing is cancelled: cancel the deal if it is off."]} canWrite active />
      )
    );
    expect(markup).toContain("Changed in HubSpot");
    expect(markup).toContain("Marked lost in HubSpot (Closed Lost). Nothing is cancelled: cancel the deal if it is off.");
    expect(markup).toContain('href="/o/acme/invoices/deals/deal-1?from=hubspot#change"');
    expect(markup).toContain("Keep the deal as it is");
    const viewer = decode(renderToStaticMarkup(<CrmDealChanges orgSlug="acme" dealId="deal-1" label="HubSpot" words={["x"]} canWrite={false} active />));
    expect(viewer).not.toContain("Keep the deal as it is");
  });
});
