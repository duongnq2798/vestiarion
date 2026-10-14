import { asanaConnectDeps } from "@/lib/asana/connect-deps";
import { asanaSettingsFromEnv } from "@/lib/asana/settings";
import { finishConnect } from "@/lib/connectors/connect";

/**
 * Where Asana sends a person back (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2), registered for the
 * app as https://www.vestiarion.xyz/api/integrations/asana/callback. Not there unless Asana is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Asana, one read of the person it acts as, and a few writes. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const settings = asanaSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, asanaConnectDeps(settings));
}
