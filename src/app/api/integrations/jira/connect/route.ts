import { jiraConnectDeps } from "@/lib/jira/connect-deps";
import { jiraSettingsFromEnv } from "@/lib/jira/settings";
import { startConnect } from "@/lib/connectors/connect";

/**
 * Continue to Jira (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR2): the connect page's form, from this
 * deployment's own pages only, sends an owner or admin who agreed to Jira to Atlassian's consent screen with a signed
 * state. Not there unless Jira is configured, both `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` set (JR1).
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = jiraSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, jiraConnectDeps(settings));
}
