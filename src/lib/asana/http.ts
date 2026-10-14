import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";

/**
 * Asana over HTTP (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A1, A6): the OAuth endpoints and the
 * REST API, named here once. Every request goes to `app.asana.com` and nowhere else, at an address built here from
 * checked ids, never from a link a person or Asana gave. Each call has a timeout; a refusal becomes a `ProviderError`
 * naming the call and its status, never a token or a body.
 */

export const ASANA_HOST = "app.asana.com";
export const ASANA_API = `https://${ASANA_HOST}/api/1.0`;
export const ASANA_AUTHORIZE = `https://${ASANA_HOST}/-/oauth_authorize`;
export const ASANA_TOKEN = `https://${ASANA_HOST}/-/oauth_token`;
export const ASANA_REVOKE = `https://${ASANA_HOST}/-/oauth_revoke`;

/** An Asana id: digits only, so it can be put in a path without escaping anything. */
export const GID = /^[0-9]{1,32}$/;

export interface AsanaHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 15_000;

export async function asanaFetch(url: string, init: RequestInit, label: string, deps: AsanaHttp = {}): Promise<Response> {
  if (new URL(url).hostname !== ASANA_HOST) throw new ProviderError("bad_response", `Asana ${label}: not Asana's address`);
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `Asana ${label}: no answer`);
  }
}

/** A GET to the API with a bearer token. */
export function apiGet(accessToken: string): RequestInit {
  return { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } };
}

/** A refused call, by its status: 429 with the wait Asana asked for, 401, 403, 5xx, anything else unreadable. */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) return new ProviderError("rate_limited", `Asana ${label}: 429`, parseRetryAfter(response.headers.get("retry-after"), nowMs) ?? 60_000);
  if (status === 401) return new ProviderError("unauthorized", `Asana ${label}: 401`);
  if (status === 402 || status === 403) return new ProviderError("forbidden", `Asana ${label}: ${status}`);
  if (status >= 500) return new ProviderError("unavailable", `Asana ${label}: ${status}`);
  return new ProviderError("bad_response", `Asana ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `Asana ${label}: an answer that is not JSON`);
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
