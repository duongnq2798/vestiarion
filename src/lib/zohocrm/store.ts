import { db } from "../dal";
import { isNotSetUp, NotSetUpError } from "../connectors/connections";
import { crmReady } from "../connectors/crm-review";

/**
 * Throws `NotSetUpError` before migrations 0105 and 0123 have run
 * (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C17): the CRM tables, or the connection tables taking
 * `zohocrm`, are not there yet, so no one is sent to Zoho for nothing.
 */
export async function zohoCrmReady(): Promise<void> {
  await crmReady();
  const probe = await db().rpc("zohocrm_connector_ready");
  if (!probe.error) return;
  if (isNotSetUp(probe.error)) throw new NotSetUpError();
  throw new Error(probe.error.message);
}
