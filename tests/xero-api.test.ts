import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { billsPage, contactsPage, accounts, modifiedSince } from "@/lib/xero/api";
import { authorizeUrl, exchangeCode, listOrganisations, refreshTokens, revokeToken } from "@/lib/xero/oauth";
import { xeroProvider } from "@/lib/xero/provider";
import { xeroRedirectUri, xeroSettingsFromEnv } from "@/lib/xero/settings";

/**
 * Xero over HTTP (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X5, X6, X8), against a recording fetch
 * that answers with recorded Xero-shaped bodies: the requests Vestiarion sends, and what it makes of each answer, the
 * refusals and the rate limits included. No call leaves the test.
 */

const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "tests", "fixtures", "xero", name), "utf8");
const SETTINGS = { clientId: "91E5715B1199038080D6D0BBACCD4E60", clientSecret: "client-secret-value" };
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const TENANT = "70784a63-d24b-46a9-a4db-0e70a274b056";

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

describe("settings", () => {
  it("is on with both variables, off without either or with a client id that is not one", () => {
    expect(xeroSettingsFromEnv({ XERO_CLIENT_ID: SETTINGS.clientId, XERO_CLIENT_SECRET: "s" })).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s" });
    expect(xeroSettingsFromEnv({ XERO_CLIENT_ID: SETTINGS.clientId })).toBeNull();
    expect(xeroSettingsFromEnv({ XERO_CLIENT_SECRET: "s" })).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(xeroSettingsFromEnv({ XERO_CLIENT_ID: "not one!", XERO_CLIENT_SECRET: "s" })).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not one!");
    warn.mockRestore();
  });

  it("sends a person back to the deployment's own callback, as registered in Xero", () => {
    expect(xeroRedirectUri("https://www.vestiarion.xyz")).toBe("https://www.vestiarion.xyz/api/integrations/xero/callback");
    expect(xeroRedirectUri("http://localhost:3000")).toBe("http://localhost:3000/api/integrations/xero/callback");
  });
});

describe("authorizeUrl", () => {
  it("asks for the code with the read-only granular scopes and offline access, and nothing about the person", () => {
    const url = new URL(authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: "https://www.vestiarion.xyz/api/integrations/xero/callback" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://login.xero.com/identity/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: SETTINGS.clientId,
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/xero/callback",
      scope: "offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read",
      state: "vx1.state",
    });
  });
});

