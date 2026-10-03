import { after } from "next/server";
import { handleInteraction } from "@/lib/slack/interactions";
import { slackSettingsFromEnv } from "@/lib/slack/settings";

/**
 * A click on a Slack card (docs/superpowers/specs/2026-10-03-slack-design.md, S1, S2, S9, S10). Not there unless Slack
 * is configured; closed to anything Slack did not sign; answered at once, with the decision made after the response.
 */

export const dynamic = "force-dynamic";
/** Approve and pay waits for Circle to confirm the transfer, after the response. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const settings = slackSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return handleInteraction(request, { settings, defer: (work) => after(work) });
}
