import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { PAGE_SIZE, zohoCrmReader } from "@/lib/zohocrm/api";
import { DEAL_FIELDS, ifModifiedSince, mapDeal, mapDealsList, mapOrg, mapPipelineStages, stageOf, type DealContext } from "@/lib/zohocrm/map";
import { zohoCrmProvider } from "@/lib/zohocrm/provider";
import { ZOHO_CRM_SCOPES, zohoCrmRedirectUri, zohoCrmSettingsFromEnv } from "@/lib/zohocrm/settings";

/**
 * Zoho CRM on the connector core (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md): the Zoho client it
 * shares with Zoho Books (C2), its read scopes and Zoho's OAuth at the token's data center (C3, C5), its deals in the
 * core's shapes with each stage's outcome (C6, C7), and the reader's pages, contacts and deals by id (C8).
 */

const SETTINGS = { clientId: "1000.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", clientSecret: "secret-not-a-real-one" };
const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const REDIRECT = "https://www.vestiarion.xyz/api/integrations/zohocrm/callback";
const TOKEN = "eu|1000.access";

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fetch that answers by the request's path, and remembers each request it was sent. */
function fake(route: (url: URL, init: RequestInit) => Answer) {
  const sent: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push({ url, init: init ?? {} });
    const answer = route(url, init ?? {});
    const status = answer.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : JSON.stringify(answer.body ?? {}), { status, headers: { "content-type": "application/json", ...answer.headers } });
  }) as unknown as typeof fetch;
  return { sent, deps: { fetchImpl, now: () => NOW } };
}

const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

const DEAL = {
  id: "5725767000000411001",
  Deal_Name: "Website rebuild",
  Amount: 4800.5,
  Currency: "EUR",
  Closing_Date: "2026-10-14",
  Stage: "Closed Won",
  Pipeline: { name: "Standard", id: "5725767000000091023" },
  Account_Name: { name: "Lumen Holdings", id: "5725767000000300001" },
  Contact_Name: { name: "Ana Lima", id: "5725767000000300100" },
  Owner: { name: "Sam", id: "5725767000000200001", email: "sam@example.com" },
  Modified_Time: "2026-10-15T14:02:11+05:30",
};

const CONTEXT: DealContext = { stages: new Map([["Closed Won", "won"], ["Closed Lost", "lost"], ["Negotiation", "open"]]), homeCurrency: "USD", emails: new Map([["5725767000000300100", "ana@lumen.example"]]) };

describe("the Zoho client, shared with Zoho Books (C2)", () => {
  it("is on with Zoho Books' client, or with its own when both of its own are set", () => {
    expect(zohoCrmSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: SETTINGS.clientId, ZOHO_BOOKS_CLIENT_SECRET: "s" })).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s" });
    const own = "1000.ZYXWVUTSRQPONMLKJIHGFEDCBA9876";
    expect(zohoCrmSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: SETTINGS.clientId, ZOHO_BOOKS_CLIENT_SECRET: "s", ZOHO_CRM_CLIENT_ID: own, ZOHO_CRM_CLIENT_SECRET: "t" })).toEqual({
      clientId: own,
      clientSecret: "t",
    });
    // One of its own alone does not count: the Zoho Books client is used.
    expect(zohoCrmSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: SETTINGS.clientId, ZOHO_BOOKS_CLIENT_SECRET: "s", ZOHO_CRM_CLIENT_ID: own })).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s" });
    expect(zohoCrmSettingsFromEnv({})).toBeNull();
  });

  it("sends people back to its own callback, and asks to read only", () => {
    expect(zohoCrmRedirectUri("https://www.vestiarion.xyz")).toBe(REDIRECT);
    expect(ZOHO_CRM_SCOPES).toEqual([
      "ZohoCRM.modules.deals.READ",
      "ZohoCRM.modules.accounts.READ",
      "ZohoCRM.modules.contacts.READ",
      "ZohoCRM.org.READ",
      "ZohoCRM.settings.layouts.READ",
      "ZohoCRM.settings.pipeline.READ",
    ]);
    for (const scope of ZOHO_CRM_SCOPES) expect(scope).toMatch(/\.READ$/);
  });
});

