import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { CONSENT_VERSIONS } from "@/lib/connectors/consent";
import type { AccountingProvider, ExternalOrganisation } from "@/lib/connectors/provider";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Zoho CRM (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4, C5, C17): the
 * core's checks as for every CRM; then the callback's `location` goes to the code exchange, read only after every other
 * check; the one organization the token reaches connects; and before migration 0123 no one is sent to Zoho.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f02";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

const LUMEN: ExternalOrganisation = { externalOrgId: "71234567", name: "Lumen Holdings", connectionId: null };
const TOKENS = { accessToken: "eu|1000.access", refreshToken: "eu|1000.refresh", expiresAt: NOW + 3_600_000, scopes: ["ZohoCRM.modules.deals.READ"] };
const CONSENT = { version: "zohocrm-2026-10-16", at: "2026-10-16T07:59:00.000Z" };

const exchangeCode = vi.fn();
const organisations = vi.fn();
const provider = {
  id: "zohocrm",
  label: "Zoho CRM",
  kind: "crm",
  scopes: ["ZohoCRM.modules.deals.READ", "ZohoCRM.org.READ"],
  callbackRegionParam: "location",
  authorizeUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) => `https://accounts.zoho.com/oauth/v2/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode,
  organisations,
  revoke: vi.fn(),
} as unknown as AccountingProvider;

const CONNECTION_ROW = {
  id: "conn-z", org_id: ORG, provider: "zohocrm", external_org_id: LUMEN.externalOrgId, external_org_name: LUMEN.name, status: "connected", scopes: TOKENS.scopes,
  connected_by: USER, connected_at: "2026-10-16T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-18",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

beforeEach(() => {
  for (const mock of [...Object.values(mocks), exchangeCode, organisations]) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "admin", network: "arc-testnet" });
  exchangeCode.mockResolvedValue({ ok: true, tokens: TOKENS, authEventId: null });
  organisations.mockResolvedValue([LUMEN]);
});

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined, deps: Partial<ConnectDeps> = {}) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: sent.params.get("select") === "slug" ? { slug: "acme" } : orgs.orgRow(ORG, { slug: "acme" }) };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "POST") return { body: [CONNECTION_ROW] };
    if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST") return { body: [{ id: "tok-z" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const later: Array<() => Promise<void>> = [];
  const make = (): ConnectDeps => ({ provider, origin: ORIGIN, keys: keys(), now: () => NOW, afterConnect: (work) => later.push(work), firstSync: vi.fn(async () => undefined), ...deps });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run, deps: make, later };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const NONCE = "z".repeat(43);
const signed = (fields: Partial<Parameters<typeof connectState>[0]> = {}) =>
  connectState({ provider: "zohocrm", org: ORG, user: USER, nonce: NONCE, consent: CONSENT, ...fields }, keys(), NOW);
const callback = (query: Record<string, string>, nonce: string | null = NONCE) =>
  new Request(`${ORIGIN}/api/integrations/zohocrm/callback?${new URLSearchParams(query).toString()}`, { headers: nonce ? { cookie: `vx_zohocrm_oauth=${nonce}` } : {} });
const REDIRECT = `${ORIGIN}/api/integrations/zohocrm/callback`;

describe("startConnect for Zoho CRM", () => {
  it("sends an owner or admin who agreed to Zoho CRM with a signed state, once migration 0123 has run", async () => {
    const { run, deps } = world();
    const ready = vi.fn(async () => undefined);
    const form = new Request(`${ORIGIN}/api/integrations/zohocrm/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({ consent_version: CONSENT_VERSIONS.zohocrm, org: "acme", consent: "yes" }).toString(),
    });
    const response = await run(() => startConnect(form, { ...deps(), ready }));
    expect(ready).toHaveBeenCalled();
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://accounts.zoho.com/oauth/v2/auth");
    expect(to.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(readConnectState(to.searchParams.get("state") ?? "", keys(), NOW)).toMatchObject({ provider: "zohocrm", org: ORG, consent: { version: "zohocrm-2026-10-16" } });
  });
});

describe("finishConnect for Zoho CRM", () => {
  it("passes the callback's data center to the code exchange, and connects the organization the token reaches", async () => {
    const { fake, run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed(), location: "eu", "accounts-server": "https://accounts.zoho.eu" }), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?zohocrm=connected#zohocrm`);
    expect(exchangeCode).toHaveBeenCalledWith({ code: "the-code", redirectUri: REDIRECT, region: "eu" });
    expect(organisations).toHaveBeenCalledWith(TOKENS, null);
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({ provider: "zohocrm", external_org_id: LUMEN.externalOrgId, external_org_name: "Lumen Holdings", consent_version: "zohocrm-2026-10-16" });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(JSON.stringify(tokens?.body)).not.toContain("1000.refresh");
  });

  it("passes no data center as null, which the provider reads as the US", async () => {
    const { run, deps } = world();
    await run(() => finishConnect(callback({ code: "c", state: signed() }), deps()));
    expect(exchangeCode).toHaveBeenCalledWith({ code: "c", redirectUri: REDIRECT, region: null });
  });

  it("reads the data center only after every other check: a foreign state exchanges nothing", async () => {
    const { run, deps } = world();
    expect((await run(() => finishConnect(callback({ code: "c", state: signed({ provider: "xero" }), location: "eu" }), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed(), location: "eu" }, "m".repeat(43)), deps()))).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});
