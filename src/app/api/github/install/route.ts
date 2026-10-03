import { siteOrigin } from "@/lib/auth/env";
import { startConnect } from "@/lib/github/connect";
import { githubAppSettingsFromEnv } from "@/lib/github/settings";

/**
 * Connect GitHub (docs/superpowers/specs/2026-10-04-github-app-design.md G2): an owner or admin is sent to install the
 * app, with a signed state. Not there unless the GitHub App is configured (G9).
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const settings = githubAppSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return startConnect(request, { settings, origin: siteOrigin() });
}
