import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { CONSENT_VERSIONS } from "@/lib/connectors/consent";
import { NotSetUpError } from "@/lib/connectors/connections";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { asanaProvider } from "@/lib/asana/provider";
import { ASANA_SCOPES } from "@/lib/asana/settings";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2, A15), through the
 * connector core's flow with Asana's own OAuth calls: only an owner or admin who ticked I agree goes to Asana, asking for
 * exactly the app's registered scopes at the registered redirect; on the way back the state, the cookie, the person and
 * the consent are checked again, the code is exchanged with the client's secret in the body, and the grant's Asana user
 * becomes the connection, its tokens sealed apart. Before migration 0115 no one is sent to Asana.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a5b01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a5b02";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-14T08:00:00.000Z");
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
const SETTINGS = { clientId: "1211111111111111", clientSecret: "secret-of-the-app" };
const CONSENT = { version: "asana-2026-10-14", at: "2026-10-14T07:59:00.000Z" };
const NONCE = "n".repeat(43);

const CONNECTION_ROW = {
  id: "conn-asana", org_id: ORG, provider: "asana", external_org_id: "4673218951", external_org_name: "Duong", status: "connected", scopes: [...ASANA_SCOPES],
  connected_by: USER, connected_at: "2026-10-14T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-16",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

const asanaCalls: Array<{ url: string; init: RequestInit }> = [];
const asanaFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  asanaCalls.push({ url, init: init ?? {} });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://app.asana.com/-/oauth_token") {
    return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "bearer", data: { id: 4673218951, gid: "4673218951", name: "Duong", email: "duong@example.com" } });
  }
  if (url.startsWith("https://app.asana.com/api/1.0/users/me")) return json({ data: { gid: "4673218951", name: "Duong" } });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const ready = vi.fn();

beforeEach(() => {
  for (const mock of [...Object.values(mocks), ready]) mock.mockReset();
  asanaCalls.length = 0;
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "owner", network: "arc-testnet" });
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
  const deps = (): ConnectDeps => ({ provider: asanaProvider(SETTINGS, { fetchImpl: asanaFetch, now: () => NOW }), origin: ORIGIN, keys: keys(), now: () => NOW, ready });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run, deps };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const form = (fields: Record<string, string>) =>
  new Request(`${ORIGIN}/api/integrations/asana/connect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ consent_version: CONSENT_VERSIONS.asana, ...fields }).toString() });
const callback = (query: Record<string, string>, nonce: string | null) =>
  new Request(`${ORIGIN}/api/integrations/asana/callback?${new URLSearchParams(query).toString()}`, { headers: nonce ? { cookie: `vx_asana_oauth=${nonce}` } : {} });
const signed = () => connectState({ provider: "asana", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, keys(), NOW);

describe("startConnect for Asana", () => {
  it("sends an owner who agreed to Asana's authorize page, with the registered scopes, redirect and a signed state", async () => {
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://app.asana.com/-/oauth_authorize");
    expect(to.searchParams.get("redirect_uri")).toBe("https://www.vestiarion.xyz/api/integrations/asana/callback");
    expect(to.searchParams.get("scope")).toBe(ASANA_SCOPES.join(" "));
    expect(to.searchParams.get("client_id")).toBe(SETTINGS.clientId);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "asana", org: ORG, user: USER, consent: { version: "asana-2026-10-14" } });
    expect(response.headers.get("set-cookie")).toContain(`vx_asana_oauth=${state?.nonce}`);
    expect(asanaCalls).toHaveLength(0);
  });

  it("sends a member who may not manage integrations back, and no one before migration 0115", async () => {
    const { run, deps } = world();
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "approver", network: "arc-testnet" });
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/asana/connect?org=acme&error=forbidden`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "owner", network: "arc-testnet" });
    ready.mockRejectedValue(new NotSetUpError());
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/asana/connect?org=acme&error=not_set_up`);
  });
});

describe("finishConnect for Asana", () => {
  it("connects the grant's Asana user with its consent, and seals its tokens apart", async () => {
    const { fake, run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?asana=connected#asana`);
    const exchange = asanaCalls.find((call) => call.url === "https://app.asana.com/-/oauth_token");
    expect(Object.fromEntries(new URLSearchParams(String(exchange?.init.body)))).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/asana/callback",
      client_secret: SETTINGS.clientSecret,
    });
    // Not exclusive: no other workspace is asked about.
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/rpc/accounting_connections_by_external")).toBe(false);
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({ org_id: ORG, provider: "asana", external_org_id: "4673218951", external_org_name: "Duong", connected_by: USER, consent_version: "asana-2026-10-14" });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(tokens?.body).toMatchObject({ org_id: ORG, provider: "asana", connection_id: "conn-asana", authorized_by: USER });
    expect(JSON.stringify(tokens?.body)).not.toMatch(/access-1|refresh-1/);
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_action: "accounting_connected" });
    expect(entry.p_summary).toBe("Connected Asana: Duong. Its tasks can be linked to milestones on Contractors");
  });

  it("refuses a callback without the browser's nonce, and never exchanges the code", async () => {
    const { run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }, null), deps()));
    expect(response.status).toBe(400);
    expect(asanaCalls).toHaveLength(0);
  });
});
