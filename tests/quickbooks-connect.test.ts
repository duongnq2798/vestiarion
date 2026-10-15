import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { CONSENT_VERSIONS } from "@/lib/connectors/consent";
import type { AccountingProvider, ExternalOrganisation } from "@/lib/connectors/provider";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { quickBooksProvider } from "@/lib/quickbooks/provider";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to QuickBooks Online (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4,
 * Q5, Q13), as Xero's callback is held (Xero connector X4): only an owner or admin who ticked I agree goes to Intuit; on
 * the way back the state must be Vestiarion's, recent, carry the browser's nonce and the consent, and name the person
 * signed in now, still allowed to manage integrations. Then the company the callback names is confirmed with the new
 * token; a company another workspace holds is refused without keeping or revoking the tokens; the same company again
 * reconnects its row.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e09";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e02";
const OTHER_USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e03";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const REALM = "9341455327810551";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

const SANDBOX: ExternalOrganisation = { externalOrgId: REALM, name: "Sandbox Company_US_1", connectionId: null };
const TOKENS = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 3_600_000, scopes: ["com.intuit.quickbooks.accounting"] };
const CONSENT = { version: "quickbooks-2026-10-12", at: "2026-10-12T07:59:00.000Z" };

const exchangeCode = vi.fn();
const organisations = vi.fn();
const revoke = vi.fn();
const provider = {
  id: "quickbooks",
  label: "QuickBooks",
  scopes: ["com.intuit.quickbooks.accounting"],
  callbackOrganisationParam: "realmId",
  exclusive: true,
  authorizeUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
    `https://appcenter.intuit.com/connect/oauth2?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode,
  organisations,
  revoke,
} as unknown as AccountingProvider;

const CONNECTION_ROW = {
  id: "conn-1", org_id: ORG, provider: "quickbooks", external_org_id: REALM, external_org_name: SANDBOX.name, status: "connected", scopes: TOKENS.scopes,
  connected_by: USER, connected_at: "2026-10-12T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-14",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

beforeEach(() => {
  for (const mock of [...Object.values(mocks), exchangeCode, organisations, revoke]) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "admin", network: "arc-testnet" });
  exchangeCode.mockResolvedValue({ ok: true, tokens: TOKENS, authEventId: null });
  organisations.mockResolvedValue([SANDBOX]);
});

const BY_EXTERNAL = "/rest/v1/rpc/accounting_connections_by_external";

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined, deps: Partial<ConnectDeps> = {}) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: sent.params.get("select") === "slug" ? { slug: "acme" } : orgs.orgRow(ORG, { slug: "acme" }) };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "POST") return { body: [CONNECTION_ROW] };
    if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST") return { body: [{ id: "tok-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const later: Array<() => Promise<void>> = [];
  const firstSync = vi.fn(async () => undefined);
  const make = (): ConnectDeps => ({ provider, origin: ORIGIN, keys: keys(), now: () => NOW, afterConnect: (work) => later.push(work), firstSync, ...deps });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run, deps: make, later, firstSync };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const wrote = (fake: ReturnType<typeof fakeSupabase>, path: string) => fake.requests.some((sent) => sent.path === path && sent.method !== "GET");

function form(fields: Record<string, string>, origin: string | null = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/integrations/quickbooks/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams({ consent_version: CONSENT_VERSIONS.quickbooks, ...fields }).toString(),
  });
}

function callback(query: Record<string, string>, nonce: string | null): Request {
  return new Request(`${ORIGIN}/api/integrations/quickbooks/callback?${new URLSearchParams(query).toString()}`, {
    headers: nonce ? { cookie: `vx_quickbooks_oauth=${nonce}` } : {},
  });
}

const NONCE = "q".repeat(43);
const signed = (fields: Partial<Parameters<typeof connectState>[0]> = {}, nowMs = NOW) =>
  connectState({ provider: "quickbooks", org: ORG, user: USER, nonce: NONCE, consent: CONSENT, ...fields }, keys(), nowMs);
const back = (code: string, query: Record<string, string> = { state: signed() }) => callback({ code, realmId: REALM, ...query }, NONCE);

describe("startConnect for QuickBooks", () => {
  it("sends an owner or admin who agreed to Intuit, with a signed state carrying QuickBooks' consent and a nonce in its own cookie", async () => {
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/quickbooks/callback`);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "quickbooks", org: ORG, user: USER, consent: { version: "quickbooks-2026-10-15", at: "2026-10-12T08:00:00.000Z" } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_quickbooks_oauth=${state?.nonce}`);
    expect(cookie).toContain("Path=/api/integrations/quickbooks");
    expect(cookie).toMatch(/HttpOnly/);
  });

  it("asks for the tick first, and refuses a form from another site", async () => {
    const { run, deps } = world();
    expect(location(await run(() => startConnect(form({ org: "acme" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/quickbooks/connect?org=acme&consent=missing`);
    expect((await run(() => startConnect(form({ org: "acme", consent: "yes" }, "https://evil.example"), deps()))).status).toBe(403);
  });
});

