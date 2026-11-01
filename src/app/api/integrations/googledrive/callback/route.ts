import { finishConnect } from "@/lib/connectors/connect";
import { googleDriveConnectDeps } from "@/lib/googledrive/connect-deps";
import { googleDriveSettingsFromEnv } from "@/lib/googledrive/settings";

/**
 * Where Google sends a person back (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD2), registered on
 * the Google OAuth client as https://www.vestiarion.xyz/api/integrations/googledrive/callback. Not there unless the
 * deployment's Google Drive client is set.
 */

export const dynamic = "force-dynamic";
/** One exchange with Google, one read of the Drive account, and a few writes. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const settings = googleDriveSettingsFromEnv();
  if (!settings) return Response.json({ error: "not_found" }, { status: 404 });
  return finishConnect(request, googleDriveConnectDeps(settings));
}
