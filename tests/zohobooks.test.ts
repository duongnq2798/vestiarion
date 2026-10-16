import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import { billsParams, booksUrl, PAGE_SIZE } from "@/lib/zohobooks/api";
import { mapBill, mapBillsPage, mapOrganizations, mapTokens, mapVendorsPage, zohoAmount, zohoFilterTime, zohoTime } from "@/lib/zohobooks/map";
import { authorizeUrl, exchangeCode, refreshTokens, revokeToken } from "@/lib/zohobooks/oauth";
import { zohoBooksProvider } from "@/lib/zohobooks/provider";
import { regionalToken, regionOf, withRegion } from "@/lib/zohobooks/regions";
import { ZOHO_BOOKS_SCOPES, zohoBooksRedirectUri, zohoBooksSettingsFromEnv } from "@/lib/zohobooks/settings";

/**
 * Zoho Books on the connector core (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md): its app's
 * settings (Z2), its data centers and the tokens that carry them (Z3, Z4), its OAuth calls (Z10), and its bills, vendors
 * and organizations in the core's shapes (Z5, Z6, Z8).
 */

const SETTINGS = { clientId: "1000.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", clientSecret: "secret-not-a-real-one" };
const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const REDIRECT = "https://www.vestiarion.xyz/api/integrations/zohobooks/callback";

/** A fetch that answers `body` with `status`, and remembers each request it was sent. */
function fake(answers: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
  }) as unknown as typeof fetch;
  return { sent, deps: { fetchImpl, now: () => NOW } };
}

const formOf = (init: RequestInit) => new URLSearchParams(String(init.body));

describe("the Zoho Books app's settings (Z2)", () => {
  it("is on with a Zoho client id and a secret, and off otherwise", () => {
    expect(zohoBooksSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: ` ${SETTINGS.clientId} `, ZOHO_BOOKS_CLIENT_SECRET: "s" })).toEqual({ clientId: SETTINGS.clientId, clientSecret: "s" });
    expect(zohoBooksSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: SETTINGS.clientId })).toBeNull();
    expect(zohoBooksSettingsFromEnv({ ZOHO_BOOKS_CLIENT_SECRET: "s" })).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(zohoBooksSettingsFromEnv({ ZOHO_BOOKS_CLIENT_ID: "not-a-zoho-id", ZOHO_BOOKS_CLIENT_SECRET: "s" })).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not-a-zoho-id");
    warn.mockRestore();
  });

  it("sends people back to the deployment's own callback, and asks to read only", () => {
    expect(zohoBooksRedirectUri("https://www.vestiarion.xyz")).toBe(REDIRECT);
    expect(ZOHO_BOOKS_SCOPES).toEqual(["ZohoBooks.bills.READ", "ZohoBooks.contacts.READ", "ZohoBooks.settings.READ"]);
    for (const scope of ZOHO_BOOKS_SCOPES) expect(scope).toMatch(/\.READ$/);
  });
});

describe("Zoho's data centers (Z3, Z4)", () => {
  it("reads a callback's location from its own table only; none is the US", () => {
    expect(regionOf("eu")).toBe("eu");
    expect(regionOf(" IN ")).toBe("in");
    expect(regionOf(null)).toBe("us");
    expect(regionOf("")).toBe("us");
    for (const unknown of ["evil", "toString", "__proto__", "eu.attacker.example", "cn"]) expect(regionOf(unknown), unknown).toBeNull();
  });

  it("keeps each token with its data center, and refuses one without", () => {
    expect(withRegion("au", "1000.abc.def")).toBe("au|1000.abc.def");
    expect(regionalToken("au|1000.abc.def")).toEqual({ region: "au", token: "1000.abc.def" });
    for (const bad of ["1000.abc", "|1000.abc", "evil|1000.abc", "eu|"]) expect(() => regionalToken(bad), bad).toThrow();
  });
});

