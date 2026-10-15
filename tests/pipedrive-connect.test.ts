import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { NotSetUpError } from "@/lib/connectors/connections";
import { CONSENT_VERSIONS, consentStatement } from "@/lib/connectors/consent";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { pipedriveProvider } from "@/lib/pipedrive/provider";
import { parseMasterKeys } from "@/lib/secrets";
import { API_DOMAIN, COMPANY_ID, fakePipedrive } from "./support/fake-pipedrive";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Pipedrive (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P3, P4, P14),
 * through the connector core's flow with the real Pipedrive provider and an in-memory Pipedrive: the state is signed and
 * bound to the nonce in the browser's cookie; the way back checks the person, their role and their consent before the
 * code is exchanged; a grant without the read scopes is refused in words and nothing kept; a company another workspace
 * holds is refused; the same company again reconnects its row; tokens are kept sealed with the company's domain.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f02";
const OTHER_USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f03";
const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f04";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-14T08:00:00.000Z");
const COMPANY = String(COMPANY_ID);
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
const settings = { clientId: "b4d083d9216b7d0c", clientSecret: "client-secret-value" };
const CONSENT = { version: CONSENT_VERSIONS.pipedrive, at: "2026-10-14T07:59:00.000Z" };

const CONNECTION_ROW = {
  id: "conn-pd", org_id: ORG, provider: "pipedrive", external_org_id: COMPANY, external_org_name: "Cedar & Co", status: "connected", scopes: [],
  connected_by: USER, connected_at: "2026-10-14T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-16",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "cedar", name: "Cedar", mode: "sandbox", role: "owner", network: "arc-testnet" });
});

function world(options: { scope?: string; respond?: (sent: RecordedRequest) => FakeReply | undefined } = {}) {
  const pipedrive = fakePipedrive({ scope: options.scope });
  const fake = fakeSupabase((sent) => {
    const reply = options.respond?.(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: sent.params.get("select") === "slug" ? { slug: "cedar" } : orgs.orgRow(ORG, { slug: "cedar" }) };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "POST") return { body: [CONNECTION_ROW] };
    if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST") return { body: [{ id: "tok-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const later: Array<() => Promise<void>> = [];
  const firstSync = vi.fn(async () => undefined);
  const ready = vi.fn(async () => undefined);
  const provider = pipedriveProvider(settings, { fetchImpl: pipedrive.fetchImpl, now: () => NOW });
  const deps = (): ConnectDeps => ({ provider, origin: ORIGIN, keys: keys(), now: () => NOW, ready, afterConnect: (work) => later.push(work), firstSync });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, pipedrive, run, deps, later, firstSync, ready };
}

const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const form = (fields: Record<string, string>, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/integrations/pipedrive/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams({ consent_version: CONSENT_VERSIONS.pipedrive, ...fields }).toString(),
  });
const callback = (query: Record<string, string>, nonce: string | null) =>
  new Request(`${ORIGIN}/api/integrations/pipedrive/callback?${new URLSearchParams(query).toString()}`, { headers: nonce ? { cookie: `vx_pipedrive_oauth=${nonce}` } : {} });
const NONCE = "p".repeat(43);
const signed = (fields: Partial<Parameters<typeof connectState>[0]> = {}, nowMs = NOW) =>
  connectState({ provider: "pipedrive", org: ORG, user: USER, nonce: NONCE, consent: CONSENT, ...fields }, keys(), nowMs);

