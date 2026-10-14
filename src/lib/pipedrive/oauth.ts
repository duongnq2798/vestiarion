import { parseRetryAfter } from "../connectors/backoff";
import { ConnectRefusal } from "../connectors/connect-refusal";
import { ProviderError, type ExchangeOutcome, type ExternalOrganisation, type ProviderTokens, type RefreshOutcome } from "../connectors/provider";
import { openCredential } from "./credential";
import { apiJson, jsonOf, oauthForm, PIPEDRIVE_AUTHORIZE, PIPEDRIVE_REVOKE, PIPEDRIVE_TOKEN, pipedriveFetch, type PipedriveHttp } from "./http";
import { mapMe, mapTokens, type PipedriveMe } from "./map";
import { readsDeals, type PipedriveSettings } from "./settings";

/**
 * Pipedrive's OAuth 2.0 authorization code flow (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4,
 * P5, P15): the authorize URL, the code exchange and the refresh with the client's credentials as Basic auth, the company
 * a token reaches, and revocation, which uninstalls the app from the company. Every token comes back sealed with the
 * company's `api_domain` (`./credential.ts`).
 */

/** Pipedrive asks for the app's own scopes, set in Developer Hub: the URL names none (P4). */
export function authorizeUrl(settings: PipedriveSettings, input: { state: string; redirectUri: string }): string {
  const url = new URL(PIPEDRIVE_AUTHORIZE);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** The error code a token endpoint's 400 carries (`invalid_grant`), or null. */
async function oauthError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error.slice(0, 40) : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(settings: PipedriveSettings, input: { code: string; redirectUri: string }, deps: PipedriveHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await pipedriveFetch(PIPEDRIVE_TOKEN, oauthForm(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }), "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("pipedrive: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  try {
    return { ok: true, tokens: mapTokens(await jsonOf(response, "code exchange"), now()), authEventId: null };
  } catch (error) {
    // An answer without tokens, or naming a domain that is not Pipedrive's: nothing is kept.
    console.error("pipedrive: the code exchange answered what does not read", error instanceof Error ? error.message : "unknown error");
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A refresh (P5): a new access token, and the refresh token and domain Pipedrive answers with, else the ones sent; the
 * core stores them under its lease. `invalid_grant`, or a 400 or 401 for the refresh token, means the app was uninstalled
 * or the token lapsed: the connection needs a person. Anything else is tried again later.
 */
export async function refreshTokens(settings: PipedriveSettings, refreshCredential: string, deps: PipedriveHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  const opened = openCredential(refreshCredential);
  if (!opened) return { ok: false, reason: "reconnect" };
  let response: Response;
  try {
    response = await pipedriveFetch(PIPEDRIVE_TOKEN, oauthForm(settings, { grant_type: "refresh_token", refresh_token: opened.token }), "refresh", deps);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  if (response.ok) {
    try {
      return { ok: true, tokens: mapTokens(await jsonOf(response, "refresh"), now(), { refreshCredential }) };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  if (response.status === 400 || response.status === 401) {
    const code = await oauthError(response);
    console.error("pipedrive: a refresh was refused", response.status, code);
    return { ok: false, reason: "reconnect" };
  }
  console.error("pipedrive: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes a refresh token, which uninstalls the app from the company (P15). True when Pipedrive confirmed it. */
export async function revokeToken(settings: PipedriveSettings, refreshCredential: string, deps: PipedriveHttp = {}): Promise<boolean> {
  const opened = openCredential(refreshCredential);
  if (!opened) return false;
  try {
    const response = await pipedriveFetch(PIPEDRIVE_REVOKE, oauthForm(settings, { token: opened.token, token_type_hint: "refresh_token" }), "revocation", deps);
    if (!response.ok) console.error("pipedrive: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/** The user a token acts as, and their company. */
export async function readMe(credential: string, deps: PipedriveHttp = {}): Promise<PipedriveMe> {
  return mapMe(await apiJson(credential, "/api/v1/users/me", {}, "users/me", deps));
}

/**
 * The one company a fresh grant reaches (P4): `users/me`'s company, named by its name. A grant without the scopes that
 * read deals and their organizations is refused before anything is kept, in words (`scopes`), and its tokens revoked:
 * Pipedrive installed an app that cannot do its work.
 */
export async function listCompany(settings: PipedriveSettings, tokens: ProviderTokens, deps: PipedriveHttp = {}): Promise<ExternalOrganisation[]> {
  if (!readsDeals(tokens.scopes)) {
    await revokeToken(settings, tokens.refreshToken, deps);
    throw new ConnectRefusal("scopes");
  }
  const me = await readMe(tokens.accessToken, deps);
  return [{ externalOrgId: me.companyId, name: me.companyName ?? me.companyDomain ?? `Pipedrive company ${me.companyId}`, connectionId: null }];
}

/** Whether a call failed because Pipedrive no longer takes the token. */
export const refusedToken = (error: unknown) => error instanceof ProviderError && (error.failure === "unauthorized" || error.failure === "forbidden");
