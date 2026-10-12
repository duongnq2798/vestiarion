import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { crmReady } from "../connectors/crm-review";
import { crmSyncInScope } from "../connectors/crm-store";
import { hubspotProvider } from "./provider";
import type { HubSpotSettings } from "./settings";

/**
 * HubSpot's connect flow as the routes run it (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4, H7):
 * the deployment's own origin, a check that migration 0105 has run before anyone goes to HubSpot, and the first sync
 * once the answer is sent, with a smaller page budget than the sweeper's.
 */
export function hubspotConnectDeps(settings: HubSpotSettings): ConnectDeps {
  const provider = hubspotProvider(settings);
  return {
    provider,
    origin: siteOrigin(),
    ready: crmReady,
    afterConnect: (work) => after(work),
    firstSync: (connection) => crmSyncInScope(connection.id, provider, { maxPages: 10 }),
  };
}
