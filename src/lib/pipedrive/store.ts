import { siteOrigin } from "../auth/env";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { isNotSetUp, NotSetUpError, type Connection } from "../connectors/connections";
import type { CrmProvider } from "../connectors/crm";
import { crmReady } from "../connectors/crm-review";
import { connectionTokenStore } from "../connectors/token-store";
import { freshAccessToken } from "../connectors/tokens";
import { masterKeysFromEnv } from "../secrets";
import type { PipedriveHttp } from "./http";
import { ensureWebhook, type WebhookOutcome } from "./webhooks";

/**
 * Pipedrive's own needs of the database and the workspace in scope
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P2, P7, P17): whether migration 0116 has run, and the
 * webhook made sure of with a fresh token. No token leaves for anything but Pipedrive.
 */

/** Throws `NotSetUpError` before migrations 0105 and 0116 have run: no one is sent to Pipedrive for nothing (P17). */
export async function pipedriveReady(): Promise<void> {
  await crmReady();
  const probe = await db().rpc("pipedrive_connector_ready");
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}

/**
 * Makes sure Pipedrive tells this deployment when the company's deals change (P7), in the connection's workspace scope.
 * Best effort: a webhook that cannot be made leaves the sweeper's 15 minutes, and is said in the log by its outcome only.
 */
export async function ensureWebhookInScope(connection: Connection, provider: CrmProvider, deps: PipedriveHttp & { origin?: string } = {}): Promise<WebhookOutcome | "no_token"> {
  try {
    const token = await freshAccessToken({ store: connectionTokenStore(currentOrgId(), connection.id), refresh: provider.refresh });
    if (!token.ok) return "no_token";
    const outcome = await ensureWebhook({ credential: token.accessToken, companyId: connection.externalOrgId, origin: deps.origin ?? siteOrigin(), keys: masterKeysFromEnv() }, deps);
    if (outcome === "refused") console.info("pipedrive: Pipedrive did not let Vestiarion register its webhook; the sweeper reads every 15 minutes", connection.id);
    return outcome;
  } catch (error) {
    console.error("pipedrive: the webhook was not made sure of", connection.id, error instanceof Error ? error.message : "unknown error");
    return "skipped";
  }
}
