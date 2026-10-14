import { startConnect } from "@/lib/connectors/connect";
import { pipedriveConnectDeps } from "@/lib/pipedrive/connect-deps";
import { pipedriveSettingsFromEnv } from "@/lib/pipedrive/settings";

/**
 * Continue to Pipedrive (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P4): the connect page's form,
 * from this deployment's own pages only, sends an owner or admin who agreed to Pipedrive with a signed state. Not there
 * unless Pipedrive is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = pipedriveSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, pipedriveConnectDeps(settings));
}
