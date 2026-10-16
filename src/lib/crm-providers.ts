import type { CrmProvider } from "./connectors/crm";
import type { ProviderId } from "./connectors/provider";
import { hubspotProvider } from "./hubspot/provider";
import { hubspotSettingsFromEnv } from "./hubspot/settings";
import { pipedriveProvider } from "./pipedrive/provider";
import { pipedriveSettingsFromEnv } from "./pipedrive/settings";
import { zohoCrmProvider } from "./zohocrm/provider";
import { zohoCrmSettingsFromEnv } from "./zohocrm/settings";

/**
 * The CRMs this deployment has set up (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H1, H17;
 * docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P1, P17;
 * docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C1, C2): the one place the core is wired to a CRM's
 * folder, as `accounting-providers.ts` is for accounting tools. HubSpot is on with `HUBSPOT_CLIENT_ID` and
 * `HUBSPOT_CLIENT_SECRET`, Pipedrive with `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET`, Zoho CRM with the Zoho
 * client (`ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`, or `ZOHO_CRM_*`). Each call makes a new provider: make
 * one per run.
 */
export function crmProvider(id: ProviderId): CrmProvider | null {
  if (id === "hubspot") {
    const settings = hubspotSettingsFromEnv();
    return settings ? hubspotProvider(settings) : null;
  }
  if (id === "pipedrive") {
    const settings = pipedriveSettingsFromEnv();
    return settings ? pipedriveProvider(settings) : null;
  }
  if (id === "zohocrm") {
    const settings = zohoCrmSettingsFromEnv();
    return settings ? zohoCrmProvider(settings) : null;
  }
  return null;
}
