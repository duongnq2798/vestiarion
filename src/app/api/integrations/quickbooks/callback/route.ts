import { finishConnect } from "@/lib/connectors/connect";
import { quickBooksConnectDeps } from "@/lib/quickbooks/connect-deps";
import { quickBooksSettingsFromEnv } from "@/lib/quickbooks/settings";

/**
 * Where Intuit sends a person back (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q4), registered
 * for the app as https://www.vestiarion.xyz/api/integrations/quickbooks/callback and
 * http://localhost:3000/api/integrations/quickbooks/callback, with `code`, `state` and `realmId`. Not there unless
 * QuickBooks is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Intuit, the company's info, a few writes, then the first sync after the answer. */
export const maxDuration = 120;

export async function GET(request: Request): Promise<Response> {
  const settings = quickBooksSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, quickBooksConnectDeps(settings));
}
