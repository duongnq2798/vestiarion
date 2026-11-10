import { after } from "next/server";
import { jiraProvider } from "@/lib/jira/provider";
import { jiraSettingsFromEnv } from "@/lib/jira/settings";
import { handleJiraWebhook } from "@/lib/jira/webhook";
import { rereadForDelivery } from "@/lib/jira/workspace";

/**
 * Jira's dynamic webhooks (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR14, JR15), one per connection,
 * each registered to https://www.vestiarion.xyz/api/integrations/jira/webhook: a delivery whose bearer token verifies
 * under the app's client secret is answered exactly 200 at once and followed, after the answer, by a read through Jira's
 * API of the one issue it names, in each workspace whose site row holds a webhook it matched. Its body is not read before
 * the token verifies, and nothing in it is believed. Not there unless Jira is configured (JR1).
 */

export const dynamic = "force-dynamic";
/** The answer is immediate; the reads after it take a few seconds. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const settings = jiraSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  const provider = jiraProvider(settings);
  return handleJiraWebhook(request, {
    secret: settings.clientSecret,
    defer: (work) => after(work),
    reread: (event) => rereadForDelivery(event, provider),
  });
}
