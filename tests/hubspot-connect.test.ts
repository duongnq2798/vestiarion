import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { NotSetUpError } from "@/lib/connectors/connections";
import type { ConnectingProvider, ExternalOrganisation } from "@/lib/connectors/provider";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to HubSpot (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H3, H4, H14), through
 * the connector core's flow, as Xero's: only an owner or admin who ticked I agree goes to HubSpot; on the way back the
 * state must be Vestiarion's, recent, carry the browser's nonce and the consent, and name the person signed in now,
 * still allowed to manage integrations. One account per grant; an account another workspace holds is refused, and so is
 * a second account while the workspace is connected to one; the same account again reconnects its row.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e02";
const OTHER_USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e03";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e04";
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

const HUB: ExternalOrganisation = { externalOrgId: "1234567", name: "example.com", connectionId: null };
const OTHER_HUB: ExternalOrganisation = { externalOrgId: "7654321", name: "northwind.example", connectionId: null };
const SCOPES = ["oauth", "crm.objects.companies.read", "crm.objects.contacts.read", "crm.objects.deals.read"];
const TOKENS = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: NOW + 1_800_000, scopes: SCOPES };
const CONSENT = { version: "hubspot-2026-10-12", at: "2026-10-12T07:59:00.000Z" };

const exchangeCode = vi.fn();
const organisations = vi.fn();
const ready = vi.fn();
const provider: ConnectingProvider = {
  id: "hubspot",
  label: "HubSpot",
  scopes: SCOPES,
  exclusive: true,
  authorizeUrl: ({ state, redirectUri, write }) => `https://app.hubspot.com/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}&write=${write ? 1 : 0}`,
  exchangeCode,
  organisations,
  refresh: vi.fn(),
  revoke: vi.fn(),
};

const CONNECTION_ROW = {
  id: "conn-1", org_id: ORG, provider: "hubspot", external_org_id: HUB.externalOrgId, external_org_name: HUB.name, status: "connected", scopes: SCOPES,
  connected_by: USER, connected_at: "2026-10-12T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-14",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

beforeEach(() => {
  for (const mock of [...Object.values(mocks), exchangeCode, organisations, ready]) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "admin", network: "arc-testnet" });
  exchangeCode.mockResolvedValue({ ok: true, tokens: TOKENS, authEventId: null });
  organisations.mockResolvedValue([HUB]);
  ready.mockResolvedValue(undefined);
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
  const deps = (): ConnectDeps => ({ provider, origin: ORIGIN, keys: keys(), now: () => NOW, ready, afterConnect: (work) => later.push(work), firstSync });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run, deps, later, firstSync };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);

