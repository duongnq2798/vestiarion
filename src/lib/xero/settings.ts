/**
 * The platform's one Xero app, a "Web app" (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X6, X16).
 * Off unless both variables are set: then the Xero card and every Xero route are not there, as Slack's.
 */

export interface XeroSettings {
  clientId: string;
  clientSecret: string;
}

/** Xero's client ids are 32 hexadecimal characters; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9]{16,64}$/;

export function xeroSettingsFromEnv(env: Record<string, string | undefined> = process.env): XeroSettings | null {
  const clientId = env.XERO_CLIENT_ID?.trim();
  const clientSecret = env.XERO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Xero is off: XERO_CLIENT_ID is not a Xero client id");
    return null;
  }
  return { clientId, clientSecret };
}

/** Where Xero sends a person back: the deployment's own callback, as registered for the app. */
export function xeroRedirectUri(origin: string): string {
  return `${origin}/api/integrations/xero/callback`;
}

/**
 * Granular scopes: an app created after 2 March 2026 has no broad accounting scopes. Read: bills
 * (`accounting.invoices.read`), suppliers (`accounting.contacts.read`) and the chart of accounts and the organisation
 * (`accounting.settings.read`), with `offline_access` for a refresh token. Nothing about the Xero user.
 */
export const XERO_READ_SCOPES = ["offline_access", "accounting.invoices.read", "accounting.contacts.read", "accounting.settings.read"] as const;

/**
 * Write: booking the payments a person approved against their bills (`accounting.payments`,
 * docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W8). A connection made before it was asked for
 * reconnects to grant it.
 */
export const XERO_WRITE_SCOPES = ["accounting.payments"] as const;

/** What a connection asks Xero for. */
export const XERO_SCOPES = [...XERO_READ_SCOPES, ...XERO_WRITE_SCOPES] as const;
