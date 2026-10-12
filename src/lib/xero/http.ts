import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";
import type { XeroSettings } from "./settings";

/**
 * Xero over HTTP (docs/superpowers/specs/2026-10-12-xero-connector-design.md X6, X8, X17): its identity server for
 * tokens and the Accounting API for records. Each call has a timeout; a refusal becomes a `ProviderError` naming the
 * call and its status, never a token or a body.
 */

export const XERO_AUTHORIZE = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN = "https://identity.xero.com/connect/token";
export const XERO_REVOKE = "https://identity.xero.com/connect/revocation";
export const XERO_CONNECTIONS = "https://api.xero.com/connections";
export const XERO_ACCOUNTING = "https://api.xero.com/api.xro/2.0";

export interface XeroHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;

export async function xeroFetch(url: string, init: RequestInit, label: string, deps: XeroHttp = {}): Promise<Response> {
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `Xero ${label}: no answer`);
  }
}

/** A refused call, by its status: 429 with the wait Xero asked for, 401, 403, 5xx, anything else unreadable. */
export function failureOf(response: Response, label: string, nowMs: number): ProviderError {
  const status = response.status;
  if (status === 429) {
    const problem = response.headers.get("x-rate-limit-problem");
    return new ProviderError("rate_limited", `Xero ${label}: 429${problem ? ` (${problem})` : ""}`, parseRetryAfter(response.headers.get("retry-after"), nowMs));
  }
  if (status === 401) return new ProviderError("unauthorized", `Xero ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `Xero ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `Xero ${label}: ${status}`);
  return new ProviderError("bad_response", `Xero ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `Xero ${label}: an answer that is not JSON`);
  }
}

/** HTTP Basic client authentication, which Xero's identity server takes. */
export function basicAuth(settings: XeroSettings): string {
  return `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`, "utf8").toString("base64")}`;
}
