import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { syncInScope } from "../connectors/sweep";
import { quickBooksProvider } from "./provider";
import type { QuickBooksSettings } from "./settings";

/**
 * QuickBooks' connect flow as the routes run it (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4,
 * Q10): the deployment's own origin, and the first sync once the answer is sent, with a smaller page budget than the
 * sweeper's.
 */
export function quickBooksConnectDeps(settings: QuickBooksSettings): ConnectDeps {
  const provider = quickBooksProvider(settings);
  return {
    provider,
    origin: siteOrigin(),
    afterConnect: (work) => after(work),
    firstSync: (connection) => syncInScope(connection.id, provider, { maxPages: 10 }),
  };
}
