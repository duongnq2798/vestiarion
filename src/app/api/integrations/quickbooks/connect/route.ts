import { startConnect } from "@/lib/connectors/connect";
import { quickBooksConnectDeps } from "@/lib/quickbooks/connect-deps";
import { quickBooksSettingsFromEnv } from "@/lib/quickbooks/settings";

/**
 * Continue to QuickBooks (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4): the connect page's
 * form, from this deployment's own pages only, sends an owner or admin who agreed to Intuit with a signed state. Not
 * there unless QuickBooks is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = quickBooksSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, quickBooksConnectDeps(settings));
}
