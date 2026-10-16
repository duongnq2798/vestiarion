import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";

/**
 * Zoho Books over HTTP (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z10): Zoho's OAuth servers for
 * tokens and the Books API for records. Each call has a timeout; a refusal becomes a `ProviderError` naming the call and
 * its status, never a token, a body or an id.
 */

export interface ZohoBooksHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;
/** Zoho says no wait on a 429: its per-minute limit clears within a minute. */
const RATE_LIMIT_WAIT_MS = 60_000;

export async function zohoFetch(url: string, init: RequestInit, label: string, deps: ZohoBooksHttp = {}): Promise<Response> {
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `Zoho Books ${label}: no answer`);
  }
}

/** A refused call, by its status: 429 with the wait asked for, or a minute; 401; 403; 5xx; anything else unreadable. */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) {
    return new ProviderError("rate_limited", `Zoho Books ${label}: 429`, parseRetryAfter(response.headers.get("retry-after"), nowMs) ?? RATE_LIMIT_WAIT_MS);
  }
  if (status === 401) return new ProviderError("unauthorized", `Zoho Books ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `Zoho Books ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `Zoho Books ${label}: ${status}`);
  return new ProviderError("bad_response", `Zoho Books ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `Zoho Books ${label}: an answer that is not JSON`);
  }
}
