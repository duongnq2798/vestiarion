import { startConnect } from "@/lib/connectors/connect";
import { xeroConnectDeps } from "@/lib/xero/connect-deps";
import { xeroSettingsFromEnv } from "@/lib/xero/settings";

/**
 * Continue to Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4): the connect page's form, from this
 * deployment's own pages only, sends an owner or admin who agreed to Xero with a signed state. Not there unless Xero is
 * configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = xeroSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, xeroConnectDeps(settings));
}
