import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { searchBody } from "@/lib/hubspot/api";
import { authorizeUrl, exchangeCode, listAccount, refreshTokens, revokeToken } from "@/lib/hubspot/oauth";
import { hubspotProvider } from "@/lib/hubspot/provider";
import { HUBSPOT_SCOPES, HUBSPOT_WRITE_SCOPES, hubspotRedirectUri, hubspotSettingsFromEnv } from "@/lib/hubspot/settings";

/**
 * HubSpot over HTTP (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4, H5, H6, H8), against a recording
 * fetch that answers with recorded HubSpot-shaped bodies: the requests Vestiarion sends, and what it makes of each
 * answer, the refusals and the rate limits included. No call leaves the test.
 */

const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "tests", "fixtures", "hubspot", name), "utf8");
const SETTINGS = { clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", clientSecret: "client-secret-value" };
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const HUB = "48291736";

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

function recorder(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    sent.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { sent, deps: { fetchImpl, now: () => NOW } };
}

const json = (body: string | unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const form = (sent: Sent) => Object.fromEntries(new URLSearchParams(sent.body));

/** HubSpot's CRM, answering each read with its recorded body. */
function crm(search: (body: Record<string, unknown>) => string = () => fixture("deals-search-page-1.json")) {
  return recorder((sent) => {
    const at = sent.url.pathname;
    if (at === "/crm/pipelines/2026-03/deals") return json(fixture("pipelines-deals.json"));
    if (at === "/account-info/2026-03/details") return json(fixture("account-details.json"));
    if (at === "/crm/objects/2026-03/deals/search") return json(search(JSON.parse(sent.body)));
    if (at === "/crm/associations/2026-03/deals/companies/batch/read") return json(fixture("assoc-deals-companies.json"));
    if (at === "/crm/objects/2026-03/companies/batch/read") return json(fixture("companies-batch.json"));
    if (at === "/crm/associations/2026-03/companies/contacts/batch/read") return json(fixture("assoc-companies-contacts.json"));
    if (at === "/crm/objects/2026-03/contacts/batch/read") return json(fixture("contacts-batch.json"));
    if (at === "/crm/objects/2026-03/deals/batch/read") return json(fixture("deals-batch-read.json"), { status: 207 });
    return new Response("not found", { status: 404 });
  });
}

const account = { accessToken: "access-1", externalOrgId: HUB };

describe("settings", () => {
  it("is on with a client id and secret, and off without either or with an id that is not one", () => {
    expect(hubspotSettingsFromEnv({ HUBSPOT_CLIENT_ID: SETTINGS.clientId, HUBSPOT_CLIENT_SECRET: "s" })).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s" });
    expect(hubspotSettingsFromEnv({ HUBSPOT_CLIENT_ID: SETTINGS.clientId })).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(hubspotSettingsFromEnv({ HUBSPOT_CLIENT_ID: "not an id!", HUBSPOT_CLIENT_SECRET: "s" })).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not an id!");
    warn.mockRestore();
    expect(hubspotRedirectUri("https://www.vestiarion.xyz")).toBe("https://www.vestiarion.xyz/api/integrations/hubspot/callback");
  });
});

describe("OAuth", () => {
  it("asks for the write scopes as optional ones only when writing receipts is allowed (CRM receipts R3)", () => {
    const url = new URL(authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: "https://www.vestiarion.xyz/api/integrations/hubspot/callback", write: true }));
    expect(url.searchParams.get("scope")).toBe("oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read");
    expect(url.searchParams.get("optional_scope")).toBe("crm.objects.deals.write crm.schemas.deals.write");
  });


  it("sends the person to HubSpot with the app's required scopes, read-only, and the state", () => {
    const url = new URL(authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: "https://www.vestiarion.xyz/api/integrations/hubspot/callback" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://app.hubspot.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: SETTINGS.clientId,
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/hubspot/callback",
      scope: "oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.deals.read",
      state: "vx1.state",
    });
  });

  it("exchanges the code with the credentials in the body, and hands the account on", async () => {
    const { sent, deps } = recorder(() => json(fixture("token.json")));
    const outcome = await exchangeCode(SETTINGS, { code: "the-code", redirectUri: "https://x.example/cb" }, deps);
    expect(outcome).toMatchObject({ ok: true, authEventId: HUB, tokens: { accessToken: "CNb5recorded-access-token", refreshToken: "na1-7f3e-recorded-refresh", expiresAt: NOW + 1_800_000 } });
    expect(sent[0].url.toString()).toBe("https://api.hubapi.com/oauth/2026-03/token");
    expect(sent[0].url.search).toBe("");
    expect(sent[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(form(sent[0])).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://x.example/cb", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
  });

  it("says refused for a code HubSpot refuses, and unavailable when HubSpot is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, recorder(() => json({ error: "invalid_grant" }, { status: 400 })).deps)).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: "r" }, recorder(() => new Response("", { status: 503 })).deps)).toEqual({ ok: false, reason: "unavailable" });
    error.mockRestore();
  });

  it("refreshes, keeping the refresh token sent when HubSpot sends none back", async () => {
    const { sent, deps } = recorder(() => json(fixture("refresh-without-refresh-token.json")));
    const outcome = await refreshTokens(SETTINGS, "na1-sent-refresh", deps);
    expect(outcome).toMatchObject({ ok: true, tokens: { accessToken: "CNb5recorded-access-token-2", refreshToken: "na1-sent-refresh" } });
    expect(form(sent[0])).toEqual({ grant_type: "refresh_token", refresh_token: "na1-sent-refresh", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
  });

  it("asks a person to reconnect when the refresh token is refused, and tries again later when HubSpot is down", async () => {
    expect(await refreshTokens(SETTINGS, "r", recorder(() => json(fixture("invalid-grant.json"), { status: 400 })).deps)).toEqual({ ok: false, reason: "reconnect" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await refreshTokens(SETTINGS, "r", recorder(() => new Response("", { status: 502, headers: { "retry-after": "30" } })).deps)).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 30_000,
    });
    error.mockRestore();
  });

  it("revokes the refresh token in the body", async () => {
    const { sent, deps } = recorder(() => new Response(null, { status: 204 }));
    expect(await revokeToken(SETTINGS, "na1-refresh", deps)).toBe(true);
    expect(sent[0].url.toString()).toBe("https://api.hubapi.com/oauth/2026-03/token/revoke");
    expect(form(sent[0])).toEqual({ token: "na1-refresh", token_type_hint: "refresh_token", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
  });

  it("names the one account of the grant by its domain, and by its id when HubSpot does not say", async () => {
    const named = recorder(() => json(fixture("introspect.json")));
    expect(await listAccount(SETTINGS, "access-1", HUB, named.deps)).toEqual([{ externalOrgId: HUB, name: "northstar-studio.example", connectionId: null }]);
    expect(form(named.sent[0])).toMatchObject({ token_type_hint: "access_token", token: "access-1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await listAccount(SETTINGS, "access-1", HUB, recorder(() => new Response("", { status: 500 })).deps)).toEqual([
      { externalOrgId: HUB, name: `HubSpot account ${HUB}`, connectionId: null },
    ]);
    error.mockRestore();
    await expect(listAccount(SETTINGS, "access-1", null, recorder(() => json({ active: false })).deps)).rejects.toThrow(ProviderError);
    await expect(listAccount(SETTINGS, "access-1", "999", recorder(() => json(fixture("introspect.json"))).deps)).rejects.toThrow(/two accounts/);
  });
});

describe("searching deals", () => {
  it("asks a backfill for what is open, or won since the window's first day, in the order of the last change", () => {
    expect(searchBody({ phase: "backfill", since: null, page: 1, windowFrom: "2026-07-14" })).toEqual({
      filterGroups: [
        { filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }] },
        {
          filters: [
            { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
            { propertyName: "closedate", operator: "GTE", value: String(Date.parse("2026-07-14T00:00:00.000Z")) },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
      properties: ["dealname", "amount", "deal_currency_code", "closedate", "pipeline", "dealstage", "hs_is_closed", "hs_is_closed_won", "hs_lastmodifieddate"],
      limit: 100,
    });
  });

  it("asks an incremental run for every deal changed since five minutes before, and pages by offset", () => {
    const body = searchBody({ phase: "incremental", since: "2026-10-12T07:00:00.000Z", page: 3, windowFrom: "2026-07-14" });
    expect(body.filterGroups).toEqual([{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(Date.parse("2026-10-12T06:55:00.000Z")) }] }]);
    expect(body.after).toBe("200");
  });
});

describe("the provider's reads", () => {
  it("reads a page of deals with their companies and main contacts, the pipelines and the account once", async () => {
    const { sent, deps } = crm();
    const provider = hubspotProvider(SETTINGS, deps);
    const page = await provider.deals({ ...account, page: 1, phase: "backfill", since: null, windowFrom: "2026-07-14" });
    expect(page).toMatchObject({ page: 1, last: false, total: 4, capped: false });
    expect(page.items.map((deal) => [deal.externalId, deal.stage, deal.company?.name ?? null, deal.company?.email ?? null])).toEqual([
      ["30117482911", "won", "Northwind Labs", "jane.ito@northwind.example"],
      ["30117482912", "open", "Contoso Design", null],
    ]);
    expect(page.items[0]).toMatchObject({ amount: "12500", currency: "USD", closeOn: "2026-10-01", stageLabel: "Closed Won" });
    const search = sent.find((call) => call.url.pathname.endsWith("/deals/search"));
    expect(search?.method).toBe("POST");
    expect(search?.headers.get("authorization")).toBe("Bearer access-1");
    expect(JSON.parse(search?.body ?? "{}")).toMatchObject({ limit: 100, sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }] });
    const companies = sent.find((call) => call.url.pathname === "/crm/objects/2026-03/companies/batch/read");
    expect(companies?.url.searchParams.get("archived")).toBe("false");
    expect(JSON.parse(companies?.body ?? "{}")).toEqual({ inputs: [{ id: "9100000001" }, { id: "9100000002" }], properties: ["name", "domain"], propertiesWithHistory: [] });
    // A second page reads neither the pipelines nor the account again.
    await provider.deals({ ...account, page: 2, phase: "backfill", since: null, windowFrom: "2026-07-14" });
    expect(sent.filter((call) => call.url.pathname === "/crm/pipelines/2026-03/deals")).toHaveLength(1);
    expect(sent.filter((call) => call.url.pathname === "/account-info/2026-03/details")).toHaveLength(1);
    expect(JSON.stringify(sent.map((call) => call.url.toString()))).not.toContain("access-1");
  });

  it("makes no company call for a page without deals", async () => {
    const { sent, deps } = crm(() => JSON.stringify({ total: 0, results: [] }));
    const page = await hubspotProvider(SETTINGS, deps).deals({ ...account, page: 1, phase: "incremental", since: "2026-10-12T07:00:00.000Z", windowFrom: "2026-07-14" });
    expect(page).toMatchObject({ items: [], last: true, total: 0 });
    expect(sent.map((call) => call.url.pathname)).toEqual(["/crm/objects/2026-03/deals/search"]);
  });

  it("ends a read at HubSpot's 10,000 results", async () => {
    const { deps } = crm(() => fixture("deals-search-capped.json"));
    const page = await hubspotProvider(SETTINGS, deps).deals({ ...account, page: 100, phase: "incremental", since: "2026-10-01T00:00:00.000Z", windowFrom: "2026-07-14" });
    expect(page).toMatchObject({ last: true, capped: true, total: 12840 });
  });

  it("reads linked deals by id, and names those HubSpot no longer has", async () => {
    const { sent, deps } = crm();
    const read = await hubspotProvider(SETTINGS, deps).dealsById({ ...account, ids: ["30117482911", "30117400000"] });
    expect(read.missing).toEqual(["30117400000"]);
    expect(read.deals.map((deal) => [deal.externalId, deal.amount, deal.closeOn])).toEqual([["30117482911", "15000", "2026-10-20"]]);
    const batch = sent.find((call) => call.url.pathname === "/crm/objects/2026-03/deals/batch/read");
    expect(JSON.parse(batch?.body ?? "{}").inputs).toEqual([{ id: "30117482911" }, { id: "30117400000" }]);
  });
});

describe("refusals and rate limits", () => {
  const read = (answer: Response) => hubspotProvider(SETTINGS, recorder(() => answer).deps).deals({ ...account, page: 1, phase: "backfill", since: null, windowFrom: "2026-07-14" });
  const failure = async (answer: Response) => {
    try {
      await read(answer);
    } catch (error) {
      return error as ProviderError;
    }
    throw new Error("no failure");
  };

  it("waits the interval HubSpot names for its ten-second limit, a second for search, and Retry-After when sent", async () => {
    const tenSecondly = await failure(json(fixture("rate-limited.json"), { status: 429, headers: { "x-hubspot-ratelimit-interval-milliseconds": "10000" } }));
    expect(tenSecondly).toMatchObject({ failure: "rate_limited", retryAfterMs: 10_000 });
    expect(tenSecondly.message).toBe("HubSpot deal search: 429 (TEN_SECONDLY_ROLLING)");
    expect(await failure(json({ policyName: "SECONDLY" }, { status: 429 }))).toMatchObject({ retryAfterMs: 1_000 });
    expect(await failure(json({ policyName: "DAILY" }, { status: 429 }))).toMatchObject({ retryAfterMs: 3_600_000 });
    expect(await failure(json({}, { status: 429, headers: { "retry-after": "3" } }))).toMatchObject({ retryAfterMs: 3_000 });
  });

  it("names a refused token, a removed access, an outage and an answer that does not read", async () => {
    expect(await failure(new Response("", { status: 401 }))).toMatchObject({ failure: "unauthorized" });
    expect(await failure(json({ category: "MISSING_SCOPES" }, { status: 403 }))).toMatchObject({ failure: "forbidden" });
    expect(await failure(new Response("", { status: 502 }))).toMatchObject({ failure: "unavailable" });
    expect(await failure(json({ category: "VALIDATION_ERROR" }, { status: 400 }))).toMatchObject({ failure: "bad_response" });
    expect(await failure(new Response("<html>", { status: 200 }))).toMatchObject({ failure: "bad_response" });
  });
});

describe("the app's config in integrations/hubspot", () => {
  const config = JSON.parse(readFileSync(path.join(process.cwd(), "integrations", "hubspot", "src", "app", "app-hsmeta.json"), "utf8")) as {
    config: { auth: { type: string; redirectUrls: string[]; requiredScopes: string[]; optionalScopes: string[] }; distribution: string };
  };

  it("asks for exactly the scopes the authorize URL sends, read-only, and lists both callbacks", () => {
    expect(config.config.auth.type).toBe("oauth");
    expect(config.config.distribution).toBe("marketplace");
    expect([...config.config.auth.requiredScopes].sort()).toEqual([...HUBSPOT_SCOPES].sort());
    // Writing receipts back (CRM receipts R3): optional, asked for only when an owner or admin allows it.
    expect([...config.config.auth.optionalScopes].sort()).toEqual([...HUBSPOT_WRITE_SCOPES].sort());
    expect(config.config.auth.redirectUrls).toEqual(
      expect.arrayContaining([hubspotRedirectUri("https://www.vestiarion.xyz"), hubspotRedirectUri("http://localhost:3000")])
    );
  });

  it("holds no secret", () => {
    const text = readFileSync(path.join(process.cwd(), "integrations", "hubspot", "src", "app", "app-hsmeta.json"), "utf8");
    expect(text).not.toMatch(/secret|token|password/i);
  });
});
