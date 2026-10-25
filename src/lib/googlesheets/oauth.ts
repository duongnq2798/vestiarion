import { parseRetryAfter } from "../connectors/backoff";
import { ConnectRefusal } from "../connectors/connect-refusal";
import type { ExchangeOutcome, ExternalOrganisation, ProviderTokens, RefreshOutcome } from "../connectors/provider";
import { maskEmail } from "../payment-notices";
import { DRIVE_API, GOOGLE_AUTHORIZE, GOOGLE_REVOKE, GOOGLE_TOKEN, GoogleError, apiInit, googleCall, googleFetch, jsonOf, oauthForm, type GoogleHttp } from "./http";
import { GOOGLE_SHEETS_SCOPES, type GoogleSheetsSettings } from "./settings";
import { NO_ACCOUNT_NAME } from "./views";

/**
 * Google's OAuth 2.0 authorization code flow for Google Sheets
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS3, GS6, GS13, GS14): the authorize URL with
 * the one Drive scope, the code exchange and the refresh at Google's token endpoint with the client's credentials in the
 * body, the Google account a token acts as, and revocation. Google's refresh answer carries no new refresh token, so the
 * one sent is kept.
 */

const DRIVE_FILE = GOOGLE_SHEETS_SCOPES[0];

/**
 * The authorize URL (GS3): offline, so a refresh token comes back; `prompt=consent`, so one comes back on every connect;
 * and `include_granted_scopes=false`, so a sign-in grant is never folded in.
 */
export function authorizeUrl(settings: GoogleSheetsSettings, input: { state: string; redirectUri: string }): string {
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", GOOGLE_SHEETS_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  return url.toString();
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** A token answer: the access token, the refresh token (the one sent when Google sends none), its life and the scopes granted. */
function mapTokens(body: unknown, nowMs: number, sentRefreshToken?: string): ProviderTokens {
  const json = isObject(body) ? body : {};
  const accessToken = text(json.access_token);
  const refreshToken = text(json.refresh_token) ?? sentRefreshToken ?? null;
  if (!accessToken) throw new GoogleError("bad_response", "Google's token answer had no access_token");
  if (!refreshToken) throw new GoogleError("bad_response", "Google's token answer had no refresh_token");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  const scopes = typeof json.scope === "string" ? [...new Set(json.scope.split(/\s+/).filter(Boolean))] : [];
  return { accessToken, refreshToken, expiresAt: nowMs + expiresIn * 1000, scopes };
}

/** The error code a token endpoint's 400 or 401 carries (`invalid_grant`), or null. */
async function oauthError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(settings: GoogleSheetsSettings, input: { code: string; redirectUri: string }, deps: GoogleHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await googleFetch(
      GOOGLE_TOKEN,
      oauthForm({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: settings.clientId, client_secret: settings.clientSecret }),
      "code exchange",
      deps
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("google sheets: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  let body: unknown;
  try {
    body = await jsonOf(response, "code exchange");
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  try {
    // Without a refresh token the connection would stop within the hour: nothing is kept.
    return { ok: true, tokens: mapTokens(body, now()), authEventId: null };
  } catch {
    console.error("google sheets: the code exchange answered no refresh token");
    return { ok: false, reason: "refused" };
  }
}

/**
 * A refresh (GS13): a new access token, and the refresh token sent, kept. `invalid_grant`, `unauthorized_client` or
 * `invalid_client` mean the access was removed, the grant went unused for six months or the client changed: the
 * connection needs a person. Anything else is tried again at the next export.
 */
export async function refreshTokens(settings: GoogleSheetsSettings, refreshToken: string, deps: GoogleHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await googleFetch(
      GOOGLE_TOKEN,
      oauthForm({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: settings.clientId, client_secret: settings.clientSecret }),
      "refresh",
      deps
    );
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
  console.error("google sheets: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/**
 * Revokes the grant (GS14): Google ends every scope this Google account gave the app, for every workspace connected with
 * it, so the disconnect action calls this only when no other workspace is. True when Google confirmed it.
 */
export async function revokeToken(refreshToken: string, deps: GoogleHttp = {}): Promise<boolean> {
  try {
    const response = await googleFetch(GOOGLE_REVOKE, oauthForm({ token: refreshToken }), "revocation", deps);
    if (!response.ok) console.error("google sheets: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/** A Drive permission id: letters, digits, `_` and `-`, so it can be kept and compared as it is (GS6). */
const PERMISSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * The one Google account a fresh grant reaches (GS3, GS6): a grant without drive.file is refused before any call, and
 * nothing is kept. Then Drive's `about`, which drive.file allows, names the account: its permission id is the
 * connection's external id, and its email, masked, the name, since the name goes into the signed ledger and to webhook
 * endpoints. The full address is never kept.
 */
export async function googleAccount(tokens: ProviderTokens, deps: GoogleHttp = {}): Promise<ExternalOrganisation[]> {
  if (!tokens.scopes.includes(DRIVE_FILE)) throw new ConnectRefusal("scopes");
  const url = new URL(`${DRIVE_API}/about`);
  url.searchParams.set("fields", "user(displayName,emailAddress,permissionId)");
  const response = await googleCall({ url: url.toString(), init: apiInit(tokens.accessToken, "GET"), label: "about.get", repeatable: true }, deps);
  const body = await jsonOf(response, "about.get");
  const user = isObject(body) && isObject(body.user) ? body.user : {};
  const permissionId = typeof user.permissionId === "string" ? user.permissionId : "";
  if (!PERMISSION_ID.test(permissionId)) throw new GoogleError("bad_response", "Google about.get: no permission id that reads");
  const email = typeof user.emailAddress === "string" ? user.emailAddress.trim() : "";
  const name = EMAIL.test(email) ? maskEmail(email).slice(0, 200) : NO_ACCOUNT_NAME;
  return [{ externalOrgId: permissionId, name, connectionId: null }];
}
