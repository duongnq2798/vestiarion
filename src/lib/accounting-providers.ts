import type { AccountingProvider, ProviderId } from "./connectors/provider";
import { quickBooksProvider } from "./quickbooks/provider";
import { quickBooksSettingsFromEnv } from "./quickbooks/settings";
import { xeroProvider } from "./xero/provider";
import { xeroSettingsFromEnv } from "./xero/settings";

/**
 * The accounting providers this deployment has set up (docs/superpowers/specs/2026-10-12-xero-connector-design.md X1,
 * X16; docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q1, Q2): the one place the core is wired to a
 * provider's folder. Xero is on with `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`; QuickBooks Online with
 * `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`.
 */
export function accountingProvider(id: ProviderId): AccountingProvider | null {
  if (id === "xero") {
    const settings = xeroSettingsFromEnv();
    return settings ? xeroProvider(settings) : null;
  }
  if (id === "quickbooks") {
    const settings = quickBooksSettingsFromEnv();
    return settings ? quickBooksProvider(settings) : null;
  }
  return null;
}

/** Whether a provider is set up on this deployment, without building it. */
export function accountingProviderOn(id: ProviderId): boolean {
  return id === "xero" ? xeroSettingsFromEnv() !== null : quickBooksSettingsFromEnv() !== null;
}