describe("Zoho's OAuth (Z3, Z4, Z10)", () => {
  it("authorizes at the US accounts server for a refresh token, read scopes only, consent every time", () => {
    const url = new URL(authorizeUrl(SETTINGS, { state: "s1", redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe("https://accounts.zoho.com/oauth/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: SETTINGS.clientId,
      response_type: "code",
      scope: "ZohoBooks.bills.READ,ZohoBooks.contacts.READ,ZohoBooks.settings.READ",
      redirect_uri: REDIRECT,
      access_type: "offline",
      prompt: "consent",
      state: "s1",
    });
    expect(url.toString()).not.toContain(SETTINGS.clientSecret);
  });

  it("exchanges the code at the accounts server of the callback's data center, and keeps it on both tokens", async () => {
    const { sent, deps } = fake([{ body: { access_token: "1000.access", refresh_token: "1000.refresh", api_domain: "https://www.zohoapis.eu", expires_in: 3600 } }]);
    const outcome = await exchangeCode(SETTINGS, { code: "c1", redirectUri: REDIRECT, region: "eu" }, deps);
    expect(sent[0].url).toBe("https://accounts.zoho.eu/oauth/v2/token");
    expect(Object.fromEntries(formOf(sent[0].init))).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      client_id: SETTINGS.clientId,
      client_secret: SETTINGS.clientSecret,
      redirect_uri: REDIRECT,
    });
    expect(outcome).toEqual({
      ok: true,
      authEventId: null,
      tokens: { accessToken: "eu|1000.access", refreshToken: "eu|1000.refresh", expiresAt: NOW + 3_600_000, scopes: [...ZOHO_BOOKS_SCOPES] },
    });
  });

  it("sends nothing for a data center not in its table, and refuses Zoho's errors answered with 200", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const none = fake([{ body: {} }]);
    expect(await exchangeCode(SETTINGS, { code: "c1", redirectUri: REDIRECT, region: "attacker" }, none.deps)).toEqual({ ok: false, reason: "refused" });
    expect(none.sent).toHaveLength(0);
    const refused = fake([{ status: 200, body: { error: "invalid_code" } }]);
    expect(await exchangeCode(SETTINGS, { code: "c1", redirectUri: REDIRECT, region: "us" }, refused.deps)).toEqual({ ok: false, reason: "refused" });
    const down = fake([{ status: 503, body: {} }]);
    expect(await exchangeCode(SETTINGS, { code: "c1", redirectUri: REDIRECT }, down.deps)).toEqual({ ok: false, reason: "unavailable" });
    expect(down.sent[0].url).toBe("https://accounts.zoho.com/oauth/v2/token");
    error.mockRestore();
  });

  it("refreshes at the token's own data center and keeps the refresh token, which Zoho does not send again", async () => {
    const { sent, deps } = fake([{ body: { access_token: "1000.access2", expires_in: 3600 } }]);
    const outcome = await refreshTokens(SETTINGS, "in|1000.refresh", deps);
    expect(sent[0].url).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(Object.fromEntries(formOf(sent[0].init))).toEqual({ grant_type: "refresh_token", refresh_token: "1000.refresh", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(outcome).toEqual({ ok: true, tokens: { accessToken: "in|1000.access2", refreshToken: "in|1000.refresh", expiresAt: NOW + 3_600_000, scopes: [...ZOHO_BOOKS_SCOPES] } });
  });

  it("asks for a person when Zoho no longer takes the refresh token, and waits on anything else", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await refreshTokens(SETTINGS, "us|1000.refresh", fake([{ body: { error: "invalid_code" } }]).deps)).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(SETTINGS, "1000.refresh-without-a-region", fake([{ body: {} }]).deps)).toEqual({ ok: false, reason: "reconnect" });
    expect(await refreshTokens(SETTINGS, "us|1000.refresh", fake([{ status: 500, body: {} }]).deps)).toEqual({ ok: false, reason: "unavailable", retryAfterMs: null });
    error.mockRestore();
  });

  it("revokes at the token's own data center", async () => {
    const { sent, deps } = fake([{ body: { status: "success" } }]);
    expect(await revokeToken("jp|1000.refresh", deps)).toBe(true);
    expect(sent[0].url).toBe("https://accounts.zoho.jp/oauth/v2/token/revoke");
    expect(formOf(sent[0].init).get("token")).toBe("1000.refresh");
    expect(await revokeToken("no-region", fake([{ body: {} }]).deps)).toBe(false);
  });
});

