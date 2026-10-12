import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { chooseConnect, finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import type { AccountingProvider, ExternalOrganisation } from "@/lib/connectors/provider";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md X3, X4, X12): only an owner
 * or admin who ticked I agree, from this deployment's own page, goes to Xero; on the way back the state must be
 * Vestiarion's, recent, carry the browser's nonce and the consent, and name the person signed in now, still allowed to
 * manage integrations; one organisation is connected at once, several are offered to pick from, and a workspace already
 * connected to another organisation is refused.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d02";
const OTHER_USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d03";
const PENDING = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d04";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

const DEMO: ExternalOrganisation = { externalOrgId: "70784a63-d24b-46a9-a4db-0e70a274b056", name: "Demo Company (Global)", connectionId: "e1eede29" };
const NORTHSTAR: ExternalOrganisation = { externalOrgId: "e0da6937-de07-4a14-adee-37abfac298ce", name: "Northstar Studio Pte Ltd", connectionId: "32587c85" };
const TOKENS = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 1_800_000, scopes: ["offline_access", "accounting.invoices.read"] };
const CONSENT = { version: "xero-2026-10-12", at: "2026-10-12T07:59:00.000Z" };

const exchangeCode = vi.fn();
const organisations = vi.fn();
const provider = {
  id: "xero",
  label: "Xero",
  scopes: ["offline_access", "accounting.invoices.read"],
  authorizeUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) => `https://login.xero.com/identity/connect/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode,
  organisations,
} as unknown as AccountingProvider;

const CONNECTION_ROW = {
  id: "conn-1", org_id: ORG, provider: "xero", external_org_id: DEMO.externalOrgId, external_org_name: DEMO.name, status: "connected", scopes: TOKENS.scopes,
  connected_by: USER, connected_at: "2026-10-12T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-14",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

beforeEach(() => {
  for (const mock of [...Object.values(mocks), exchangeCode, organisations]) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "admin", network: "arc-testnet" });
  exchangeCode.mockResolvedValue({ ok: true, tokens: TOKENS, authEventId: "event-1" });
  organisations.mockResolvedValue([DEMO]);
});

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
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
  const deps = (): ConnectDeps => ({ provider, origin: ORIGIN, keys: keys(), now: () => NOW, afterConnect: (work) => later.push(work), firstSync });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run, deps, later, firstSync };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);

function form(fields: Record<string, string>, origin: string | null = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/integrations/xero/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

function callback(query: Record<string, string>, nonce: string | null): Request {
  return new Request(`${ORIGIN}/api/integrations/xero/callback?${new URLSearchParams(query).toString()}`, {
    headers: nonce ? { cookie: `vx_xero_oauth=${nonce}` } : {},
  });
}

const NONCE = "n".repeat(43);
const signed = (fields: Partial<Parameters<typeof connectState>[0]> = {}, nowMs = NOW) =>
  connectState({ provider: "xero", org: ORG, user: USER, nonce: NONCE, consent: CONSENT, ...fields }, keys(), nowMs);

describe("startConnect", () => {
  it("sends an owner or admin who agreed to Xero, with a signed state carrying the consent and a nonce in their cookie", async () => {
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://login.xero.com/identity/connect/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/xero/callback`);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "xero", org: ORG, user: USER, consent: { version: "xero-2026-10-12.2", at: "2026-10-12T08:00:00.000Z" } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_xero_oauth=${state?.nonce}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toContain("Path=/api/integrations/xero");
  });

  it("refuses a form from another site", async () => {
    const { run, deps } = world();
    expect((await run(() => startConnect(form({ org: "acme", consent: "yes" }, "https://evil.example"), deps()))).status).toBe(403);
    expect((await run(() => startConnect(form({ org: "acme", consent: "yes" }, null), deps()))).status).toBe(403);
  });

  it("asks for the tick before going to Xero", async () => {
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme" }), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/integrations/xero/connect?org=acme&consent=missing`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("sends a member who may not manage integrations back, and a signed-out person to sign in", async () => {
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "approver", network: "arc-testnet" });
    const { run, deps } = world();
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(
      `${ORIGIN}/integrations/xero/connect?org=acme&error=forbidden`
    );
    mocks.session.mockResolvedValue(null);
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).pathname).toBe("/login");
  });

  it("says Xero is not set up yet before migration 0101 has run", async () => {
    const { run, deps } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" ? { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.accounting_connections'" } } : undefined
    );
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(
      `${ORIGIN}/integrations/xero/connect?org=acme&error=not_set_up`
    );
  });
});

