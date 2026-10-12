import type { AccountingProvider, ProviderId } from "./connectors/provider";
import { xeroProvider } from "./xero/provider";
import { xeroSettingsFromEnv } from "./xero/settings";

/**
 * The accounting providers this deployment has set up (docs/superpowers/specs/2026-10-12-xero-connector-design.md X1,
 * X16): the one place the core is wired to a provider's folder. Xero is on with `XERO_CLIENT_ID` and
 * `XERO_CLIENT_SECRET`; QuickBooks Online joins here next.
 */
export function accountingProvider(id: ProviderId): AccountingProvider | null {
  if (id === "xero") {
    const settings = xeroSettingsFromEnv();
    return settings ? xeroProvider(settings) : null;
  }
  return null;
}
