import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { CONSENT_VERSIONS } from "@/lib/connectors/consent";
import { EXPORT_NEVER_DUE } from "@/lib/connectors/connections";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { googleSheetsConnectDeps } from "@/lib/googlesheets/connect-deps";
import { GOOGLE_AUTHORIZE } from "@/lib/googlesheets/http";
import { parseMasterKeys } from "@/lib/secrets";
import { GET as callbackRoute } from "@/app/api/integrations/googlesheets/callback/route";
import { POST as connectRoute } from "@/app/api/integrations/googlesheets/connect/route";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS2, GS3,
 * GS4, GS6, GS15, GS19): nothing is there without the deployment's Google client; before migration 0145 no one is sent
 * to Google; the core's checks then send an owner or admin to Google with a signed state; and the callback keeps one
 * Google account, named by a masked email, never due to the sweeper. A grant without the Drive permission keeps
 * nothing, another account while one is connected is refused, and the old provider check answers "failed".
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6d02";
const ORIGIN = "https://www.vestiarion.xyz";
const NOW = Date.parse("2026-10-25T08:00:00.000Z");
const SETTINGS = { clientId: "1234567890-abc123def456.apps.googleusercontent.com", clientSecret: "GOCSPX-the-secret" };
const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const ACCESS = "ya29.a0-the-access-token";
const REFRESH = "1//0g-the-refresh-token";
const PERMISSION = "07623471185212345678";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
const CONSENT = { version: "googlesheets-2026-10-25", at: "2026-10-25T07:59:00.000Z" };

const CONNECTION_ROW = {
  id: "conn-g", org_id: ORG, provider: "googlesheets", external_org_id: PERMISSION, external_org_name: "du***@gmail.com", status: "connected", scopes: [DRIVE_FILE],
  connected_by: USER, connected_at: "2026-10-25T08:00:00Z", consent_version: CONSENT.version, consented_at: CONSENT.at, revoked_at: null, window_from: "2026-07-27",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: EXPORT_NEVER_DUE, sync_lease_until: null, payment_account: null, payment_account_at: null,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: "duong@gmail.com" });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "admin", network: "arc-testnet" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type Sent = { url: string; init: RequestInit };
