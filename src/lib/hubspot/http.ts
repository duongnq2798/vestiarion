import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError } from "../connectors/provider";

/**
 * HubSpot over HTTP (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H6, H8, H18): the OAuth endpoints
 * and the CRM, on one API version named here once. Each call has a timeout; a refusal becomes a `ProviderError` naming
 * the call and its status, never a token or a body.
 */

/** HubSpot's date-versioned API, which replaces v1 and v3. One constant to move when HubSpot retires it. */
export const HUBSPOT_API_VERSION = "2026-03";
export const HUBSPOT_API = "https://api.hubapi.com";
export const HUBSPOT_AUTHORIZE = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_TOKEN = `${HUBSPOT_API}/oauth/${HUBSPOT_API_VERSION}/token`;
export const HUBSPOT_INTROSPECT = `${HUBSPOT_TOKEN}/introspect`;
export const HUBSPOT_REVOKE = `${HUBSPOT_TOKEN}/revoke`;
export const HUBSPOT_ACCOUNT = `${HUBSPOT_API}/account-info/${HUBSPOT_API_VERSION}/details`;
export const hubspotObjects = (object: "deals" | "companies" | "contacts") => `${HUBSPOT_API}/crm/objects/${HUBSPOT_API_VERSION}/${object}`;
export const hubspotAssociations = (from: string, to: string) => `${HUBSPOT_API}/crm/associations/${HUBSPOT_API_VERSION}/${from}/${to}/batch/read`;
export const HUBSPOT_DEAL_PIPELINES = `${HUBSPOT_API}/crm/pipelines/${HUBSPOT_API_VERSION}/deals`;
/** Deal property definitions and their groups (crm-receipts R2). */
export const HUBSPOT_DEAL_PROPERTIES = `${HUBSPOT_API}/crm/properties/${HUBSPOT_API_VERSION}/deals`;

export interface HubSpotHttp {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const TIMEOUT_MS = 20_000;

export async function hubspotFetch(url: string, init: RequestInit, label: string, deps: HubSpotHttp = {}): Promise<Response> {
  try {
    return await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new ProviderError("unavailable", `HubSpot ${label}: no answer`);
  }
}

/** The wait a 429 asks for (H8): `Retry-After` when sent; else by the limit HubSpot names. */
async function rateLimitWait(response: Response, nowMs: number): Promise<{ wait: number; policy: string | null }> {
  const given = parseRetryAfter(response.headers.get("retry-after"), nowMs);
  let policy: string | null = null;
  try {
    const body = (await response.json()) as { policyName?: unknown };
    policy = typeof body.policyName === "string" ? body.policyName.slice(0, 40) : null;
  } catch {
    policy = null;
  }
  if (given !== null) return { wait: given, policy };
  if (policy === "SECONDLY") return { wait: 1_000, policy };
  if (policy === "DAILY") return { wait: 60 * 60_000, policy };
  const interval = Number(response.headers.get("x-hubspot-ratelimit-interval-milliseconds"));
  return { wait: Number.isFinite(interval) && interval > 0 && interval <= 60_000 ? interval : 10_000, policy };
}

/** A refused call, by its status: 429 with the wait HubSpot asked for, 401, 403, 5xx, anything else unreadable. */
export async function failureOf(response: Response, label: string, nowMs: number): Promise<ProviderError> {
  const status = response.status;
  if (status === 429) {
    const { wait, policy } = await rateLimitWait(response, nowMs);
    return new ProviderError("rate_limited", `HubSpot ${label}: 429${policy ? ` (${policy})` : ""}`, wait);
  }
  if (status === 401) return new ProviderError("unauthorized", `HubSpot ${label}: 401`);
  if (status === 403) return new ProviderError("forbidden", `HubSpot ${label}: 403`);
  if (status >= 500) return new ProviderError("unavailable", `HubSpot ${label}: ${status}`);
  return new ProviderError("bad_response", `HubSpot ${label}: ${status}`);
}

export async function jsonOf(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProviderError("bad_response", `HubSpot ${label}: an answer that is not JSON`);
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
