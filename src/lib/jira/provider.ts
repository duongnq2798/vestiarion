import type { ConnectingProvider } from "../connectors/provider";
import { jiraReader, type JiraReader } from "./api";
import type { JiraHttp } from "./http";
import { authorizeUrl, exchangeCode, grantSites, refreshTokens, revokeToken } from "./oauth";
import { JIRA_SCOPES, jiraSettingsFromEnv, type JiraSettings } from "./settings";
import { jiraWebhookApi, type JiraWebhookApi } from "./webhooks";

/**
 * Jira as the connector core sees it (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR2, JR4):
 * connecting, its tokens and disconnecting, through the core's `ConnectingProvider`; its reads, which the acceptance code
 * uses with a connection's fresh token; and the one webhook a connection keeps on its site. The Jira site a connection
 * reads is its external organisation, its cloudId the id every API address names. Not exclusive: two Vestiarion
 * workspaces may each connect the same site, each with its own webhook. Revoking makes no request: Atlassian gives apps no
 * way to end their own grant.
 */
export interface JiraProvider extends ConnectingProvider {
  reader: JiraReader;
  hooks: JiraWebhookApi;
}

export function jiraProvider(settings: JiraSettings, deps: JiraHttp = {}): JiraProvider {
  return {
    id: "jira",
    label: "Jira",
    scopes: JIRA_SCOPES,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens) => grantSites(tokens.accessToken, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: () => revokeToken(),
    reader: jiraReader(deps),
    hooks: jiraWebhookApi(deps),
  };
}

/** Jira on this deployment, or null unless both `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` are set (JR1). */
export function jiraProviderFromEnv(): JiraProvider | null {
  const settings = jiraSettingsFromEnv();
  return settings ? jiraProvider(settings) : null;
}
