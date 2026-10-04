import { after } from "next/server";
import { siteOrigin } from "@/lib/auth/env";
import { handleGitHubDelivery } from "@/lib/github/deliveries";
import { githubAppSettingsFromEnv } from "@/lib/github/settings";
import { githubWebhookSecretFromEnv } from "@/lib/github/webhook";

/**
 * The GitHub App's webhook (docs/superpowers/specs/2026-10-04-github-bounties-design.md B2): `/bounty` and `/payto` on
 * pull requests. Not there unless the app and its webhook secret are configured; closed to anything GitHub did not
 * sign; answered at once, with the work done after the response.
 */

export const dynamic = "force-dynamic";
/** A permission check, a few writes and a reply fit well inside a minute. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const settings = githubAppSettingsFromEnv();
  const secret = githubWebhookSecretFromEnv();
  if (!settings || !secret) return Response.json({ error: "not_found" }, { status: 404 });
  return handleGitHubDelivery(request, { settings, secret, origin: siteOrigin(), defer: (work) => after(work) });
}
