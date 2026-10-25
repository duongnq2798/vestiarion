/**
 * The deployment's one Google OAuth client for Google Sheets
 * (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS2, GS3). Off unless both variables are set and
 * the id is a Google OAuth client id: then the Google Sheets card, the close pack page's export control and both routes
 * are not there, as for every connector without its client.
 */

export interface GoogleSheetsSettings {
  clientId: string;
  clientSecret: string;
}

/** A Google OAuth client id: the project number, a dash, lowercase letters and digits, then Google's domain. */
const CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export function googleSheetsSettingsFromEnv(env: Record<string, string | undefined> = process.env): GoogleSheetsSettings | null {
  const clientId = env.GOOGLE_SHEETS_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_SHEETS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Google Sheets is off: GOOGLE_SHEETS_CLIENT_ID is not a Google OAuth client id");
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * The one scope (GS3): Google's non-sensitive, recommended Drive scope, which reaches only the files this app makes and
 * needs no data-access verification. Neither `spreadsheets` (every sheet the person has) nor `drive`, and no identity
 * scope: the account is read from Drive's `about`.
 */
export const GOOGLE_SHEETS_SCOPES = ["https://www.googleapis.com/auth/drive.file"] as const;
