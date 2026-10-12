import { chooseConnect } from "@/lib/connectors/connect";
import { xeroConnectDeps } from "@/lib/xero/connect-deps";
import { xeroSettingsFromEnv } from "@/lib/xero/settings";

/**
 * The Xero organisation picked, when a person authorized several (docs/superpowers/specs/2026-10-12-xero-connector-design.md
 * X4): from this deployment's own connect page only. Not there unless Xero is configured.
 */

export const dynamic = "force-dynamic";
/** A few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const settings = xeroSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return chooseConnect(request, xeroConnectDeps(settings));
}
