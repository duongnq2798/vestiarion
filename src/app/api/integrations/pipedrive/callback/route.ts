import { after } from "next/server";
import { finishConnect } from "@/lib/connectors/connect";
import { connectionsByExternal } from "@/lib/connectors/connections";
import { crmSyncInScope } from "@/lib/connectors/crm-store";
import { withOrg } from "@/lib/dal/scope";
import { pipedriveConnectDeps } from "@/lib/pipedrive/connect-deps";
import { pipedriveProvider } from "@/lib/pipedrive/provider";
import { pipedriveSettingsFromEnv } from "@/lib/pipedrive/settings";
import { handlePipedriveUninstall } from "@/lib/pipedrive/webhooks";

/**
 * Where Pipedrive sends a person back (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4), registered as
 * the app's Callback URL in Developer Hub: https://www.vestiarion.xyz/api/integrations/pipedrive/callback. Pipedrive also
 * sends its uninstall notice here (`DELETE`, Basic auth with the app's client id and secret, P7): it only starts a sync
 * of the company's connections, which then asks a person to reconnect. Not there unless Pipedrive is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Pipedrive, its company, a few writes, then the webhook and the first sync after the answer. */
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  const settings = pipedriveSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, pipedriveConnectDeps(settings));
}

export async function DELETE(request: Request): Promise<Response> {
  const settings = pipedriveSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  const provider = pipedriveProvider(settings);
  return handlePipedriveUninstall(request, {
    settings,
    defer: (work) => after(work),
    findConnections: (companyIds) => connectionsByExternal("pipedrive", companyIds),
    nudge: (match) => withOrg(match.orgId, () => crmSyncInScope(match.connectionId, provider, { maxPages: 1 })),
  });
}
