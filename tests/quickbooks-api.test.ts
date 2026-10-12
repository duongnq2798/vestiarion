import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { accountingProvider } from "@/lib/accounting-providers";
import { ProviderError, type PageRequest } from "@/lib/connectors/provider";
import { bankAccounts, billsPage, companyUrl, deletedBills, vendorsPage } from "@/lib/quickbooks/api";
import { authorizeUrl, exchangeCode, grantedCompany, refreshTokens, revokeToken } from "@/lib/quickbooks/oauth";
import { quickBooksProvider } from "@/lib/quickbooks/provider";
import { quickBooksApiBase, quickBooksRedirectUri, quickBooksSettingsFromEnv, quickBooksWebhookTokenFromEnv, type QuickBooksSettings } from "@/lib/quickbooks/settings";

/**
 * QuickBooks Online over HTTP (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q2, Q3, Q4, Q6, Q7,
 * Q8), against a recording fetch that answers with recorded QuickBooks-shaped bodies: the requests Vestiarion sends
 * (the queries, their paging and counts, change data capture, the base URL of each environment, `minorversion`), and
 * what it makes of each answer, the refusals and the rate limits included. No call leaves the test.
 */

const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "tests", "fixtures", "quickbooks", name), "utf8");
const misc = JSON.parse(fixture("misc.json")) as Record<string, unknown>;
const CLIENT_ID = "ABcdEFghIJklMNopQRstUVwxYZ0123456789abcdefghijklmn";
const SETTINGS: QuickBooksSettings = { clientId: CLIENT_ID, clientSecret: "client-secret-value", environment: "sandbox" };
const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const REALM = "9341455327810551";
const REDIRECT = "https://www.vestiarion.xyz/api/integrations/quickbooks/callback";
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:client-secret-value`).toString("base64")}`;

interface Sent {
  url: URL;
  raw: string;
  method: string;
  headers: Headers;
  body: string;
}

function recorder(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: new URL(String(input)), raw: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    sent.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { sent, deps: { fetchImpl, now: () => NOW } };
}

const json = (body: string | unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** The statement a query call sent. */
const statementOf = (sent: Sent) => sent.url.searchParams.get("query");

/** Answers a page of bills, its count and the change feed by what each call asks. */
function company(bills: string, count = misc.count, cdc: unknown = misc.cdcEmpty) {
  return recorder((sent) => {
    const query = statementOf(sent) ?? "";
    if (sent.url.pathname.endsWith("/cdc")) return json(cdc);
    if (sent.url.pathname.endsWith("/preferences")) return json(misc.preferences);
    if (/^SELECT COUNT\(\*\)/.test(query)) return json(count);
    return json(fixture(bills));
  });
}

const request = (fields: Partial<PageRequest> = {}): PageRequest => ({
  accessToken: "access-1",
  externalOrgId: REALM,
  page: 1,
  phase: "backfill",
  since: null,
  windowFrom: "2026-07-14",
  ...fields,
});

describe("settings", () => {
  it("is on with both variables, in the sandbox unless told otherwise, and off without either", () => {
    expect(quickBooksSettingsFromEnv({ QUICKBOOKS_CLIENT_ID: CLIENT_ID, QUICKBOOKS_CLIENT_SECRET: "s" })).toEqual({ clientId: CLIENT_ID, clientSecret: "s", environment: "sandbox" });
    expect(quickBooksSettingsFromEnv({ QUICKBOOKS_CLIENT_ID: CLIENT_ID, QUICKBOOKS_CLIENT_SECRET: "s", QUICKBOOKS_ENVIRONMENT: "production" })?.environment).toBe("production");
    expect(quickBooksSettingsFromEnv({ QUICKBOOKS_CLIENT_ID: CLIENT_ID })).toBeNull();
    expect(quickBooksSettingsFromEnv({ QUICKBOOKS_CLIENT_SECRET: "s" })).toBeNull();
  });

  it("turns off on a client id that is not one, or an environment it does not know, naming the variable and never its value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(quickBooksSettingsFromEnv({ QUICKBOOKS_CLIENT_ID: "not one!", QUICKBOOKS_CLIENT_SECRET: "s" })).toBeNull();
    expect(quickBooksSettingsFromEnv({ QUICKBOOKS_CLIENT_ID: CLIENT_ID, QUICKBOOKS_CLIENT_SECRET: "s", QUICKBOOKS_ENVIRONMENT: "staging-x" })).toBeNull();
    const said = warn.mock.calls.flat().join(" ");
    expect(said).toContain("QUICKBOOKS_ENVIRONMENT");
    expect(said).not.toContain("not one!");
    expect(said).not.toContain("staging-x");
    warn.mockRestore();
  });

  it("reads the webhook's verifier token, and the deployment's own callback", () => {
    expect(quickBooksWebhookTokenFromEnv({ QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN: " token " })).toBe("token");
    expect(quickBooksWebhookTokenFromEnv({})).toBeNull();
    expect(quickBooksRedirectUri("http://localhost:3000")).toBe("http://localhost:3000/api/integrations/quickbooks/callback");
  });

  it("reads sandbox companies and real ones at their own base URL", () => {
    expect(quickBooksApiBase("sandbox")).toBe("https://sandbox-quickbooks.api.intuit.com");
    expect(quickBooksApiBase("production")).toBe("https://quickbooks.api.intuit.com");
    expect(companyUrl({ ...SETTINGS, environment: "production" }, REALM, "query", { query: "SELECT * FROM Bill" })).toBe(
      `https://quickbooks.api.intuit.com/v3/company/${REALM}/query?query=SELECT%20*%20FROM%20Bill&minorversion=75`
    );
  });

  it("is wired into the deployment's providers as QuickBooks: the callback names the company, one workspace holds it", () => {
    vi.stubEnv("QUICKBOOKS_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("QUICKBOOKS_CLIENT_SECRET", "s");
    expect(accountingProvider("quickbooks")).toMatchObject({ id: "quickbooks", label: "QuickBooks", callbackOrganisationParam: "realmId", exclusive: true, scopes: ["com.intuit.quickbooks.accounting"] });
    vi.unstubAllEnvs();
  });
});

describe("authorizeUrl", () => {
  it("asks for the code with the accounting scope only, and nothing about the person", () => {
    const url = new URL(authorizeUrl(SETTINGS, { state: "vx1.state", redirectUri: REDIRECT }));
    expect(`${url.origin}${url.pathname}`).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: REDIRECT,
      state: "vx1.state",
    });
  });
});

