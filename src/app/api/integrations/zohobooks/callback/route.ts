import { finishConnect } from "@/lib/connectors/connect";
import { zohoBooksConnectDeps } from "@/lib/zohobooks/connect-deps";
import { zohoBooksSettingsFromEnv } from "@/lib/zohobooks/settings";

/**
 * Where Zoho sends a person back (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z3, Z5), registered
 * for the app as https://www.vestiarion.xyz/api/integrations/zohobooks/callback and
 * http://localhost:3000/api/integrations/zohobooks/callback. Its `location` names the person's data center. Not there
 * unless Zoho Books is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Zoho, its organizations, a few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  const settings = zohoBooksSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, zohoBooksConnectDeps(settings));
}
