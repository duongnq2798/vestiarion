import { startConnect } from "@/lib/connectors/connect";
import { hubspotConnectDeps } from "@/lib/hubspot/connect-deps";
import { hubspotSettingsFromEnv } from "@/lib/hubspot/settings";

/**
 * Continue to HubSpot (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4): the connect page's form, from
 * this deployment's own pages only, sends an owner or admin who agreed to HubSpot with a signed state. Not there unless
 * HubSpot is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = hubspotSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, hubspotConnectDeps(settings));
}
