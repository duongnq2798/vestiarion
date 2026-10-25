import { isNotSetUp, NotSetUpError } from "../connectors/connections";
import { db } from "../dal";

/**
 * Throws `NotSetUpError` before migration 0145 has run (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS2, GS19): the connection tables do not take `googlesheets` yet, so no one is sent to Google for nothing, the card says
 * Google Sheets is not set up, and the close pack page shows no export control.
 */
export async function googleSheetsReady(): Promise<void> {
  const probe = await db().rpc("googlesheets_connector_ready");
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}
