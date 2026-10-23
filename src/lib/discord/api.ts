import { sliceUnits } from "./escape";
import { DISCORD_WEBHOOKS } from "./webhook-url";

/**
 * The two calls Vestiarion makes to a Discord channel webhook (docs/superpowers/specs/2026-10-22-discord-design.md DC1,
 * DC4, DC5): reading the webhook, to name its channel when it is connected, and posting to it. Each goes only to the
 * canonical `https://discord.com/api/webhooks/` URL `parseDiscordWebhookUrl` rebuilt, never follows a redirect, and has a
 * deadline. A failure is reported, never thrown, and the URL is never logged: it is a credential.
 */

export const DISCORD_DEADLINE_MS = 10_000;
/** Discord refuses a message's content past 2,000 characters. */
export const DISCORD_CONTENT_MAX = 2000;

/** Discord's own codes for a webhook that is gone: Unknown Webhook, and Invalid Webhook Token. */
export const GONE_CODES: readonly number[] = [10015, 50027];

export interface DiscordResult {
  ok: boolean;
  /** The HTTP status; 0 when Discord was not reached, or the URL was not Discord's. */
  status: number;
  /** How long Discord asked to wait, on a 429 that said; null otherwise, as a Cloudflare 429 does not say. */
  retryAfterMs: number | null;
  /** Discord's JSON error code (10015, 50027, …); null when there is none. */
  code: number | null;
}

const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const SNOWFLAKE = /^\d{17,20}$/;

async function bodyOf(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return record(await response.json());
  } catch {
    return null;
  }
}

/** Whether Discord's answer says the webhook is gone: deleted, its token reset, or never there (DC5). */
export function webhookGone(result: Pick<DiscordResult, "status" | "code">): boolean {
  return [401, 403, 404].includes(result.status) || (result.code !== null && GONE_CODES.includes(result.code));
}

/** The seconds a 429 asked to wait: its JSON `retry_after`, else its `Retry-After` header; null when neither says. */
function retryAfterMs(response: Response, body: Record<string, unknown> | null): number | null {
  const fromBody = typeof body?.retry_after === "number" ? body.retry_after : null;
  const header = response.headers.get("retry-after");
  const seconds = fromBody ?? (header !== null && header.trim() !== "" ? Number(header) : null);
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

async function call(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ result: DiscordResult; body: Record<string, unknown> | null }> {
  if (!url.startsWith(DISCORD_WEBHOOKS)) return { result: { ok: false, status: 0, retryAfterMs: null, code: null }, body: null };
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(DISCORD_DEADLINE_MS) });
  } catch {
    return { result: { ok: false, status: 0, retryAfterMs: null, code: null }, body: null };
  }
  const body = await bodyOf(response);
  const code = typeof body?.code === "number" ? body.code : null;
  return {
    result: { ok: response.ok, status: response.status, retryAfterMs: response.status === 429 ? retryAfterMs(response, body) : null, code: response.ok ? null : code },
    body,
  };
}

/** A message as Vestiarion posts it: its content alone, nothing pinged, no preview of a link. */
export interface DiscordMessage {
  content: string;
}

/**
 * Posts to the channel (DC4, DC5): as "Vestiarion", with no mention parsed whatever the content says, embeds suppressed
 * (flag 4) so a Review link is never unfurled, and the content clipped to Discord's 2,000 characters. `?wait=true`
 * makes Discord answer only once the message exists.
 */
export async function postToDiscord(url: string, message: DiscordMessage, fetchImpl: typeof fetch = fetch): Promise<DiscordResult> {
  // Clipped by UTF-16 units, as Discord counts, never between the two halves of an emoji.
  const content = message.content.length <= DISCORD_CONTENT_MAX ? message.content : `${sliceUnits(message.content, DISCORD_CONTENT_MAX - 1)}…`;
  const { result } = await call(
    `${url}?wait=true`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, username: "Vestiarion", allowed_mentions: { parse: [] }, flags: 4 }),
    },
    fetchImpl
  );
  return result;
}

/** What Discord says of a webhook: its channel, its server and its name. */
export interface DiscordWebhookInfo {
  id: string;
  channelId: string;
  guildId: string | null;
  name: string;
}

export type ReadWebhookResult = ({ ok: true; webhook: DiscordWebhookInfo } & DiscordResult) | ({ ok: false } & DiscordResult);

/** Reads the webhook with its token (DC1): no permission is needed, and nothing is posted. */
export async function readDiscordWebhook(url: string, fetchImpl: typeof fetch = fetch): Promise<ReadWebhookResult> {
  const { result, body } = await call(url, { method: "GET" }, fetchImpl);
  if (!result.ok) return { ...result, ok: false };
  const id = text(body?.id);
  const channelId = text(body?.channel_id);
  const guildId = text(body?.guild_id);
  if (!id || !SNOWFLAKE.test(id) || !channelId || !SNOWFLAKE.test(channelId)) return { ...result, ok: false };
  // The name Discord shows in the channel's settings, as one line; a webhook always has one, but a blank is named.
  const name = Array.from((text(body?.name) ?? "").replace(/\s+/g, " ").trim()).slice(0, 80).join("").trim() || "Discord webhook";
  return { ...result, ok: true, webhook: { id, channelId, guildId: guildId && SNOWFLAKE.test(guildId) ? guildId : null, name } };
}