function form(fields: Record<string, string>, origin: string | null = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/integrations/hubspot/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

function callback(query: Record<string, string>, nonce: string | null): Request {
  return new Request(`${ORIGIN}/api/integrations/hubspot/callback?${new URLSearchParams(query).toString()}`, {
    headers: nonce ? { cookie: `vx_hubspot_oauth=${nonce}` } : {},
  });
}

const NONCE = "n".repeat(43);
const signed = (fields: Partial<Parameters<typeof connectState>[0]> = {}, nowMs = NOW) =>
  connectState({ provider: "hubspot", org: ORG, user: USER, nonce: NONCE, consent: CONSENT, ...fields }, keys(), nowMs);

describe("startConnect for HubSpot", () => {
  it("sends an owner or admin who agreed to HubSpot, with a signed state carrying the consent and a nonce in their cookie", async () => {
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://app.hubspot.com/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/hubspot/callback`);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "hubspot", org: ORG, user: USER, consent: { version: "hubspot-2026-10-13", at: "2026-10-12T08:00:00.000Z" } });
    // Writing was not asked for: HubSpot is asked for the read scopes alone.
    expect(state?.write).toBeUndefined();
    expect(to.searchParams.get("write")).toBe("0");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_hubspot_oauth=${state?.nonce}`);
    expect(cookie).toContain("Path=/api/integrations/hubspot");
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("refuses a form from another site, asks for the tick, and sends a member who may not manage integrations back", async () => {
    const { run, deps } = world();
    expect((await run(() => startConnect(form({ org: "acme", consent: "yes" }, "https://evil.example"), deps()))).status).toBe(403);
    expect(location(await run(() => startConnect(form({ org: "acme" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/hubspot/connect?org=acme&consent=missing`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "approver", network: "arc-testnet" });
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(
      `${ORIGIN}/integrations/hubspot/connect?org=acme&error=forbidden`
    );
  });

  it("says HubSpot is not set up yet before migration 0105 has run, without going to HubSpot", async () => {
    ready.mockRejectedValue(new NotSetUpError());
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/integrations/hubspot/connect?org=acme&error=not_set_up`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("finishConnect for HubSpot", () => {
  it("connects the one account of the grant: the connection with its consent, its tokens, the entry, and the first sync", async () => {
    const { fake, run, deps, later, firstSync } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=connected#hubspot`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(exchangeCode).toHaveBeenCalledWith({ code: "the-code", redirectUri: `${ORIGIN}/api/integrations/hubspot/callback` });
    const asked = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/accounting_connections_by_external");
    expect(asked?.body).toEqual({ p_provider: "hubspot", p_external_org_ids: [HUB.externalOrgId] });
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({
      org_id: ORG, provider: "hubspot", external_org_id: HUB.externalOrgId, external_org_name: HUB.name, status: "connected", connected_by: USER,
      consent_version: "hubspot-2026-10-12", consented_at: CONSENT.at, window_from: "2026-07-14",
    });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(tokens?.body).toMatchObject({ org_id: ORG, provider: "hubspot", connection_id: "conn-1", authorized_by: USER });
    expect(JSON.stringify(tokens?.body)).not.toContain("refresh-1");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_action: "accounting_connected", p_actor: "human", p_domain: "system" });
    expect(entry.p_summary).toBe("Connected HubSpot: example.com. Its won deals come in to plan collections on Bills & receivables");
    expect(entry.p_detail).toEqual({
      by: USER, provider: "hubspot", connectionId: "conn-1", externalOrgId: HUB.externalOrgId, externalOrgName: HUB.name, scopes: SCOPES, consent: CONSENT, reconnected: false,
    });
    expect(later).toHaveLength(1);
    await run(() => later[0]());
    expect(firstSync).toHaveBeenCalledWith(expect.objectContaining({ id: "conn-1" }));
  });

  it("refuses an account another workspace has connected, and neither keeps nor revokes the new tokens", async () => {
    const { fake, run, deps } = world((sent) =>
      sent.path === "/rest/v1/rpc/accounting_connections_by_external"
        ? { body: [{ org_id: OTHER_ORG, connection_id: "theirs", external_org_id: HUB.externalOrgId, status: "connected", next_sync_after: null }] }
        : undefined
    );
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?hubspot=other_workspace#hubspot`
    );
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method !== "GET")).toBe(false);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens")).toBe(false);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("says other workspace when another one connected the account a moment before (the index)", async () => {
    const { run, deps } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "POST"
        ? { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "accounting_connections_hubspot_one_workspace"' } }
        : undefined
    );
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?hubspot=other_workspace#hubspot`
    );
  });

  it("refuses a state whose nonce is not the browser's, one with no cookie, an expired one and a forged one", async () => {
    const { run, deps } = world();
    expect((await run(() => finishConnect(callback({ code: "c", state: signed() }, "m".repeat(43)), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed() }, null), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed({}, NOW - 11 * 60_000) }, NONCE), deps()))).status).toBe(400);
    const forged = connectState({ provider: "hubspot", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, parseMasterKeys(`t9:${Buffer.alloc(32, 9).toString("base64")}`), NOW);
    expect((await run(() => finishConnect(callback({ code: "c", state: forged }, NONCE), deps()))).status).toBe(400);
    // A state made for Xero is not HubSpot's.
    expect((await run(() => finishConnect(callback({ code: "c", state: signed({ provider: "xero" }) }, NONCE), deps()))).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses another person than the one who started, a non-member, and a member who may not manage integrations", async () => {
    const { run, deps } = world();
    mocks.session.mockResolvedValue({ id: OTHER_USER, email: null });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=forbidden#hubspot`);
    mocks.session.mockResolvedValue({ id: USER, email: null });
    mocks.membership.mockResolvedValue(null);
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=forbidden#hubspot`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "viewer", network: "arc-testnet" });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=forbidden#hubspot`);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a state without the consent before the code is exchanged, and says cancelled when the person said no", async () => {
    const { run, deps } = world();
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed({ consent: null }) }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/integrations/hubspot/connect?org=acme&consent=missing`
    );
    expect(location(await run(() => finishConnect(callback({ error: "access_denied", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?hubspot=cancelled#hubspot`
    );
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses another account while the workspace is connected to one, and writes no tokens", async () => {
    const { fake, run, deps } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "GET"
        ? { body: [{ ...CONNECTION_ROW, external_org_id: OTHER_HUB.externalOrgId, external_org_name: OTHER_HUB.name }] }
        : undefined
    );
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?hubspot=other_organisation#hubspot`
    );
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens")).toBe(false);
  });

  it("reconnects the same account's row, keeping it and its window, and says so in the entry", async () => {
    const { fake, run, deps } = world((sent) => {
      // The account's own connection, in this workspace, is no other workspace's.
      if (sent.path === "/rest/v1/rpc/accounting_connections_by_external") {
        return { body: [{ org_id: ORG, connection_id: "conn-1", external_org_id: HUB.externalOrgId, status: "needs_reconnect", next_sync_after: null }] };
      }
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [{ ...CONNECTION_ROW, status: "needs_reconnect" }] };
      if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [CONNECTION_ROW] };
      return undefined;
    });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=connected#hubspot`);
    const patch = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH");
    expect(patch?.params.get("id")).toBe("eq.conn-1");
    expect(patch?.body).toMatchObject({ status: "connected", revoked_at: null, failures: 0, last_error: null });
    expect(patch?.body).not.toHaveProperty("window_from");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_detail: Record<string, unknown> };
    expect(entry.p_detail.reconnected).toBe(true);
  });

  it("says failed when HubSpot refused the code", async () => {
    exchangeCode.mockResolvedValue({ ok: false, reason: "refused" });
    const { run, deps } = world();
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/acme/settings?hubspot=failed#hubspot`
    );
  });
});

