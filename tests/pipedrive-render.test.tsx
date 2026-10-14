import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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
vi.mock("@/app/actions/pipedrive", () => ({
  syncPipedriveNowAction: vi.fn(),
  disconnectPipedriveAction: vi.fn(),
  setPipedriveReceiptsAction: vi.fn(),
  overwritePipedriveReceiptAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CrmDealChanges } from "@/components/CrmDealChanges";
import { CrmDeals } from "@/components/CrmDeals";
import PipedrivePanel, { PIPEDRIVE_NOTICES, VISIBILITY_NOTE } from "@/components/PipedrivePanel";
import type { CrmPanelView, CrmRowView } from "@/lib/connectors/crm-review";
import type { CrmReceiptsPanel } from "@/lib/connectors/crm-receipts-view";
import { noTestAccountRule } from "@/lib/connectors/crm-receipts-view";

/**
 * Pipedrive's card in Settings, its won deals on Bills & receivables, and a deal's changes
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4, P11, P12, P13, P16, P20): Pipedrive's name and
 * never its logo; the reality rule said, and no switch, for a workspace that never writes; what the connection sees. And
 * nothing that moves money imports the CRM code.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const connected: Extract<CrmPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-pd",
  status: { tone: "ok", title: "Connected to Cedar & Co", detail: ["Last synced 2 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "Cedar & Co",
  toPlan: 1,
  changed: 1,
};

const receipts = (fields: Partial<CrmReceiptsPanel> = {}): CrmReceiptsPanel => ({
  on: false,
  allowed: true,
  counts: { written: 0, waiting: 0, failed: 0, conflicts: 0, refused: 0 },
  lastWrittenAt: null,
  account: null,
  rule: null,
  ...fields,
});

const panel = (view: CrmPanelView, options: { canManage?: boolean; notice?: string | null; receipts?: CrmReceiptsPanel | null } = {}) =>
  decode(renderToStaticMarkup(<PipedrivePanel orgSlug="cedar" view={view} canManage={options.canManage ?? true} notice={options.notice ?? null} receipts={options.receipts ?? null} />));

describe("PipedrivePanel", () => {
  it("names Pipedrive without a logo, and connects through the connect page", () => {
    const markup = panel({ state: "not_connected" });
    expect(markup).toContain(">Pipedrive<");
    expect(markup).not.toMatch(/<img/);
    expect(markup).toContain('href="/integrations/pipedrive/connect?org=cedar"');
    expect(markup).toContain('href="/docs/guides/pipedrive"');
    expect(panel({ state: "not_connected" }, { canManage: false })).toContain("An owner or admin connects Pipedrive.");
    expect(panel({ state: "not_set_up" })).toContain("Pipedrive is not set up on this deployment yet.");
  });

  it("says the company, the deals to plan and changed, what the connection sees, with Sync now and Disconnect Pipedrive", () => {
    const markup = panel(connected);
    expect(markup).toContain("Connected to Cedar & Co");
    expect(markup).toContain("1 won deal to plan");
    expect(markup).toContain("1 planned deal changed in Pipedrive since.");
    expect(markup).toContain(VISIBILITY_NOTE);
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Disconnect Pipedrive");
    expect(markup).toContain('href="/o/cedar/invoices?tab=receivables#from-pipedrive"');
    expect(panel(connected, { canManage: false })).not.toContain("Disconnect Pipedrive");
  });

  it("says the scopes refusal in words", () => {
    expect(panel({ state: "not_connected" }, { notice: "scopes" })).toContain(PIPEDRIVE_NOTICES.scopes.text);
  });

  it("offers Write receipts to Pipedrive on Arc mainnet outside shadow mode", () => {
    const markup = panel(connected, { receipts: receipts() });
    expect(markup).toContain("Receipts in Pipedrive");
    expect(markup).toContain("Write receipts to Pipedrive");
  });

  it("offers no switch where writing would never go, and says why", () => {
    const rule = noTestAccountRule("Pipedrive", { network: "arc-testnet", shadow: false });
    const markup = panel(connected, { receipts: receipts({ blocked: true, rule }) });
    expect(markup).toContain(rule);
    expect(rule).toContain("Pipedrive does not say which of its companies are developer sandboxes: Vestiarion never writes these receipts to Pipedrive.");
    expect(markup).not.toContain("Write receipts to Pipedrive");
    // One turned on before shadow mode was, can still be turned off.
    expect(panel(connected, { receipts: receipts({ on: true, blocked: true, rule }) })).toContain("Stop writing to Pipedrive");
    expect(noTestAccountRule("Pipedrive", { network: "arc-mainnet", shadow: true })).toMatch(/^This workspace is in shadow mode/);
  });
});

describe("CrmDeals for Pipedrive", () => {
  const won: CrmRowView = {
    id: "row-42",
    name: "Spring campaign",
    company: "Cedar & Co",
    amount: "200 USD",
    closeOn: "2026-10-14",
    stage: "Negotiation",
    plan: { ok: true },
    linkedDeal: null,
    changes: [],
  };

  it("lists the won deal with Plan collections at Pipedrive's own address, and the open one read-only", () => {
    const markup = decode(
      renderToStaticMarkup(
        <CrmDeals
          provider="pipedrive"
          orgSlug="cedar"
          organisation="Cedar & Co"
          won={[won, { ...won, id: "row-43", name: "No org deal", company: null, plan: { ok: false, reason: "No organization in Pipedrive" } }]}
          open={[{ ...won, id: "row-44", name: "Summer launch", plan: { ok: false, reason: "Not won yet" } }]}
          emails={[{ counterpartyId: "cp-1", name: "Cedar & Co", email: "rosa@cedarandco.example" }]}
          canWrite
        />
      )
    );
    expect(markup).toContain('id="from-pipedrive"');
    expect(markup).toContain("From Pipedrive: 2 won deals");
    expect(markup).toContain('href="/o/cedar/invoices?pipedrive=row-42#plan-from-pipedrive"');
    expect(markup).toContain("No organization in Pipedrive");
    expect(markup).toContain("Not won yet: 1 deal in Pipedrive");
    expect(markup).toContain("Billing emails from Pipedrive");
    expect(markup).toContain("Pipedrive has one for the person on their deal");
    expect(markup).not.toContain("HubSpot");
  });

  it("opens Change deal from Pipedrive's changes", () => {
    const markup = decode(
      renderToStaticMarkup(<CrmDealChanges orgSlug="cedar" dealId="deal-1" label="Pipedrive" words={["Amount: 200 USD to 250 USD."]} seen="k" canWrite active from="pipedrive" />)
    );
    expect(markup).toContain("Changed in Pipedrive");
    expect(markup).toContain('href="/o/cedar/invoices/deals/deal-1?from=pipedrive#change"');
  });
});

describe("nothing that moves or decides money reads the CRM code", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });

  it("keeps the agent, the payments, the allocations and the money commands away from Pipedrive and the CRM connectors", () => {
    const root = process.cwd();
    const watched = [
      ...files(path.join(root, "src", "lib", "agent")),
      ...files(path.join(root, "src", "lib", "allocations")),
      path.join(root, "src", "lib", "payments.ts"),
      ...["payables.ts", "milestones.ts", "allocations.ts", "payment-plan.ts", "bookings.ts"].map((name) => path.join(root, "src", "lib", "commands", name)),
    ];
    for (const file of watched) {
      const source = readFileSync(file, "utf8");
      expect(source, path.relative(root, file)).not.toMatch(/from ["'][^"']*pipedrive[^"']*["']/);
      expect(source, path.relative(root, file)).not.toMatch(/from ["'][^"']*(crm-providers|connectors\/crm)[^"']*["']/);
    }
  });
});
