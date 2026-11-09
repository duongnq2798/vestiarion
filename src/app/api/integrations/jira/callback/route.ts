import { jiraConnectDeps } from "@/lib/jira/connect-deps";
import { jiraSettingsFromEnv } from "@/lib/jira/settings";
import { finishConnect } from "@/lib/connectors/connect";

/**
 * Where Atlassian sends a person back (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2), registered for
 * the app as https://www.vestiarion.xyz/api/integrations/jira/callback: one site the grant reaches is connected, several
 * are offered on the connect page, and none is refused as `no_site`, keeping nothing. Not there unless Jira is
 * configured (JR1).
 */

export const dynamic = "force-dynamic";
/** One exchange with Atlassian, one read of the sites the grant reaches, a few writes, then the first upkeep after the answer. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const settings = jiraSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, jiraConnectDeps(settings));
}