describe("the token endpoint", () => {
  it("exchanges a code with Basic client authentication and a form body", async () => {
    const { sent, deps } = recorder(() => json(misc.token));
    const outcome = await exchangeCode(SETTINGS, { code: "the-code", redirectUri: REDIRECT }, deps);
    expect(outcome).toEqual({
      ok: true,
      authEventId: null,
      tokens: { accessToken: expect.stringContaining("fixture-access"), refreshToken: "AB11799999999fixturerefresh", expiresAt: NOW + 3_600_000, scopes: ["com.intuit.quickbooks.accounting"] },
    });
    expect(sent[0].url.toString()).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].headers.get("authorization")).toBe(BASIC);
    expect(sent[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT });
  });

  it("says refused when Intuit refuses the code, and unavailable when it does not answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, recorder(() => json({ error: "invalid_grant" }, { status: 400 })).deps)).toEqual({ ok: false, reason: "refused" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, recorder(() => json({}, { status: 503 })).deps)).toEqual({ ok: false, reason: "unavailable" });
    expect(await exchangeCode(SETTINGS, { code: "c", redirectUri: REDIRECT }, recorder(() => json({ access_token: "a" })).deps)).toEqual({ ok: false, reason: "unavailable" });
    error.mockRestore();
  });

  it("keeps whatever refresh token Intuit returns, the same or a new one", async () => {
    const { sent, deps } = recorder(() => json({ ...(misc.token as object), refresh_token: "AB11-rotated" }));
    const outcome = await refreshTokens(SETTINGS, "AB11-old", deps);
    expect(outcome).toMatchObject({ ok: true, tokens: { refreshToken: "AB11-rotated", expiresAt: NOW + 3_600_000 } });
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({ grant_type: "refresh_token", refresh_token: "AB11-old" });
    expect(sent[0].headers.get("authorization")).toBe(BASIC);
  });

  it("asks for a reconnect on invalid_grant, and backs off on anything else", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await refreshTokens(SETTINGS, "spent", recorder(() => json({ error: "invalid_grant" }, { status: 400 })).deps)).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(SETTINGS, "r", recorder(() => json({}, { status: 503, headers: { "retry-after": "30" } })).deps)).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 30_000 });
    expect(await refreshTokens(SETTINGS, "r", recorder(() => json({ error: "invalid_client" }, { status: 401 })).deps)).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    expect(error.mock.calls.flat().join(" ")).not.toContain("spent");
    error.mockRestore();
  });

  it("revokes a refresh token with a JSON body and Basic client authentication", async () => {
    const { sent, deps } = recorder(() => new Response(null, { status: 200 }));
    expect(await revokeToken(SETTINGS, "AB11-refresh", deps)).toBe(true);
    expect(sent[0].url.toString()).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    expect(sent[0].method).toBe("POST");
    expect(sent[0].headers.get("authorization")).toBe(BASIC);
    expect(sent[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent[0].body)).toEqual({ token: "AB11-refresh" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await revokeToken(SETTINGS, "x", recorder(() => json({}, { status: 400 })).deps)).toBe(false);
    error.mockRestore();
  });
});

