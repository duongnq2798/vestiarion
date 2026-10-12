import { after } from "next/server";
import { connectionsByExternal } from "@/lib/connectors/connections";
import { syncInScope } from "@/lib/connectors/sweep";
import { withOrg } from "@/lib/dal/scope";
import { quickBooksProvider } from "@/lib/quickbooks/provider";
import { quickBooksSettingsFromEnv, quickBooksWebhookTokenFromEnv } from "@/lib/quickbooks/settings";
import { handleQuickBooksWebhook } from "@/lib/quickbooks/webhook";

/**
 * QuickBooks Online's webhook (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q11), registered for
 * the app as https://www.vestiarion.xyz/api/integrations/quickbooks/webhook with the CloudEvents payload format. Not
 * there unless the app and its verifier token are configured; closed to anything Intuit did not sign; answered at
 * once, with each nudged connection's sync run after the response, with Sync now's page budget.
 */

export const dynamic = "force-dynamic";
/** The answer is immediate; the syncs after it stop starting at 60 seconds, and one may run a little longer. */
export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const settings = quickBooksSettingsFromEnv();
  const verifierToken = quickBooksWebhookTokenFromEnv();
  if (!settings || !verifierToken) return Response.json({ error: "not_found" }, { status: 404 });
  const provider = quickBooksProvider(settings);
  return handleQuickBooksWebhook(request, {
    verifierToken,
    defer: (work) => after(work),
    findConnections: (realmIds) => connectionsByExternal("quickbooks", realmIds),
    nudge: (match) => withOrg(match.orgId, () => syncInScope(match.connectionId, provider, { maxPages: 5 })),
  });
}
