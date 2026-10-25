import type { ConnectingProvider } from "../connectors/provider";
import type { GoogleHttp } from "./http";
import { authorizeUrl, exchangeCode, googleAccount, refreshTokens, revokeToken } from "./oauth";
import { GOOGLE_SHEETS_SCOPES, googleSheetsSettingsFromEnv, type GoogleSheetsSettings } from "./settings";

/**
 * Google Sheets as the connector core sees it (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS1,
 * GS3, GS4, GS6): connecting, its tokens and disconnecting, through the core's `ConnectingProvider`. One Google account
 * per grant, its Drive permission id the connection's external id. Not exclusive: the same Google account may be
 * connected to several workspaces, each with its own spreadsheets.
 */
export function googleSheetsProvider(settings: GoogleSheetsSettings, deps: GoogleHttp = {}): ConnectingProvider {
  return {
    id: "googlesheets",
    label: "Google Sheets",
    scopes: GOOGLE_SHEETS_SCOPES,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens) => googleAccount(tokens, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(refreshToken, deps),
  };
}

/** Google Sheets on this deployment, or null when `GOOGLE_SHEETS_CLIENT_ID` and `GOOGLE_SHEETS_CLIENT_SECRET` are not set. */
export function googleSheetsProviderFromEnv(): ConnectingProvider | null {
  const settings = googleSheetsSettingsFromEnv();
  return settings ? googleSheetsProvider(settings) : null;
}
