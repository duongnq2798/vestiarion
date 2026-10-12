import { finishConnect } from "@/lib/connectors/connect";
import { xeroConnectDeps } from "@/lib/xero/connect-deps";
import { xeroSettingsFromEnv } from "@/lib/xero/settings";

/**
 * Where Xero sends a person back (docs/superpowers/specs/2026-10-12-xero-connector-design.md X4), registered for the
 * app as https://www.vestiarion.xyz/api/integrations/xero/callback and http://localhost:3000/api/integrations/xero/callback.
 * Not there unless Xero is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Xero, its organisations, a few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  const settings = xeroSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, xeroConnectDeps(settings));
}
