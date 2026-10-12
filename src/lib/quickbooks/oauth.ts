import { parseRetryAfter } from "../connectors/backoff";
import { ProviderError, type ExchangeOutcome, type ExternalOrganisation, type ProviderTokens, type RefreshOutcome } from "../connectors/provider";
import { companyInfo } from "./api";
import { basicAuth, quickBooksFetch, INTUIT_AUTHORIZE, INTUIT_REVOKE, INTUIT_TOKEN, type QuickBooksHttp } from "./http";
import { mapTokens } from "./map";
import { QUICKBOOKS_SCOPES, type QuickBooksSettings } from "./settings";

/**
 * Intuit's OAuth 2.0 authorization code flow (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q3, Q4,
 * Q14): the authorize URL, the code exchange and the refresh at the token endpoint with HTTP Basic client
 * authentication, revocation, and the one company a grant is for, which the callback names.
 */

export function authorizeUrl(settings: QuickBooksSettings, input: { state: string; redirectUri: string }): string {
  const url = new URL(INTUIT_AUTHORIZE);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", QUICKBOOKS_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function tokenRequest(settings: QuickBooksSettings, body: Record<string, string>, label: string, deps: QuickBooksHttp): Promise<Response> {
  return quickBooksFetch(
    INTUIT_TOKEN,
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

/** The code, exchanged once: Intuit refuses a second exchange of the same code. */
export async function exchangeCode(settings: QuickBooksSettings, input: { code: string; redirectUri: string }, deps: QuickBooksHttp = {}): Promise<ExchangeOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await tokenRequest(settings, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, "code exchange", deps);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (response.status >= 500 || response.status === 429) return { ok: false, reason: "unavailable" };
  if (!response.ok) {
    console.error("quickbooks: the code exchange was refused", response.status, await oauthError(response));
    return { ok: false, reason: "refused" };
  }
  try {
    const body = await response.json();
    return { ok: true, tokens: mapTokens(body, now(), QUICKBOOKS_SCOPES), authEventId: null };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A refresh. Intuit changes the refresh token about once a day and the old one stops working at once, so the core
 * stores whatever comes back, under its lease (Q3). `invalid_grant` means the refresh token is spent, revoked or
 * expired, and the connection needs a person; anything else may pass, and is tried again later.
 */
export async function refreshTokens(settings: QuickBooksSettings, refreshToken: string, deps: QuickBooksHttp = {}): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await tokenRequest(settings, { grant_type: "refresh_token", refresh_token: refreshToken }, "refresh", deps);
  } catch {
    return { ok: false, reason: "unavailable", retryAfterMs: null };
  }
  if (response.ok) {
    try {
      return { ok: true, tokens: mapTokens(await response.json(), now(), QUICKBOOKS_SCOPES) };
    } catch {
      return { ok: false, reason: "unavailable", retryAfterMs: null };
    }
  }
  if (response.status === 400 && (await oauthError(response)) === "invalid_grant") return { ok: false, reason: "reconnect" };
  console.error("quickbooks: a refresh failed", response.status);
  return { ok: false, reason: "unavailable", retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()) };
}

/** Revokes a refresh token, which disconnects the app from the company. True when Intuit confirmed it. */
export async function revokeToken(settings: QuickBooksSettings, refreshToken: string, deps: QuickBooksHttp = {}): Promise<boolean> {
  try {
    const response = await quickBooksFetch(
      INTUIT_REVOKE,
      {
        method: "POST",
        headers: { authorization: basicAuth(settings), "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: refreshToken }),
      },
      "revocation",
      deps
    );
    if (!response.ok) console.error("quickbooks: revocation was refused", response.status);
    return response.ok;
  } catch {
    return false;
  }
}

/** A realm id is digits: anything else in the callback was not Intuit's. */
const REALM = /^\d{1,32}$/;

/**
 * The one company a grant is for (Q4): the one the callback named, confirmed by reading its `CompanyInfo` with the new
 * access token, so a realm id edited in the URL reads nothing and connects nothing.
 */
export async function grantedCompany(
  settings: QuickBooksSettings,
  tokens: ProviderTokens,
  named: string | undefined,
  deps: QuickBooksHttp = {}
): Promise<ExternalOrganisation[]> {
  if (!named || !REALM.test(named)) throw new ProviderError("bad_response", "QuickBooks' callback named no company");
  return [await companyInfo(settings, { accessToken: tokens.accessToken, externalOrgId: named }, deps)];
}
