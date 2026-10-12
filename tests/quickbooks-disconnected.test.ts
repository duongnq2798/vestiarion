import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Connection } from "@/lib/connectors/connections";
import { confirmDisconnected, providerAccepts, type DisconnectedWorkspace } from "@/lib/connectors/disconnected";
import { ProviderError, type AccountingProvider, type RefreshOutcome } from "@/lib/connectors/provider";
import type { StoredTokens, TokenStore } from "@/lib/connectors/tokens";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * QuickBooks' Disconnect URL (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q12): a plain link, so it
 * records nothing on its say-so. Only a workspace where the signed-in person manages integrations is looked at, only
 * the company QuickBooks named, and a connection is marked revoked only when QuickBooks refuses it now; one it still
 * accepts, or did not answer about, is left as it is.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a71";
const VIEWER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a72";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a73";
const REALM = "9341455327810551";
const NOW = Date.parse("2026-10-12T10:00:00.000Z");
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const connection: Connection = {
  id: "conn-1", orgId: ORG, provider: "quickbooks", externalOrgId: REALM, externalOrgName: "Sandbox Company_US_1", status: "connected", scopes: [],
  connectedBy: USER, connectedAt: "2026-10-12T07:00:00.000Z", consentVersion: "quickbooks-2026-10-12", consentedAt: "2026-10-12T07:00:00.000Z", revokedAt: null,
  windowFrom: "2026-07-14", lastSyncedAt: null, lastError: null, lastErrorAt: null, failures: 0, nextSyncAfter: null, syncLeaseUntil: null, paymentAccount: null,
  paymentAccountAt: null,
};

function tokens(expiresAt = NOW + 3_600_000): TokenStore {
  let row: StoredTokens = { id: "tok", version: 1, accessToken: "access-1", refreshToken: "refresh-1", expiresAt, scopes: [] };
  return {
    read: async () => row,
    lease: async () => row,
    store: async (_holder, _version, next) => {
      row = { ...row, ...next, version: row.version + 1 };
      return true;
    },
    release: async () => undefined,
  };
}

function provider(accounts: (accessToken: string) => Promise<unknown>, refresh: () => Promise<RefreshOutcome> = async () => ({ ok: false, reason: "reconnect" })) {
  return {
    id: "quickbooks",
    label: "QuickBooks",
    accounts: vi.fn(async ({ accessToken }: { accessToken: string }) => accounts(accessToken)),
    refresh: vi.fn(refresh),
    revoke: vi.fn(async () => true),
  } as unknown as AccountingProvider & { accounts: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> };
}

const check = (p: AccountingProvider, store = tokens()) => providerAccepts(connection, p, { tokens: store, now: () => NOW, sleep: async () => undefined });

describe("providerAccepts", () => {
  it("is accepted when a read with the connection's token works", async () => {
    expect(await check(provider(async () => []))).toBe("accepted");
  });

  it("is refused when QuickBooks refuses the company, or the refresh, or a token the refresh does not cure", async () => {
    expect(await check(provider(async () => Promise.reject(new ProviderError("forbidden", "QuickBooks accounts: 403"))))).toBe("refused");
    expect(await check(provider(async () => Promise.reject(new ProviderError("unauthorized", "QuickBooks accounts: 401"))))).toBe("refused");
    expect(await check(provider(async () => []), tokens(NOW - 1))).toBe("refused");
    const fresh = { ok: true as const, tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: NOW + 3_600_000, scopes: [] } };
    expect(await check(provider(async () => Promise.reject(new ProviderError("unauthorized", "401")), async () => fresh))).toBe("refused");
  });

  it("is accepted when a refresh cures a refused access token", async () => {
    const fresh = { ok: true as const, tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: NOW + 3_600_000, scopes: [] } };
    const p = provider(async (accessToken) => (accessToken === "access-2" ? [] : Promise.reject(new ProviderError("unauthorized", "401"))), async () => fresh);
    expect(await check(p)).toBe("accepted");
  });

  it("is not known when QuickBooks does not answer, or slows Vestiarion down", async () => {
    expect(await check(provider(async () => Promise.reject(new ProviderError("unavailable", "QuickBooks accounts: 503"))))).toBe("unknown");
    expect(await check(provider(async () => Promise.reject(new ProviderError("rate_limited", "QuickBooks accounts: 429"))))).toBe("unknown");
    expect(await check(provider(async () => [], async () => ({ ok: false, reason: "unavailable", retryAfterMs: null })), tokens(NOW - 1))).toBe("unknown");
  });
});

