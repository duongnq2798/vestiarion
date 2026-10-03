import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { handleEvent } from "@/lib/slack/events";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Slack's events (Slack design S13): verified first; the URL check answered with Slack's own challenge; and when the
 * app is uninstalled, or its bot's token revoked, the install and its links are removed and the removal recorded.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c91";
const SETTINGS = { clientId: "1.2", clientSecret: "client-secret", signingSecret: "signing-secret-for-tests" };
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

let installed: boolean;
beforeEach(() => {
  installed = true;
});

function signedEvent(payload: unknown, secret = SETTINGS.signingSecret): Request {
  const body = JSON.stringify(payload);
  const at = Math.floor(Date.now() / 1000);
  const signature = `v0=${crypto.createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`;
  return new Request("https://www.vestiarion.xyz/api/slack/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-signature": signature, "x-slack-request-timestamp": String(at) },
    body,
  });
}

function world() {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (sent.path === "/rest/v1/slack_installs" && sent.method === "GET") {
      return { body: installed ? [{ id: "inst-1", org_id: ORG, team_id: "T0TEAM", app_id: "A0APP", bot_user_id: "U0BOT", channel_id: "C0FIN", notified_seq: 0, decisions_limit_usdc: null, installed_at: "2026-10-03T08:00:00Z", bot_token_enc: {}, webhook_url_enc: {} }] : [] };
    }
    if (sent.path === "/rest/v1/slack_installs" && sent.method === "DELETE") return { body: [{ id: "inst-1" }] };
    if (sent.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const handle = (request: Request) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => handleEvent(request, { settings: SETTINGS }));
  const removed = () => fake.requests.filter((sent) => sent.path === "/rest/v1/slack_installs" && sent.method === "DELETE").length;
  const ledger = () => fake.requests.filter((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry").map((sent) => sent.body as { p_action: string; p_detail: Record<string, unknown> });
  return { fake, handle, removed, ledger };
}

describe("handleEvent", () => {
  it("answers 401 to an event Slack did not sign", async () => {
    const { fake, handle } = world();
    expect((await handle(signedEvent({ type: "url_verification", challenge: "abc" }, "another-secret"))).status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it("answers Slack's URL check with its own challenge", async () => {
    const { handle } = world();
    const response = await handle(signedEvent({ type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }));
    expect(await response.json()).toEqual({ challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  });

  it("removes the install when the app is uninstalled, and records it as Slack's doing", async () => {
    const { handle, removed, ledger } = world();
    const response = await handle(signedEvent({ type: "event_callback", team_id: "T0TEAM", event: { type: "app_uninstalled" }, event_id: "Ev1" }));
    expect(response.status).toBe(200);
    expect(removed()).toBe(1);
    expect(ledger()[0]).toMatchObject({ p_action: "slack_uninstalled", p_detail: { by: null, teamId: "T0TEAM", via: "slack" } });
  });

  it("removes it when its own bot's token is revoked, and not when someone else's is", async () => {
    const mine = world();
    await mine.handle(signedEvent({ type: "event_callback", team_id: "T0TEAM", event: { type: "tokens_revoked", tokens: { bot: ["U0BOT"] } } }));
    expect(mine.removed()).toBe(1);
    const theirs = world();
    await theirs.handle(signedEvent({ type: "event_callback", team_id: "T0TEAM", event: { type: "tokens_revoked", tokens: { oauth: ["U0SOMEONE"] } } }));
    expect(theirs.removed()).toBe(0);
  });

  it("acknowledges an event about a team it does not serve, or one it does not handle, and changes nothing", async () => {
    installed = false;
    const { handle, removed } = world();
    expect((await handle(signedEvent({ type: "event_callback", team_id: "T0ELSE", event: { type: "app_uninstalled" } }))).status).toBe(200);
    expect((await handle(signedEvent({ type: "event_callback", team_id: "T0TEAM", event: { type: "message" } }))).status).toBe(200);
    expect(removed()).toBe(0);
  });
});
