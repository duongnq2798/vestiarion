import { asanaConnectDeps } from "@/lib/asana/connect-deps";
import { asanaSettingsFromEnv } from "@/lib/asana/settings";
import { startConnect } from "@/lib/connectors/connect";

/**
 * Continue to Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A2): the connect page's form, from this
 * deployment's own pages only, sends an owner or admin who agreed to Asana with a signed state. Not there unless Asana is
 * configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = asanaSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, asanaConnectDeps(settings));
}
