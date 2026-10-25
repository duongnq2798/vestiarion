import { finishConnect } from "@/lib/connectors/connect";
import { googleSheetsConnectDeps } from "@/lib/googlesheets/connect-deps";
import { googleSheetsSettingsFromEnv } from "@/lib/googlesheets/settings";

/**
 * Where Google sends a person back (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS3, GS4, GS6),
 * registered on the Google OAuth client as https://www.vestiarion.xyz/api/integrations/googlesheets/callback. Not there
 * unless the deployment's Google client is set.
 */

export const dynamic = "force-dynamic";
/** One exchange with Google, one read of the Drive account, and a few writes. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const settings = googleSheetsSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, googleSheetsConnectDeps(settings));
}
