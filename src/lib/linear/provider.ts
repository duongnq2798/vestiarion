import type { ConnectingProvider } from "../connectors/provider";
import { linearReader, type LinearReader } from "./api";
import type { LinearHttp } from "./http";
import { authorizeUrl, exchangeCode, grantWorkspace, refreshTokens, revokeToken } from "./oauth";
import { LINEAR_SCOPES, linearSettingsFromEnv, type LinearSettings } from "./settings";

/**
 * Linear as the connector core sees it (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN1, LN2):
 * connecting, its tokens and disconnecting, through the core's `ConnectingProvider`; and its reads, which the acceptance
 * code uses with a connection's fresh token. The Linear workspace a grant reads is the connection's external
 * organisation, its id the one a webhook delivery names. Not exclusive: two Vestiarion workspaces may each connect the
 * same Linear workspace, and a delivery nudges each.
 */
export interface LinearProvider extends ConnectingProvider {
  reader: LinearReader;
  /** The app webhook's signing secret (LN11). */
  webhookSecret: string;
}

export function linearProvider(settings: LinearSettings, deps: LinearHttp = {}): LinearProvider {
  return {
    id: "linear",
    label: "Linear",
    scopes: LINEAR_SCOPES,
    authorizeUrl: (input) => authorizeUrl(settings, input),
    exchangeCode: (input) => exchangeCode(settings, input, deps),
    organisations: (tokens) => grantWorkspace(tokens.accessToken, deps),
    refresh: (refreshToken) => refreshTokens(settings, refreshToken, deps),
    revoke: (refreshToken) => revokeToken(settings, refreshToken, deps),
    reader: linearReader(deps),
    webhookSecret: settings.webhookSecret,
  };
}

/** Linear on this deployment, or null unless `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` are set. */
export function linearProviderFromEnv(): LinearProvider | null {
  const settings = linearSettingsFromEnv();
  return settings ? linearProvider(settings) : null;
}
