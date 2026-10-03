import { siteOrigin } from "@/lib/auth/env";
import { finishConnect } from "@/lib/github/connect";
import { githubAppSettingsFromEnv } from "@/lib/github/settings";

/**
 * Where GitHub sends a person back after they install the app and authorize it
 * (docs/superpowers/specs/2026-10-04-github-app-design.md G2). Not there unless the GitHub App is configured (G9).
 */

export const dynamic = "force-dynamic";
/** Two calls to GitHub and one write. */
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const settings = githubAppSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, { settings, origin: siteOrigin() });
}
