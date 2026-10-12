import { finishConnect } from "@/lib/connectors/connect";
import { hubspotConnectDeps } from "@/lib/hubspot/connect-deps";
import { hubspotSettingsFromEnv } from "@/lib/hubspot/settings";

/**
 * Where HubSpot sends a person back (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H4), registered in
 * the app's config (`integrations/hubspot/src/app/app-hsmeta.json`) as
 * https://www.vestiarion.xyz/api/integrations/hubspot/callback and http://localhost:3000/api/integrations/hubspot/callback.
 * Not there unless HubSpot is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with HubSpot, its account, a few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  const settings = hubspotSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, hubspotConnectDeps(settings));
}