describe("finishConnect", () => {
  it("connects the one organisation: the connection with its consent, its tokens, the entry, and the first sync after the answer", async () => {
    const { fake, run, deps, later, firstSync } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?xero=connected#xero`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(exchangeCode).toHaveBeenCalledWith({ code: "the-code", redirectUri: `${ORIGIN}/api/integrations/xero/callback` });
    expect(organisations).toHaveBeenCalledWith(TOKENS, "event-1");
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({
      org_id: ORG, provider: "xero", external_org_id: DEMO.externalOrgId, external_org_name: DEMO.name, status: "connected", connected_by: USER,
      consent_version: "xero-2026-10-12", consented_at: CONSENT.at, window_from: "2026-07-14",
    });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(tokens?.body).toMatchObject({ org_id: ORG, connection_id: "conn-1", authorized_by: USER });
    expect(JSON.stringify(tokens?.body)).not.toContain("refresh-1");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_action: "accounting_connected", p_actor: "human", p_domain: "system" });
    expect(entry.p_detail).toEqual({
      by: USER, provider: "xero", connectionId: "conn-1", externalOrgId: DEMO.externalOrgId, externalOrgName: DEMO.name, scopes: TOKENS.scopes, consent: CONSENT, reconnected: false,
    });
    expect(later).toHaveLength(1);
    await run(() => later[0]());
    expect(firstSync).toHaveBeenCalledWith(expect.objectContaining({ id: "conn-1" }));
  });

  it("offers the organisations to pick from when Xero authorized several, keeping the tokens as a pending grant", async () => {
    organisations.mockResolvedValue([DEMO, NORTHSTAR]);
    const { fake, run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), deps()));
    const to = location(response);
    expect(`${to.pathname}`).toBe("/integrations/xero/connect");
    expect(Object.fromEntries(to.searchParams)).toEqual({ org: "acme", choose: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const pending = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST")?.body as Record<string, unknown>;
    expect(pending).toMatchObject({ connection_id: null, choose_until: "2026-10-12T08:10:00.000Z", choices: { organisations: [DEMO, NORTHSTAR], consent: CONSENT } });
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST")).toBe(false);
  });

  it("refuses a state whose nonce is not the browser's, and one with no cookie", async () => {
    const { run, deps } = world();
    const mismatch = await run(() => finishConnect(callback({ code: "c", state: signed() }, "m".repeat(43)), deps()));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toMatch(/expired or was not started from this browser/);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed() }, null), deps()))).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses an expired state, and one signed with another key", async () => {
    const { run, deps } = world();
    expect((await run(() => finishConnect(callback({ code: "c", state: signed({}, NOW - 11 * 60_000) }, NONCE), deps()))).status).toBe(400);
    const forged = connectState({ provider: "xero", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, parseMasterKeys(`t9:${Buffer.alloc(32, 9).toString("base64")}`), NOW);
    expect((await run(() => finishConnect(callback({ code: "c", state: forged }, NONCE), deps()))).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses another person than the one who started, and a person who is no longer allowed", async () => {
    const { run, deps } = world();
    mocks.session.mockResolvedValue({ id: OTHER_USER, email: null });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?xero=forbidden#xero`);
    mocks.session.mockResolvedValue({ id: USER, email: null });
    mocks.membership.mockResolvedValue(null);
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?xero=forbidden#xero`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "viewer", network: "arc-testnet" });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?xero=forbidden#xero`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a state without the consent, before the code is exchanged", async () => {
    const { run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "c", state: signed({ consent: null }) }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/integrations/xero/connect?org=acme&consent=missing`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("says cancelled when the person said no at Xero, and failed when Xero refused the code", async () => {
    const { run, deps } = world();
    expect(location(await run(() => finishConnect(callback({ error: "access_denied", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?xero=cancelled#xero`
    );
    exchangeCode.mockResolvedValue({ ok: false, reason: "refused" });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?xero=failed#xero`
    );
  });

  it("refuses another organisation while the workspace is connected to one, and writes no tokens", async () => {
    const { fake, run, deps } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "GET"
        ? { body: [{ ...CONNECTION_ROW, external_org_id: NORTHSTAR.externalOrgId, external_org_name: NORTHSTAR.name }] }
        : undefined
    );
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?xero=other_organisation#xero`
    );
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens")).toBe(false);
  });

  it("reconnects the same organisation's row, keeping it, and says so in the entry", async () => {
    const { fake, run, deps } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [{ ...CONNECTION_ROW, status: "needs_reconnect" }] };
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [CONNECTION_ROW] };
      return undefined;
    });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?xero=connected#xero`);
    const patch = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH");
    expect(patch?.params.get("id")).toBe("eq.conn-1");
    expect(patch?.body).toMatchObject({ status: "connected", revoked_at: null, failures: 0, last_error: null });
    expect(patch?.body).not.toHaveProperty("window_from");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail.reconnected).toBe(true);
  });
});

