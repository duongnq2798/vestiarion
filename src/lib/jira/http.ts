import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";

/**
 * Jira over HTTP (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2, JR3, JR8, JR17): Atlassian's OAuth
 * endpoints and Jira Cloud's REST API, named here once. Every API request goes to `api.atlassian.com` and nowhere else,
 * naming the site by its cloudId (`/ex/jira/<cloudId>/rest/api/3/...`); a person goes to `auth.atlassian.com` only to
 * authorize, and the tokens come from there too. A link a person or Jira gave is never opened.
 *
 * An address is built here from parts checked first (a cloudId, an issue's numeric id or key, a fixed path), never with
 * a slash before its query, which Jira answers `401 scope does not match`. Each call has a timeout, never follows a
 * redirect and is never cached; a refusal becomes a `ProviderError` naming the call and its status, never a token or a
 * body. Atlassian's rate limit is one pool for every tenant of the app, so a 429 that says the pool itself is spent
 * pauses every Jira call of the process until it has refilled (JR17).
 */

/** Atlassian's authorization server: the consent screen and the token endpoint. */
export const JIRA_AUTH_HOST = "auth.atlassian.com";
/** Atlassian's API gateway: the sites a grant reaches, and each site's REST API. */
export const JIRA_API_HOST = "api.atlassian.com";
export const JIRA_AUTHORIZE = `https://${JIRA_AUTH_HOST}/authorize`;
/** Takes a JSON body, for the code's exchange and for each refresh (JR2, JR3). */
export const JIRA_TOKEN = `https://${JIRA_AUTH_HOST}/oauth/token`;
/** The sites a token reaches, `[{id, name, url, scopes, avatarUrl}]`, where `id` is the cloudId (JR2). */
export const JIRA_RESOURCES = `https://${JIRA_API_HOST}/oauth/token/accessible-resources`;
/**
 * Atlassian's sign-in, where the consent screen may send a person who is signed out before they agree. Only the content
 * security policy's form targets name it (B11); no request is ever made to it.
 */
export const JIRA_LOGIN = "https://id.atlassian.com";

/** A site's cloudId, as Atlassian writes it: a UUID in lower case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An issue's numeric id, which it keeps when it moves to another project (JR6). A project's id is one too. */
export const ISSUE_ID = /^[0-9]{1,18}$/;
/** An issue's key: its project's key, a dash and its number (`ENG-142`). It changes when the issue moves. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,49}-[0-9]{1,18}$/;
/** A project's key. */
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,49}$/;

/** At most this much of an answer is read: an issue read's answers may hold 50 comments in ADF; anything else is small. */
export const ISSUE_JSON_BYTES = 4_000_000;
export const JSON_BYTES = 1_000_000;

/**
 * The pause on every Jira call (JR17): until when, in epoch milliseconds; 0 when there is none. One for the process,
 * since Atlassian's pool is one for every tenant of the app; a test passes its own.
 */
export interface JiraPause {
  until: number;
}

const PROCESS_PAUSE: JiraPause = { until: 0 };

export interface JiraHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
  pause?: JiraPause;
}

const TIMEOUT_MS = 15_000;
/** Without a `Retry-After`, a rate limit is waited out for a minute; however long Atlassian asks, an hour at most. */
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 60 * 60_000;
/** A site's REST API: the part of `api.atlassian.com` Jira's rate limit counts. */
const JIRA_REST = /^\/ex\/jira\/[0-9a-f-]{36}\/rest\//;
/** A path under `/rest/api/3`: segments of letters, digits, dashes and underscores, and no slash at its end. */
const API_PATH = /^(?:\/[A-Za-z0-9_-]{1,64}){1,6}$/;

/** A query value, encoded but for its commas, which Jira reads alike either way: `fields=summary,status`. */
const encodeValue = (value: string) => encodeURIComponent(value).replace(/%2C/g, ",");

/**
 * The address of one REST call on one site: `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3<path>?<query>`. The
 * cloudId and the path are checked first, so nothing a person or Jira gave reaches it unchecked.
 */
export function apiUrl(cloudId: string, path: string, query: Readonly<Record<string, string>> = {}): string {
  if (!UUID.test(cloudId)) throw new ProviderError("bad_response", "Jira: not a site's cloud id");
  if (!API_PATH.test(path)) throw new ProviderError("bad_response", "Jira: not an API path");
  const search = Object.entries(query)
    .map(([key, value]) => `${key}=${encodeValue(value)}`)
    .join("&");
  return `https://${JIRA_API_HOST}/ex/jira/${cloudId}/rest/api/3${path}${search ? `?${search}` : ""}`;
}