describe("the company a grant is for", () => {
  it("is the one the callback named, read with the new token from its own company info", async () => {
    const { sent, deps } = recorder(() => json(fixture("companyinfo.json")));
    const tokens = { accessToken: "access-1", refreshToken: "r", expiresAt: NOW + 3_600_000, scopes: [] };
    expect(await grantedCompany(SETTINGS, tokens, REALM, deps)).toEqual([{ externalOrgId: REALM, name: "Sandbox Company_US_1", connectionId: null }]);
    expect(sent[0].raw).toBe(`https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/companyinfo/${REALM}?minorversion=75`);
    expect(sent[0].headers.get("authorization")).toBe("Bearer access-1");
    expect(sent[0].headers.get("accept")).toBe("application/json");
  });

  it("refuses a callback that named no company or something else, and a company the token does not read", async () => {
    const tokens = { accessToken: "access-1", refreshToken: "r", expiresAt: NOW, scopes: [] };
    const none = recorder(() => json({}));
    await expect(grantedCompany(SETTINGS, tokens, undefined, none.deps)).rejects.toThrow(/named no company/);
    await expect(grantedCompany(SETTINGS, tokens, "1/../2", none.deps)).rejects.toThrow(/named no company/);
    expect(none.sent).toHaveLength(0);
    const refused = recorder(() => json(misc.authFault, { status: 403 }));
    await expect(grantedCompany(SETTINGS, tokens, "1234", refused.deps)).rejects.toMatchObject({ failure: "forbidden" });
  });
});

