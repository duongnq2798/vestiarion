import type { ConnectingProvider } from "../connectors/provider";
import { asanaReader, type AsanaReader } from "./api";
import type { AsanaHttp } from "./http";
import { authorizeUrl, exchangeCode, grantUser, refreshTokens, revokeToken } from "./oauth";
import { ASANA_SCOPES, asanaSettingsFromEnv, type AsanaSettings } from "./settings";

/**
 * Asana as the connector core sees it (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A1, A2): connecting,
 * its tokens and disconnecting, through the core's `ConnectingProvider`; and its reads, which the acceptance code uses
 * with a connection's fresh token. One Asana user per grant, its gid the connection's external id. Not exclusive: two
 * workspaces may each connect the same person's Asana.
 */
export interface AsanaProvider extends ConnectingProvider {
  reader: AsanaReader;
}

export function asanaProvider(settings: AsanaSettings, deps: AsanaHttp = {}): AsanaProvider {
  return {
    id: "asana",
    label: "Asana",
    scopes: ASANA_SCOPES,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    // The code exchange hands the grant's user on as its authorization event (`./oauth.ts`).
    organisations: (tokens, userGid) => grantUser(tokens.accessToken, userGid, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(settings, refreshToken, deps),
    reader: asanaReader(deps),
  };
}

/** Asana on this deployment, or null when `ASANA_CLIENT_ID` and `ASANA_CLIENT_SECRET` are not set. */
export function asanaProviderFromEnv(): AsanaProvider | null {
  const settings = asanaSettingsFromEnv();
  return settings ? asanaProvider(settings) : null;
}
