import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";
import type { QuickBooksSettings } from "./settings";

/**
 * QuickBooks Online over HTTP (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q3, Q6, Q17): Intuit's
 * OAuth server for tokens and the Accounting API for records. Each call has a timeout; a refusal becomes a
 * `ProviderError` naming the call and its status, never a token, a body, a query or an id.
 */

export const INTUIT_AUTHORIZE = "https://appcenter.intuit.com/connect/oauth2";
export const INTUIT_TOKEN = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const INTUIT_REVOKE = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

export interface QuickBooksHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;

export async function quickBooksFetch(url: string, init: RequestInit, label: string, deps: QuickBooksHttp = {}): Promise<Response> {
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `QuickBooks ${label}: no answer`);
  }
}

/**
 * A refused call, by its status: 429 with the wait Intuit asked for, if it said one (the core waits a minute
 * otherwise, as Intuit asks); 401; 403; 5xx; anything else (a 400 `Fault`: a query QuickBooks did not take) unreadable.
 */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) return new ProviderError("rate_limited", `QuickBooks ${label}: 429`, parseRetryAfter(response.headers.get("retry-after"), nowMs));
  if (status === 401) return new ProviderError("unauthorized", `QuickBooks ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `QuickBooks ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `QuickBooks ${label}: ${status}`);
  return new ProviderError("bad_response", `QuickBooks ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `QuickBooks ${label}: an answer that is not JSON`);
  }
}

/** HTTP Basic client authentication, which Intuit's OAuth server takes. */
export function basicAuth(settings: QuickBooksSettings): string {
  return `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`, "utf8").toString("base64")}`;
}
