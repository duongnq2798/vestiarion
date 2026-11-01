/**
 * The deployment's Google OAuth client for Google Drive (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md
 * GD1, GD2). Off unless both variables are set and the id is a Google OAuth client id, checked as Google Sheets checks
 * its own: then the Google Drive card, the review list's Check Google Drive now and both routes are not there, as for
 * every connector without its client. The partner may set them to the same client as Google Sheets'.
 */

export interface GoogleDriveSettings {
  clientId: string;
  clientSecret: string;
}

/** A Google OAuth client id: the project number, a dash, lowercase letters and digits, then Google's domain. */
const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export function googleDriveSettingsFromEnv(env: Record<string, string | undefined> = process.env): GoogleDriveSettings | null {
  const clientId = env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Google Drive is off: GOOGLE_DRIVE_CLIENT_ID is not a Google OAuth client id");
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * The one scope (GD2): Drive read-only. `drive.file`, Google Sheets' scope, reaches only the files the app made or the
 * person opened with it, and a file someone later drops into a folder is neither. `drive.readonly` is a restricted scope:
 * until Google verifies it, Google shows its unverified-app screen to whoever grants it. No identity scope: the account
 * is read from Drive's `about`.
 */
export const GOOGLE_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"] as const;
