import { MAX_RETRY_AFTER_MS, parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";
import { apiBase, openCredential } from "./credential";

/**
 * Pipedrive over HTTP (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P5, P8, P18): the OAuth server,
 * and each company's own API domain. Each call has a timeout; a refusal becomes a `ProviderError` naming the call and its
 * status, never a token or a body.
 */

export const PIPEDRIVE_OAUTH = "https://oauth.pipedrive.com";
export const PIPEDRIVE_AUTHORIZE = `${PIPEDRIVE_OAUTH}/oauth/authorize`;
export const PIPEDRIVE_TOKEN = `${PIPEDRIVE_OAUTH}/oauth/token`;
export const PIPEDRIVE_REVOKE = `${PIPEDRIVE_OAUTH}/oauth/revoke`;

export interface PipedriveHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;
/** A burst limit is counted over two seconds (P8): without a header saying otherwise, that is the wait. */
const BURST_WAIT_MS = 2_000;

export async function pipedriveFetch(url: string, init: RequestInit, label: string, deps: PipedriveHttp = {}): Promise<Response> {
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store", redirect: "error" });
  } catch {
    throw new ProviderError("unavailable", `Pipedrive ${label}: no answer`);
  }
}

/** The wait a 429 asks for (P8): `Retry-After` when sent; else `x-ratelimit-reset`, in seconds; else the burst window. */
export function rateLimitWait(response: Response, nowMs: number): number {
  const given = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  if (given !== null) return given;
  const reset = (response.headers.get("x-ratelimit-reset") ?? "").trim();
  if (/^\d{1,6}$/.test(reset)) return Math.min(Math.max(Number(reset) * 1000, BURST_WAIT_MS), MAX_RETRY_AFTER_MS);
  return BURST_WAIT_MS;
}

/** A refused call, by its status: 429 with the wait Pipedrive asked for, 401, 403, 5xx, anything else unreadable. */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) return new ProviderError("rate_limited", `Pipedrive ${label}: 429`, rateLimitWait(response, nowMs));
  if (status === 401) return new ProviderError("unauthorized", `Pipedrive ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `Pipedrive ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `Pipedrive ${label}: ${status}`);
  return new ProviderError("bad_response", `Pipedrive ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `Pipedrive ${label}: an answer that is not JSON`);
  }
}

/** Pipedrive's words for a refused request (`error`, `error_info`), cut to fit, never a token. */
export async function refusalWords(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown; error_info?: unknown; message?: unknown };
    const words = [body.error, body.message, body.error_info].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return words ? words.trim().replace(/\s+/g, " ").slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** The client's credentials for the OAuth server, as HTTP Basic auth: never in a URL or a body. */
export function clientAuth(settings: { clientId: string; clientSecret: string }): string {
  return `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`, "utf8").toString("base64")}`;
}

/** A form for the OAuth server: the client's credentials in the Authorization header. */
export function oauthForm(settings: { clientId: string; clientSecret: string }, fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { authorization: clientAuth(settings), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  };
}

/**
 * A call to the company's API with a sealed credential: to the host it was issued for, with its token as a Bearer. A
 * credential that does not open is a token Vestiarion cannot use: the connection needs a person.
 */
export async function apiCall(
  credential: string,
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; query?: Record<string, string>; body?: unknown },
  label: string,
  deps: PipedriveHttp = {}
): Promise<Response> {
  const opened = openCredential(credential);
  if (!opened) throw new ProviderError("unauthorized", `Pipedrive ${label}: a credential that does not open`);
  const url = new URL(`${apiBase(opened)}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  return pipedriveFetch(
    url.toString(),
    {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${opened.token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    label,
    deps
  );
}

/** A call that must answer 2xx with JSON: the JSON, or the failure its status says. */
export async function apiJson(
  credential: string,
  path: string,
  init: Parameters<typeof apiCall>[2],
  label: string,
  deps: PipedriveHttp = {}
): Promise<unknown> {
  const response = await apiCall(credential, path, init, label, deps);
  if (!response.ok) throw failureOf(response, label, (deps.now ?? Date.now)());
  return jsonOf(response, label);
}
