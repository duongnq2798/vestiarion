import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMembership } from "@/lib/auth/membership";

/**
 * Getting from a Settings card to its connect page (Xero connector X4; QuickBooks Q4; HubSpot H4): every Connect,
 * Reconnect and Allow link names the workspace it was opened from, the connect page picks it, and a person who may
 * manage integrations in one workspace only finds it picked without being asked. The workspace choices and I agree are
 * real inputs with labels, so clicking the words picks them, the keyboard works as in any form, and the page works
 * before its JavaScript has loaded.
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
import HubSpotConnectPage from "@/app/integrations/hubspot/connect/page";
import type { AccountingPanelView } from "@/lib/connectors/panel";
import type { CrmPanelView } from "@/lib/connectors/crm-review";

const workspace = (slug: string, role: OrgMembership["role"] = "owner"): OrgMembership => ({
  orgId: `org-${slug}`,
  slug,
  name: slug === "acme" ? "Acme Studio" : slug === "beta" ? "Beta Works" : slug,
  mode: "live",
  role,
  network: "arc-testnet",
});

beforeEach(() => {
  memberships.value = [];
  pending.value = null;
});

const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*\/integrations\/[^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));

/** Every `<input>` the markup has, as its attributes. */
function inputs(markup: string): Array<Record<string, string>> {
  return [...markup.matchAll(/<input\b([^>]*)>/g)].map((match) =>
    Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((attribute) => [attribute[1], attribute[2] ?? ""]))
  );
}

/** The text of the `<label>` that names an input, by its `for`. */
function labelFor(markup: string, id: string): string | null {
  const match = markup.match(new RegExp(`<label[^>]*for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^]*?)</label>`));
  return match ? match[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim() : null;
}

const accountingView = (fields: Record<string, unknown> = {}) =>
  ({
    state: "connection",
    connectionId: "conn-1",
    status: { tone: "ok", title: "Connected to Demo Company (Global)", detail: [], reconnect: false },
    connected: true,
    revoked: false,
    organisation: "Demo Company (Global)",
    waiting: 0,
    closedAfterAdded: 0,
    paymentAccount: null,
    sample: null,
    ...fields,
  }) as AccountingPanelView;

describe("the Settings cards' links to a connect page", () => {
  it("name the workspace on Connect, Reconnect and Allow Vestiarion to book payments, for Xero and QuickBooks", () => {
    for (const provider of ["xero", "quickbooks"] as const) {
      const panel = (view: AccountingPanelView) =>
        hrefs(renderToStaticMarkup(<AccountingPanel provider={provider} orgSlug="acme" view={view} canManage notice={null} />));
      expect(panel({ state: "not_connected" })).toEqual([`/integrations/${provider}/connect?org=acme`]);
      expect(panel(accountingView({ revoked: true, connected: false }))).toContain(`/integrations/${provider}/connect?org=acme`);
      const reconnect = panel(accountingView({ connected: false, status: { tone: "error", title: "Needs you", detail: [], reconnect: true } }));
      expect(reconnect).toContain(`/integrations/${provider}/connect?org=acme`);
      for (const href of [...reconnect, ...panel(accountingView({ bookingAllowed: false }))]) expect(href).toMatch(/\?org=acme$/);
    }
  });

  it("name the workspace on HubSpot's Connect and Reconnect", () => {
    const panel = (view: CrmPanelView) => hrefs(renderToStaticMarkup(<HubSpotPanel orgSlug="acme" view={view} canManage notice={null} />));
    expect(panel({ state: "not_connected" } as CrmPanelView)).toEqual(["/integrations/hubspot/connect?org=acme"]);
  });
});

const connectPage = async (provider: "xero" | "quickbooks" | "hubspot", query: Record<string, string> = {}) => {
  const searchParams = Promise.resolve(query);
  const page = provider === "hubspot" ? await HubSpotConnectPage({ searchParams }) : await AccountingConnect({ provider, searchParams });
  return renderToStaticMarkup(page);
};

describe.each(["xero", "quickbooks", "hubspot"] as const)("the %s connect page", (provider) => {
  it("picks the workspace the Settings card named, among several, with real radio buttons and their labels", async () => {
    memberships.value = [workspace("acme"), workspace("beta", "admin")];
    const markup = await connectPage(provider, { org: "beta" });
    const radios = inputs(markup).filter((input) => input.type === "radio");
    expect(radios.map((radio) => radio.value)).toEqual(["acme", "beta"]);
    for (const radio of radios) {
      expect(radio.name).toBe("org");
      expect("required" in radio).toBe(true);
      expect(labelFor(markup, radio.id)).toBe(radio.value === "acme" ? "Acme Studio" : "Beta Works");
    }
    expect(radios.filter((radio) => "checked" in radio).map((radio) => radio.value)).toEqual(["beta"]);
    expect(markup).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Workspace<\/legend>/);
  });

  it("picks nothing among several when no workspace is named", async () => {
    memberships.value = [workspace("acme"), workspace("beta")];
    const radios = inputs(await connectPage(provider)).filter((input) => input.type === "radio");
    expect(radios).toHaveLength(2);
    expect(radios.some((radio) => "checked" in radio)).toBe(false);
  });

  it("picks the one workspace the person may manage integrations for, without being told", async () => {
    memberships.value = [workspace("acme"), workspace("beta", "approver")];
    const markup = await connectPage(provider);
    expect(inputs(markup).filter((input) => input.type === "radio")).toEqual([]);
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "org", value: "acme" }));
    expect(markup.replace(/<[^>]+>/g, "")).toContain("Workspace: Acme Studio");
  });

  it("asks for I agree with a real, required checkbox its label ticks", async () => {
    memberships.value = [workspace("acme")];
    const markup = await connectPage(provider);
    const boxes = inputs(markup).filter((input) => input.type === "checkbox");
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ name: "consent", value: "yes" });
    expect("required" in boxes[0]).toBe(true);
    expect(labelFor(markup, boxes[0].id)).toMatch(/^I agree/);
    // No stand-in control a form cannot see: what is ticked is what is posted.
    expect(markup).not.toContain('role="checkbox"');
    expect(markup).not.toContain('role="radio"');
  });
});

describe("the organisation pick after Xero", () => {
  it("offers the organisations Xero authorised as real radio buttons with their labels", async () => {
    memberships.value = [workspace("acme")];
    pending.value = {
      id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d04",
      choices: [
        { externalOrgId: "tenant-1", name: "Demo Company (Global)" },
        { externalOrgId: "tenant-2", name: "Northstar Studio Pte Ltd" },
      ],
    };
    const markup = await connectPage("xero", { org: "acme", choose: pending.value.id });
    const radios = inputs(markup).filter((input) => input.type === "radio");
    expect(radios.map((radio) => radio.value)).toEqual(["tenant-1", "tenant-2"]);
    expect(radios.map((radio) => labelFor(markup, radio.id))).toEqual(["Demo Company (Global)", "Northstar Studio Pte Ltd"]);
    expect(radios.every((radio) => radio.name === "organisation" && "required" in radio)).toBe(true);
  });
});
