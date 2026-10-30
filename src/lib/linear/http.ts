import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";

/**
 * Linear over HTTP (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN1, LN2, LN6): the OAuth endpoints
 * and the GraphQL API, named here once. Every request goes to `api.linear.app` and nowhere else; a person goes to
 * `linear.app` only to authorize. A query names an issue by its id or identifier as a GraphQL variable, never by a link
 * a person or Linear gave. Each call has a timeout; a refusal becomes a `ProviderError` naming the call and its status,
 * never a token or a body.
 *
 * Linear answers a GraphQL request that fails with a list of `errors`, each with an `extensions.code`: an expired or
 * revoked token is `AUTHENTICATION_ERROR` (HTTP 401 or 400), a rate limit `RATELIMITED` (HTTP 400 or 429, with
 * `X-RateLimit-Requests-Reset` in epoch milliseconds), an issue the token cannot see `Entity not found`.
 */

export const LINEAR_WEB_HOST = "linear.app";
export const LINEAR_API_HOST = "api.linear.app";
export const LINEAR_AUTHORIZE = `https://${LINEAR_WEB_HOST}/oauth/authorize`;
export const LINEAR_TOKEN = `https://${LINEAR_API_HOST}/oauth/token`;
export const LINEAR_REVOKE = `https://${LINEAR_API_HOST}/oauth/revoke`;
export const LINEAR_GRAPHQL = `https://${LINEAR_API_HOST}/graphql`;

/** Linear's ids are UUIDs, written in lower case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An issue's identifier: its team's key, a dash and its number (`ENG-123`). */
export const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,9}$/;

export interface LinearHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 15_000;

export async function linearFetch(url: string, init: RequestInit, label: string, deps: LinearHttp = {}): Promise<Response> {
  if (new URL(url).hostname !== LINEAR_API_HOST) throw new ProviderError("bad_response", `Linear ${label}: not Linear's address`);
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `Linear ${label}: no answer`);
  }
}

/** How long Linear asked to wait: `Retry-After`, else the reset time of its request limit, else a minute. */
export function waitOf(response: Response, nowMs: number): number {
  const after = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  if (after !== null) return after;
  const reset = Number(response.headers.get("x-ratelimit-requests-reset"));
  if (Number.isFinite(reset) && reset > nowMs) return Math.min(reset - nowMs, 60 * 60_000);
  return 60_000;
}

/** A refused call, by its status: 429 with the wait Linear asked for, 401, 403, 5xx, anything else unreadable. */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) return new ProviderError("rate_limited", `Linear ${label}: 429`, waitOf(response, nowMs));
  if (status === 401) return new ProviderError("unauthorized", `Linear ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `Linear ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `Linear ${label}: ${status}`);
  return new ProviderError("bad_response", `Linear ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `Linear ${label}: an answer that is not JSON`);
  }
}

/** A form for the OAuth endpoints: the client id and secret in the body, never in the URL. */
export function oauthForm(settings: { clientId: string; clientSecret: string }, fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...fields, client_id: settings.clientId, client_secret: settings.clientSecret }).toString(),
  };
}

/** One of Linear's GraphQL errors, as far as it is read: its message's start, and its code and type. */
export interface GraphqlError {
  message: string;
  code: string | null;
  type: string | null;
}

export interface GraphqlAnswer {
  data: Record<string, unknown> | null;
  errors: GraphqlError[];
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const word = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

function errorsOf(body: Record<string, unknown> | null): GraphqlError[] {
  if (!body || !Array.isArray(body.errors)) return [];
  return body.errors.slice(0, 10).flatMap((raw): GraphqlError[] => {
    const error = record(raw);
    if (!error) return [];
    const extensions = record(error.extensions);
    return [{ message: word(error.message, 200) ?? "", code: word(extensions?.code, 60), type: word(extensions?.type, 60) }];
  });
}

const isAuthentication = (error: GraphqlError) => error.code === "AUTHENTICATION_ERROR" || /^authentication/i.test(error.type ?? "");
const isRateLimit = (error: GraphqlError) => error.code === "RATELIMITED" || /^ratelimited/i.test(error.type ?? "");
const isForbidden = (error: GraphqlError) => error.code === "FORBIDDEN" || /^forbidden/i.test(error.type ?? "");

/** An answer saying the entity asked for does not exist, or not for this token. */
export const notFound = (errors: readonly GraphqlError[]) =>
  errors.some((error) => error.code === "ENTITY_NOT_FOUND" || /entity not found|could not find referenced/i.test(error.message));

/**
 * One GraphQL request with a bearer token. Throws `ProviderError` for a refused token (`unauthorized`, so the session
 * refreshes it once), a rate limit, a refusal, an outage or an answer that does not read; answers Linear's data and
 * any other errors, which the caller reads (an issue not found is an answer about the issue).
 */
export async function graphql(accessToken: string, query: string, variables: Record<string, unknown>, label: string, deps: LinearHttp = {}): Promise<GraphqlAnswer> {
  const now = deps.now ?? Date.now;
  const response = await linearFetch(
    LINEAR_GRAPHQL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    label,
    deps
  );
  if (response.status === 401 || response.status === 429 || response.status === 403 || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw failureOf(response, label, now());
  }
  let body: Record<string, unknown> | null;
  try {
    body = record(await response.json());
  } catch {
    throw response.ok ? new ProviderError("bad_response", `Linear ${label}: an answer that is not JSON`) : failureOf(response, label, now());
  }
  const errors = errorsOf(body);
  if (errors.some(isAuthentication)) throw new ProviderError("unauthorized", `Linear ${label}: ${response.status} AUTHENTICATION_ERROR`);
  if (errors.some(isRateLimit)) throw new ProviderError("rate_limited", `Linear ${label}: ${response.status} RATELIMITED`, waitOf(response, now()));
  if (errors.some(isForbidden)) throw new ProviderError("forbidden", `Linear ${label}: ${response.status} FORBIDDEN`);
  const data = record(body?.data);
  if (!response.ok && errors.length === 0) throw failureOf(response, label, now());
  return { data, errors };
}
