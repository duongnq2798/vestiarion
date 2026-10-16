import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { syncInScope } from "../connectors/sweep";
import { zohoBooksProvider } from "./provider";
import type { ZohoBooksSettings } from "./settings";
import { zohoBooksReady } from "./store";

/**
 * Zoho Books' connect flow as the routes run it (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z3,
 * Z5, Z12): migration 0122 first, the deployment's own origin, and the first sync once the answer is sent, with a
 * smaller page budget than the sweeper's.
 */
export function zohoBooksConnectDeps(settings: ZohoBooksSettings): ConnectDeps {
  const provider = zohoBooksProvider(settings);
  return {
    provider,
    ready: zohoBooksReady,
    origin: siteOrigin(),
    afterConnect: (work) => after(work),
    firstSync: (connection) => syncInScope(connection.id, provider, { maxPages: 10 }),
  };
}