describe("startConnect for Pipedrive", () => {
  it("sends an owner who agreed to Pipedrive's authorize page with a signed state, its nonce in an HttpOnly cookie for Pipedrive's routes alone", async () => {
    const { run, deps, ready } = world();
    const response = await run(() => startConnect(form({ org: "cedar", consent: "yes" }), deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://oauth.pipedrive.com/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe(settings.clientId);
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/pipedrive/callback`);
    expect(to.searchParams.has("scope")).toBe(false);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "pipedrive", org: ORG, user: USER, consent: { version: "pipedrive-2026-10-15" } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_pipedrive_oauth=${state?.nonce}`);
    expect(cookie).toContain("Path=/api/integrations/pipedrive");
    expect(cookie).toContain("HttpOnly");
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("refuses a form from another site and a member who may not manage integrations; says not set up before migration 0116", async () => {
    const { run, deps, ready } = world();
    expect((await run(() => startConnect(form({ org: "cedar", consent: "yes" }, "https://evil.example"), deps()))).status).toBe(403);
    ready.mockRejectedValueOnce(new NotSetUpError());
    expect(location(await run(() => startConnect(form({ org: "cedar", consent: "yes" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/pipedrive/connect?org=cedar&error=not_set_up`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "cedar", name: "Cedar", mode: "sandbox", role: "approver", network: "arc-testnet" });
    expect(location(await run(() => startConnect(form({ org: "cedar", consent: "yes" }), deps()))).toString()).toBe(`${ORIGIN}/integrations/pipedrive/connect?org=cedar&error=forbidden`);
  });
});

describe("finishConnect for Pipedrive", () => {
  it("connects the company of the grant, keeps its tokens sealed with its domain, records the consent, then the first sync", async () => {
    const { fake, pipedrive, run, deps, later, firstSync } = world();
    const response = await run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/cedar/settings?pipedrive=connected#pipedrive`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    // users/me at the company's own domain names the company.
    expect(pipedrive.requests.map((sent) => `${sent.method} ${sent.host}${sent.path}`)).toEqual(["POST oauth.pipedrive.com/oauth/token", `GET ${new URL(API_DOMAIN).host}/api/v1/users/me`]);
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/rpc/accounting_connections_by_external")?.body).toEqual({ p_provider: "pipedrive", p_external_org_ids: [COMPANY] });
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "POST")?.body).toMatchObject({
      org_id: ORG, provider: "pipedrive", external_org_id: COMPANY, external_org_name: "Cedar & Co", consent_version: "pipedrive-2026-10-15",
    });
    const tokens = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST");
    expect(tokens?.body).toMatchObject({ org_id: ORG, provider: "pipedrive", connection_id: "conn-pd" });
    // Sealed under the master key: neither token nor its domain readable in the row.
    expect(JSON.stringify(tokens?.body)).not.toContain("refresh-a");
    expect(JSON.stringify(tokens?.body)).not.toContain("cedar-and-co");
    const entry = fake.requests.find((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")?.body as { p_action: string; p_detail: Record<string, unknown> };
    expect(entry).toMatchObject({ p_action: "accounting_connected", p_detail: { provider: "pipedrive", externalOrgId: COMPANY, consent: CONSENT } });
    await run(() => later[0]());
    expect(firstSync).toHaveBeenCalledWith(expect.objectContaining({ id: "conn-pd" }));
  });

  it("refuses a grant without the scopes that read deals and organizations, keeps nothing, and uninstalls it", async () => {
    const { fake, pipedrive, run, deps } = world({ scope: "base,users:read" });
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/cedar/settings?pipedrive=scopes#pipedrive`);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method !== "GET")).toBe(false);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens")).toBe(false);
    expect(pipedrive.state.revoked).toEqual(["1:1:refresh-a"]);
  });

  it("binds the state to the browser: another nonce, no cookie, an expired or forged state, or HubSpot's, never reach Pipedrive", async () => {
    const { pipedrive, run, deps } = world();
    expect((await run(() => finishConnect(callback({ code: "c", state: signed() }, "q".repeat(43)), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed() }, null), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed({}, NOW - 11 * 60_000) }, NONCE), deps()))).status).toBe(400);
    const forged = connectState({ provider: "pipedrive", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, parseMasterKeys(`t9:${Buffer.alloc(32, 9).toString("base64")}`), NOW);
    expect((await run(() => finishConnect(callback({ code: "c", state: forged }, NONCE), deps()))).status).toBe(400);
    expect((await run(() => finishConnect(callback({ code: "c", state: signed({ provider: "hubspot" }) }, NONCE), deps()))).status).toBe(400);
    expect(pipedrive.requests).toEqual([]);
  });

  it("refuses another person, a member who may not manage integrations, a state without consent, and says cancelled when the person declined", async () => {
    const { pipedrive, run, deps } = world();
    mocks.session.mockResolvedValue({ id: OTHER_USER, email: null });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/cedar/settings?pipedrive=forbidden#pipedrive`);
    mocks.session.mockResolvedValue({ id: USER, email: null });
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "cedar", name: "Cedar", mode: "sandbox", role: "viewer", network: "arc-testnet" });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/cedar/settings?pipedrive=forbidden#pipedrive`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "cedar", name: "Cedar", mode: "sandbox", role: "owner", network: "arc-testnet" });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed({ consent: null }) }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/integrations/pipedrive/connect?org=cedar&consent=missing`
    );
    expect(location(await run(() => finishConnect(callback({ error: "user_denied", state: signed() }, NONCE), deps()))).toString()).toBe(
      `${ORIGIN}/o/cedar/settings?pipedrive=cancelled#pipedrive`
    );
    expect(pipedrive.requests).toEqual([]);
  });

  it("refuses a company another workspace holds, and neither keeps nor revokes the new tokens", async () => {
    const { fake, pipedrive, run, deps } = world({
      respond: (sent) =>
        sent.path === "/rest/v1/rpc/accounting_connections_by_external"
          ? { body: [{ org_id: OTHER_ORG, connection_id: "theirs", external_org_id: COMPANY, status: "connected", next_sync_after: null }] }
          : undefined,
    });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/cedar/settings?pipedrive=other_workspace#pipedrive`);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/accounting_tokens")).toBe(false);
    expect(pipedrive.state.revoked).toEqual([]);
  });

  it("reconnects the same company's row", async () => {
    const { fake, run, deps } = world({
      respond: (sent) => {
        if (sent.path === "/rest/v1/rpc/accounting_connections_by_external") return { body: [{ org_id: ORG, connection_id: "conn-pd", external_org_id: COMPANY, status: "needs_reconnect", next_sync_after: null }] };
        if (sent.path === "/rest/v1/accounting_connections" && sent.method === "GET") return { body: [{ ...CONNECTION_ROW, status: "needs_reconnect" }] };
        if (sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH") return { body: [CONNECTION_ROW] };
        return undefined;
      },
    });
    expect(location(await run(() => finishConnect(callback({ code: "c", state: signed() }, NONCE), deps()))).toString()).toBe(`${ORIGIN}/o/cedar/settings?pipedrive=connected#pipedrive`);
    expect(fake.requests.find((sent) => sent.path === "/rest/v1/accounting_connections" && sent.method === "PATCH")?.params.get("id")).toBe("eq.conn-pd");
  });
});

describe("Pipedrive's consent", () => {
  it("says what is read and written, the webhooks, and that testnet or shadow payments are never written", () => {
    const words = consentStatement("pipedrive").join(" ");
    expect(words).toContain("organizations and persons");
    expect(words).toContain("Pipedrive tells Vestiarion when a deal changes, and Vestiarion then reads it again from Pipedrive");
    expect(words).toContain("never writes payments on Arc testnet or in shadow mode to Pipedrive");
    expect(words).toContain("Vestiarion never uses Pipedrive data to train or improve any AI model");
    expect(words).toContain("The agent's model provider (DeepSeek, on the hosted service) may see a deal's facts to decide on its collections, under that provider's own API terms.");
    expect(words).not.toMatch(/may not train/);
    // Disconnecting calls Pipedrive's revoke endpoint; the uninstall is what Pipedrive documents that doing.
    expect(words).toContain(
      "Disconnecting stops the reading at once and revokes Vestiarion's access, which, as Pipedrive documents it, uninstalls Vestiarion from your Pipedrive company."
    );
    expect(words).not.toMatch(/VND/);
  });
});
