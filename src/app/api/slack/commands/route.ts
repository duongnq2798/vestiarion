import { after } from "next/server";
import { siteOrigin } from "@/lib/auth/env";
import { handleSlashCommand } from "@/lib/slack/commands";
import { slackSettingsFromEnv } from "@/lib/slack/settings";

/**
 * `/vestiarion` (docs/superpowers/specs/2026-10-03-slack-design.md, S1, S2, S6). Not there unless Slack is configured;
 * closed to anything Slack did not sign; answered at once, with the work done after the response.
 */

export const dynamic = "force-dynamic";
/** A pause or a ledger check, after the response, fits well inside a minute. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const settings = slackSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return handleSlashCommand(request, { settings, origin: siteOrigin(), defer: (work) => after(work) });
}
