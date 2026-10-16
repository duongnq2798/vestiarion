import type { CrmProvider } from "../connectors/crm";
import { authorizeUrl, exchangeCode, refreshTokens, revokeToken } from "../zohobooks/oauth";
import { zohoCrmReader } from "./api";
import type { ZohoCrmHttp } from "./http";
import { ZOHO_CRM_SCOPES, type ZohoCrmSettings } from "./settings";

/**
 * Zoho CRM as the connector core sees it (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md C1, C3, C5): a
 * CRM on Zoho's OAuth, the callback naming the data center (`location`), one organization per grant, read only, so it
 * writes no receipts. Several workspaces may connect one organization: nothing is written there for them to contend over.
 * Each provider made reads the stages and the home currency once, and remembers its page tokens: make one per run.
 */
export function zohoCrmProvider(settings: ZohoCrmSettings, deps: ZohoCrmHttp = {}): CrmProvider {
  const app = { ...settings, scopes: ZOHO_CRM_SCOPES, name: "zohocrm" };
  const reader = zohoCrmReader(deps);
  return {
    id: "zohocrm",
    label: "Zoho CRM",
    kind: "crm",
    scopes: ZOHO_CRM_SCOPES,
    callbackRegionParam: "location",
    authorizeUrl: (input) => authorizeUrl(app, input),
    exchangeCode: (input) => exchangeCode(app, input, deps),
    organisations: async (tokens) => [await reader.organisation(tokens.accessToken)],
    refresh: (refreshToken) => refreshTokens(app, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(refreshToken, deps),
    deals: (request) => reader.deals(request),
    dealsById: (input) => reader.dealsById(input),
  };
}
