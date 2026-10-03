import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as installRoute } from "@/app/api/slack/install/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { parseMasterKeys } from "@/lib/secrets";
import { finishInstall, startInstall } from "@/lib/slack/oauth";
import { oauthState, readOAuthState } from "@/lib/slack/state";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Connecting a workspace to Slack (Slack design S3): only an owner or admin, signed in, starts it; the state Slack
 * carries back is signed, recent, and names the person whose browser holds its nonce; the install is checked again on
 * the way back before the code is exchanged; and a Slack workspace already serving another workspace is refused.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn(), exchange: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));
vi.mock("@/lib/slack/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/slack/api")>()), exchangeCode: mocks.exchange }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c81";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c82";
const OTHER_USER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c83";
const ORIGIN = "https://www.vestiarion.xyz";
const SETTINGS = { clientId: "1234.5678", clientSecret: "client-secret", signingSecret: "signing-secret" };
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const GRANT = {
  teamId: "T0TEAM", teamName: "Acme", appId: "A0APP", botUserId: "U0BOT", botToken: "xoxb-1", installerSlackUserId: "U0LINH",
  webhookUrl: "https://hooks.slack.com/services/T0TEAM/B0/x", channelId: "C0FIN", channelName: "#finance",
};

let takenBy: string | null;

beforeEach(() => {
  takenBy = null;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "admin" });
  mocks.exchange.mockResolvedValue({ ok: true, grant: GRANT });
});

function world() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: sent.params.get("select") === "slug" ? { slug: "acme" } : orgs.orgRow(ORG, { slug: "acme", name: "Acme" }) };
    if (sent.path === "/rest/v1/slack_installs" && sent.method === "GET") {
      return { body: takenBy && sent.params.get("team_id") ? [{ id: "inst-x", org_id: takenBy, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0", notified_seq: 0, decisions_limit_usdc: null, installed_at: "2026-10-03T08:00:00Z", bot_token_enc: {}, webhook_url_enc: {} }] : [] };
    }
    if (sent.path === "/rest/v1/slack_installs" && sent.method === "POST") return { body: [{ id: "inst-1", org_id: ORG, team_id: "T0TEAM", app_id: "A0APP", channel_id: "C0FIN", notified_seq: 0, decisions_limit_usdc: null, installed_at: "2026-10-03T08:00:00Z", bot_token_enc: {}, webhook_url_enc: {} }] };
    if (sent.path === "/rest/v1/slack_links" && sent.method === "POST") return { body: [{ id: "link-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);
const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);

describe("startInstall", () => {
  it("sends an owner or admin to Slack with the two scopes, the callback, and a signed state whose nonce is in their cookie", async () => {
    const { run } = world();
    const response = await run(() => startInstall(new Request(`${ORIGIN}/api/slack/install?org=acme`), { settings: SETTINGS, origin: ORIGIN }));
    expect(response.status).toBe(302);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(to.searchParams.get("client_id")).toBe("1234.5678");
    expect(to.searchParams.get("scope")).toBe("commands,incoming-webhook");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/slack/oauth`);
    const state = readOAuthState(to.searchParams.get("state") ?? "", keys());
    expect(state).toMatchObject({ org: ORG, user: USER });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_slack_oauth=${state?.nonce}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("sends anyone else back to Settings, and Slack is never asked", async () => {
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "approver" });
    const { run } = world();
    const response = await run(() => startInstall(new Request(`${ORIGIN}/api/slack/install?org=acme`), { settings: SETTINGS, origin: ORIGIN }));
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?slack=forbidden#slack`);

    mocks.session.mockResolvedValue(null);
    const signedOut = await run(() => startInstall(new Request(`${ORIGIN}/api/slack/install?org=acme`), { settings: SETTINGS, origin: ORIGIN }));
    expect(location(signedOut).pathname).toBe("/o/acme/settings");
  });

  it("is not there when Slack is not configured", async () => {
    expect((await installRoute(new Request(`${ORIGIN}/api/slack/install?org=acme`))).status).toBe(404);
  });
});

describe("finishInstall", () => {
  function callback(fields: { state?: string; code?: string; error?: string }, cookie?: string) {
    const url = new URL(`${ORIGIN}/api/slack/oauth`);
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) url.searchParams.set(key, value);
    return new Request(url, { headers: cookie ? { cookie } : {} });
  }
  const started = (user = USER) => {
    const nonce = "n".repeat(43);
    return { state: oauthState({ org: ORG, user, nonce }, keys()), cookie: `other=1; vx_slack_oauth=${nonce}` };
  };

  it("exchanges the code, saves the install in the workspace's scope, and returns the person to Settings", async () => {
    const { fake, run } = world();
    const { state, cookie } = started();
    const response = await run(() => finishInstall(callback({ state, code: "code-1" }, cookie), { settings: SETTINGS, origin: ORIGIN }));
    expect(mocks.exchange).toHaveBeenCalledWith(SETTINGS, "code-1", `${ORIGIN}/api/slack/oauth`, undefined);
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?slack=connected#slack`);
    expect(response.headers.get("set-cookie")).toMatch(/vx_slack_oauth=;.*Max-Age=0/i);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/slack_installs" && sent.method === "POST")).toBe(true);
  });

  it("refuses a state that is not signed, has expired, or has no cookie, without asking Slack", async () => {
    const { run } = world();
    const { state, cookie } = started();
    const bad = await run(() => finishInstall(callback({ state: `${state}x`, code: "c" }, cookie), { settings: SETTINGS, origin: ORIGIN }));
    expect(bad.status).toBe(400);
    const old = oauthState({ org: ORG, user: USER, nonce: "n".repeat(43) }, keys(), Date.now() - 11 * 60_000);
    expect((await run(() => finishInstall(callback({ state: old, code: "c" }, cookie), { settings: SETTINGS, origin: ORIGIN }))).status).toBe(400);
    expect((await run(() => finishInstall(callback({ state, code: "c" }), { settings: SETTINGS, origin: ORIGIN }))).status).toBe(400);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("refuses an install finished by someone other than who started it, or who is no longer allowed to", async () => {
    const { run } = world();
    const { state, cookie } = started(OTHER_USER);
    expect(location(await run(() => finishInstall(callback({ state, code: "c" }, cookie), { settings: SETTINGS, origin: ORIGIN }))).searchParams.get("slack")).toBe("forbidden");
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "live", role: "viewer" });
    const mine = started();
    expect(location(await run(() => finishInstall(callback({ state: mine.state, code: "c" }, mine.cookie), { settings: SETTINGS, origin: ORIGIN }))).searchParams.get("slack")).toBe("forbidden");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("says when the person cancelled in Slack, when Slack refused, and when the Slack workspace serves another workspace", async () => {
    const { run } = world();
    const one = started();
    expect(location(await run(() => finishInstall(callback({ state: one.state, error: "access_denied" }, one.cookie), { settings: SETTINGS, origin: ORIGIN }))).searchParams.get("slack")).toBe("cancelled");
    mocks.exchange.mockResolvedValueOnce({ ok: false, reason: "enterprise_install", error: null });
    expect(location(await run(() => finishInstall(callback({ state: one.state, code: "c" }, one.cookie), { settings: SETTINGS, origin: ORIGIN }))).searchParams.get("slack")).toBe("enterprise_install");
    takenBy = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c89";
    expect(location(await run(() => finishInstall(callback({ state: one.state, code: "c" }, one.cookie), { settings: SETTINGS, origin: ORIGIN }))).searchParams.get("slack")).toBe("team_taken");
  });
});
