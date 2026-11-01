import { isNotSetUp, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";

/**
 * Throws `NotSetUpError` before migration 0148 has run (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md
 * GD3): the connection tables do not take `googledrive` yet, so no one is sent to Google for nothing, the card says
 * Google Drive is not set up, and the review list offers no Check Google Drive now.
 */
export async function googleDriveReady(): Promise<void> {
  const probe = await db().rpc("googledrive_connector_ready");
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}