describe("the token endpoint", () => {
  it("exchanges a code with Basic client authentication and a form body, and reads the authorization's event", async () => {
    const { sent, deps } = recorder(() => json(fixture("token.json")));
    const outcome = await exchangeCode(SETTINGS, { code: "the-code", redirectUri: "https://www.vestiarion.xyz/api/integrations/xero/callback" }, deps);
    expect(outcome).toMatchObject({ ok: true, authEventId: "d99ecdfe-391d-43d2-b834-17636ba90e8d" });
    expect(sent[0].url.toString()).toBe("https://identity.xero.com/connect/token");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].headers.get("authorization")).toBe(`Basic ${Buffer.from(`${SETTINGS.clientId}:client-secret-value`).toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/xero/callback",
    });
  });

  it("says refused for a code Xero refuses, and unavailable when it cannot answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exchangeCode(SETTINGS, { code: "x", redirectUri: "r" }, recorder(() => json({ error: "invalid_grant" }, { status: 400 })).deps)).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "x", redirectUri: "r" }, recorder(() => json({}, { status: 503 })).deps)).toEqual({ ok: false, reason: "unavailable" });
    const failing = { fetchImpl: (async () => Promise.reject(new Error("socket"))) as unknown as typeof fetch, now: () => NOW };
    expect(await exchangeCode(SETTINGS, { code: "x", redirectUri: "r" }, failing)).toEqual({ ok: false, reason: "unavailable" });
    error.mockRestore();
  });

  it("refreshes with the refresh token and takes the new pair Xero rotates in", async () => {
    const { sent, deps } = recorder(() => json(fixture("token.json")));
    const outcome = await refreshTokens(SETTINGS, "refresh-old", deps);
    expect(outcome).toMatchObject({ ok: true, tokens: { refreshToken: expect.stringMatching(/^3a1f/), expiresAt: NOW + 1_800_000 } });
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-old" });
  });

  it("needs a reconnect only for invalid_grant; anything else is tried again, with Xero's wait", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await refreshTokens(SETTINGS, "r", recorder(() => json({ error: "invalid_grant" }, { status: 400 })).deps)).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(SETTINGS, "r", recorder(() => json({ error: "invalid_client" }, { status: 400 })).deps)).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: null,
    });
    expect(await refreshTokens(SETTINGS, "r", recorder(() => json({}, { status: 429, headers: { "retry-after": "30" } })).deps)).toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterMs: 30_000,
    });
    error.mockRestore();
  });

  it("revokes a refresh token at the revocation endpoint", async () => {
    const { sent, deps } = recorder(() => new Response(null, { status: 200 }));
    expect(await revokeToken(SETTINGS, "refresh-1", deps)).toBe(true);
    expect(sent[0].url.toString()).toBe("https://identity.xero.com/connect/revocation");
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({ token: "refresh-1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await revokeToken(SETTINGS, "refresh-1", recorder(() => new Response(null, { status: 400 })).deps)).toBe(false);
    error.mockRestore();
  });
});

describe("listOrganisations", () => {
  it("reads /connections with the access token and offers this authorization's organisations", async () => {
    const { sent, deps } = recorder(() => json(fixture("connections.json")));
    const organisations = await listOrganisations("access-1", "d99ecdfe-391d-43d2-b834-17636ba90e8d", deps);
    expect(organisations.map((organisation) => organisation.name)).toEqual(["Demo Company (Global)", "Northstar Studio Pte Ltd"]);
    expect(sent[0].url.toString()).toBe("https://api.xero.com/connections");
    expect(sent[0].headers.get("authorization")).toBe("Bearer access-1");
  });

  it("refuses an answer with no organisation at all", async () => {
    await expect(listOrganisations("a", null, recorder(() => json([])).deps)).rejects.toThrow(/no organisation/);
  });
});

describe("reading bills", () => {
  it("backfills approved bills in update order, a page at a time, for the organisation named in xero-tenant-id", async () => {
    const { sent, deps } = recorder(() => json(fixture("invoices-backfill-page-1.json")));
    const page = await billsPage({ accessToken: "access-1", externalOrgId: TENANT, page: 1, phase: "backfill", since: null }, deps);
    expect(page.items).toHaveLength(3);
    expect(page.last).toBe(false);
    const url = sent[0].url;
    expect(`${url.origin}${url.pathname}`).toBe("https://api.xero.com/api.xro/2.0/Invoices");
    expect(Object.fromEntries(url.searchParams)).toEqual({ where: 'Type=="ACCPAY"', Statuses: "AUTHORISED", order: "UpdatedDateUTC ASC", page: "1", pageSize: "100" });
    expect(sent[0].headers.get("xero-tenant-id")).toBe(TENANT);
    expect(sent[0].headers.get("authorization")).toBe("Bearer access-1");
    expect(sent[0].headers.get("if-modified-since")).toBeNull();
  });

  it("follows changes since a time, whatever their status, with If-Modified-Since in UTC to the second", async () => {
    const { sent, deps } = recorder(() => json(fixture("invoices-modified.json")));
    const page = await billsPage({ accessToken: "a", externalOrgId: TENANT, page: 2, phase: "incremental", since: "2026-10-12T07:15:22.093Z" }, deps);
    expect(page.items.map((bill) => bill.status)).toEqual(["paid", "voided", "draft", "draft", "deleted"]);
    expect(sent[0].url.searchParams.get("Statuses")).toBeNull();
    expect(sent[0].url.searchParams.get("page")).toBe("2");
    expect(sent[0].headers.get("if-modified-since")).toBe("2026-10-12T07:15:22");
    expect(modifiedSince("2026-10-12T07:15:22.999Z")).toBe("2026-10-12T07:15:22");
  });

  it("turns a 429 into a rate limit carrying Xero's wait, and 401, 403 and 5xx into their failures", async () => {
    const request = { accessToken: "a", externalOrgId: TENANT, page: 1, phase: "backfill" as const, since: null };
    const failure = async (response: Response) => {
      try {
        await billsPage(request, recorder(() => response).deps);
      } catch (error) {
        return error as ProviderError;
      }
      throw new Error("no failure");
    };
    const limited = await failure(json({}, { status: 429, headers: { "retry-after": "42", "x-rate-limit-problem": "minute" } }));
    expect(limited).toBeInstanceOf(ProviderError);
    expect([limited.failure, limited.retryAfterMs, limited.message]).toEqual(["rate_limited", 42_000, "Xero invoices: 429 (minute)"]);
    expect((await failure(json({}, { status: 401 }))).failure).toBe("unauthorized");
    expect((await failure(json({}, { status: 403 }))).failure).toBe("forbidden");
    expect((await failure(json({}, { status: 502 }))).failure).toBe("unavailable");
    expect((await failure(new Response("<html>", { status: 200 }))).failure).toBe("bad_response");
  });

  it("calls a network failure unavailable", async () => {
    const failing = { fetchImpl: (async () => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch, now: () => NOW };
    await expect(billsPage({ accessToken: "a", externalOrgId: TENANT, page: 1, phase: "backfill", since: null }, failing)).rejects.toMatchObject({ failure: "unavailable" });
  });
});

describe("contacts and accounts", () => {
  it("reads contacts in update order, archived ones included, and keeps the suppliers", async () => {
    const { sent, deps } = recorder(() => json(fixture("contacts-page.json")));
    const page = await contactsPage({ accessToken: "a", externalOrgId: TENANT, page: 1, phase: "incremental", since: "2026-10-12T07:00:00.000Z" }, deps);
    expect(page.items.map((contact) => contact.name)).toEqual(["PowerDirect", "Hoyt Productions"]);
    expect(Object.fromEntries(sent[0].url.searchParams)).toEqual({ order: "UpdatedDateUTC ASC", page: "1", pageSize: "100", includeArchived: "true" });
    expect(sent[0].headers.get("if-modified-since")).toBe("2026-10-12T07:00:00");
  });

  it("reads the chart and offers the accounts a payment can be booked to", async () => {
    const { sent, deps } = recorder(() => json(fixture("accounts.json")));
    expect((await accounts({ accessToken: "a", externalOrgId: TENANT }, deps)).map((account) => account.name)).toEqual([
      "Business Bank Account",
      "Arc USDC wallet",
      "UK Account",
      "Stablecoin clearing",
    ]);
    expect(`${sent[0].url.origin}${sent[0].url.pathname}`).toBe("https://api.xero.com/api.xro/2.0/Accounts");
  });
});

describe("xeroProvider", () => {
  it("is the core's provider for Xero, with its scopes", () => {
    const provider = xeroProvider(SETTINGS);
    expect([provider.id, provider.label]).toEqual(["xero", "Xero"]);
    expect(provider.scopes).toContain("accounting.invoices.read");
    expect(provider.authorizeUrl({ state: "s", redirectUri: "r" })).toContain("client_id=91E5715B1199038080D6D0BBACCD4E60");
  });
});