describe("bills", () => {
  it("backfills the open bills due in the window, a page at a time in update order, with a count of the same filter", async () => {
    const { sent, deps } = company("bills-backfill-page-1.json");
    const page = await billsPage(SETTINGS, request(), deps);
    expect(page).toMatchObject({ page: 1, last: true, total: 3 });
    expect(page.items.map((bill) => [bill.externalId, bill.status, bill.amountDue])).toEqual([["146", "open", "1250"], ["147", "open", "400"], ["148", "open", "98000"]]);
    expect(sent.map(statementOf)).toEqual([
      "SELECT * FROM Bill WHERE Balance > '0' AND DueDate >= '2026-07-14' ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 100",
      "SELECT COUNT(*) FROM Bill WHERE Balance > '0' AND DueDate >= '2026-07-14'",
    ]);
    expect(sent[0].raw).toMatch(new RegExp(`^https://sandbox-quickbooks\\.api\\.intuit\\.com/v3/company/${REALM}/query\\?query=SELECT%20\\*%20FROM%20Bill%20WHERE%20Balance%20%3E%20'0'`));
    expect(sent[0].raw).not.toContain("+");
    expect(sent[0].url.searchParams.get("minorversion")).toBe("75");
    expect(sent[0].headers.get("authorization")).toBe("Bearer access-1");
  });

  it("reads the next page from where the last one ended", async () => {
    const { sent, deps } = company("bills-backfill-page-1.json", { QueryResponse: { totalCount: 250 } });
    await billsPage(SETTINGS, request({ page: 3 }), deps);
    expect(statementOf(sent[0])).toContain("STARTPOSITION 201 MAXRESULTS 100");
  });

  it("follows every bill changed since the last run, whatever its balance, and asks change data capture for the deleted ones once", async () => {
    const { sent, deps } = company("bills-modified.json", misc.count, JSON.parse(fixture("cdc-bills.json")));
    const page = await billsPage(SETTINGS, request({ phase: "incremental", since: "2026-10-12T09:55:00.000Z" }), deps);
    expect(statementOf(sent[0])).toBe("SELECT * FROM Bill WHERE MetaData.LastUpdatedTime >= '2026-10-12T09:55:00Z' ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 100");
    expect(statementOf(sent[1])).toBe("SELECT COUNT(*) FROM Bill WHERE MetaData.LastUpdatedTime >= '2026-10-12T09:55:00Z'");
    // One bill came without its currency: the company's home currency is read, once.
    expect(sent[2].url.pathname).toBe(`/v3/company/${REALM}/preferences`);
    const cdc = sent[3];
    expect(cdc.url.pathname).toBe(`/v3/company/${REALM}/cdc`);
    expect(Object.fromEntries(cdc.url.searchParams)).toEqual({ entities: "Bill", changedSince: "2026-10-12T09:55:00Z", minorversion: "75" });
    expect(page.items.map((bill) => [bill.externalId, bill.status, bill.factsKnown ?? true])).toEqual([
      ["146", "paid", true],
      ["139", "voided", true],
      ["152", "open", true],
      ["148", "deleted", false],
    ]);
    const second = company("bills-modified.json");
    await billsPage(SETTINGS, request({ phase: "incremental", since: "2026-10-12T09:55:00.000Z", page: 2 }), second.deps);
    expect(second.sent.some((call) => call.url.pathname.endsWith("/cdc"))).toBe(false);
  });

  it("asks change data capture no further back than its 30 days", async () => {
    const { sent, deps } = recorder(() => json(misc.cdcEmpty));
    await deletedBills(SETTINGS, { accessToken: "a", externalOrgId: REALM, since: "2026-08-01T00:00:00.000Z" }, deps);
    expect(sent[0].url.searchParams.get("changedSince")).toBe("2026-09-12T11:00:00Z");
  });

  it("reads the home currency once per provider, however many pages need it", async () => {
    const { sent, deps } = company("bills-modified.json");
    const provider = quickBooksProvider(SETTINGS, deps);
    await provider.bills(request());
    await provider.bills(request({ page: 2 }));
    expect(sent.filter((call) => call.url.pathname.endsWith("/preferences"))).toHaveLength(1);
  });

  it("says what QuickBooks refused, by its status, never with a token or the query", async () => {
    const call = (response: () => Response) => billsPage(SETTINGS, request(), recorder(response).deps);
    await expect(call(() => json(misc.throttleFault, { status: 429, headers: { "retry-after": "3" } }))).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 3000 });
    await expect(call(() => json(misc.throttleFault, { status: 429 }))).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: null });
    await expect(call(() => json(misc.authFault, { status: 401 }))).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(call(() => json(misc.authFault, { status: 403 }))).rejects.toMatchObject({ failure: "forbidden" });
    await expect(call(() => json({}, { status: 502 }))).rejects.toMatchObject({ failure: "unavailable" });
    await expect(call(() => json(misc.fault, { status: 400 }))).rejects.toMatchObject({ failure: "bad_response" });
    await expect(call(() => json(misc.fault))).rejects.toMatchObject({ failure: "bad_response" });
    await expect(call(() => new Response("<html>", { status: 200 }))).rejects.toMatchObject({ failure: "bad_response" });
    const failure = await call(() => {
      throw new Error("socket hang up");
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ failure: "unavailable" });
    const refused = await call(() => json(misc.authFault, { status: 401 })).catch((error: Error) => error.message);
    expect(refused).toBe("QuickBooks bills: 401");
  });
});

describe("vendors and bank accounts", () => {
  it("reads every vendor, active or not, and only those changed since the last run when following changes", async () => {
    const backfill = recorder(() => json(fixture("vendors-page.json")));
    const page = await vendorsPage(SETTINGS, request(), backfill.deps);
    expect(page.items.map((vendor) => vendor.name)).toEqual(["PowerDirect", "Old Courier Co"]);
    expect(statementOf(backfill.sent[0])).toBe("SELECT * FROM Vendor WHERE Active IN (true, false) ORDERBY MetaData.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 100");
    const later = recorder(() => json(fixture("vendors-page.json")));
    await vendorsPage(SETTINGS, request({ phase: "incremental", since: "2026-10-12T09:55:00.000Z", page: 2 }), later.deps);
    expect(statementOf(later.sent[0])).toBe(
      "SELECT * FROM Vendor WHERE Active IN (true, false) AND MetaData.LastUpdatedTime >= '2026-10-12T09:55:00Z' ORDERBY MetaData.LastUpdatedTime STARTPOSITION 101 MAXRESULTS 100"
    );
  });

  it("reads the active bank accounts only", async () => {
    const { sent, deps } = recorder(() => json(fixture("accounts-bank.json")));
    expect((await bankAccounts(SETTINGS, { accessToken: "a", externalOrgId: REALM }, deps)).map((account) => account.name)).toEqual(["Arc USDC wallet", "Checking"]);
    expect(statementOf(sent[0])).toBe("SELECT * FROM Account WHERE AccountType = 'Bank' AND Active = true MAXRESULTS 1000");
  });
});
