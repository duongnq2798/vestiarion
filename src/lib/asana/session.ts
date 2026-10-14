import { waitInRun } from "../connectors/backoff";
import { ProviderError, type ConnectingProvider } from "../connectors/provider";
import { freshAccessToken, type AccessOutcome, type TokenStore } from "../connectors/tokens";

/**
 * Calls to Asana with a connection's own token (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A11), as
 * the connector core's runners make them: the access token is refreshed only under the token row's lease, a call Asana
 * refuses with 401 refreshes once and is sent again, and a short rate limit is waited out once. The token is used for
 * Asana's own API only: `asanaFetch` sends nothing anywhere else.
 */

/** Why no call could be made: the connection needs a person, another refresh holds the lease, or Asana did not answer. */
export class AsanaAccessError extends Error {
  constructor(readonly outcome: Exclude<AccessOutcome, { ok: true }>) {
    super(`Asana access: ${outcome.reason}`);
    this.name = "AsanaAccessError";
  }
}

export interface AsanaSession {
  call<T>(read: (accessToken: string) => Promise<T>): Promise<T>;
}

export function asanaSession(input: {
  provider: Pick<ConnectingProvider, "refresh">;
  tokens: TokenStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): AsanaSession {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let accessToken: string | null = null;

  async function token(refused?: string): Promise<string> {
    const outcome = await freshAccessToken({ store: input.tokens, refresh: input.provider.refresh, now, sleep, ...(refused ? { refused } : {}) });
    if (!outcome.ok) throw new AsanaAccessError(outcome);
    accessToken = outcome.accessToken;
    return outcome.accessToken;
  }

  return {
    async call<T>(read: (accessToken: string) => Promise<T>): Promise<T> {
      let current = accessToken ?? (await token());
      let waited = false;
      let refreshed = false;
      for (;;) {
        try {
          return await read(current);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (error.failure === "rate_limited" && !waited && waitInRun(error.retryAfterMs)) {
            waited = true;
            await sleep(error.retryAfterMs ?? 0);
            continue;
          }
          if (error.failure === "unauthorized" && !refreshed) {
            refreshed = true;
            current = await token(current);
            continue;
          }
          throw error;
        }
      }
    },
  };
}
