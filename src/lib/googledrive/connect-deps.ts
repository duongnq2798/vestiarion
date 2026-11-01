import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import type { GoogleHttp } from "../googlesheets/http";
import { googleDriveProvider } from "./provider";
import { googleDriveReady } from "./ready";
import type { GoogleDriveSettings } from "./settings";

/**
 * Google Drive's connect flow as the routes run it (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD2,
 * GD3): the deployment's own origin, whose callback is registered on the Google OAuth client as
 * https://www.vestiarion.xyz/api/integrations/googledrive/callback, and a check that migration 0148 has run before anyone
 * goes to Google. Nothing is read at once: the folder is read once a person chooses it.
 */
export function googleDriveConnectDeps(settings: GoogleDriveSettings, http: GoogleHttp = {}): ConnectDeps {
  return {
    provider: googleDriveProvider(settings, http),
    origin: siteOrigin(),
    ready: googleDriveReady,
  };
}
