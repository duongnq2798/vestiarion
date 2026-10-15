import { API_BASE, SCOPE } from "./config.js";
import { challengeOf, newState, newVerifier } from "./pkce.js";

/**
 * Connecting to Vestiarion without an API key: authorization code with PKCE through chrome.identity.launchWebAuthFlow.
 * Vestiarion's consent page issues a one-time code to this extension's own address, and the code with the verifier
 * gets an access token (an hour) and a refresh token (30 days, replaced on each refresh; never past 90 days from
 * connecting), for invoice drafts only. The access token is kept in memory only (chrome.storage.session, gone when
 * Chrome closes); the refresh token and the workspace's name in chrome.storage.local, which the service worker keeps
 * from content scripts where Chrome allows it (the extension has none). Disconnect revokes them.
 */

const TOKEN_URL = `${API_BASE}/api/extension/v1/token`;
const REVOKE_URL = `${API_BASE}/api/extension/v1/revoke`;
/** An access token is refreshed a minute before it would end. */
const EARLY_MS = 60000;

export class AuthError extends Error {
  /** `refused` when Vestiarion said the code or token is no longer good, rather than not answering. */
  constructor(message, refused = false) {
    super(message);
    this.refused = refused;
  }
}

async function tokenRequest(params) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new AuthError("Vestiarion could not be reached. Check your connection and try again.");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    // A code or token no longer good, or this extension no longer allowed: it ends here. Anything else may pass.
    const refused = body?.error === "invalid_grant" || body?.error === "invalid_client";
    throw new AuthError(body?.error_description ?? "Vestiarion did not answer. Try again in a moment.", refused);
  }
  return body;
}

/** True in the service worker, where every refresh runs, one at a time. */
const inWorker = typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope;

/** The refresh token and the workspace to disk; the access token to memory only. */
async function saveTokens(tokens) {
  await chrome.storage.local.set({ auth: { refreshToken: tokens.refresh_token, workspace: tokens.workspace ?? null } });
  await chrome.storage.session.set({ access: { accessToken: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 - EARLY_MS } });
  return getAuth();
}

/** The connection as kept: the refresh token and the workspace, with the access token while memory holds one. */
export async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  if (!auth) return null;
  const { access } = await chrome.storage.session.get("access");
  return { ...auth, accessToken: access?.accessToken ?? null, expiresAt: access?.expiresAt ?? 0 };
}

/** Connect Vestiarion: the consent page in Chrome's sign-in window, then the code exchanged for tokens. */
export async function connect() {
  const verifier = newVerifier();
  const state = newState();
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL(`${API_BASE}/extension/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: chrome.runtime.id,
    redirect_uri: redirectUri,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
    state,
    scope: SCOPE,
  }).toString();

  let returned;
  try {
    returned = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch {
    throw new AuthError("Connecting was cancelled.");
  }
  const back = new URL(returned);
  if (back.searchParams.get("state") !== state) throw new AuthError("The answer did not match this request. Connect again.");
  const error = back.searchParams.get("error");
  if (error) throw new AuthError(error === "access_denied" ? "Connecting was cancelled." : (back.searchParams.get("error_description") ?? "Vestiarion refused to connect."));
  const code = back.searchParams.get("code");
  if (!code) throw new AuthError("Vestiarion did not send a code. Connect again.");
  const tokens = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: chrome.runtime.id });
  return saveTokens(tokens);
}

let refreshing = null;

/**
 * The refresh itself, in the service worker, one at a time: a popup that closes mid-refresh loses nothing, and two
 * views never present the same refresh token twice, which Vestiarion takes as the token used again and answers by ending
 * the connection. Only the pair it tried is forgotten when Vestiarion refuses it, never one stored since.
 */
export function refreshInWorker() {
  refreshing ??= (async () => {
    const auth = await getAuth();
    if (!auth?.refreshToken) return false;
    try {
      await saveTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refreshToken, client_id: chrome.runtime.id }));
      return true;
    } catch (error) {
      const now = await getAuth();
      if (now && now.refreshToken !== auth.refreshToken) return true;
      if (error instanceof AuthError && error.refused) await forget();
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** A new pair for the refresh token, from the service worker; false when it no longer works, or did not answer. */
export async function refresh() {
  if (inWorker) return refreshInWorker();
  const answer = await chrome.runtime.sendMessage({ type: "refresh" }).catch(() => null);
  return answer?.ok === true;
}

/** The tokens, refreshed first when the access token is missing or about to end; null when not connected. */
export async function validAuth() {
  const auth = await getAuth();
  if (!auth) return null;
  if (auth.accessToken && Date.now() < auth.expiresAt) return auth;
  return (await refresh()) ? getAuth() : null;
}

/** Forgets the tokens and the draft in progress, without asking Vestiarion. */
export async function forget() {
  await chrome.storage.local.remove(["auth", "currentDraftId"]);
  await chrome.storage.session.remove("access");
}

/** Disconnect: Vestiarion revokes the connection, then the extension forgets it. */
export async function disconnect() {
  const auth = await getAuth();
  if (auth?.refreshToken) {
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: auth.refreshToken, token_type_hint: "refresh_token", client_id: chrome.runtime.id }).toString(),
      });
    } catch {
      // Forgotten here either way; Settings in Vestiarion lists the connection until it is revoked there.
    }
  }
  await forget();
}
