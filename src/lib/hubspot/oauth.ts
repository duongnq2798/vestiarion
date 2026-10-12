import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError, type ExchangeOutcome, type ExternalOrganisation, type RefreshOutcome } from "../connectors/provider";
import { HUBSPOT_AUTHORIZE, HUBSPOT_INTROSPECT, HUBSPOT_REVOKE, HUBSPOT_TOKEN, hubspotFetch, jsonOf, oauthForm, type HubSpotHttp } from "./http";
import { mapIntrospection, mapTokens } from "./map";
import { HUBSPOT_SCOPES, type HubSpotSettings } from "./settings";

/**
 * HubSpot's OAuth 2.0 authorization code flow for an app on the developer platform
 * (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4, H5, H15): the authorize URL, the code exchange and
 * the refresh at the 2026-03 token endpoint with the client's credentials in the body, the account a token reaches,
 * and revocation. One account per grant: the token answer names it (`hub_id`), and the code exchange hands it on as
 * the grant's "authorization event" so the core can ask for the account without another call.
 */

export function authorizeUrl(settings: HubSpotSettings, input: { state: string; redirectUri: string }): string {
  const url = new URL(HUBSPOT_AUTHORIZE);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** The error code a token endpoint's 400 carries (`invalid_grant`), or null. */
async function oauthError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown; status?: unknown };
    return typeof body.error === "string" ? body.error : typeof body.status === "string" ? body.status : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(settings: HubSpotSettings, input: { code: string; redirectUri: string }, deps: HubSpotHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await hubspotFetch(HUBSPOT_TOKEN, oauthForm(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }), "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("hubspot: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  try {
    const { tokens, hubId } = mapTokens(await jsonOf(response, "code exchange"), now());
    // The account of the grant, handed to `organisations` as the core hands on an authorization event.
    return { ok: true, tokens, authEventId: hubId };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A refresh: a new access token, and the refresh token HubSpot sends back, else the one sent. `invalid_grant` means
 * the app was uninstalled or the token revoked, and the connection needs a person; anything else is tried again later.
 */
export async function refreshTokens(settings: HubSpotSettings, refreshToken: string, deps: HubSpotHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await hubspotFetch(HUBSPOT_TOKEN, oauthForm(settings, { grant_type: "refresh_token", refresh_token: refreshToken }), "refresh", deps);
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
    if (code === "invalid_grant" || code === "BAD_REFRESH_TOKEN") return { ok: false, reason: "reconnect" };
  }
  console.error("hubspot: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes a refresh token, which ends the access it grants. True when HubSpot confirmed it. */
export async function revokeToken(settings: HubSpotSettings, refreshToken: string, deps: HubSpotHttp = {}): Promise<boolean> {
  try {
    const response = await hubspotFetch(HUBSPOT_REVOKE, oauthForm(settings, { token: refreshToken, token_type_hint: "refresh_token" }), "revocation", deps);
    if (!response.ok) console.error("hubspot: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The one account a fresh token reaches: its hub id (from the code exchange, else the introspection) and its domain as
 * its name, else "HubSpot account <id>". The introspection only names it: when it fails, the id is enough.
 */
export async function listAccount(settings: HubSpotSettings, accessToken: string, hubId: string | null, deps: HubSpotHttp = {}): Promise<ExternalOrganisation[]> {
  let introspected: { hubId: string | null; hubDomain: string | null } = { hubId: null, hubDomain: null };
  try {
    const response = await hubspotFetch(HUBSPOT_INTROSPECT, oauthForm(settings, { token_type_hint: "access_token", token: accessToken }), "introspection", deps);
    if (response.ok) introspected = mapIntrospection(await jsonOf(response, "introspection"));
    else console.error("hubspot: the introspection was refused", response.status);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
  }
  const id = hubId ?? introspected.hubId;
  if (!id) throw new ProviderError("bad_response", "HubSpot named no account for this grant");
  if (hubId && introspected.hubId && introspected.hubId !== hubId) throw new ProviderError("bad_response", "HubSpot named two accounts for one grant");
  return [{ externalOrgId: id, name: introspected.hubDomain ?? `HubSpot account ${id}`, connectionId: null }];
}
