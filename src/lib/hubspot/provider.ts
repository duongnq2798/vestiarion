import type { CrmProvider } from "../connectors/crm";
import { hubspotReader } from "./api";
import type { HubSpotHttp } from "./http";
import { authorizeUrl, exchangeCode, listAccount, refreshTokens, revokeToken } from "./oauth";
import { HUBSPOT_SCOPES, type HubSpotSettings } from "./settings";

/**
 * HubSpot as the connector core sees it (docs/superpowers/specs/2026-10-12-hubspot-connector-design.md H1, H4): a CRM,
 * one account per grant, and one workspace per account. Each provider made reads the pipelines and the account's
 * details once: make one per run.
 */
export function hubspotProvider(settings: HubSpotSettings, deps: HubSpotHttp = {}): CrmProvider {
  const reader = hubspotReader(deps);
  return {
    id: "hubspot",
    label: "HubSpot",
    kind: "crm",
    scopes: HUBSPOT_SCOPES,
    exclusive: true,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    // The code exchange hands the grant's account on as its authorization event (`./oauth.ts`).
    organisations: (tokens, hubId) => listAccount(settings, tokens.accessToken, hubId, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(settings, refreshToken, deps),
    deals: (request) => reader.deals(request),
    dealsById: (input) => reader.dealsById(input),
  };
}
