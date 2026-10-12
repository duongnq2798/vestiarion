import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError, type ExchangeOutcome, type ExternalOrganisation, type RefreshOutcome } from "../connectors/provider";
import { basicAuth, failureOf, jsonOf, xeroFetch, XERO_AUTHORIZE, XERO_CONNECTIONS, XERO_REVOKE, XERO_TOKEN, type XeroHttp } from "./http";
import { authEventOf, mapConnections, mapTokens } from "./map";
import { XERO_SCOPES, type XeroSettings } from "./settings";

/**
 * Xero's OAuth 2.0 authorization code flow, for a Web app (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X4, X5, X13): the authorize URL, the code exchange and the refresh at the token endpoint with HTTP Basic client
 * authentication, revocation, and the organisations a token reaches.
 */

export function authorizeUrl(settings: XeroSettings, input: { state: string; redirectUri: string }): string {
  const url = new URL(XERO_AUTHORIZE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", XERO_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function tokenRequest(settings: XeroSettings, body: Record<string, string>, label: string, deps: XeroHttp): Promise<Response> {
  return xeroFetch(
    XERO_TOKEN,
    {
      method: "POST",
      headers: { authorization: basicAuth(settings), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
    },
    label,
    deps
  );
}

/** The error code a token endpoint's 400 carries (`invalid_grant`, `invalid_client`), or null. */
async function oauthError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(settings: XeroSettings, input: { code: string; redirectUri: string }, deps: XeroHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await tokenRequest(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("xero: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  try {
    const tokens = mapTokens(await jsonOf(response, "code exchange"), now());
    return { ok: true, tokens, authEventId: authEventOf(tokens.accessToken) };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A refresh: a new access token and a new refresh token (Xero rotates it). `invalid_grant` means the refresh token is
 * spent, revoked or expired, and the connection needs a person; anything else may pass, and is tried again later.
 */
export async function refreshTokens(settings: XeroSettings, refreshToken: string, deps: XeroHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await tokenRequest(settings, { grant_type: "refresh_token", refresh_token: refreshToken }, "refresh", deps);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  if (response.ok) {
    try {
      return { ok: true, tokens: mapTokens(await jsonOf(response, "refresh"), now()) };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  if (response.status === 400 && (await oauthError(response)) === "invalid_grant") return { ok: false, reason: "reconnect" };
  console.error("xero: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes a refresh token, which ends the access it grants. True when Xero confirmed it. */
export async function revokeToken(settings: XeroSettings, refreshToken: string, deps: XeroHttp = {}): Promise<boolean> {
  try {
    const response = await xeroFetch(
      XERO_REVOKE,
      {
        method: "POST",
        headers: { authorization: basicAuth(settings), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      },
      "revocation",
      deps
    );
    if (!response.ok) console.error("xero: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/** The organisations a fresh token reaches, those of its own authorization when Xero says which. */
export async function listOrganisations(accessToken: string, authEventId: string | null, deps: XeroHttp = {}): Promise<ExternalOrganisation[]> {
  const response = await xeroFetch(XERO_CONNECTIONS, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, "connections", deps);
  if (!response.ok) throw failureOf(response, "connections", (deps.now ?? Date.now)());
  const organisations = mapConnections(await jsonOf(response, "connections"), authEventId);
  if (organisations.length === 0) throw new ProviderError("bad_response", "Xero connections: no organisation");
  return organisations;
}
