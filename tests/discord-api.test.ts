import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCORD_CONTENT_MAX, DISCORD_DEADLINE_MS, postToDiscord, readDiscordWebhook, webhookGone } from "@/lib/discord/api";

/**
 * The calls Vestiarion makes to a Discord channel webhook (docs/superpowers/specs/2026-10-22-discord-design.md DC1, DC4,
 * DC5): only to the canonical discord.com URL, never following a redirect, with a deadline; a post pings no one and
 * previews no link. A failure is reported with Discord's status and code, never thrown, and the URL is never logged.
 */

const URL_ = "https://discord.com/api/webhooks/1234567890123456789/aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123";
const TOKEN = URL_.split("/").at(-1) as string;

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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postToDiscord", () => {
  it("posts as Vestiarion to the webhook with wait=true, no mentions parsed, embeds suppressed, no redirect followed", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { sent, fetchImpl } = fakeFetch(() => json({ id: "1", channel_id: "2" }));
    expect(await postToDiscord(URL_, { content: "Hello @everyone" }, fetchImpl)).toEqual({ ok: true, status: 200, retryAfterMs: null, code: null });
    expect(sent[0].url).toBe(`${URL_}?wait=true`);
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].init.redirect).toBe("error");
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ content: "Hello @everyone", username: "Vestiarion", allowed_mentions: { parse: [] }, flags: 4 });
    expect(timeout).toHaveBeenCalledWith(DISCORD_DEADLINE_MS);
    expect(DISCORD_DEADLINE_MS).toBe(10_000);
  });

  it("clips content to Discord's 2,000 characters", async () => {
    const { sent, fetchImpl } = fakeFetch(() => json({}));
    await postToDiscord(URL_, { content: "x".repeat(2500) }, fetchImpl);
    expect((JSON.parse(String(sent[0].init.body)) as { content: string }).content).toHaveLength(DISCORD_CONTENT_MAX);
  });

  it.each([
    ["another host", "https://example.com/api/webhooks/1/2"],
    ["discordapp.com, which is only ever parsed, never called", URL_.replace("discord.com", "discordapp.com")],
    ["http", URL_.replace("https:", "http:")],
  ])("refuses %s without calling it", async (_why, url) => {
    const { sent, fetchImpl } = fakeFetch(() => json({}));
    expect(await postToDiscord(url, { content: "x" }, fetchImpl)).toEqual({ ok: false, status: 0, retryAfterMs: null, code: null });
    expect(sent).toEqual([]);
  });

  it("reads how long a 429 asks to wait, from its body or its header, and nothing from Cloudflare's page", async () => {
    const body = fakeFetch(() => json({ message: "You are being rate limited.", retry_after: 1.25, global: false }, 429));
    expect(await postToDiscord(URL_, { content: "x" }, body.fetchImpl)).toMatchObject({ ok: false, status: 429, retryAfterMs: 1250 });
    const header = fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "3" } }));
    expect(await postToDiscord(URL_, { content: "x" }, header.fetchImpl)).toMatchObject({ status: 429, retryAfterMs: 3000 });
    const cloudflare = fakeFetch(() => new Response("<html>1015</html>", { status: 429, headers: { "content-type": "text/html" } }));
    expect(await postToDiscord(URL_, { content: "x" }, cloudflare.fetchImpl)).toMatchObject({ status: 429, retryAfterMs: null, code: null });
  });

  it("reports Discord's own code, and which answers mean the webhook is gone", async () => {
    const unknown = fakeFetch(() => json({ message: "Unknown Webhook", code: 10015 }, 404));
    const gone = await postToDiscord(URL_, { content: "x" }, unknown.fetchImpl);
    expect(gone).toEqual({ ok: false, status: 404, retryAfterMs: null, code: 10015 });
    expect(webhookGone(gone)).toBe(true);
    for (const status of [401, 403, 404]) expect(webhookGone({ status, code: null }), String(status)).toBe(true);
    expect(webhookGone({ status: 400, code: 50027 })).toBe(true);
    expect(webhookGone({ status: 400, code: 50035 })).toBe(false);
    expect(webhookGone({ status: 500, code: null })).toBe(false);
    expect(webhookGone({ status: 429, code: null })).toBe(false);
  });

  it("reports a server error, a timeout and a redirect as failures, never throwing, and logs nothing", async () => {
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    expect(await postToDiscord(URL_, { content: "x" }, fakeFetch(() => new Response("bad gateway", { status: 502 })).fetchImpl)).toEqual({
      ok: false, status: 502, retryAfterMs: null, code: null,
    });
    const timedOut = fakeFetch(() => {
      throw new DOMException(`The operation timed out: ${URL_}`, "TimeoutError");
    });
    expect(await postToDiscord(URL_, { content: "x" }, timedOut.fetchImpl)).toEqual({ ok: false, status: 0, retryAfterMs: null, code: null });
    const redirected = fakeFetch(() => {
      throw new TypeError(`fetch failed: unexpected redirect to ${URL_}`);
    });
    expect((await postToDiscord(URL_, { content: "x" }, redirected.fetchImpl)).status).toBe(0);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
  });
});

describe("readDiscordWebhook", () => {
  it("reads the webhook's channel, server and name with a GET, never following a redirect", async () => {
    const { sent, fetchImpl } = fakeFetch(() =>
      json({ id: "1234567890123456789", type: 1, guild_id: "2234567890123456789", channel_id: "3234567890123456789", name: "  Finance\nbot ", token: TOKEN })
    );
    expect(await readDiscordWebhook(URL_, fetchImpl)).toEqual({
      ok: true, status: 200, retryAfterMs: null, code: null,
      webhook: { id: "1234567890123456789", channelId: "3234567890123456789", guildId: "2234567890123456789", name: "Finance bot" },
    });
    expect(sent[0].url).toBe(URL_);
    expect(sent[0].init.method).toBe("GET");
    expect(sent[0].init.redirect).toBe("error");
  });

  it("names a webhook with no name, clips a long one, and keeps no server it cannot read", async () => {
    const blank = fakeFetch(() => json({ id: "1234567890123456789", channel_id: "3234567890123456789", name: "" }));
    expect(await readDiscordWebhook(URL_, blank.fetchImpl)).toMatchObject({ ok: true, webhook: { name: "Discord webhook", guildId: null } });
    const long = fakeFetch(() => json({ id: "1234567890123456789", channel_id: "3234567890123456789", guild_id: "x", name: "n".repeat(120) }));
    expect(await readDiscordWebhook(URL_, long.fetchImpl)).toMatchObject({ ok: true, webhook: { name: "n".repeat(80), guildId: null } });
  });

  it("fails on an answer that names no channel, and passes Discord's refusal on", async () => {
    expect((await readDiscordWebhook(URL_, fakeFetch(() => json({ id: "1234567890123456789" })).fetchImpl)).ok).toBe(false);
    expect(await readDiscordWebhook(URL_, fakeFetch(() => json({ message: "Unknown Webhook", code: 10015 }, 404)).fetchImpl)).toEqual({
      ok: false, status: 404, retryAfterMs: null, code: 10015,
    });
    const other = fakeFetch(() => json({}));
    expect(await readDiscordWebhook("https://example.com/api/webhooks/1/2", other.fetchImpl)).toMatchObject({ ok: false, status: 0 });
    expect(other.sent).toEqual([]);
  });
});
