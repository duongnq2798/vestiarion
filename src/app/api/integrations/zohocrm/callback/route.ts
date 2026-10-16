import { finishConnect } from "@/lib/connectors/connect";
import { zohoCrmConnectDeps } from "@/lib/zohocrm/connect-deps";
import { zohoCrmSettingsFromEnv } from "@/lib/zohocrm/settings";

/**
 * Where Zoho sends a person back from Zoho CRM (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C4, C5),
 * registered on the Zoho client as https://www.vestiarion.xyz/api/integrations/zohocrm/callback and
 * http://localhost:3000/api/integrations/zohocrm/callback, beside Zoho Books'. Its `location` names the person's data
 * center. Not there unless the Zoho client is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Zoho, its organization, a few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  const settings = zohoCrmSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, zohoCrmConnectDeps(settings));
}
