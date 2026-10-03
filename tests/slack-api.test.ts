import { describe, expect, it } from "vitest";
import { exchangeCode, postToResponseUrl, postToWebhook, uninstallApp } from "@/lib/slack/api";

/**
 * The few calls Vestiarion makes to Slack (Slack design S3, S7, S10, S13): exchanging an install's code, uninstalling,
 * and posting to an incoming webhook or a click's `response_url`. Each has a deadline and posts only to Slack's own
 * hosts; a failure is reported, never thrown.
 */

const SETTINGS = { clientId: "1234567890.9876543210", clientSecret: "client-secret-value", signingSecret: "signing-secret-value" };
const WEBHOOK = "https://hooks.slack.com/services/T0TEAM/B0HOOK/abcdefghijklmnopqrstuvwx";

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    sent.push(call);
    return reply(call);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GRANT = {
  ok: true,
  access_token: "xoxb-1-2-abc",
  token_type: "bot",
  scope: "commands,incoming-webhook",
  bot_user_id: "U0BOT",
  app_id: "A0APP",
  team: { id: "T0TEAM", name: "Northstar" },
  enterprise: null,
  is_enterprise_install: false,
  authed_user: { id: "U0LINH" },
  incoming_webhook: { channel: "#finance", channel_id: "C0FINANCE", configuration_url: "https://northstar.slack.com/services/B0HOOK", url: WEBHOOK },
};

describe("exchangeCode", () => {
  it("posts the code with the app's credentials and returns the install's facts", async () => {
    const { sent, fetchImpl } = fakeFetch(() => json(GRANT));
    const result = await exchangeCode(SETTINGS, "code-1", "https://www.vestiarion.xyz/api/slack/oauth", fetchImpl);

    expect(sent[0].url).toBe("https://slack.com/api/oauth.v2.access");
    expect(sent[0].init.method).toBe("POST");
    const form = new URLSearchParams(String(sent[0].init.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret, code: "code-1", redirect_uri: "https://www.vestiarion.xyz/api/slack/oauth",
    });
    expect(result).toEqual({
      ok: true,
      grant: {
        teamId: "T0TEAM", teamName: "Northstar", appId: "A0APP", botUserId: "U0BOT", botToken: "xoxb-1-2-abc",
        installerSlackUserId: "U0LINH", webhookUrl: WEBHOOK, channelId: "C0FINANCE", channelName: "#finance",
      },
    });
  });

  it("refuses what Slack refused, an enterprise-wide install, and an install with no channel", async () => {
    expect(await exchangeCode(SETTINGS, "x", "r", fakeFetch(() => json({ ok: false, error: "invalid_code" })).fetchImpl)).toEqual({
      ok: false, reason: "slack_refused", error: "invalid_code",
    });
    expect(await exchangeCode(SETTINGS, "x", "r", fakeFetch(() => json({ ...GRANT, is_enterprise_install: true })).fetchImpl)).toMatchObject({
      ok: false, reason: "enterprise_install",
    });
    expect(await exchangeCode(SETTINGS, "x", "r", fakeFetch(() => json({ ...GRANT, incoming_webhook: undefined })).fetchImpl)).toMatchObject({
      ok: false, reason: "missing_webhook",
    });
    const elsewhere = { ...GRANT, incoming_webhook: { ...GRANT.incoming_webhook, url: "https://example.com/hook" } };
    expect(await exchangeCode(SETTINGS, "x", "r", fakeFetch(() => json(elsewhere)).fetchImpl)).toMatchObject({ ok: false, reason: "missing_webhook" });
  });

  it("reports Slack unreachable, without throwing", async () => {
    const result = await exchangeCode(SETTINGS, "x", "r", fakeFetch(() => Promise.reject(new Error("socket hang up"))).fetchImpl);
    expect(result).toEqual({ ok: false, reason: "unreachable", error: null });
  });
});

describe("uninstallApp", () => {
  it("uninstalls with the app's credentials and the bot's token", async () => {
    const { sent, fetchImpl } = fakeFetch(() => json({ ok: true }));
    expect(await uninstallApp(SETTINGS, "xoxb-1-2-abc", fetchImpl)).toBe(true);
    expect(sent[0].url).toBe("https://slack.com/api/apps.uninstall");
    expect(new Headers(sent[0].init.headers).get("authorization")).toBe("Bearer xoxb-1-2-abc");
    expect(Object.fromEntries(new URLSearchParams(String(sent[0].init.body)))).toEqual({ client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(await uninstallApp(SETTINGS, "xoxb", fakeFetch(() => json({ ok: false, error: "invalid_auth" })).fetchImpl)).toBe(false);
  });
});

describe("posting", () => {
  it("posts a message to the webhook as JSON, and reads Slack's ok", async () => {
    const { sent, fetchImpl } = fakeFetch(() => new Response("ok", { status: 200 }));
    expect(await postToWebhook(WEBHOOK, { text: "hello", blocks: [] }, fetchImpl)).toEqual({ ok: true, status: 200, error: null });
    expect(sent[0].init.method).toBe("POST");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ text: "hello", blocks: [] });
    expect(new Headers(sent[0].init.headers).get("content-type")).toBe("application/json");
  });

  it("reports what Slack refused, and a network failure, without throwing", async () => {
    expect(await postToWebhook(WEBHOOK, { text: "x" }, fakeFetch(() => new Response("no_service", { status: 404 })).fetchImpl)).toEqual({
      ok: false, status: 404, error: "no_service",
    });
    expect(await postToWebhook(WEBHOOK, { text: "x" }, fakeFetch(() => Promise.reject(new Error("boom"))).fetchImpl)).toEqual({
      ok: false, status: 0, error: "unreachable",
    });
  });

  it("posts only to Slack's own hooks host", async () => {
    const { sent, fetchImpl } = fakeFetch(() => new Response("ok"));
    expect(await postToResponseUrl("https://evil.example.com/hook", { text: "x" }, fetchImpl)).toEqual({ ok: false, status: 0, error: "not_slack" });
    expect(await postToWebhook("http://hooks.slack.com/services/x", { text: "x" }, fetchImpl)).toEqual({ ok: false, status: 0, error: "not_slack" });
    expect(sent).toEqual([]);
    expect(await postToResponseUrl("https://hooks.slack.com/actions/T0/1/abc", { text: "x", replace_original: true }, fetchImpl)).toMatchObject({ ok: true });
  });
});
