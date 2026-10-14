import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError, type ExchangeOutcome, type ExternalOrganisation, type RefreshOutcome } from "../connectors/provider";
import { ASANA_AUTHORIZE, ASANA_API, ASANA_REVOKE, ASANA_TOKEN, apiGet, asanaFetch, failureOf, jsonOf, oauthForm, type AsanaHttp } from "./http";
import { mapTokens, mapUser } from "./map";
import { ASANA_SCOPES, type AsanaSettings } from "./settings";

/**
 * Asana's OAuth 2.0 authorization code flow (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2): the
 * authorize URL with the app's registered scopes, the code exchange and the refresh at `/-/oauth_token` with the
 * client's credentials in the body, the person a token acts as, and revocation of the refresh token. A grant is one
 * Asana user's: the connection reads the tasks that user can see, in every Asana workspace they belong to.
 */

/**
 * The authorize URL. Asana wants the scopes space-delimited and URL-encoded as `%20`, so the query is built by hand,
 * each value through `encodeURIComponent`.
 */
export function authorizeUrl(settings: AsanaSettings, input: { state: string; redirectUri: string }): string {
  const query = [
    ["client_id", settings.clientId],
    ["redirect_uri", input.redirectUri],
    ["response_type", "code"],
    ["state", input.state],
    ["scope", ASANA_SCOPES.join(" ")],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${ASANA_AUTHORIZE}?${query}`;
}

/** The error code a token endpoint's 400 or 401 carries (`invalid_grant`), or null. */
async function oauthError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error.slice(0, 40) : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(settings: AsanaSettings, input: { code: string; redirectUri: string }, deps: AsanaHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await asanaFetch(ASANA_TOKEN, oauthForm(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }), "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("asana: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  try {
    const { tokens, user } = mapTokens(await jsonOf(response, "code exchange"), now());
    // The person of the grant, handed to `organisations` as the core hands on an authorization event.
    return { ok: true, tokens, authEventId: user?.gid ?? null };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A refresh: a new access token, and the refresh token Asana sends back, else the one sent (Asana keeps a refresh token
 * for as long as the app stays authorized). `invalid_grant` means the person revoked the app or left, and the
 * connection needs a person; anything else is tried again later.
 */
export async function refreshTokens(settings: AsanaSettings, refreshToken: string, deps: AsanaHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await asanaFetch(ASANA_TOKEN, oauthForm(settings, { grant_type: "refresh_token", refresh_token: refreshToken }), "refresh", deps);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  if (response.ok) {
    try {
      return { ok: true, tokens: mapTokens(await jsonOf(response, "refresh"), now(), refreshToken).tokens };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  if (response.status === 400 || response.status === 401) {
    const code = await oauthError(response);
    if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") return { ok: false, reason: "reconnect" };
  }
  console.error("asana: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes a refresh token, which ends the access it grants, its access tokens with it. True when Asana confirmed it. */
export async function revokeToken(settings: AsanaSettings, refreshToken: string, deps: AsanaHttp = {}): Promise<boolean> {
  try {
    const response = await asanaFetch(ASANA_REVOKE, oauthForm(settings, { token: refreshToken }), "revocation", deps);
    if (!response.ok) console.error("asana: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/** The one Asana user a fresh token acts as: its gid and name, from `/users/me`; the code exchange's when that fails. */
export async function grantUser(accessToken: string, fromExchange: string | null, deps: AsanaHttp = {}): Promise<ExternalOrganisation[]> {
  const now = deps.now ?? Date.now;
  try {
    const response = await asanaFetch(`${ASANA_API}/users/me?opt_fields=gid,name`, apiGet(accessToken), "user", deps);
    if (!response.ok) throw failureOf(response, "user", now());
    const user = mapUser(await jsonOf(response, "user"));
    if (fromExchange && user.gid !== fromExchange) throw new ProviderError("bad_response", "Asana named two users for one grant");
    return [{ externalOrgId: user.gid, name: user.name, connectionId: null }];
  } catch (error) {
    if (!(error instanceof ProviderError) || error.message.includes("two users")) throw error;
    if (!fromExchange) throw error;
    return [{ externalOrgId: fromExchange, name: `Asana user ${fromExchange}`, connectionId: null }];
  }
}