describe("allowing receipts to be written to HubSpot (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3)", () => {
  const WRITE_SCOPES = [...SCOPES, "crm.objects.deals.write", "crm.schemas.deals.write"];

  it("asks HubSpot for the write scopes only when the person ticked Write receipts to HubSpot, and carries the choice in the signed state", async () => {
    const { run, deps } = world();
    const allowWrites = vi.fn();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes", write: "yes" }), { ...deps(), allowWrites }));
    const to = location(response);
    expect(to.searchParams.get("write")).toBe("1");
    expect(readConnectState(to.searchParams.get("state") ?? "", keys(), NOW)?.write).toBe(true);
    // A provider that does not write ignores the box.
    const plain = location(await run(() => startConnect(form({ org: "acme", consent: "yes", write: "yes" }), deps())));
    expect(plain.searchParams.get("write")).toBe("0");
    expect(allowWrites).not.toHaveBeenCalled();
  });

  it("turns writing on once HubSpot granted the write scopes, before the first sync", async () => {
    exchangeCode.mockResolvedValue({ ok: true, tokens: { ...TOKENS, scopes: WRITE_SCOPES }, authEventId: null });
    const { run, deps, later } = world();
    const allowWrites = vi.fn(async () => "writing" as const);
    const response = await run(() => finishConnect(callback({ code: "c", state: signed({ write: true }) }, NONCE), { ...deps(), allowWrites }));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=writing#hubspot`);
    expect(allowWrites).toHaveBeenCalledWith({ connection: expect.objectContaining({ id: "conn-1" }), userId: USER, scopes: WRITE_SCOPES });
    expect(later).toHaveLength(1);
  });

  it("says so when HubSpot connected without them, and keeps the connection reading", async () => {
    const { run, deps } = world();
    const allowWrites = vi.fn(async () => "write_not_granted" as const);
    const response = await run(() => finishConnect(callback({ code: "c", state: signed({ write: true }) }, NONCE), { ...deps(), allowWrites }));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=write_not_granted#hubspot`);
  });

  it("never turns writing on for a connection the person did not allow it for", async () => {
    const { run, deps } = world();
    const allowWrites = vi.fn(async () => "writing" as const);
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), { ...deps(), allowWrites }));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?hubspot=connected#hubspot`);
    expect(allowWrites).not.toHaveBeenCalled();
  });
});
