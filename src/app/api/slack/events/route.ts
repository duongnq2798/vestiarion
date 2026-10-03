import { handleEvent } from "@/lib/slack/events";
import { slackSettingsFromEnv } from "@/lib/slack/settings";

/**
 * Slack's events: its URL check, and the app being uninstalled or its token revoked
 * (docs/superpowers/specs/2026-10-03-slack-design.md, S13). Not there unless Slack is configured.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const settings = slackSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return handleEvent(request, { settings });
}
