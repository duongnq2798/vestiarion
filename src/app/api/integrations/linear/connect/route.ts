import { linearConnectDeps } from "@/lib/linear/connect-deps";
import { linearSettingsFromEnv } from "@/lib/linear/settings";
import { startConnect } from "@/lib/connectors/connect";

/**
 * Continue to Linear (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2): the connect page's form, from
 * this deployment's own pages only, sends an owner or admin who agreed to Linear with a signed state. Not there unless
 * Linear is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = linearSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, linearConnectDeps(settings));
}
