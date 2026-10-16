import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/hubspot", () => ({
  syncHubSpotNowAction: vi.fn(),
  disconnectHubSpotAction: vi.fn(),
  keepCrmChangeAction: vi.fn(),
  fillCrmEmailAction: vi.fn(),
  setHubSpotReceiptsAction: vi.fn(),
  overwriteHubSpotReceiptAction: vi.fn(),
}));
vi.mock("@/app/actions/zohocrm", () => ({ syncZohoCrmNowAction: vi.fn(), disconnectZohoCrmAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CrmDeals } from "@/components/CrmDeals";
import ZohoCrmPanel, { ZOHO_CRM_NOTICES, ZOHO_CRM_VISIBILITY_NOTE } from "@/components/ZohoCrmPanel";
import type { CrmPanelView } from "@/lib/connectors/crm-review";

/**
 * Zoho CRM's card in Settings and its won deals on Bills & receivables
 * (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4, C12, C14, C16): its mark beside its name, its
 * connect page, what the connection sees, and nothing about writing, since it writes nothing.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const connected: Extract<CrmPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-zc",
  status: { tone: "ok", title: "Connected to Lumen Holdings", detail: ["Last synced 2 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "Lumen Holdings",
  toPlan: 2,
  changed: 1,
};

const panel = (view: CrmPanelView, options: { canManage?: boolean; notice?: string | null } = {}) =>
  decode(renderToStaticMarkup(<ZohoCrmPanel orgSlug="lumen" view={view} canManage={options.canManage ?? true} notice={options.notice ?? null} />));

describe("ZohoCrmPanel", () => {
  it("names Zoho CRM beside its mark, and connects through its connect page", () => {
    const markup = panel({ state: "not_connected" });
    expect(markup).toContain('id="zohocrm"');
    expect(markup).toMatch(/data-brand="zohocrm-lockup"/);
    expect(markup).toContain('href="/integrations/zohocrm/connect?org=lumen"');
    expect(markup).toContain('href="/docs/guides/zohocrm"');
    expect(markup).toContain("Connect Zoho CRM");
    expect(panel({ state: "not_connected" }, { canManage: false })).toContain("An owner or admin connects Zoho CRM.");
    expect(panel({ state: "not_set_up" })).toContain("Zoho CRM is not set up on this deployment yet.");
  });

  it("says the organization, the deals to plan and changed, what it sees, with Sync now and Disconnect Zoho CRM, and nothing about writing", () => {
    const markup = panel(connected);
    expect(markup).toContain("Connected to Lumen Holdings");
    expect(markup).toContain("2 won deals to plan");
    expect(markup).toContain("1 planned deal changed in Zoho CRM since.");
    expect(markup).toContain('href="/o/lumen/invoices?tab=receivables#from-zohocrm"');
    expect(markup).toContain(ZOHO_CRM_VISIBILITY_NOTE);
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Disconnect Zoho CRM");
    expect(markup).not.toMatch(/Write receipts|Receipts in Zoho CRM|Stop writing/);
    expect(panel(connected, { canManage: false })).toContain("An owner or admin manages Zoho CRM.");
  });

  it("asks for a reconnect, and says how connecting went", () => {
    const markup = panel({ ...connected, connected: false, status: { tone: "error", title: "Zoho CRM needs you to reconnect", detail: [], reconnect: true } });
    expect(markup).toContain("Reconnect Zoho CRM");
    expect(markup).not.toContain("Sync now");
    expect(panel({ state: "not_connected" }, { notice: "connected" })).toContain(ZOHO_CRM_NOTICES.connected.text);
    expect(panel({ state: "not_connected" }, { notice: "nonsense" })).not.toContain('role="status"');
  });
});

describe("Zoho CRM's won deals on Bills & receivables", () => {
  it("says there are none yet in Zoho CRM's words", () => {
    const markup = decode(renderToStaticMarkup(<CrmDeals provider="zohocrm" orgSlug="lumen" organisation="Lumen Holdings" won={[]} open={[]} emails={[]} canWrite />));
    expect(markup).toContain('id="from-zohocrm"');
    expect(markup).toContain("No won deals from Zoho CRM yet. A deal moved to a Closed Won stage there comes in at the next sync, within 15 minutes.");
  });
});
