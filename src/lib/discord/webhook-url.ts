/**
 * A Discord channel webhook's URL, as an owner or admin pastes it (docs/superpowers/specs/2026-10-22-discord-design.md
 * DC1). Only Discord's own hosts, over HTTPS, with nothing but `/api[/vN]/webhooks/{id}/{token}`; the URL kept and called
 * is always rebuilt on discord.com from the id and the token checked here, never the string pasted, so no other host can
 * be reached through it, whatever it resolves to. Pure.
 */

/** Where every webhook is called: what `postToDiscord` refuses anything else than. */
export const DISCORD_WEBHOOKS = "https://discord.com/api/webhooks/";

const HOSTS: readonly string[] = ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"];
const PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{60,100})\/?$/;

export interface DiscordWebhookUrl {
  /** The webhook's id: one of Discord's snowflakes. */
  id: string;
  token: string;
  /** `https://discord.com/api/webhooks/{id}/{token}`: the only form stored and called. */
  url: string;
}

export function parseDiscordWebhookUrl(raw: string): DiscordWebhookUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  // `search` and `hash` are empty for a bare "?" or "#" too: the pasted text must not carry either.
  if (parsed.search !== "" || parsed.hash !== "" || /[?#]/.test(raw)) return null;
  if (!HOSTS.includes(parsed.hostname)) return null;
  const match = PATH.exec(parsed.pathname);
  if (!match) return null;
  const [, id, token] = match;
  return { id, token, url: `${DISCORD_WEBHOOKS}${id}/${token}` };
}