describe("Zoho Books' answers in the core's shapes (Z5, Z6, Z8)", () => {
  const BILL = {
    bill_id: "460000000038029",
    vendor_id: "460000000026049",
    vendor_name: "Lumen Print Co.",
    status: "open",
    bill_number: "LP-3101",
    reference_number: "PO-3101",
    date: "2026-10-14",
    due_date: "2026-10-28",
    currency_code: "USD",
    total: 9,
    balance: 9,
    last_modified_time: "2026-10-15T14:02:11+0530",
  };

  it("reads Zoho's times with or without a colon in the offset, in UTC", () => {
    expect(zohoTime("2026-10-15T14:02:11+0530")).toBe("2026-10-15T08:32:11.000Z");
    expect(zohoTime("2026-10-15T14:02:11+05:30")).toBe("2026-10-15T08:32:11.000Z");
    expect(zohoTime("2026-10-15T08:32:11Z")).toBe("2026-10-15T08:32:11.000Z");
    expect(zohoTime("2026-10-15 14:02:11")).toBeNull();
    expect(zohoFilterTime("2026-10-15T08:32:11.987Z")).toBe("2026-10-15T08:32:11+0000");
    expect(zohoAmount(40.6)).toBe("40.6");
    expect(zohoAmount("1250.50")).toBe("1250.5");
    expect(zohoAmount("1e3")).toBeNull();
  });

  it("maps a bill, its version its update time", () => {
    expect(mapBill(BILL)).toEqual({
      externalId: "460000000038029",
      version: "2026-10-15T08:32:11.000Z",
      updatedAt: "2026-10-15T08:32:11.000Z",
      contactExternalId: "460000000026049",
      contactName: "Lumen Print Co.",
      number: "LP-3101",
      reference: "PO-3101",
      currency: "USD",
      total: "9",
      amountDue: "9",
      issuedOn: "2026-10-14",
      dueOn: "2026-10-28",
      status: "open",
    });
  });

  it("reads each status of a bill in the core's words, and leaves out one it does not know", () => {
    const statusOf = (status: string) => mapBill({ ...BILL, status })?.status ?? null;
    expect(["open", "overdue", "partially_paid", "approved"].map(statusOf)).toEqual(["open", "open", "open", "open"]);
    expect(statusOf("paid")).toBe("paid");
    expect(statusOf("void")).toBe("voided");
    expect(statusOf("draft")).toBe("draft");
    expect(statusOf("pending_approval")).toBe("draft");
    expect(statusOf("something_new")).toBeNull();
    expect(mapBill({ ...BILL, currency_code: "usd" })?.currency).toBe("USD");
    expect(mapBill({ ...BILL, total: "a lot" })).toBeNull();
    expect(mapBill({ ...BILL, last_modified_time: undefined })).toBeNull();
  });

  it("pages by has_more_page, and refuses an answer Zoho sent as an error", () => {
    expect(mapBillsPage({ code: 0, bills: [BILL], page_context: { has_more_page: true } }, 1)).toMatchObject({ page: 1, last: false, items: [{ externalId: BILL.bill_id }] });
    expect(mapBillsPage({ code: 0, bills: [], page_context: { has_more_page: false } }, 2)).toMatchObject({ last: true, items: [] });
    expect(() => mapBillsPage({ code: 57, message: "You are not authorized to perform this operation" }, 1)).toThrow(ProviderError);
  });

  it("maps vendors, inactive ones archived, and the organizations a token reaches", () => {
    const page = mapVendorsPage(
      {
        code: 0,
        contacts: [
          { contact_id: "4600001", contact_name: "Lumen Print Co.", contact_type: "vendor", status: "active", last_modified_time: "2026-10-15T14:02:11+0530" },
          { contact_id: "4600002", contact_name: "Old Supplier", contact_type: "vendor", status: "inactive", last_modified_time: "2026-09-01T10:00:00+0000" },
          { contact_id: "4600003", contact_name: "A customer", contact_type: "customer", status: "active", last_modified_time: "2026-09-01T10:00:00+0000" },
        ],
        page_context: { has_more_page: false },
      },
      1
    );
    expect(page.items.map((vendor) => [vendor.externalId, vendor.archived, vendor.isSupplier])).toEqual([
      ["4600001", false, true],
      ["4600002", true, true],
    ]);
    expect(mapOrganizations({ code: 0, organizations: [{ organization_id: "60012345678", name: "Lumen Holdings" }, { organization_id: 60087654321, name: "" }] })).toEqual([
      { externalOrgId: "60012345678", name: "Lumen Holdings", connectionId: null },
      { externalOrgId: "60087654321", name: "Zoho Books organization", connectionId: null },
    ]);
  });

  it("refuses a token answer without an access token, naming the field and never a value", () => {
    expect(() => mapTokens({ refresh_token: "1000.secret" }, "us", NOW, ZOHO_BOOKS_SCOPES)).toThrow(/access_token/);
    try {
      mapTokens({ access_token: "1000.secret" }, "us", NOW, ZOHO_BOOKS_SCOPES);
    } catch (error) {
      expect(String(error)).not.toContain("1000.secret");
    }
  });
});

