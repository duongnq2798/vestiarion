import type { SlackSettings } from "./settings";

/**
 * The few calls Vestiarion makes to Slack (Slack design S3, S7, S10, S13, S15): exchanging an install's code,
 * uninstalling the app, posting to an incoming webhook or to the `response_url` a command or a click carries, and
 * fetching a file someone chose. Each has a deadline; a post goes only to Slack's own hooks host, and a fetch only to
 * its file host. A failure is reported, never thrown; a URL or a token is never logged, since either is a credential.
 */

export const SLACK_DEADLINE_MS = 10_000;
const HOOKS = "https://hooks.slack.com/";
const FILES = "https://files.slack.com/";

/** What an install grants, as Vestiarion keeps it. */
export interface InstallGrant {
  teamId: string;
  teamName: string | null;
  appId: string;
  botUserId: string | null;
  botToken: string;
  /** The Slack account of the person who installed it, whom Slack authenticated. */
  installerSlackUserId: string;
  webhookUrl: string;
  channelId: string;
  channelName: string | null;
  /** The bot permissions Slack granted, as it lists them: `files:read` lets the app read a file someone chose (S15). */
  scopes: string[];
}

export type ExchangeResult =
  | { ok: true; grant: InstallGrant }
  | { ok: false; reason: "slack_refused" | "enterprise_install" | "missing_webhook" | "malformed" | "unreachable"; error: string | null };

const ID = /^[A-Z][A-Z0-9]{1,31}$/;
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

async function callSlack(method: string, form: Record<string, string>, fetchImpl: typeof fetch, token?: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(SLACK_DEADLINE_MS),
    });
    return record(await response.json());
  } catch {
    return null;
  }
}

/** `oauth.v2.access`: the install's code for its bot token, its team and the channel its webhook posts to. */
export async function exchangeCode(settings: SlackSettings, code: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<ExchangeResult> {
  const body = await callSlack(
    "oauth.v2.access",
    { client_id: settings.clientId, client_secret: settings.clientSecret, code, redirect_uri: redirectUri },
    fetchImpl
  );
  if (!body) return { ok: false, reason: "unreachable", error: null };
  if (body.ok !== true) return { ok: false, reason: "slack_refused", error: text(body.error) };
  if (body.is_enterprise_install === true) return { ok: false, reason: "enterprise_install", error: null };

  const team = record(body.team);
  const user = record(body.authed_user);
  const hook = record(body.incoming_webhook);
  const webhookUrl = text(hook?.url);
  const channelId = text(hook?.channel_id);
  if (!webhookUrl || !webhookUrl.startsWith(HOOKS) || !channelId || !ID.test(channelId)) {
    return { ok: false, reason: "missing_webhook", error: null };
  }
  const teamId = text(team?.id);
  const appId = text(body.app_id);
  const botToken = text(body.access_token);
  const installer = text(user?.id);
  const botUserId = text(body.bot_user_id);
  if (!teamId || !ID.test(teamId) || !appId || !ID.test(appId) || !botToken || !installer || !ID.test(installer)) {
    return { ok: false, reason: "malformed", error: null };
  }
  return {
    ok: true,
    grant: {
      teamId,
      teamName: text(team?.name)?.slice(0, 200) ?? null,
      appId,
      botUserId: botUserId && ID.test(botUserId) ? botUserId : null,
      botToken,
      installerSlackUserId: installer,
      webhookUrl,
      channelId,
      channelName: text(hook?.channel)?.slice(0, 200) ?? null,
      scopes: (text(body.scope) ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => /^[a-z][a-z0-9:._-]{0,63}$/.test(scope)),
    },
  };
}

/** `apps.uninstall`: removes the app from the Slack workspace, which revokes its token and its webhook. */
export async function uninstallApp(settings: SlackSettings, botToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const body = await callSlack("apps.uninstall", { client_id: settings.clientId, client_secret: settings.clientSecret }, fetchImpl, botToken);
  return body?.ok === true;
}

/** A message as Slack takes it from a webhook or a `response_url`. */
export interface SlackMessage {
  text: string;
  blocks?: unknown[];
  response_type?: "ephemeral" | "in_channel";
  replace_original?: boolean;
}

export interface PostResult {
  ok: boolean;
  status: number;
  /** Slack's own code (`no_service`, `channel_not_found`, …), `unreachable`, or `not_slack`; null when it went. */
  error: string | null;
}

async function post(url: string, message: SlackMessage, fetchImpl: typeof fetch): Promise<PostResult> {
  if (!url.startsWith(HOOKS)) return { ok: false, status: 0, error: "not_slack" };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SLACK_DEADLINE_MS),
    });
    const said = (await response.text()).trim().slice(0, 100);
    return response.ok ? { ok: true, status: response.status, error: null } : { ok: false, status: response.status, error: said || null };
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
}

/** Posts to the channel the install picked. */
export function postToWebhook(url: string, message: SlackMessage, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  return post(url, message, fetchImpl);
}

/** Answers a command or a click, or rewrites the message a click came from (`replace_original`). */
export function postToResponseUrl(url: string, message: SlackMessage, fetchImpl: typeof fetch = fetch): Promise<PostResult> {
  return post(url, message, fetchImpl);
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: "not_slack" | "no_access" | "too_large" | "unreachable" };

/**
 * A file someone chose in Slack (S15), from Slack's own file host with the bot token, which `files:read` lets read
 * it: at most `maxBytes`. Without that permission Slack answers with its sign-in page rather than an error, so a page
 * is no access, as a refusal is.
 */
export async function downloadSlackFile(url: string, botToken: string, maxBytes: number, fetchImpl: typeof fetch = fetch): Promise<DownloadResult> {
  if (!url.startsWith(FILES)) return { ok: false, reason: "not_slack" };
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(SLACK_DEADLINE_MS) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || contentType === "text/html") return { ok: false, reason: "no_access" };
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) return { ok: false, reason: "too_large" };
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? { ok: false, reason: "too_large" } : { ok: true, bytes, contentType };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
