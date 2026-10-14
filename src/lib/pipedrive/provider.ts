import type { CrmProvider } from "../connectors/crm";
import { pipedriveReader } from "./api";
import type { PipedriveHttp } from "./http";
import { authorizeUrl, exchangeCode, listCompany, refreshTokens, revokeToken } from "./oauth";
import { pipedriveReceipts } from "./receipts";
import { PIPEDRIVE_SCOPES, type PipedriveSettings } from "./settings";

/**
 * Pipedrive as the connector core sees it (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md P1, P4): a
 * CRM, one company per grant, and one workspace per company. Each provider made reads the stages, pipelines and deal
 * fields once, and remembers its page cursors: make one per run.
 */
export function pipedriveProvider(settings: PipedriveSettings, deps: PipedriveHttp = {}): CrmProvider {
  const reader = pipedriveReader(deps);
  return {
    id: "pipedrive",
    label: "Pipedrive",
    kind: "crm",
    scopes: PIPEDRIVE_SCOPES,
    exclusive: true,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens) => listCompany(settings, tokens, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(settings, refreshToken, deps),
    deals: (request) => reader.deals(request),
    dealsById: (input) => reader.dealsById(input),
    receipts: pipedriveReceipts(deps),
  };
}
