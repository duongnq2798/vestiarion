import { startConnect } from "@/lib/connectors/connect";
import { zohoCrmConnectDeps } from "@/lib/zohocrm/connect-deps";
import { zohoCrmSettingsFromEnv } from "@/lib/zohocrm/settings";

/**
 * Continue to Zoho CRM (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4): the connect page's form, from
 * this deployment's own pages only, sends an owner or admin who agreed to Zoho CRM with a signed state. Not there unless
 * the Zoho client is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = zohoCrmSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, zohoCrmConnectDeps(settings));
}
