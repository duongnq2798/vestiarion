import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";

/**
 * Asana over HTTP (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A1, A6): the OAuth endpoints and the
 * REST API, named here once. Every request goes to `app.asana.com` and nowhere else, at an address built here from
 * checked ids, never from a link a person or Asana gave. Each call has a timeout; a refusal becomes a `ProviderError`
 * naming the call and its status, never a token or a body. A webhook Asana refuses to make or delete also carries
 * Asana's own short reason (`reasonOf`), so the log says why.
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

/**
 * A refused call, by its status: 429 with the wait Asana asked for, 401, 403, 5xx, anything else unreadable. `reason`,
 * from `reasonOf`, follows the status.
 */
export function failureOf(response: Response, label: string, nowMs: number, reason: string | null = null): ProviderError {
  const status = response.status;
  const said = reason ? `: ${reason}` : "";
  if (status === 429) return new ProviderError("rate_limited", `Asana ${label}: 429${said}`, parseRetryAfter(response.headers.get("retry-after"), nowMs) ?? 60_000);
  if (status === 401) return new ProviderError("unauthorized", `Asana ${label}: 401${said}`);
  if (status === 402 || status === 403) return new ProviderError("forbidden", `Asana ${label}: ${status}${said}`);
  if (status >= 500) return new ProviderError("unavailable", `Asana ${label}: ${status}${said}`);
  return new ProviderError("bad_response", `Asana ${label}: ${status}${said}`);
}

/** The most of a refusal's body read for its reason. */
const REASON_BODY_BYTES = 4_000;
const REASON_CHARS = 200;

/**
 * Asana's own words for a refusal, from `errors[0].message` of its JSON body: at most 200 printable characters, with
 * any web address in them replaced, with or without its scheme, since one could be Vestiarion's webhook address. Null
 * when the start of the body says none. Reads the body, so it is called once, in place of cancelling it.
 */
export async function reasonOf(response: Response): Promise<string | null> {
  let text: string;
  try {
    text = await startOf(response, REASON_BODY_BYTES);
  } catch {
    return null;
  }
  let message: unknown;
  try {
    const body = JSON.parse(text) as { errors?: Array<{ message?: unknown }> };
    message = Array.isArray(body?.errors) ? body.errors[0]?.message : undefined;
  } catch {
    return null;
  }
  if (typeof message !== "string") return null;
  const words = message
    .replace(/https?:\/\/\S+/gi, "[an address]")
    .replace(/\S*[a-z0-9-]\.[a-z]{2,}\/\S*/gi, "[an address]")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (words.length === 0) return null;
  return words.length > REASON_CHARS ? `${words.slice(0, REASON_CHARS - 1)}…` : words;
}

/** The first `bytes` of a body as text, the rest never read. */
async function startOf(response: Response, bytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all.subarray(0, bytes));
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
