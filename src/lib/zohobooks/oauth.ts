import { parseRetryAfter } from "../connectors/backoff";
import type { ExchangeOutcome, RefreshOutcome } from "../connectors/provider";
import { zohoFetch, type ZohoBooksHttp } from "./http";
import { mapTokens, tokenError } from "./map";
import { regionalToken, regionOf, ZOHO_REGIONS, type ZohoRegion } from "./regions";
import { ZOHO_BOOKS_SCOPES, type ZohoBooksSettings } from "./settings";

/**
 * Zoho's OAuth 2.0 authorization code flow (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z3, Z4,
 * Z10): the authorize URL at the US accounts server, which sends a person of another data center on to theirs; the code
 * exchanged at the accounts server of the data center the callback named; refresh and revocation at the one the token
 * carries. Client id and secret go in the form body, never in a URL.
 */

export function authorizeUrl(settings: ZohoBooksSettings, input: { state: string; redirectUri: string }): string {
  const url = new URL(`${ZOHO_REGIONS.us.accounts}/oauth/v2/auth`);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ZOHO_BOOKS_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  // A refresh token, and the consent screen each time, so a reconnect always gets a new one.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function tokenRequest(region: ZohoRegion, body: Record<string, string>, label: string, deps: ZohoBooksHttp): Promise<Response> {
  return zohoFetch(
    `${ZOHO_REGIONS[region].accounts}/oauth/v2/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(body).toString() },
    label,
    deps
  );
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The code, exchanged once, at the accounts server of the data center the callback named (Z3). A `location` not in the
 * table is refused before anything is sent.
 */
export async function exchangeCode(
  settings: ZohoBooksSettings,
  input: { code: string; redirectUri: string; region?: string | null },
  deps: ZohoBooksHttp = {}
): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  const region = regionOf(input.region);
  if (!region) {
    console.error("zohobooks: the callback named a data center Vestiarion does not know");
    return { ok: false, reason: "refused" };
  }
  let response: Response;
  try {
    response = await tokenRequest(
      region,
      { grant_type: "authorization_code", code: input.code, client_id: settings.clientId, client_secret: settings.clientSecret, redirect_uri: input.redirectUri },
      "code exchange",
      deps
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  const body = await bodyOf(response);
  const error = tokenError(body);
  if (!response.ok || error) {
    console.error("zohobooks: the code exchange was refused", response.status, error);
    return { ok: false, reason: "refused" };
  }
  try {
    return { ok: true, tokens: mapTokens(body, region, now(), ZOHO_BOOKS_SCOPES), authEventId: null };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Refusals at refresh that mean the refresh token no longer works, and the connection needs a person (Z10). */
const SPENT = new Set(["invalid_code", "invalid_grant", "invalid_client"]);

/** A refresh at the token's own data center. Zoho answers an access token only; the refresh token is kept (Z4). */
export async function refreshTokens(settings: ZohoBooksSettings, refreshToken: string, deps: ZohoBooksHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let kept: { region: ZohoRegion; token: string };
  try {
    kept = regionalToken(refreshToken);
  } catch {
    return { ok: false, reason: "reconnect" };
  }
  let response: Response;
  try {
    response = await tokenRequest(
      kept.region,
      { grant_type: "refresh_token", refresh_token: kept.token, client_id: settings.clientId, client_secret: settings.clientSecret },
      "refresh",
      deps
    );
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  const body = await bodyOf(response);
  const error = tokenError(body);
  if (response.ok && !error) {
    try {
      return { ok: true, tokens: mapTokens(body, kept.region, now(), ZOHO_BOOKS_SCOPES, refreshToken) };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  if (error && SPENT.has(error)) return { ok: false, reason: "reconnect" };
  console.error("zohobooks: a refresh failed", response.status, error);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes a refresh token at its data center. True when Zoho confirmed it. */
export async function revokeToken(refreshToken: string, deps: ZohoBooksHttp = {}): Promise<boolean> {
  let kept: { region: ZohoRegion; token: string };
  try {
    kept = regionalToken(refreshToken);
  } catch {
    return false;
  }
  try {
    const response = await zohoFetch(
      `${ZOHO_REGIONS[kept.region].accounts}/oauth/v2/token/revoke`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ token: kept.token }).toString() },
      "revocation",
      deps
    );
    const error = tokenError(await bodyOf(response));
    if (!response.ok || error) console.error("zohobooks: revocation was refused", response.status, error);
    return response.ok && !error;
  } catch {
    return false;
  }
}
