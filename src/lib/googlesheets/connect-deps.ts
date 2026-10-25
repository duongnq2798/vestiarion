import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import type { GoogleHttp } from "./http";
import { googleSheetsProvider } from "./provider";
import { googleSheetsReady } from "./ready";
import type { GoogleSheetsSettings } from "./settings";

/**
 * Google Sheets' connect flow as the routes run it (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS1, GS2): the deployment's own origin, whose callback is registered on the Google OAuth client as
 * https://www.vestiarion.xyz/api/integrations/googlesheets/callback, and a check that migration 0145 has run before
 * anyone goes to Google. Nothing is read at once and nothing syncs: a month is written when a person exports it.
 */
export function googleSheetsConnectDeps(settings: GoogleSheetsSettings, http: GoogleHttp = {}): ConnectDeps {
  return {
    provider: googleSheetsProvider(settings, http),
    origin: siteOrigin(),
    ready: googleSheetsReady,
  };
}
