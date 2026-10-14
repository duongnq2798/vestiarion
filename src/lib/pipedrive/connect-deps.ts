import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { crmSyncInScope } from "../connectors/crm-store";
import { pipedriveProvider } from "./provider";
import type { PipedriveSettings } from "./settings";
import { ensureWebhookInScope, pipedriveReady } from "./store";

/**
 * Pipedrive's connect flow as the routes run it (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4,
 * P7): the deployment's own origin, a check that migration 0116 has run before anyone goes to Pipedrive, and, once the
 * answer is sent, the webhook made sure of and the first sync, with a smaller page budget than the sweeper's. Writing is
 * not asked for here: Pipedrive grants every scope at once, and the card's switch turns writing on (P11).
 */
export function pipedriveConnectDeps(settings: PipedriveSettings): ConnectDeps {
  const provider = pipedriveProvider(settings);
  return {
    provider,
    origin: siteOrigin(),
    ready: pipedriveReady,
    afterConnect: (work) => after(work),
    firstSync: async (connection) => {
      await ensureWebhookInScope(connection, provider);
      return crmSyncInScope(connection.id, provider, { maxPages: 10 });
    },
  };
}
