import { parseRetryAfter } from "../connectors/backoff";
import type { ExchangeOutcome, ExternalOrganisation, RefreshOutcome } from "../connectors/provider";
import { graphql, jsonOf, LINEAR_AUTHORIZE, LINEAR_REVOKE, LINEAR_TOKEN, linearFetch, oauthForm, type LinearHttp } from "./http";
import { mapTokens, mapViewer } from "./map";
import { LINEAR_SCOPES, type LinearSettings } from "./settings";

/**
 * Linear's OAuth 2.0 authorization code flow (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2): the
 * authorize URL with scope `read` and `actor=user`, the code exchange and the refresh at `/oauth/token` with the client's
 * credentials in the body, the workspace a token reads, and revocation. A grant is one Linear user's in one Linear
 * workspace: the connection reads the issues that person can see. Access tokens last a day; each refresh answers a new
 * refresh token, the one sent working for 30 minutes more, so a refresh happens only under the token row's lease.
 */

/**
 * The authorize URL. `prompt=consent` shows Linear's consent screen every time, where a person who belongs to several
 * Linear workspaces picks the one to connect; `actor=user` makes the token act as that person, Linear's default.
 */
export function authorizeUrl(settings: LinearSettings, input: { state: string; redirectUri: string }): string {
  const query = [
    ["client_id", settings.clientId],
    ["redirect_uri", input.redirectUri],
    ["response_type", "code"],
    ["scope", LINEAR_SCOPES.join(",")],
    ["state", input.state],
    ["actor", "user"],
    ["prompt", "consent"],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${LINEAR_AUTHORIZE}?${query}`;
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

export async function exchangeCode(settings: LinearSettings, input: { code: string; redirectUri: string }, deps: LinearHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await linearFetch(LINEAR_TOKEN, oauthForm(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }), "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("linear: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  try {
    return { ok: true, tokens: mapTokens(await jsonOf(response, "code exchange"), now()), authEventId: null };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A refresh: a new access token and the new refresh token Linear answers with. `invalid_grant` means the app was
 * revoked in Linear, or the refresh token is no longer good, and the connection needs a person; anything else is tried
 * again later.
 */
export async function refreshTokens(settings: LinearSettings, refreshToken: string, deps: LinearHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await linearFetch(LINEAR_TOKEN, oauthForm(settings, { grant_type: "refresh_token", refresh_token: refreshToken }), "refresh", deps);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  if (response.ok) {
    try {
      return { ok: true, tokens: mapTokens(await jsonOf(response, "refresh"), now(), refreshToken) };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  if (response.status === 400 || response.status === 401) {
    const code = await oauthError(response);
    if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") return { ok: false, reason: "reconnect" };
  }
  console.error("linear: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes the grant at Linear by its refresh token, which ends its access tokens with it. True when Linear confirmed it. */
export async function revokeToken(settings: LinearSettings, refreshToken: string, deps: LinearHttp = {}): Promise<boolean> {
  try {
    const response = await linearFetch(LINEAR_REVOKE, oauthForm(settings, { token: refreshToken, token_type_hint: "refresh_token" }), "revocation", deps);
    await response.body?.cancel().catch(() => {});
    if (!response.ok) console.error("linear: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

export const VIEWER_QUERY = "query Viewer { viewer { id name organization { id name } } }";

/** The one Linear workspace a fresh token reads, with `viewer { organization { id name } }`: its id and name (LN2). */
export async function grantWorkspace(accessToken: string, deps: LinearHttp = {}): Promise<ExternalOrganisation[]> {
  const answer = await graphql(accessToken, VIEWER_QUERY, {}, "viewer", deps);
  const viewer = mapViewer(answer.data);
  return [{ externalOrgId: viewer.organizationId, name: viewer.organizationName, connectionId: null }];
}
