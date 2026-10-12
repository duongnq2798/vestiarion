import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMembership } from "@/lib/auth/membership";

/**
 * The connectors' marks where the product shows them (docs/superpowers/specs/2026-10-12-integration-marks-design.md):
 * each Settings card, connect page and launch page shows Xero's wordmark, QuickBooks' green qb circle or HubSpot's sprocket beside the tool's name,
 * as decoration (an empty alt, hidden from assistive technology). Xero's wordmark spells its name, so there the name is
 * for screen readers; QuickBooks' circle and HubSpot's sprocket stand before the written name.
 */

const { memberships, pending } = vi.hoisted(() => ({
  memberships: { value: [] as OrgMembership[] },
  pending: { value: null as null | { id: string; choices: Array<{ externalOrgId: string; name: string }> } },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn(async () => ({ id: "u1", email: "dana@example.com" })) }));
vi.mock("@/lib/auth/membership", () => ({ membershipsOf: vi.fn(async () => memberships.value) }));
vi.mock("@/lib/accounting-providers", () => ({ accountingProviderOn: () => true }));
vi.mock("@/lib/hubspot/settings", () => ({ hubspotSettingsFromEnv: () => ({}) }));
vi.mock("@/lib/connectors/token-store", () => ({ pendingChoice: vi.fn(async () => pending.value) }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: (_org: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/components/vx/SiteChrome", () => ({ SiteHeader: () => null, SiteFooter: () => null }));
vi.mock("@/app/actions/accounting", () => ({
  syncAccountingNowAction: vi.fn(),
  disconnectAccountingAction: vi.fn(),
  loadAccountingAccountsAction: vi.fn(),
  chooseAccountingAccountAction: vi.fn(),
}));
vi.mock("@/app/actions/hubspot", () => ({ syncHubSpotNowAction: vi.fn(), disconnectHubSpotAction: vi.fn() }));

import AccountingPanel from "@/components/AccountingPanel";
import HubSpotPanel from "@/components/HubSpotPanel";
import { AccountingConnect } from "@/app/integrations/_accounting/AccountingConnect";
import { AccountingLaunch } from "@/app/integrations/_accounting/AccountingLaunch";
import HubSpotConnectPage from "@/app/integrations/hubspot/connect/page";
import HubSpotIntegrationPage from "@/app/integrations/hubspot/page";
import type { CrmPanelView } from "@/lib/connectors/crm-review";

const workspace = (slug: string): OrgMembership => ({ orgId: `org-${slug}`, slug, name: slug, mode: "live", role: "owner", network: "arc-testnet" });

beforeEach(() => {
  memberships.value = [workspace("acme")];
  pending.value = null;
});

/** The mark and what is written right after it, as `[brand] words`, with the sr-only words marked. */
function marked(markup: string): string[] {
  return [...markup.matchAll(/<img src="\/brands\/([\w-]+)\.svg" alt="" aria-hidden="true"[^>]*\/>(?:<\/span>)?\s*(<span[^>]*>)?([^<]*)/g)].map(
    ([, brand, span, words]) => `[${brand}] ${span?.includes("sr-only") ? `(sr) ${words}` : words}`.trim()
  );
}

/** The heading with this id, or the first h1. */
const heading = (markup: string, tag: "h1" | "h2", id?: string) => {
  const match = markup.match(new RegExp(`<${tag}${id ? `[^>]*id="${id}"` : ""}[^>]*>([^]*?)</${tag}>`));
  if (!match) throw new Error(`no ${tag} ${id ?? ""}`);
  return match[1].replace(/<!-- -->/g, "");
};

describe("the Settings cards", () => {
  it("head Xero's card with its wordmark, the name for screen readers", () => {
    const markup = renderToStaticMarkup(<AccountingPanel provider="xero" orgSlug="acme" view={{ state: "not_connected" }} canManage notice={null} />);
    expect(marked(heading(markup, "h2", "xero-title"))).toEqual(["[xero] (sr) Xero"]);
    expect(heading(markup, "h2", "xero-title")).toMatch(/width="42" height="12"/);
  });

  it("head QuickBooks' card with its qb circle beside the written name", () => {
    const markup = renderToStaticMarkup(<AccountingPanel provider="quickbooks" orgSlug="acme" view={{ state: "not_set_up" }} canManage notice={null} />);
    expect(marked(heading(markup, "h2", "quickbooks-title"))).toEqual(["[quickbooks] QuickBooks"]);
  });

  it("head HubSpot's card with its sprocket beside the written name", () => {
    const markup = renderToStaticMarkup(<HubSpotPanel orgSlug="acme" view={{ state: "not_connected" } as CrmPanelView} canManage notice={null} />);
    expect(marked(heading(markup, "h2", "hubspot-title"))).toEqual(["[hubspot] HubSpot"]);
  });

  it("keep the mark level with Docs, as Slack's does", () => {
    for (const markup of [
      renderToStaticMarkup(<AccountingPanel provider="xero" orgSlug="acme" view={{ state: "not_set_up" }} canManage notice={null} />),
      renderToStaticMarkup(<HubSpotPanel orgSlug="acme" view={{ state: "not_set_up" } as CrmPanelView} canManage notice={null} />),
    ]) {
      // React may add a preload <link> for the image ahead of the section.
      expect(markup).toMatch(/<section[^>]*><div class="[^"]*items-center[^"]*"/);
    }
  });
});

describe("the connect pages", () => {
  const connect = async (provider: "xero" | "quickbooks" | "hubspot", query: Record<string, string> = {}) => {
    const searchParams = Promise.resolve(query);
    return renderToStaticMarkup(provider === "hubspot" ? await HubSpotConnectPage({ searchParams }) : await AccountingConnect({ provider, searchParams }));
  };

  it("show the tool's mark beside Connect Xero, Connect QuickBooks and Connect HubSpot", async () => {
    expect(marked(heading(await connect("xero"), "h1"))).toEqual(["[xero] Connect Xero"]);
    expect(marked(heading(await connect("quickbooks"), "h1"))).toEqual(["[quickbooks] Connect QuickBooks"]);
    expect(marked(heading(await connect("hubspot"), "h1"))).toEqual(["[hubspot] Connect HubSpot"]);
  });

  it("draw the mark at the heading's size, level with its first line when the heading wraps", async () => {
    const h1 = heading(await connect("quickbooks"), "h1");
    expect(h1).toMatch(/^<span class="flex h-8 shrink-0 items-center"><img src="\/brands\/quickbooks\.svg"[^>]*width="24" height="24"/);
    expect(await connect("hubspot")).toMatch(/<h1 class="flex items-start gap-3 text-2xl/);
  });

  it("keep Xero's mark on the organisation pick after Xero", async () => {
    pending.value = { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d04", choices: [{ externalOrgId: "tenant-1", name: "Demo Company (Global)" }] };
    const markup = await connect("xero", { org: "acme", choose: pending.value.id });
    expect(marked(heading(markup, "h1")).map((line) => line.replace(/\s+/g, " "))).toEqual(["[xero] Pick the Xero organisation"]);
  });
});

describe("the launch pages, for a person with several workspaces", () => {
  beforeEach(() => {
    memberships.value = [workspace("acme"), workspace("beta")];
  });

  it("head each page with the tool's mark and name", async () => {
    expect(marked(heading(renderToStaticMarkup(await AccountingLaunch({ provider: "xero" })), "h1"))).toEqual(["[xero] (sr) Xero"]);
    expect(marked(heading(renderToStaticMarkup(await AccountingLaunch({ provider: "quickbooks" })), "h1"))).toEqual(["[quickbooks] QuickBooks"]);
    expect(marked(heading(renderToStaticMarkup(await HubSpotIntegrationPage()), "h1"))).toEqual(["[hubspot] HubSpot"]);
  });
});
