import { chooseConnect } from "@/lib/connectors/connect";
import { jiraConnectDeps } from "@/lib/jira/connect-deps";
import { jiraSettingsFromEnv } from "@/lib/jira/settings";

/**
 * The Jira site picked, when a person's grant reaches several (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md
 * JR2), as Xero's and Zoho Books' choose routes: from this deployment's own connect page only, within the ten minutes the
 * pending grant is kept. Not there unless Jira is configured (JR1).
 */

export const dynamic = "force-dynamic";
/** A few writes, then the first upkeep after the answer. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const settings = jiraSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return chooseConnect(request, jiraConnectDeps(settings));
}
