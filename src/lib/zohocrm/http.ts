import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";
import { regionalToken, ZOHO_REGIONS } from "../zohobooks/regions";

/**
 * Zoho CRM over HTTP (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C5, C8): API v8 at the API domain
 * of the data center the token carries, `Authorization: Zoho-oauthtoken`. Each call has a timeout; a refusal becomes a
 * `ProviderError` naming the call and its status, never a token, a body or an id. Zoho CRM answers an empty list with 204
 * and nothing changed since `If-Modified-Since` with 304: both read as no records.
 */

export interface ZohoCrmHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;
/** Zoho CRM sends no wait with a 429: its credits and its concurrency free up within a minute or so. */
const RATE_LIMIT_WAIT_MS = 60_000;

/** A refused call, by its status: 429 with the wait asked for, or a minute; 401; 403; 5xx; anything else unreadable. */
export function crmFailureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) {
    return new ProviderError("rate_limited", `Zoho CRM ${label}: 429`, parseRetryAfter(response.headers.get("retry-after"), nowMs) ?? RATE_LIMIT_WAIT_MS);
  }
  if (status === 401) return new ProviderError("unauthorized", `Zoho CRM ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `Zoho CRM ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `Zoho CRM ${label}: ${status}`);
  return new ProviderError("bad_response", `Zoho CRM ${label}: ${status}`);
}

/**
 * One GET of Zoho CRM's API v8, at the API domain of the token's data center: its JSON, or null for 204 and 304 (no
 * records). The query's values are encoded; `since` becomes `If-Modified-Since`.
 */
export async function crmGet(
  accessToken: string,
  path: string,
  options: { query?: Record<string, string>; ifModifiedSince?: string },
  label: string,
  deps: ZohoCrmHttp = {}
): Promise<unknown> {
  const now = deps.now ?? Date.now;
  let kept: ReturnType<typeof regionalToken>;
  try {
    kept = regionalToken(accessToken);
  } catch {
    throw new ProviderError("unauthorized", `Zoho CRM ${label}: a token without its data center`);
  }
  const url = new URL(`${ZOHO_REGIONS[kept.region].api}/crm/v8${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Zoho-oauthtoken ${kept.token}`,
        accept: "application/json",
        ...(options.ifModifiedSince ? { "if-modified-since": options.ifModifiedSince } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new ProviderError("unavailable", `Zoho CRM ${label}: no answer`);
  }
  if (response.status === 204 || response.status === 304) return null;
  if (!response.ok) throw crmFailureOf(response, label, now());
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `Zoho CRM ${label}: an answer that is not JSON`);
  }
}
