import { startConnect } from "@/lib/connectors/connect";
import { zohoBooksConnectDeps } from "@/lib/zohobooks/connect-deps";
import { zohoBooksSettingsFromEnv } from "@/lib/zohobooks/settings";

/**
 * Continue to Zoho Books (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z2, Z12): the connect page's
 * form, from this deployment's own pages only, sends an owner or admin who agreed to Zoho Books with a signed state,
 * once migration 0122 has run. Not there unless Zoho Books is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = zohoBooksSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, zohoBooksConnectDeps(settings));
}
