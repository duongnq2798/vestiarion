import { linearConnectDeps } from "@/lib/linear/connect-deps";
import { linearSettingsFromEnv } from "@/lib/linear/settings";
import { finishConnect } from "@/lib/connectors/connect";

/**
 * Where Linear sends a person back (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2), registered for the
 * app as https://www.vestiarion.xyz/api/integrations/linear/callback. Not there unless Linear is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Linear, one read of the workspace it reads, and a few writes. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const settings = linearSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, linearConnectDeps(settings));
}
