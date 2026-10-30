import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { CONSENT_HISTORY, CONSENT_VERSIONS, consentStatement } from "@/lib/connectors/consent";
import { NotSetUpError } from "@/lib/connectors/connections";
import { PROVIDER_KINDS, PROVIDER_LABELS, UNMARKED_PROVIDERS } from "@/lib/connectors/provider";
import { syncErrorWords } from "@/lib/connectors/status";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { linearProvider } from "@/lib/linear/provider";
import { parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN1, LN2), through the
 * connector core's flow with Linear's own OAuth calls: only an owner or admin who ticked I agree goes to Linear, asking
 * for scope read as the user at the registered redirect; on the way back the state, the cookie, the person and the
 * consent are checked again, the code is exchanged with the client's secret in the body, and the Linear workspace the
 * grant reads, its id and name from `viewer { organization }`, becomes the connection, its tokens sealed apart. Not
 * exclusive: another Vestiarion workspace is not asked about. Before migration 0147 no one is sent to Linear.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1b01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c1b02";
const LINEAR_ORG = "8c5d2f62-0a5b-4a8e-9c1e-2b7f0f6c1a01";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-31T08:00:00.000Z");
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
const SETTINGS = { clientId: "5f0c2b0d8d6a4c1f9e0a7b3c2d1e4f5a", clientSecret: "secret-of-the-app", webhookSecret: "lin_wh" };
const CONSENT = { version: CONSENT_VERSIONS.linear, at: "2026-10-31T07:59:00.000Z" };
const NONCE = "n".repeat(43);