const ROW = {
  id: "conn-1", org_id: ORG, provider: "quickbooks", external_org_id: REALM, external_org_name: "Sandbox Company_US_1", status: "connected", scopes: [], connected_by: USER,
  connected_at: "2026-10-12T07:00:00Z", consent_version: "quickbooks-2026-10-12", consented_at: "2026-10-12T07:00:00Z", revoked_at: null, window_from: "2026-07-14",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") {
      const id = (sent.params.get("id") ?? `eq.${ORG}`).slice(3);
      return { body: orgs.orgRow(id) };
    }
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [ROW] };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [{ id: "conn-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

const ADMIN: DisconnectedWorkspace = { orgId: ORG, slug: "acme", name: "Acme", role: "admin" };
const VIEWER: DisconnectedWorkspace = { orgId: VIEWER_ORG, slug: "northstar", name: "Northstar", role: "viewer" };

describe("confirmDisconnected", () => {
  it("marks revoked a connection QuickBooks refuses now, without revoking anything, and says so in the ledger", async () => {
    const { fake, run } = world();
    const p = provider(async () => []);
    const outcomes = await run(() => confirmDisconnected({ userId: USER, workspaces: [ADMIN], externalOrgId: REALM, nowMs: NOW }, { provider: p, accepts: async () => "refused" }));
    expect(outcomes).toEqual([{ slug: "acme", workspace: "Acme", organisation: "Sandbox Company_US_1", outcome: "disconnected" }]);
    expect(p.revoke).not.toHaveBeenCalled();
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "DELETE")).toBe(true);
    const patch = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH");
    expect(patch?.body).toMatchObject({ status: "revoked", revoked_by: USER, revoked_at: "2026-10-12T10:00:00.000Z" });
    expect(patch?.params.get("status")).toBe("neq.revoked");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_action: "accounting_disconnected", p_actor: "human", p_domain: "system" });
    expect(entry.p_summary).toBe("QuickBooks says it was disconnected there: Sandbox Company_US_1");
    expect(entry.p_detail).toEqual({ by: USER, provider: "quickbooks", connectionId: "conn-1", externalOrgId: REALM, revokedAtProvider: true, atProvider: true });
  });

  it("leaves alone a connection QuickBooks still accepts, or did not answer about", async () => {
    for (const [answer, outcome] of [["accepted", "still_connected"], ["unknown", "unknown"]] as const) {
      const { fake, run } = world();
      const outcomes = await run(() => confirmDisconnected({ userId: USER, workspaces: [ADMIN], externalOrgId: null }, { provider: provider(async () => []), accepts: async () => answer }));
      expect(outcomes).toEqual([{ slug: "acme", workspace: "Acme", organisation: "Sandbox Company_US_1", outcome }]);
      expect(fake.requests.filter((sent) => sent.method !== "GET" && !sent.path.startsWith("/rest/v1/orgs"))).toEqual([]);
    }
  });

  it("never looks at a workspace where the person does not manage integrations, nor at another company", async () => {
    const { fake, run } = world();
    const accepts = vi.fn(async () => "refused" as const);
    expect(await run(() => confirmDisconnected({ userId: USER, workspaces: [VIEWER], externalOrgId: null }, { provider: provider(async () => []), accepts }))).toEqual([]);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_connections")).toBe(false);
    expect(await run(() => confirmDisconnected({ userId: USER, workspaces: [ADMIN], externalOrgId: "123145812345678" }, { provider: provider(async () => []), accepts }))).toEqual([]);
    expect(accepts).not.toHaveBeenCalled();
  });

  it("writes no second entry when another request marked it revoked a moment before", async () => {
    const { fake, run } = world((sent) => (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH" ? { body: [] } : undefined));
    await run(() => confirmDisconnected({ userId: USER, workspaces: [ADMIN], externalOrgId: REALM }, { provider: provider(async () => []), accepts: async () => "refused" }));
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });

  it("says nothing of a workspace whose connection was revoked already, or that has none", async () => {
    const revoked = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "GET" ? { body: [{ ...ROW, status: "revoked", revoked_at: "2026-10-12T09:00:00Z" }] } : undefined
    );
    expect(await revoked.run(() => confirmDisconnected({ userId: USER, workspaces: [ADMIN], externalOrgId: null }, { provider: provider(async () => []), accepts: async () => "refused" }))).toEqual([]);
    const none = world((sent) => (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET" ? { body: [] } : undefined));
    expect(await none.run(() => confirmDisconnected({ userId: USER, workspaces: [ADMIN], externalOrgId: null }, { provider: provider(async () => []), accepts: async () => "refused" }))).toEqual([]);
  });
});
