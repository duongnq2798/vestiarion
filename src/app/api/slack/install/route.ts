import { siteOrigin } from "@/lib/auth/env";
import { startInstall } from "@/lib/slack/oauth";
import { slackSettingsFromEnv } from "@/lib/slack/settings";

/**
 * Add to Slack (docs/superpowers/specs/2026-10-03-slack-design.md, S3): an owner or admin is sent to Slack with a
 * signed state. Not there unless Slack is configured.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const settings = slackSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startInstall(request, { settings, origin: siteOrigin() });
}
