import { siteOrigin } from "@/lib/auth/env";
import { finishInstall } from "@/lib/slack/oauth";
import { slackSettingsFromEnv } from "@/lib/slack/settings";

/**
 * Where Slack sends a person back after they install the app (docs/superpowers/specs/2026-10-03-slack-design.md, S3).
 * Not there unless Slack is configured.
 */

export const dynamic = "force-dynamic";
/** One exchange with Slack and a few writes. */
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const settings = slackSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishInstall(request, { settings, origin: siteOrigin() });
}
