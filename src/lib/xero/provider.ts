import type { AccountingProvider } from "../connectors/provider";
import { accounts, billsPage, contactsPage } from "./api";
import type { XeroHttp } from "./http";
import { authorizeUrl, exchangeCode, listOrganisations, refreshTokens, revokeToken } from "./oauth";
import { xeroBooking } from "./payments-api";
import { XERO_SCOPES, type XeroSettings } from "./settings";

/**
 * Xero as the connector core sees it (docs/superpowers/specs/2026-10-12-xero-connector-design.md X1), booking payments
 * too (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W11).
 */
export function xeroProvider(settings: XeroSettings, deps: XeroHttp = {}): AccountingProvider {
  return {
    id: "xero",
    label: "Xero",
    scopes: XERO_SCOPES,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens, authEventId) => listOrganisations(tokens.accessToken, authEventId, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(settings, refreshToken, deps),
    bills: (request) => billsPage(request, deps),
    contacts: (request) => contactsPage(request, deps),
    accounts: (request) => accounts(request, deps),
    booking: xeroBooking(deps),
  };
}
