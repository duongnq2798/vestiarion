import { after } from "next/server";
import { siteOrigin } from "../auth/env";
import type { ConnectDeps } from "../connectors/connect";
import { syncInScope } from "../connectors/sweep";
import { xeroProvider } from "./provider";
import type { XeroSettings } from "./settings";

/**
 * Xero's connect flow as the routes run it (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4, X7): the
 * deployment's own origin, and the first sync once the answer is sent, with a smaller page budget than the sweeper's.
 */
export function xeroConnectDeps(settings: XeroSettings): ConnectDeps {
  const provider = xeroProvider(settings);
  return {
    provider,
    origin: siteOrigin(),
    afterConnect: (work) => after(work),
    firstSync: (connection) => syncInScope(connection.id, provider, { maxPages: 10 }),
  };
}