/** Google, faked: the token endpoint and Drive's `about`. */
function google(options: { scope?: string; email?: string | null; permissionId?: string } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init: init ?? {} });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://oauth2.googleapis.com/token") {
      return json({ access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: options.scope ?? DRIVE_FILE, token_type: "Bearer" });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/about")) {
      return json({ user: { displayName: "Duong", permissionId: options.permissionId ?? PERMISSION, ...(options.email === null ? {} : { emailAddress: options.email ?? "duong@gmail.com" }) } });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function world(respond: (sent: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((sent) => {
    const reply = respond(sent);
    if (reply) return reply;
    if (sent.path === "/rest/v1/orgs") return { body: sent.params.get("select") === "slug" ? { slug: "acme" } : orgs.orgRow(ORG, { slug: "acme" }) };
    if (sent.path === "/rest/v1/rpc/googlesheets_connector_ready") return { body: true };
    if (sent.path === "/rest/v1/accounting_connections" && sent.method === "POST") return { body: [CONNECTION_ROW] };
    if (sent.path === "/rest/v1/accounting_tokens" && sent.method === "POST") return { body: [{ id: "tok-g" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

const deps = (http: { fetchImpl: typeof fetch }): ConnectDeps => ({ ...googleSheetsConnectDeps(SETTINGS, { ...http, now: () => NOW }), origin: ORIGIN, keys: keys(), now: () => NOW });
const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const NONCE = "g".repeat(43);
const signed = () => connectState({ provider: "googlesheets", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, keys(), NOW);
const callback = (query: Record<string, string>) =>
  new Request(`${ORIGIN}/api/integrations/googlesheets/callback?${new URLSearchParams(query).toString()}`, { headers: { cookie: `vx_googlesheets_oauth=${NONCE}` } });
const connectForm = () =>
  new Request(`${ORIGIN}/api/integrations/googlesheets/connect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams({ consent_version: CONSENT_VERSIONS.googlesheets, org: "acme", consent: "yes" }).toString(),
  });
const posted = (fake: ReturnType<typeof world>["fake"], path: string) => fake.requests.filter((sent) => sent.path === path && sent.method === "POST");

describe("without the deployment's Google client (close pack Sheets GS2)", () => {
  it("answers 404 on both routes, and sends no one anywhere", async () => {
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_SECRET", "");
    const connect = await connectRoute(connectForm());
    expect(connect.status).toBe(404);
    expect(connect.headers.get("location")).toBeNull();
    const back = await callbackRoute(callback({ code: "4/the-code", state: "anything" }));
    expect(back.status).toBe(404);
  });

  it("answers 404 with an id that is not a Google OAuth client id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", "not-a-client-id");
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_SECRET", "GOCSPX-the-secret");
    expect((await connectRoute(connectForm())).status).toBe(404);
    expect((await callbackRoute(callback({ code: "c", state: "s" }))).status).toBe(404);
  });
});

describe("startConnect for Google Sheets (close pack Sheets GS2, GS3)", () => {
  it("sends an owner or admin who agreed to Google's authorize URL with a signed state and the nonce cookie, once 0145 has run", async () => {
    const { run } = world();
    const { fetchImpl, sent } = google();
    const response = await run(() => startConnect(connectForm(), deps({ fetchImpl })));
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe(GOOGLE_AUTHORIZE);
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/integrations/googlesheets/callback`);
    expect(to.searchParams.get("scope")).toBe(DRIVE_FILE);
    expect(readConnectState(to.searchParams.get("state") ?? "", keys(), NOW)).toMatchObject({ provider: "googlesheets", org: ORG, consent: { version: "googlesheets-2026-10-25" } });
    expect(response.headers.get("set-cookie")).toMatch(/^vx_googlesheets_oauth=[^;]+; Path=\/api\/integrations\/googlesheets; HttpOnly; SameSite=Lax/);
    // Nothing is asked of Google before the person has been there.
    expect(sent).toEqual([]);
  });

  it("before migration 0145, sends the person back to the connect page with not_set_up", async () => {
    const { run } = world((sent) =>
      sent.path === "/rest/v1/rpc/googlesheets_connector_ready" ? { status: 404, body: { code: "PGRST202", message: "Could not find the function" } } : undefined
    );
    const response = await run(() => startConnect(connectForm(), deps(google())));
    const to = location(response);
    expect(to.pathname).toBe("/integrations/googlesheets/connect");
    expect(to.searchParams.get("error")).toBe("not_set_up");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

});

describe("finishConnect for Google Sheets (close pack Sheets GS3, GS4, GS6, GS15)", () => {
  it("keeps the Google account by its permission id and a masked email, never due, its tokens encrypted, and signs accounting_connected", async () => {
    const { fake, run } = world();
    const { fetchImpl, sent } = google();
    const response = await run(() => finishConnect(callback({ code: "4/the-code", state: signed() }), deps({ fetchImpl })));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?googlesheets=connected#googlesheets`);
    expect(sent.map((one) => new URL(one.url).origin + new URL(one.url).pathname)).toEqual(["https://oauth2.googleapis.com/token", "https://www.googleapis.com/drive/v3/about"]);

    const [created] = posted(fake, "/rest/v1/accounting_connections");
    expect(created.body).toMatchObject({
      provider: "googlesheets",
      external_org_id: PERMISSION,
      external_org_name: "du***@gmail.com",
      consent_version: "googlesheets-2026-10-25",
      next_sync_after: "9999-12-31T00:00:00.000Z",
      scopes: [DRIVE_FILE],
    });
    const [tokens] = posted(fake, "/rest/v1/accounting_tokens");
    expect(tokens).toBeDefined();
    const stored = JSON.stringify(tokens.body);
    expect(stored).not.toContain(REFRESH);
    expect(stored).not.toContain(ACCESS);

    const ledger = posted(fake, "/rest/v1/rpc/append_ledger_entry").map((one) => JSON.stringify(one.body));
    expect(ledger.some((body) => body.includes("accounting_connected") && body.includes('"provider":"googlesheets"') && body.includes("du***@gmail.com"))).toBe(true);
    // The full address is kept nowhere (GS6).
    for (const one of fake.requests) expect(JSON.stringify(one.body ?? "")).not.toContain("duong@gmail.com");
  });

  it("names an account Google gave no email for as A Google account", async () => {
    const { fake, run } = world();
    await run(() => finishConnect(callback({ code: "c", state: signed() }), deps(google({ email: null }))));
    expect(posted(fake, "/rest/v1/accounting_connections")[0].body).toMatchObject({ external_org_name: "A Google account" });
  });

  it("lands on scopes and keeps nothing when the Drive box was unticked, with no call made with the token", async () => {
    const { fake, run } = world();
    const { fetchImpl, sent } = google({ scope: "openid" });
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }), deps({ fetchImpl })));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?googlesheets=scopes#googlesheets`);
    expect(sent.map((one) => new URL(one.url).pathname)).toEqual(["/token"]);
    expect(posted(fake, "/rest/v1/accounting_connections")).toEqual([]);
    expect(posted(fake, "/rest/v1/accounting_tokens")).toEqual([]);
    expect(posted(fake, "/rest/v1/rpc/append_ledger_entry")).toEqual([]);
  });

  it("refuses another Google account while one is connected, as other_organisation, keeping nothing", async () => {
    const { fake, run } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "GET" ? { body: [{ ...CONNECTION_ROW, external_org_id: "another-permission-id", external_org_name: "ow***@pinecrest.test" }] } : undefined
    );
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }), deps(google())));
    expect(location(response).searchParams.get("googlesheets")).toBe("other_organisation");
    expect(posted(fake, "/rest/v1/accounting_connections")).toEqual([]);
    expect(posted(fake, "/rest/v1/accounting_tokens")).toEqual([]);
  });

  it("answers failed when the old provider check refuses googlesheets (23514), and keeps no token", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fake, run } = world((sent) =>
      sent.path === "/rest/v1/accounting_connections" && sent.method === "POST"
        ? { status: 400, body: { code: "23514", message: 'new row for relation "accounting_connections" violates check constraint "accounting_connections_provider_check"' } }
        : undefined
    );
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }), deps(google())));
    expect(location(response).searchParams.get("googlesheets")).toBe("failed");
    expect(posted(fake, "/rest/v1/accounting_tokens")).toEqual([]);
  });

  it("answers bad_response as failed when the permission id does not read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fake, run } = world();
    const response = await run(() => finishConnect(callback({ code: "c", state: signed() }), deps(google({ permissionId: "../etc" }))));
    expect(location(response).searchParams.get("googlesheets")).toBe("failed");
    expect(posted(fake, "/rest/v1/accounting_connections")).toEqual([]);
  });
});