describe("finishConnect for QuickBooks", () => {
  it("connects the company the callback named, once the new token reads it: the connection, its tokens, the entry and the first sync", async () => {
    const { fake, run, deps, later, firstSync } = world();
    const response = await run(() => finishConnect(back("the-code"), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=connected#quickbooks`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(exchangeCode).toHaveBeenCalledWith({ code: "the-code", redirectUri: `${ORIGIN}/api/integrations/quickbooks/callback` });
    expect(organisations).toHaveBeenCalledWith(TOKENS, null, REALM);
    const check = fake.requests.find((sent) => sent.path === BY_EXTERNAL);
    expect(check?.body).toEqual({ p_provider: "quickbooks", p_external_org_ids: [REALM] });
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({
      org_id: ORG, provider: "quickbooks", external_org_id: REALM, external_org_name: "Sandbox Company_US_1", status: "connected", connected_by: USER,
      consent_version: "quickbooks-2026-10-12", consented_at: CONSENT.at, window_from: "2026-07-14", scopes: ["com.intuit.quickbooks.accounting"],
    });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(tokens?.body).toMatchObject({ org_id: ORG, provider: "quickbooks", connection_id: "conn-1", authorized_by: USER });
    expect(JSON.stringify(tokens?.body)).not.toContain("refresh-1");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_action: "accounting_connected", p_actor: "human", p_domain: "system" });
    expect(entry.p_summary).toBe("Connected QuickBooks: Sandbox Company_US_1. Its bills come in for review on Bills & receivables");
    expect(entry.p_detail).toEqual({
      by: USER, provider: "quickbooks", connectionId: "conn-1", externalOrgId: REALM, externalOrgName: "Sandbox Company_US_1", scopes: TOKENS.scopes, consent: CONSENT, reconnected: false,
    });
    expect(later).toHaveLength(1);
    await run(() => later[0]());
    expect(firstSync).toHaveBeenCalledWith(expect.objectContaining({ id: "conn-1" }));
  });

  it("refuses a state whose nonce is not the browser's, and one with no cookie", async () => {
    const { run, deps } = world();
    const mismatch = await run(() => finishConnect(callback({ code: "c", realmId: REALM, state: signed() }, "m".repeat(43)), deps()));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toMatch(/This QuickBooks connection link has expired or was not started from this browser/);
    expect((await run(() => finishConnect(callback({ code: "c", realmId: REALM, state: signed() }, null), deps()))).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses an expired state, one signed with another key, and Xero's state", async () => {
    const { run, deps } = world();
    expect((await run(() => finishConnect(back("c", { state: signed({}, NOW - 11 * 60_000) }), deps()))).status).toBe(400);
    const forged = connectState({ provider: "quickbooks", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, parseMasterKeys(`t9:${Buffer.alloc(32, 9).toString("base64")}`), NOW);
    expect((await run(() => finishConnect(back("c", { state: forged }), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(back("c", { state: signed({ provider: "xero" }) }), deps()))).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses another person than the one who started, a person no longer a member, and one who may not manage integrations", async () => {
    const { run, deps } = world();
    mocks.session.mockResolvedValue({ id: OTHER_USER, email: null });
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=forbidden#quickbooks`);
    mocks.session.mockResolvedValue({ id: USER, email: null });
    mocks.membership.mockResolvedValue(null);
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=forbidden#quickbooks`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "viewer", network: "arc-testnet" });
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=forbidden#quickbooks`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a state without the consent, before the code is exchanged", async () => {
    const { run, deps } = world();
    expect(location(await run(() => finishConnect(back("c", { state: signed({ consent: null }) }), deps()))).toString()).toBe(
      `${ORIGIN}/integrations/quickbooks/connect?org=acme&consent=missing`
    );
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("says cancelled when the person said no at Intuit, and failed when the callback names no company, before exchanging the code", async () => {
    const { run, deps } = world();
    expect(location(await run(() => finishConnect(callback({ error: "access_denied", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?quickbooks=cancelled#quickbooks`
    );
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?quickbooks=failed#quickbooks`
    );
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a company another workspace holds, keeping no token and revoking none, and names no workspace", async () => {
    const { fake, run, deps } = world((sent) =>
      sent.path === BY_EXTERNAL ? { body: [{ org_id: OTHER_ORG, connection_id: "conn-9", external_org_id: REALM, status: "connected", next_sync_after: null }] } : undefined
    );
    const response = await run(() => finishConnect(back("c"), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=other_workspace#quickbooks`);
    expect(wrote(fake, "/rest/v1/accounting_connections")).toBe(false);
    expect(wrote(fake, "/rest/v1/accounting_tokens")).toBe(false);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("refuses the same company when another workspace connected it a moment before, by the database's own index", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fake, run, deps } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "POST"
        ? { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "accounting_connections_quickbooks_one_workspace"' } }
        : undefined
    );
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=other_workspace#quickbooks`);
    expect(wrote(fake, "/rest/v1/accounting_tokens")).toBe(false);
    error.mockRestore();
  });

  it("reconnects its own company's row, a connection of this workspace not counting as another's", async () => {
    const { fake, run, deps } = world((sent) => {
      if (sent.path === BY_EXTERNAL) return { body: [{ org_id: ORG, connection_id: "conn-1", external_org_id: REALM, status: "needs_reconnect", next_sync_after: null }] };
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [{ ...CONNECTION_ROW, status: "needs_reconnect" }] };
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [CONNECTION_ROW] };
      return undefined;
    });
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=connected#quickbooks`);
    const patch = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH");
    expect(patch?.params.get("id")).toBe("eq.conn-1");
    expect(patch?.body).toMatchObject({ status: "connected", revoked_at: null, failures: 0 });
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail.reconnected).toBe(true);
  });

  it("refuses another company while the workspace is connected to one", async () => {
    const { fake, run, deps } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "GET" ? { body: [{ ...CONNECTION_ROW, external_org_id: "123145812345678" }] } : undefined
    );
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=other_organisation#quickbooks`);
    expect(wrote(fake, "/rest/v1/accounting_tokens")).toBe(false);
  });

  it("says not set up before migration 0102 has run", async () => {
    const { run, deps } = world((sent) =>
      sent.path === BY_EXTERNAL ? { status: 404, body: { code: "PGRST202", message: "Could not find the function public.accounting_connections_by_external" } } : undefined
    );
    expect(location(await run(() => finishConnect(back("c"), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?quickbooks=not_set_up#quickbooks`);
  });

  it("connects nothing when the realm id was edited on the way back: the new token cannot read that company", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const intuit = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://oauth.platform.intuit.com/")) {
        return new Response(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }), { status: 200 });
      }
      // The token was granted for another company: QuickBooks refuses this one.
      return new Response(JSON.stringify({ Fault: { Error: [{ code: "3100" }], type: "AuthorizationFault" } }), { status: 403 });
    }) as unknown as typeof fetch;
    const real = quickBooksProvider({ clientId: "ABcdEFghIJklMNopQRstUVwxYZ0123456789abcdefghijklmn", clientSecret: "s", environment: "sandbox" }, { fetchImpl: intuit, now: () => NOW });
    const { fake, run, deps } = world(undefined, { provider: real });
    expect(location(await run(() => finishConnect(callback({ code: "c", realmId: "123145812345678", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?quickbooks=failed#quickbooks`
    );
    expect(String((intuit as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0])).toContain("/v3/company/123145812345678/companyinfo/123145812345678");
    expect(wrote(fake, "/rest/v1/accounting_connections")).toBe(false);
    expect(wrote(fake, "/rest/v1/accounting_tokens")).toBe(false);
    expect(error.mock.calls.flat().join(" ")).not.toContain("access-1");
    error.mockRestore();
  });
});
