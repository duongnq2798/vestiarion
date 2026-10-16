import { db } from "../dal";
import { isNotSetUp, NotSetUpError } from "../connectors/connections";

/**
 * Throws `NotSetUpError` before migration 0122 has run (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md
 * Z12): the connection tables do not take `zohobooks` yet, so no one is sent to Zoho for nothing.
 */
export async function zohoBooksReady(): Promise<void> {
  const probe = await db().rpc("zohobooks_connector_ready");
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}