describe("chooseConnect", () => {
  const pendingRow = (fields: Record<string, unknown> = {}) => ({
    id: PENDING, provider: "xero", authorized_by: USER, scopes: TOKENS.scopes, choices: { organisations: [DEMO, NORTHSTAR], consent: CONSENT },
    choose_until: "2026-10-12T08:10:00.000Z", ...fields,
  });

  function chooseForm(fields: Record<string, string>, origin: string | null = ORIGIN) {
    return new Request(`${ORIGIN}/api/integrations/xero/choose`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("connects the organisation picked with the pending grant's tokens and consent", async () => {
    const { fake, run, deps } = world((sent) => {
      if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET") return { body: [pendingRow()] };
      if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "PATCH") return { body: [{ id: PENDING }] };
      return undefined;
    });
    const response = await run(() => chooseConnect(chooseForm({ org: "acme", choice: PENDING, organisation: NORTHSTAR.externalOrgId }), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?xero=connected#xero`);
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({ external_org_id: NORTHSTAR.externalOrgId, external_org_name: NORTHSTAR.name, consent_version: CONSENT.version, scopes: TOKENS.scopes });
    const attach = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "PATCH");
    expect(attach?.body).toEqual({ connection_id: "conn-1", choices: null, choose_until: null });
  });

  it("refuses a pending grant that is not this person's, has run out, or an organisation it did not offer", async () => {
    const theirs = world((sent) => (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET" ? { body: [pendingRow({ authorized_by: OTHER_USER })] } : undefined));
    expect(location(await theirs.run(() => chooseConnect(chooseForm({ org: "acme", choice: PENDING, organisation: DEMO.externalOrgId }), theirs.deps()))).toString()).toBe(
      `${ORIGIN}/integrations/xero/connect?org=acme&error=expired`
    );
    const late = world((sent) => (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET" ? { body: [pendingRow({ choose_until: "2026-10-12T07:59:00.000Z" })] } : undefined));
    expect(location(await late.run(() => chooseConnect(chooseForm({ org: "acme", choice: PENDING, organisation: DEMO.externalOrgId }), late.deps()))).searchParams.get("error")).toBe("expired");
    const other = world((sent) => (sent.path === "/rest/v1/accounting_tokens" && sent.method === "GET" ? { body: [pendingRow()] } : undefined));
    expect(location(await other.run(() => chooseConnect(chooseForm({ org: "acme", choice: PENDING, organisation: "not-offered" }), other.deps()))).searchParams.get("error")).toBe("pick");
    expect(other.fake.requests.some((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST")).toBe(false);
  });

  it("refuses a form from another site, and a member who may not manage integrations", async () => {
    const { run, deps } = world();
    expect((await run(() => chooseConnect(chooseForm({ org: "acme", choice: PENDING, organisation: DEMO.externalOrgId }, "https://evil.example"), deps()))).status).toBe(403);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "approver", network: "arc-testnet" });
    expect(location(await run(() => chooseConnect(chooseForm({ org: "acme", choice: PENDING, organisation: DEMO.externalOrgId }), deps()))).searchParams.get("error")).toBe("forbidden");
  });
});
