import { parseRetryAfter } from "../connectors/backoff";
import { ConnectRefusal } from "../connectors/connect-refusal";
import type { ExchangeOutcome, ExternalOrganisation, RefreshOutcome } from "../connectors/provider";
import { cappedText, failureOf, JIRA_AUTHORIZE, JIRA_RESOURCES, JIRA_TOKEN, jiraFetch, jsonOf, JSON_BYTES, discard, type JiraHttp } from "./http";
import { mapSites, mapTokens, type JiraSite } from "./map";
import { JIRA_SCOPES, type JiraSettings } from "./settings";

/**
 * Atlassian's OAuth 2.0 (3LO) authorization code flow (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2,
 * JR3, JR4): the authorize URL with the four classic scopes, the code exchange and the refresh at `/oauth/token` with a
 * JSON body that carries the client's credentials, the Jira sites a token reaches, and no revocation, since Atlassian
 * gives apps none. A grant is one Atlassian user's: the connection reads what that person can see on the site it
 * connects. Each refresh answers a new refresh token and disables the one sent, so a refresh happens only under the token
 * row's lease. No token and no body is ever logged.
 */

/**
 * The authorize URL, with exactly Atlassian's seven parameters. `prompt=consent` shows the consent screen every time,
 * where a person with several Jira sites sees which the app may reach; `offline_access` among the scopes adds the
 * refresh token.
 */
export function authorizeUrl(settings: JiraSettings, input: { state: string; redirectUri: string }): string {
  const query = [
    ["audience", "api.atlassian.com"],
    ["client_id", settings.clientId],
    ["scope", JIRA_SCOPES.join(" ")],
    ["redirect_uri", input.redirectUri],
    ["state", input.state],
    ["response_type", "code"],
    ["prompt", "consent"],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${JIRA_AUTHORIZE}?${query}`;
}

/** A POST to the token endpoint, its body JSON with the client's credentials, never in the URL. */
function tokenRequest(settings: JiraSettings, fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...fields, client_id: settings.clientId, client_secret: settings.clientSecret }),
  };
}

/** The error code a token endpoint's refusal carries (`invalid_grant`), cut to 40 characters, or null. */
async function oauthError(response: Response): Promise<string | null> {
  try {
    const text = await cappedText(response, 8_000);
    const body = JSON.parse(text ?? "") as { error?: unknown };
    return typeof body.error === "string" && /^[A-Za-z0-9_.-]{1,200}$/.test(body.error) ? body.error.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/** The codes that say Atlassian refused the app's own credentials, not the grant: the deployment's to fix (JR3). */
const CLIENT_REFUSED = new Set(["invalid_client", "unauthorized_client"]);
/** Each code already logged, so a wrong or rotated secret says so once a process, not on every refresh. */
const clientWarned = new Set<string>();

function clientRefused(code: string): void {
  if (clientWarned.has(code)) return;
  clientWarned.add(code);
  console.error(`jira: Atlassian refused this deployment's client credentials (${code}): check JIRA_CLIENT_ID and JIRA_CLIENT_SECRET`);
}

export async function exchangeCode(settings: JiraSettings, input: { code: string; redirectUri: string }, deps: JiraHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await jiraFetch(JIRA_TOKEN, tokenRequest(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }), "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) {
    await discard(response);
    return { ok: false, reason: "unavailable" };
  }
  if (!response.ok) {
    const code = await oauthError(response);
    if (code && CLIENT_REFUSED.has(code)) clientRefused(code);
    console.error("jira: the code exchange was refused", response.status, code);
    return { ok: false, reason: "refused" };
  }
  let json: unknown;
  try {
    json = await jsonOf(response, "code exchange", JSON_BYTES);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  try {
    return { ok: true, tokens: mapTokens(json, now()), authEventId: null };
  } catch {
    // No refresh token: offline_access was not granted, and the connection would end within the hour (JR2).
    console.error("jira: the code exchange answered no refresh token");
    return { ok: false, reason: "refused" };
  }
}

/**
 * A refresh (JR3): new tokens, the refresh token rotated. `invalid_grant` is the one sign Atlassian gives that the grant
 * was removed or lapsed, and the connection needs a person; Atlassian refusing the app's own credentials is the
 * deployment's to fix, and never sends every customer to reconnect; anything else is tried again later.
 */
export async function refreshTokens(settings: JiraSettings, refreshToken: string, deps: JiraHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await jiraFetch(JIRA_TOKEN, tokenRequest(settings, { grant_type: "refresh_token", refresh_token: refreshToken }), "refresh", deps);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  if (response.ok) {
    try {
      const json = await jsonOf(response, "refresh", JSON_BYTES);
      const rotated = typeof json === "object" && json !== null && typeof (json as { refresh_token?: unknown }).refresh_token === "string" && (json as { refresh_token: string }).refresh_token !== "";
      if (!rotated) console.warn("jira: a refresh answered no new refresh token; the one sent is kept");
      return { ok: true, tokens: mapTokens(json, now(), refreshToken) };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
  if (response.status === 429 || response.status >= 500) {
    await discard(response);
    console.error("jira: a refresh failed", response.status);
    return { ok: false, reason: "unavailable", retryAfterMs };
  }
  const code = await oauthError(response);
  if (code === "invalid_grant" && (response.status === 400 || response.status === 401 || response.status === 403)) return { ok: false, reason: "reconnect" };
  if (code && CLIENT_REFUSED.has(code)) {
    clientRefused(code);
    return { ok: false, reason: "unavailable", retryAfterMs };
  }
  console.error("jira: a refresh was refused", response.status, code);
  return { ok: false, reason: "unavailable", retryAfterMs };
}

/**
 * Atlassian has no endpoint for an app to end its own grant (JR4): disconnecting deletes the tokens, and a person removes
 * the app under Connected apps in their Atlassian account. No request is made.
 */
export async function revokeToken(): Promise<false> {
  return false;
}

/** The Jira sites a token reaches now (`accessible-resources`), any number of them, none included. */
export async function accessibleSites(accessToken: string, deps: JiraHttp = {}): Promise<JiraSite[]> {
  const now = deps.now ?? Date.now;
  const response = await jiraFetch(JIRA_RESOURCES, { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, "sites", deps);
  if (!response.ok) {
    await discard(response);
    throw failureOf(response, "sites", now());
  }
  return mapSites(await jsonOf(response, "sites", JSON_BYTES));
}

/**
 * The Jira sites a fresh grant reaches, as the connector core's organisations (JR2): one is connected, several are
 * offered for a person to choose, and none is refused as `no_site`, keeping nothing.
 */
export async function grantSites(accessToken: string, deps: JiraHttp = {}): Promise<ExternalOrganisation[]> {
  const sites = await accessibleSites(accessToken, deps);
  if (sites.length === 0) throw new ConnectRefusal("no_site");
  return sites.map((site) => ({ externalOrgId: site.cloudId, name: site.name, connectionId: null }));
}

