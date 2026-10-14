import { after } from "next/server";
import { connectionsByExternal } from "@/lib/connectors/connections";
import { crmSyncInScope } from "@/lib/connectors/crm-store";
import { withOrg } from "@/lib/dal/scope";
import { pipedriveProvider } from "@/lib/pipedrive/provider";
import { pipedriveSettingsFromEnv } from "@/lib/pipedrive/settings";
import { handlePipedriveWebhook, NUDGE_SYNC } from "@/lib/pipedrive/webhooks";
import { masterKeysFromEnv } from "@/lib/secrets";

/**
 * Pipedrive's webhook for a company's deals (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P7),
 * registered by Vestiarion itself at https://www.vestiarion.xyz/api/integrations/pipedrive/webhook with HTTP Basic auth.
 * Closed to anything without that auth, compared before the body is read; answered at once; the company's connections
 * each run one sync after the response, with Sync now's page budget, reading the deals that changed from Pipedrive
 * (`NUDGE_SYNC`: never every kept deal again by id, which the sweeper does). The body is never trusted. Not there unless
 * Pipedrive is configured.
 */

export const dynamic = "force-dynamic";
/** The answer is immediate; the syncs after it stop starting at 60 seconds, and one may run a little longer. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const settings = pipedriveSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  const provider = pipedriveProvider(settings);
  return handlePipedriveWebhook(request, {
    keys: masterKeysFromEnv(),
    defer: (work) => after(work),
    findConnections: (companyIds) => connectionsByExternal("pipedrive", companyIds),
    nudge: (match) => withOrg(match.orgId, () => crmSyncInScope(match.connectionId, provider, NUDGE_SYNC)),
  });
}
