import type { AccountingProvider } from "../connectors/provider";
import { billsPage, organizations, vendorsPage } from "./api";
import type { ZohoBooksHttp } from "./http";
import { authorizeUrl, exchangeCode, refreshTokens, revokeToken } from "./oauth";
import { ZOHO_BOOKS_SCOPES, type ZohoBooksSettings } from "./settings";

/**
 * Zoho Books as the connector core sees it (docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md Z1): the
 * callback names the data center (`location`, Z3), a token reaches one or more organizations (Z5), vendors are its
 * contacts (Z8), and there is no booking (Z9), so it reads no chart of accounts.
 */
export function zohoBooksProvider(settings: ZohoBooksSettings, deps: ZohoBooksHttp = {}): AccountingProvider {
  return {
    id: "zohobooks",
    label: "Zoho Books",
    scopes: ZOHO_BOOKS_SCOPES,
    callbackRegionParam: "location",
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens) => organizations(tokens.accessToken, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(refreshToken, deps),
    bills: (request) => billsPage(request, deps),
    contacts: (request) => vendorsPage(request, deps),
    accounts: async () => [],
  };
}