const CONNECTION_ROW = {
  id: "conn-linear", org_id: ORG, provider: "linear", external_org_id: LINEAR_ORG, external_org_name: "Fernhill", status: "connected", scopes: ["read"],
  connected_by: USER, connected_at: "2026-10-31T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-08-02",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

const linearCalls: Array<{ url: string; init: RequestInit }> = [];
const linearFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  linearCalls.push({ url, init: init ?? {} });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://api.linear.app/oauth/token") return json({ access_token: "lin_oauth_access_1", token_type: "Bearer", expires_in: 86399, scope: ["read"], refresh_token: "lin_refresh_1" });
  if (url === "https://api.linear.app/graphql") return json({ data: { viewer: { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a01", name: "Duong", organization: { id: LINEAR_ORG, name: "Fernhill" } } } });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const ready = vi.fn();

beforeEach(() => {
  for (const mock of [...Object.values(mocks), ready]) mock.mockReset();
  linearCalls.length = 0;
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
  const deps = (): ConnectDeps => ({ provider: linearProvider(SETTINGS, { fetchImpl: linearFetch, now: () => NOW }), origin: ORIGIN, keys: keys(), now: () => NOW, ready });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run, deps };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const form = (fields: Record<string, string>) =>
  new Request(`${ORIGIN}/api/integrations/linear/connect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams({ consent_version: CONSENT_VERSIONS.linear, ...fields }).toString() });
const callback = (query: Record<string, string>, nonce: string | null) =>
  new Request(`${ORIGIN}/api/integrations/linear/callback?${new URLSearchParams(query).toString()}`, { headers: nonce ? { cookie: `vx_linear_oauth=${nonce}` } : {} });
const signed = () => connectState({ provider: "linear", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, keys(), NOW);

describe("Linear on the connector core (Linear acceptance LN1)", () => {
  it("is a work tool named Linear, with no mark of its own yet, its consent first agreed on 2026-10-31", () => {
    expect(PROVIDER_LABELS.linear).toBe("Linear");
    expect(PROVIDER_KINDS.linear).toBe("work");
    expect(UNMARKED_PROVIDERS).toContain("linear");
    expect(CONSENT_VERSIONS.linear).toBe("linear-2026-10-31");
    expect(CONSENT_HISTORY.linear).toEqual(["linear-2026-10-31"]);
    expect(syncErrorWords("reconnect", "Linear", null)).toBe(
      "Linear no longer accepts this connection: the app's access was removed in Linear. Reconnect Linear to go on reading the issues linked to milestones."
    );
    // Asana's words are as they were.
    expect(syncErrorWords("reconnect", "Asana", null)).toMatch(/reading the tasks linked to milestones\.$/);
  });

  it("says in its statement what is read, kept and written, that a notice only has an issue read again, and that nothing pays", () => {
    const words = consentStatement("linear").join(" ");
    expect(words).toMatch(/read access only/);
    expect(words).toMatch(/It keeps the links and names, not the words of the description or the comments/);
    expect(words).toMatch(/What a notice says is never used as it is/);
    expect(words).toMatch(/Vestiarion writes nothing to Linear/);
    expect(words).toMatch(/never by itself a reason to pay/);
    expect(words).toMatch(/revokes Vestiarion's access at Linear/);
    expect(words).not.toMatch(/webhook in Linear on each/);
  });
});

describe("startConnect for Linear (LN2)", () => {
  it("sends an owner who agreed to Linear's authorize page, asking scope read as the user, with the registered redirect and a signed state", async () => {
    const { run, deps } = world();
    const response = await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://linear.app/oauth/authorize");
    expect(to.searchParams.get("redirect_uri")).toBe("https://www.vestiarion.xyz/api/integrations/linear/callback");
    expect(to.searchParams.get("scope")).toBe("read");
    expect(to.searchParams.get("actor")).toBe("user");
    expect(to.searchParams.get("client_id")).toBe(SETTINGS.clientId);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "linear", org: ORG, user: USER, consent: { version: "linear-2026-10-31" } });
    expect(response.headers.get("set-cookie")).toContain(`vx_linear_oauth=${state?.nonce}`);
    expect(linearCalls).toHaveLength(0);
  });

  it("sends a member who may not manage integrations back, and no one before migration 0147", async () => {
    const { run, deps } = world();
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "approver", network: "arc-testnet" });
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/linear/connect?org=acme&error=forbidden`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "owner", network: "arc-testnet" });
    ready.mockRejectedValue(new NotSetUpError());
    expect(location(await run(() => startConnect(form({ org: "acme", consent: "yes" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/linear/connect?org=acme&error=not_set_up`);
  });
});

describe("finishConnect for Linear (LN2)", () => {
  it("connects the Linear workspace the grant reads, by its id and name, with its consent, and seals its tokens apart", async () => {
    const { fake, run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?linear=connected#linear`);
    const exchange = linearCalls.find((call) => call.url === "https://api.linear.app/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(String(exchange?.init.body)))).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://www.vestiarion.xyz/api/integrations/linear/callback",
      client_secret: SETTINGS.clientSecret,
    });
    expect(JSON.parse(String(linearCalls.find((call) => call.url === "https://api.linear.app/graphql")?.init.body)).query).toMatch(/organization \{ id name \}/);
    // Not exclusive: no other workspace is asked about (LN2).
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/rpc/accounting_connections_by_external")).toBe(false);
    const created = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST");
    expect(created?.body).toMatchObject({ org_id: ORG, provider: "linear", external_org_id: LINEAR_ORG, external_org_name: "Fernhill", connected_by: USER, consent_version: "linear-2026-10-31", scopes: ["read"] });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(tokens?.body).toMatchObject({ org_id: ORG, provider: "linear", connection_id: "conn-linear", authorized_by: USER });
    expect(JSON.stringify(tokens?.body)).not.toMatch(/lin_oauth_access_1|lin_refresh_1/);
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(entry).toMatchObject({ p_action: "accounting_connected" });
    expect(entry.p_summary).toBe("Connected Linear: Fernhill. Its issues can be linked to milestones on Contractors");
  });

  it("refuses a callback without the browser's nonce, and never exchanges the code", async () => {
    const { run, deps } = world();
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }, null), deps()));
    expect(response.status).toBe(400);
    expect(linearCalls).toHaveLength(0);
  });
});

describe("the routes", () => {
  it("are not there unless Linear is configured, all three variables set", () => {
    for (const file of ["connect/route.ts", "callback/route.ts", "webhook/route.ts"]) {
      const source = readFileSync(`src/app/api/integrations/linear/${file}`, "utf8");
      expect(source, file).toMatch(/linear(SettingsFromEnv|ProviderFromEnv)\(\)/);
      expect(source, file).toMatch(/\{ error: "not_found" \}, \{ status: 404 \}/);
    }
  });
});