describe("Zoho's OAuth for Zoho CRM (C3, C5)", () => {
  it("authorizes with Zoho CRM's read scopes, names the callback's data center as its parameter, and writes no receipts", () => {
    const provider = zohoCrmProvider(SETTINGS);
    expect(provider).toMatchObject({ id: "zohocrm", label: "Zoho CRM", kind: "crm", callbackRegionParam: "location" });
    expect(provider.receipts).toBeUndefined();
    expect(provider.exclusive).toBeUndefined();
    const url = new URL(provider.authorizeUrl({ state: "s1", redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe("https://accounts.zoho.com/oauth/v2/auth");
    expect(url.searchParams.get("scope")).toBe(ZOHO_CRM_SCOPES.join(","));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.toString()).not.toContain(SETTINGS.clientSecret);
  });

  it("exchanges the code at the callback's data center, each token carrying it, with Zoho CRM's scopes", async () => {
    const { sent, deps } = fake(() => ({ body: { access_token: "1000.a", refresh_token: "1000.r", api_domain: "https://www.zohoapis.in", expires_in: 3600 } }));
    const outcome = await zohoCrmProvider(SETTINGS, deps).exchangeCode({ code: "c1", redirectUri: REDIRECT, region: "in" });
    expect(sent[0].url.toString()).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(outcome).toEqual({ ok: true, authEventId: null, tokens: { accessToken: "in|1000.a", refreshToken: "in|1000.r", expiresAt: NOW + 3_600_000, scopes: [...ZOHO_CRM_SCOPES] } });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const none = fake(() => ({ body: {} }));
    expect(await zohoCrmProvider(SETTINGS, none.deps).exchangeCode({ code: "c1", redirectUri: REDIRECT, region: "attacker" })).toEqual({ ok: false, reason: "refused" });
    expect(none.sent).toHaveLength(0);
    expect(error.mock.calls.flat().join(" ")).toContain("zohocrm:");
    error.mockRestore();
  });

  it("refreshes at the token's data center, keeping the refresh token Zoho does not send again", async () => {
    const { sent, deps } = fake(() => ({ body: { access_token: "1000.a2", expires_in: 3600 } }));
    const outcome = await zohoCrmProvider(SETTINGS, deps).refresh("au|1000.r");
    expect(sent[0].url.toString()).toBe("https://accounts.zoho.com.au/oauth/v2/token");
    expect(outcome).toEqual({ ok: true, tokens: { accessToken: "au|1000.a2", refreshToken: "au|1000.r", expiresAt: NOW + 3_600_000, scopes: [...ZOHO_CRM_SCOPES] } });
  });
});

describe("Zoho CRM's deals in the core's shapes (C6, C7)", () => {
  it("maps a deal: its version its last change in UTC, its own currency, its account with its contact's email", () => {
    expect(mapDeal(DEAL, CONTEXT)).toEqual({
      externalId: "5725767000000411001",
      version: "2026-10-15T08:32:11.000Z",
      updatedAt: "2026-10-15T08:32:11.000Z",
      name: "Website rebuild",
      amount: "4800.5",
      currency: "EUR",
      closeOn: "2026-10-14",
      pipelineId: "5725767000000091023",
      pipelineLabel: "Standard",
      stageId: "Closed Won",
      stageLabel: "Closed Won",
      stage: "won",
      company: { externalId: "5725767000000300001", name: "Lumen Holdings", email: "ana@lumen.example" },
    });
  });

  it("takes the home currency for a deal without one, and a pipeline written as its name", () => {
    const deal = mapDeal({ ...DEAL, Currency: undefined, Pipeline: "Standard", Contact_Name: null }, CONTEXT);
    expect(deal).toMatchObject({ currency: "USD", pipelineId: "Standard", pipelineLabel: "Standard", company: { email: null } });
    expect(mapDeal({ ...DEAL, Amount: null, Account_Name: null }, CONTEXT)).toMatchObject({ amount: null, company: null });
  });

  it("leaves out a deal without an id or a last change", () => {
    expect(mapDeal({ ...DEAL, id: undefined }, CONTEXT)).toBeNull();
    expect(mapDeal({ ...DEAL, Modified_Time: "yesterday" }, CONTEXT)).toBeNull();
    expect(mapDeal("not a deal", CONTEXT)).toBeNull();
  });

  it("reads a stage's outcome from the pipelines, else Zoho CRM's own stage names, else open", () => {
    const stages = mapPipelineStages({
      pipeline: [
        {
          display_value: "Standard",
          maps: [
            { display_value: "Signed", actual_value: "Signed", forecast_type: "Closed Won" },
            { display_value: "Gone quiet", actual_value: "Gone quiet", forecast_type: "Closed Lost" },
            { display_value: "Proposal", actual_value: "Proposal", forecast_type: "Open" },
          ],
        },
      ],
    });
    expect([...stages]).toEqual([["Signed", "won"], ["Gone quiet", "lost"], ["Proposal", "open"]]);
    expect(stageOf("Signed", stages)).toBe("won");
    expect(stageOf("Closed Won", new Map())).toBe("won");
    expect(stageOf("Closed-Lost to Competition", new Map())).toBe("lost");
    expect(stageOf("Closed Lost", new Map())).toBe("lost");
    expect(stageOf("Qualification", new Map())).toBe("open");
    expect(stageOf(null, new Map())).toBe("open");
    expect(mapPipelineStages(null).size).toBe(0);
  });

  it("reads the organization: its id, its name and its home currency", () => {
    expect(mapOrg({ org: [{ id: "71234567", company_name: "Lumen Holdings", iso_code: "USD", mc_status: false }] })).toEqual({
      organisation: { externalOrgId: "71234567", name: "Lumen Holdings", connectionId: null },
      homeCurrency: "USD",
    });
    expect(() => mapOrg({ org: [] })).toThrow(ProviderError);
  });

  it("reads a list's records and whether more follow; a 204 or a 304 is none", () => {
    expect(mapDealsList({ data: [DEAL], info: { more_records: true, next_page_token: "t2" } })).toEqual({ raws: [DEAL], more: true, nextToken: "t2" });
    expect(mapDealsList(null)).toEqual({ raws: [], more: false, nextToken: null });
    expect(() => mapDealsList({ code: "INVALID_TOKEN" })).toThrow(ProviderError);
  });

  it("writes If-Modified-Since as Zoho shows it, in UTC to the second", () => {
    expect(ifModifiedSince("2026-10-16T08:32:11.987Z")).toBe("2026-10-16T08:32:11+00:00");
  });
});

/** Zoho CRM as the reader asks it: layouts, pipelines, the organization, deals and contacts. */
function crm(deals: (url: URL, init: RequestInit) => Answer) {
  return fake((url, init) => {
    if (url.pathname === "/crm/v8/settings/layouts") return { body: { layouts: [{ id: "L1" }] } };
    if (url.pathname === "/crm/v8/settings/pipeline") return { body: { pipeline: [{ maps: [{ actual_value: "Signed", display_value: "Signed", forecast_type: "Closed Won" }] }] } };
    if (url.pathname === "/crm/v8/org") return { body: { org: [{ id: "71234567", company_name: "Lumen Holdings", iso_code: "USD" }] } };
    if (url.pathname === "/crm/v8/Contacts") return { body: { data: [{ id: "5725767000000300100", Email: "Ana@Lumen.example" }] } };
    return deals(url, init);
  });
}

const request = (fields: Partial<Parameters<ReturnType<typeof zohoCrmReader>["deals"]>[0]> = {}) => ({
  accessToken: TOKEN,
  externalOrgId: "71234567",
  phase: "backfill" as const,
  since: null,
  page: 1,
  windowFrom: "2026-07-18",
  ...fields,
});

describe("reading Zoho CRM's deals (C6, C8)", () => {
  it("reads a backfill page at the token's data center, oldest change first, with each stage's outcome and contact's email", async () => {
    const { sent, deps } = crm(() => ({ body: { data: [{ ...DEAL, Stage: "Signed", Currency: undefined }], info: { more_records: false } } }));
    const page = await zohoCrmReader(deps).deals(request());
    const deals = sent.find((call) => call.url.pathname === "/crm/v8/Deals");
    expect(deals?.url.origin).toBe("https://www.zohoapis.eu");
    expect(Object.fromEntries(deals?.url.searchParams ?? [])).toEqual({ fields: DEAL_FIELDS.join(","), per_page: String(PAGE_SIZE), sort_by: "Modified_Time", sort_order: "asc" });
    expect(headerOf(deals!.init, "authorization")).toBe("Zoho-oauthtoken 1000.access");
    expect(headerOf(deals!.init, "if-modified-since")).toBeNull();
    expect(page).toMatchObject({ page: 1, last: true, total: null });
    expect(page.items[0]).toMatchObject({ stage: "won", stageLabel: "Signed", currency: "USD", company: { name: "Lumen Holdings", email: "ana@lumen.example" } });
    expect(sent.find((call) => call.url.pathname === "/crm/v8/Contacts")?.url.searchParams.get("ids")).toBe("5725767000000300100");
  });

  it("reads the changes since a few minutes before the cursor, by If-Modified-Since, and reads a 304 as none", async () => {
    const { sent, deps } = crm(() => ({ status: 304 }));
    const page = await zohoCrmReader(deps).deals(request({ phase: "incremental", since: "2026-10-16T07:40:00.000Z" }));
    expect(page).toEqual({ items: [], page: 1, last: true, total: null });
    const deals = sent.find((call) => call.url.pathname === "/crm/v8/Deals");
    expect(headerOf(deals!.init, "if-modified-since")).toMatch(/^2026-10-16T07:3\d:00\+00:00$/);
    // No deals: no contacts, layouts or organization read.
    expect(sent.map((call) => call.url.pathname)).toEqual(["/crm/v8/Deals"]);
  });

  it("walks Zoho's page tokens, and reads the stages and the organization once per reader", async () => {
    const { sent, deps } = crm((url) =>
      url.searchParams.get("page_token") === "t2"
        ? { body: { data: [{ ...DEAL, id: "2" }], info: { more_records: false } } }
        : { body: { data: [DEAL], info: { more_records: true, next_page_token: "t2" } } }
    );
    const reader = zohoCrmReader(deps);
    const first = await reader.deals(request());
    const second = await reader.deals(request({ page: 2 }));
    expect([first.last, second.last]).toEqual([false, true]);
    expect(second.items.map((deal) => deal.externalId)).toEqual(["2"]);
    expect(sent.filter((call) => call.url.pathname === "/crm/v8/org")).toHaveLength(1);
    expect(sent.filter((call) => call.url.pathname === "/crm/v8/settings/layouts")).toHaveLength(1);
  });

  it("reads the stage names alone when Zoho will not show the pipelines", async () => {
    const { deps } = fake((url) => {
      if (url.pathname === "/crm/v8/settings/layouts") return { status: 403, body: { code: "OAUTH_SCOPE_MISMATCH" } };
      if (url.pathname === "/crm/v8/org") return { body: { org: [{ id: "71234567", company_name: "Lumen", iso_code: "USD" }] } };
      if (url.pathname === "/crm/v8/Contacts") return { status: 204 };
      return { body: { data: [DEAL], info: { more_records: false } } };
    });
    const page = await zohoCrmReader(deps).deals(request());
    expect(page.items[0]).toMatchObject({ stage: "won", company: { email: null } });
  });

  it("names the deals Zoho CRM no longer has as missing", async () => {
    const { sent, deps } = crm(() => ({ body: { data: [DEAL], info: { more_records: false } } }));
    const found = await zohoCrmReader(deps).dealsById({ accessToken: TOKEN, externalOrgId: "71234567", ids: [DEAL.id, "999"] });
    expect(found.deals.map((deal) => deal.externalId)).toEqual([DEAL.id]);
    expect(found.missing).toEqual(["999"]);
    expect(sent.find((call) => call.url.pathname === "/crm/v8/Deals")?.url.searchParams.get("ids")).toBe(`${DEAL.id},999`);
    const none = crm(() => ({ status: 204 }));
    expect(await zohoCrmReader(none.deps).dealsById({ accessToken: TOKEN, externalOrgId: "71234567", ids: ["7"] })).toEqual({ deals: [], missing: ["7"] });
  });

  it("turns Zoho CRM's refusals into the core's failures, and sends no token without its data center", async () => {
    const at = async (status: number) => {
      const { deps } = fake(() => ({ status, body: { code: "X" } }));
      return zohoCrmReader(deps).deals(request()).catch((error: unknown) => error);
    };
    expect(await at(401)).toMatchObject({ failure: "unauthorized" });
    expect(await at(403)).toMatchObject({ failure: "forbidden" });
    expect(await at(429)).toMatchObject({ failure: "rate_limited", retryAfterMs: 60_000 });
    expect(await at(502)).toMatchObject({ failure: "unavailable" });
    const { sent, deps } = fake(() => ({ body: {} }));
    await expect(zohoCrmReader(deps).deals(request({ accessToken: "1000.no-region" }))).rejects.toMatchObject({ failure: "unauthorized" });
    expect(sent).toHaveLength(0);
  });

  it("reads the organization a token reaches", async () => {
    const { deps } = crm(() => ({ body: {} }));
    expect(await zohoCrmProvider(SETTINGS, deps).organisations({ accessToken: TOKEN, refreshToken: "eu|r", expiresAt: NOW, scopes: [] }, null)).toEqual([
      { externalOrgId: "71234567", name: "Lumen Holdings", connectionId: null },
    ]);
  });
});
