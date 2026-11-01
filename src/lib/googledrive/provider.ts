import type { ConnectingProvider } from "../connectors/provider";
import type { GoogleHttp } from "../googlesheets/http";
import { authorizeUrl, exchangeCode, googleAccount, refreshTokens, revokeToken } from "../googlesheets/oauth";
import { GOOGLE_DRIVE_SCOPES, googleDriveSettingsFromEnv, type GoogleDriveSettings } from "./settings";

/**
 * Google Drive as the connector core sees it (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD1, GD2):
 * connecting, its tokens and disconnecting, through the core's `ConnectingProvider`, on Google's OAuth calls that Google
 * Sheets makes too (`../googlesheets/oauth`), with Drive's own client and its one read-only scope. One Google account
 * per grant, its Drive permission id the connection's external id, as Sheets'. Not exclusive: the same Google account
 * may be connected to several workspaces, each with its own folder. The reads of the folder go through `http`.
 */
export interface GoogleDriveProvider extends ConnectingProvider {
  /** How the folder's reads reach Google: the same fetch, clock and log name as the connection's own calls. */
  http: GoogleHttp;
}

export function googleDriveProvider(settings: GoogleDriveSettings, deps: GoogleHttp = {}): GoogleDriveProvider {
  const http: GoogleHttp = { ...deps, logAs: "google drive" };
  return {
    id: "googledrive",
    label: "Google Drive",
    scopes: GOOGLE_DRIVE_SCOPES,
    authorizeUrl: (input) => authorizeUrl(settings, input, GOOGLE_DRIVE_SCOPES),
    exchangeCode: (input) => exchangeCode(settings, input, http),
    organisations: (tokens) => googleAccount(tokens, http, GOOGLE_DRIVE_SCOPES[0]),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, http),
    revoke: (refreshToken) => revokeToken(refreshToken, http),
    http,
  };
}

/** Google Drive on this deployment, or null when `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` are not set. */
export function googleDriveProviderFromEnv(): GoogleDriveProvider | null {
  const settings = googleDriveSettingsFromEnv();
  return settings ? googleDriveProvider(settings) : null;
}
