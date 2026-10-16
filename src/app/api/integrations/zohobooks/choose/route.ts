import { chooseConnect } from "@/lib/connectors/connect";
import { zohoBooksConnectDeps } from "@/lib/zohobooks/connect-deps";
import { zohoBooksSettingsFromEnv } from "@/lib/zohobooks/settings";

/**
 * The Zoho Books organization picked, when a person's token reaches several
 * (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z5): from this deployment's own connect page only.
 * Not there unless Zoho Books is configured.
 */

export const dynamic = "force-dynamic";
/** A few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const settings = zohoBooksSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return chooseConnect(request, zohoBooksConnectDeps(settings));
}
