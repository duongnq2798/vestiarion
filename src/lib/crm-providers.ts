import type { CrmProvider } from "./connectors/crm";
import type { ProviderId } from "./connectors/provider";
import { hubspotProvider } from "./hubspot/provider";
import { hubspotSettingsFromEnv } from "./hubspot/settings";

/**
 * The CRMs this deployment has set up (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H1, H17): the one
 * place the core is wired to a CRM's folder, as `accounting-providers.ts` is for accounting tools. HubSpot is on with
 * `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET`. Each call makes a new provider: make one per run.
 */
export function crmProvider(id: ProviderId): CrmProvider | null {
  if (id === "hubspot") {
    const settings = hubspotSettingsFromEnv();
    return settings ? hubspotProvider(settings) : null;
  }
  return null;
}
