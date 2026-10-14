/**
 * The platform's one Pipedrive app, a private app made in Pipedrive's Developer Hub
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4, P17). Off unless both variables are set: then the
 * Pipedrive card and every Pipedrive route are not there, as HubSpot's.
 */

export interface PipedriveSettings {
  clientId: string;
  clientSecret: string;
}

/** Pipedrive's client ids are hex strings; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

export function pipedriveSettingsFromEnv(env: Record<string, string | undefined> = process.env): PipedriveSettings | null {
  const clientId = env.PIPEDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.PIPEDRIVE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("Pipedrive is off: PIPEDRIVE_CLIENT_ID is not a Pipedrive client id");
    return null;
  }
  return { clientId, clientSecret };
}

/** Where Pipedrive sends a person back, exactly as the app's Callback URL in Developer Hub names it. */
export function pipedriveRedirectUri(origin: string): string {
  return `${origin}/api/integrations/pipedrive/callback`;
}

/** Where Pipedrive tells Vestiarion a deal changed (P7). */
export function pipedriveWebhookUrl(origin: string): string {
  return `${origin}/api/integrations/pipedrive/webhook`;
}

/**
 * The scopes the app is set up with in Developer Hub, all granted at once or none: Pipedrive asks for the app's own
 * scopes, never the authorize URL's (P4). `base` is always on.
 */
export const PIPEDRIVE_SCOPES = ["base", "deals:full", "contacts:read", "deal-fields:full", "users:read", "recents:read", "webhooks:full"] as const;

/** Reading deals with their organizations and persons needs one scope of each pair (P4). */
export const PIPEDRIVE_READ_SCOPES: ReadonlyArray<readonly string[]> = [
  ["deals:read", "deals:full"],
  ["contacts:read", "contacts:full"],
];

/** Writing receipts needs both (P11): the deal's values, and the Vestiarion fields made once. */
export const PIPEDRIVE_WRITE_SCOPES = ["deals:full", "deal-fields:full"] as const;

/** Whether a grant reads what the connector reads: one scope of each pair. */
export function readsDeals(scopes: readonly string[]): boolean {
  return PIPEDRIVE_READ_SCOPES.every((either) => either.some((scope) => scopes.includes(scope)));
}