describe("reading an organization (Z5, Z6)", () => {
  it("calls the token's data center with Zoho-oauthtoken and the organization's id", async () => {
    const { sent, deps } = fake([{ body: { code: 0, bills: [], page_context: { has_more_page: false } } }]);
    const provider = zohoBooksProvider(SETTINGS, deps);
    await provider.bills({ accessToken: "eu|1000.access", externalOrgId: "60012345678", page: 1, phase: "backfill", since: null });
    const url = new URL(sent[0].url);
    expect(url.origin + url.pathname).toBe("https://www.zohoapis.eu/books/v3/bills");
    expect(url.searchParams.get("organization_id")).toBe("60012345678");
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe("Zoho-oauthtoken 1000.access");
  });

  it("reads every bill in a backfill, and those changed since the cursor in an incremental run, oldest first", () => {
    const base = { externalOrgId: "600", page: 2 };
    expect(billsParams({ ...base, phase: "backfill", since: null })).toEqual({
      organization_id: "600",
      filter_by: "Status.All",
      sort_column: "created_time",
      sort_order: "A",
      page: "2",
      per_page: String(PAGE_SIZE),
    });
    expect(billsParams({ ...base, phase: "incremental", since: "2026-10-15T08:32:11.000Z" }).last_modified_time).toBe("2026-10-15T08:32:11+0000");
  });

  it("lists the organizations a new token reaches, and reads no chart of accounts", async () => {
    const { sent, deps } = fake([{ body: { code: 0, organizations: [{ organization_id: "600", name: "Lumen Holdings" }] } }]);
    const provider = zohoBooksProvider(SETTINGS, deps);
    expect(provider.callbackRegionParam).toBe("location");
    const tokens = { accessToken: "au|1000.a", refreshToken: "au|1000.r", expiresAt: NOW, scopes: [] };
    expect(await provider.organisations(tokens, null)).toEqual([{ externalOrgId: "600", name: "Lumen Holdings", connectionId: null }]);
    expect(sent[0].url).toBe("https://www.zohoapis.com.au/books/v3/organizations");
    expect(await provider.accounts({ accessToken: "au|1000.a", externalOrgId: "600" })).toEqual([]);
    expect(provider.booking).toBeUndefined();
  });

  it("turns Zoho's refusals into the core's failures", async () => {
    const provider = (status: number, headers: Record<string, string> = {}) => zohoBooksProvider(SETTINGS, fake([{ status, body: { code: 44 }, headers }]).deps);
    const request = { accessToken: "us|1000.a", externalOrgId: "600", page: 1, phase: "backfill" as const, since: null };
    await expect(provider(429).bills(request)).rejects.toMatchObject({ failure: "rate_limited", retryAfterMs: 60_000 });
    await expect(provider(401).bills(request)).rejects.toMatchObject({ failure: "unauthorized" });
    await expect(provider(403).contacts(request)).rejects.toMatchObject({ failure: "forbidden" });
    await expect(provider(502).bills(request)).rejects.toMatchObject({ failure: "unavailable" });
    expect(() => booksUrl("no-region-token", "bills")).toThrow();
  });
});