/** When the pause on Jira calls ends (JR17), or null when there is none now. */
export function pausedUntil(deps: JiraHttp = {}): number | null {
  const pause = deps.pause ?? PROCESS_PAUSE;
  return pause.until > (deps.now ?? Date.now)() ? pause.until : null;
}

/** Atlassian's reason for a 429, one of a few fixed words (`jira-quota-global-based`); null for anything else. */
function limitReason(response: Response): string | null {
  const reason = response.headers.get("ratelimit-reason")?.trim().toLowerCase() ?? "";
  return /^[a-z][a-z0-9-]{0,59}$/.test(reason) ? reason : null;
}

/**
 * One request to Atlassian: to `api.atlassian.com`, or to `auth.atlassian.com` for the tokens, and nowhere else. While
 * the pause is on, a call to a site's REST API fails at once as rate limited and makes no request; the token endpoint
 * and the list of the sites a grant reaches are not in Jira's pool, so they go on. A 429 for the app's whole pool
 * (`jira-quota-global-*`) starts the pause; any other 429 is the caller's to wait out.
 */
export async function jiraFetch(url: string, init: RequestInit, label: string, deps: JiraHttp = {}): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ProviderError("bad_response", `Jira ${label}: not an address`);
  }
  const atlassian = target.hostname === JIRA_API_HOST || target.hostname === JIRA_AUTH_HOST;
  if (target.protocol !== "https:" || !atlassian || target.port !== "" || target.username !== "" || target.password !== "") {
    throw new ProviderError("bad_response", `Jira ${label}: not Atlassian's address`);
  }
  if (target.pathname.endsWith("/")) throw new ProviderError("bad_response", `Jira ${label}: a slash before the query`);
  const now = deps.now ?? Date.now;
  const pause = deps.pause ?? PROCESS_PAUSE;
  const rest = target.hostname === JIRA_API_HOST && JIRA_REST.test(target.pathname);
  if (rest && pause.until > now()) throw new ProviderError("rate_limited", `Jira ${label}: paused for Atlassian's shared rate limit`, pause.until - now());
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `Jira ${label}: no answer`);
  }
  if (rest && response.status === 429 && limitReason(response)?.startsWith("jira-quota-global")) {
    const until = now() + waitOf(response, now());
    if (until > pause.until) {
      pause.until = until;
      console.warn("jira: Atlassian's shared rate limit is spent; every Jira call waits (seconds)", Math.ceil((until - now()) / 1000));
    }
  }
  return response;
}

/** How long Atlassian asked to wait: `Retry-After`, in seconds or as a date; else a minute; at most an hour. */
export function waitOf(response: Response, nowMs: number): number {
  return Math.min(parseRetryAfter(response.headers.get("retry-after"), nowMs) ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
}

/** A refused call, by its status: 429 with the wait Atlassian asked for, 401, 403, 5xx, anything else unreadable. */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) {
    const reason = limitReason(response);
    return new ProviderError("rate_limited", `Jira ${label}: 429${reason ? ` ${reason}` : ""}`, waitOf(response, nowMs));
  }
  if (status === 401) return new ProviderError("unauthorized", `Jira ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `Jira ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `Jira ${label}: ${status}`);
  return new ProviderError("bad_response", `Jira ${label}: ${status}`);
}

/**
 * A body's text, read until it passes `maxBytes` and no further: a declared length over it is refused before anything
 * is read, and a body sent without one is given up on, its stream cancelled, the moment it is too large. Null when it
 * is. A request's body and an answer's alike.
 */
export async function cappedText(message: { body: ReadableStream<Uint8Array> | null; headers: Headers }, maxBytes: number): Promise<string | null> {
  const declared = Number(message.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await message.body?.cancel().catch(() => {});
    return null;
  }
  const reader = message.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** An answer's JSON, of at most `maxBytes`: `ISSUE_JSON_BYTES` for an issue read, `JSON_BYTES` for everything else. */
export async function jsonOf(response: Response, label: string, maxBytes: number): Promise<unknown> {
  let text: string | null;
  try {
    text = await cappedText(response, maxBytes);
  } catch {
    throw new ProviderError("unavailable", `Jira ${label}: the answer did not arrive`);
  }
  if (text === null) throw new ProviderError("bad_response", `Jira ${label}: an answer larger than ${maxBytes} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("bad_response", `Jira ${label}: an answer that is not JSON`);
  }
}

/** A request to the REST API with a bearer token, and a JSON body when there is one. */
export function apiInit(accessToken: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** A body never read, cancelled so its connection is let go. */
export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}
