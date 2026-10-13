import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { NotSetUpError } from "../connectors/connections";
import { setReceiptWrites } from "../connectors/crm-receipts-actions";
import { hasScopes } from "../connectors/posting";
import { crmReady } from "../connectors/crm-review";
import { crmSyncInScope } from "../connectors/crm-store";
import { hubspotProvider } from "./provider";
import { HUBSPOT_WRITE_SCOPES, type HubSpotSettings } from "./settings";

/**
 * HubSpot's connect flow as the routes run it (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4, H7):
 * the deployment's own origin, a check that migration 0105 has run before anyone goes to HubSpot, and the first sync
 * once the answer is sent, with a smaller page budget than the sweeper's. Writing receipts allowed on the connect page
 * is turned on once HubSpot granted both write scopes (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R3);
 * HubSpot drops an optional scope it will not grant, and the connection then reads only.
 */
export function hubspotConnectDeps(settings: HubSpotSettings): ConnectDeps {
  const provider = hubspotProvider(settings);
  return {
    provider,
    origin: siteOrigin(),
    ready: crmReady,
    afterConnect: (work) => after(work),
    firstSync: (connection) => crmSyncInScope(connection.id, provider, { maxPages: 10 }),
    allowWrites: async ({ connection, userId, scopes }) => {
      if (!hasScopes(scopes, HUBSPOT_WRITE_SCOPES)) return "write_not_granted";
      try {
        await setReceiptWrites({ connection: { ...connection, scopes: [...scopes] }, on: true, by: userId });
        return "writing";
      } catch (error) {
        if (error instanceof NotSetUpError) return "write_not_set_up";
        throw error;
      }
    },
  };
}
