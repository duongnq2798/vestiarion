import type { AccountingProvider } from "../connectors/provider";
import { bankAccounts, billsPage, vendorsPage } from "./api";
import type { QuickBooksHttp } from "./http";
import { authorizeUrl, exchangeCode, grantedCompany, refreshTokens, revokeToken } from "./oauth";
import { QUICKBOOKS_SCOPES, type QuickBooksSettings } from "./settings";

/**
 * QuickBooks Online as the connector core sees it (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md
 * Q1): the callback names the company (`realmId`), one workspace holds a company at a time, and vendors are its
 * contacts. A provider object lives for one request or one sync, and keeps the companies' home currencies that long.
 */
export function quickBooksProvider(settings: QuickBooksSettings, deps: QuickBooksHttp = {}): AccountingProvider {
  const homeCurrencies = new Map<string, string | null>();
  return {
    id: "quickbooks",
    label: "QuickBooks",
    scopes: QUICKBOOKS_SCOPES,
    callbackOrganisationParam: "realmId",
    exclusive: true,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens, _authEventId, named) => grantedCompany(settings, tokens, named, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(settings, refreshToken, deps),
    bills: (request) => billsPage(settings, request, deps, homeCurrencies),
    contacts: (request) => vendorsPage(settings, request, deps),
    accounts: (request) => bankAccounts(settings, request, deps),
  };
}
