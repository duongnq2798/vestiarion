import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { crmSyncInScope } from "../connectors/crm-store";
import { zohoCrmProvider } from "./provider";
import type { ZohoCrmSettings } from "./settings";
import { zohoCrmReady } from "./store";

/**
 * Zoho CRM's connect flow as the routes run it (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4,
 * C17): migration 0123 first, the deployment's own origin, and the first sync once the answer is sent, with a smaller
 * page budget than the sweeper's.
 */
export function zohoCrmConnectDeps(settings: ZohoCrmSettings): ConnectDeps {
  const provider = zohoCrmProvider(settings);
  return {
    provider,
    ready: zohoCrmReady,
    origin: siteOrigin(),
    afterConnect: (work) => after(work),
    firstSync: (connection) => crmSyncInScope(connection.id, provider, { maxPages: 10 }),
  };
}
