import { describe, expect, it } from "vitest";
import { DISCORD_WEBHOOKS, parseDiscordWebhookUrl } from "@/lib/discord/webhook-url";

/**
 * A Discord channel webhook's URL as pasted in Settings (docs/superpowers/specs/2026-10-22-discord-design.md DC1): only
 * Discord's own hosts, over HTTPS, with nothing but the webhook's path; every form it takes is rebuilt as the one URL on
 * discord.com that is stored and called, so the pasted string never is.
 */

const ID = "1234567890123456789";
const TOKEN = "aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123456789-aBcDeFgHiJkLmNoPqRsTuVwXyZ_0123";
const CANONICAL = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

describe("parseDiscordWebhookUrl", () => {
  it.each([
    [`https://discord.com/api/webhooks/${ID}/${TOKEN}`],
    [`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`],
    [`https://canary.discord.com/api/webhooks/${ID}/${TOKEN}`],
    [`https://ptb.discord.com/api/webhooks/${ID}/${TOKEN}`],
    [`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`],
    [`https://discord.com/api/v9/webhooks/${ID}/${TOKEN}`],
    [`https://discord.com/api/webhooks/${ID}/${TOKEN}/`],
    [`  https://DISCORD.com/api/webhooks/${ID}/${TOKEN}\n`],
  ])("accepts %j and rebuilds it on discord.com", (raw) => {
    expect(parseDiscordWebhookUrl(raw)).toEqual({ id: ID, token: TOKEN, url: CANONICAL });
  });

  it("rebuilds the URL from the id and the token alone, under the one prefix calls are made to", () => {
    const parsed = parseDiscordWebhookUrl(`https://canary.discord.com/api/v10/webhooks/${ID}/${TOKEN}/`);
    expect(parsed?.url.startsWith(DISCORD_WEBHOOKS)).toBe(true);
    expect(parsed?.url).toBe(CANONICAL);
  });

  it("accepts ids of 17 to 20 digits and tokens of 60 to 100 characters", () => {
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${"1".repeat(17)}/${"a".repeat(60)}`)?.id).toBe("1".repeat(17));
    expect(parseDiscordWebhookUrl(`https://discord.com/api/webhooks/${"1".repeat(20)}/${"a".repeat(100)}`)?.token).toBe("a".repeat(100));
  });

  it.each([
    ["http", `http://discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["credentials", `https://user:pass@discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["a user alone", `https://evil.com@discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["a port", `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`],
    ["a query", `https://discord.com/api/webhooks/${ID}/${TOKEN}?thread_id=1`],
    ["an empty query", `https://discord.com/api/webhooks/${ID}/${TOKEN}?`],
    ["a hash", `https://discord.com/api/webhooks/${ID}/${TOKEN}#x`],
    ["an empty hash", `https://discord.com/api/webhooks/${ID}/${TOKEN}#`],
    ["another host", `https://example.com/api/webhooks/${ID}/${TOKEN}`],
    ["a lookalike host", `https://discord.com.evil.com/api/webhooks/${ID}/${TOKEN}`],
    ["a lookalike subdomain", `https://evil-discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["another subdomain", `https://media.discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["a trailing dot", `https://discord.com./api/webhooks/${ID}/${TOKEN}`],
    ["a short id", `https://discord.com/api/webhooks/${"1".repeat(16)}/${TOKEN}`],
    ["a long id", `https://discord.com/api/webhooks/${"1".repeat(21)}/${TOKEN}`],
    ["an id that is not digits", `https://discord.com/api/webhooks/12345678901234567a/${TOKEN}`],
    ["a short token", `https://discord.com/api/webhooks/${ID}/${"a".repeat(59)}`],
    ["a long token", `https://discord.com/api/webhooks/${ID}/${"a".repeat(101)}`],
    ["a token with other characters", `https://discord.com/api/webhooks/${ID}/${TOKEN.slice(0, -1)}!`],
    ["an extra path", `https://discord.com/api/webhooks/${ID}/${TOKEN}/github`],
    ["a path before it", `https://discord.com/x/api/webhooks/${ID}/${TOKEN}`],
    ["an encoded slash", `https://discord.com/api/webhooks/${ID}%2F${TOKEN}`],
    ["a version of three digits", `https://discord.com/api/v100/webhooks/${ID}/${TOKEN}`],
    ["no token", `https://discord.com/api/webhooks/${ID}`],
    ["not a URL", "discord webhook please"],
    ["nothing", ""],
  ])("refuses %s", (_why, raw) => {
    expect(parseDiscordWebhookUrl(raw)).toBeNull();
  });
});
