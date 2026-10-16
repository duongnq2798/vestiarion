/**
 * The platform's one Zoho Books app (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z2). Off unless
 * its client id and secret are both set: then the Zoho Books card, its pages and every Zoho Books route are not there,
 * as Xero's and QuickBooks'.
 */

export interface ZohoBooksSettings {
  clientId: string;
  clientSecret: string;
}

/** Zoho's client ids are `1000.` and about 30 capital letters and digits; allow some room. */
const CLIENT_ID = /^1000\.[A-Z0-9]{20,60}$/;

export function zohoBooksSettingsFromEnv(env: Record<string, string | undefined> = process.env): ZohoBooksSettings | null {
  const clientId = env.ZOHO_BOOKS_CLIENT_ID?.trim();
  const clientSecret = env.ZOHO_BOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Zoho Books is off: ZOHO_BOOKS_CLIENT_ID is not a Zoho client id");
    return null;
  }
  return { clientId, clientSecret };
}

/** Where Zoho sends a person back: the deployment's own callback, as registered for the app. */
export function zohoBooksRedirectUri(origin: string): string {
  return `${origin}/api/integrations/zohobooks/callback`;
}

/** Read only (Z1): bills, vendors, and the organizations the token reaches. */
export const ZOHO_BOOKS_SCOPES = ["ZohoBooks.bills.READ", "ZohoBooks.contacts.READ", "ZohoBooks.settings.READ"] as const;
