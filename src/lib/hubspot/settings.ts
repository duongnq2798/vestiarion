/**
 * The platform's one HubSpot app, on HubSpot's developer platform with OAuth and marketplace distribution
 * (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4, H17, H21; its config is
 * `integrations/hubspot/`). Off unless both variables are set: then the HubSpot card and every HubSpot route are not
 * there, as Xero's.
 */

export interface HubSpotSettings {
  clientId: string;
  clientSecret: string;
}

/** HubSpot's client ids are UUIDs; allow some room. */
const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;

export function hubspotSettingsFromEnv(env: Record<string, string | undefined> = process.env): HubSpotSettings | null {
  const clientId = env.HUBSPOT_CLIENT_ID?.trim();
  const clientSecret = env.HUBSPOT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  // Never the values themselves: only that they were not used.
  if (!CLIENT_ID.test(clientId)) {
    console.warn("HubSpot is off: HUBSPOT_CLIENT_ID is not a HubSpot client id");
    return null;
  }
  return { clientId, clientSecret };
}

/** Where HubSpot sends a person back: the deployment's own callback, as registered in the app's config. */
export function hubspotRedirectUri(origin: string): string {
  return `${origin}/api/integrations/hubspot/callback`;
}

/**
 * The app's required scopes, exactly as `integrations/hubspot/src/app/app-hsmeta.json` lists them: HubSpot refuses an
 * authorize URL whose scopes differ. Read-only: the optional `crm.objects.deals.write` is not asked for, since nothing
 * is written to HubSpot in this version. Pipelines are read with `crm.objects.deals.read`.
 */
export const HUBSPOT_SCOPES = ["oauth", "crm.objects.companies.read", "crm.objects.contacts.read", "crm.objects.deals.read"] as const;
