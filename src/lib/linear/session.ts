import { waitInRun } from "../connectors/backoff";
import { ProviderError, type ConnectingProvider } from "../connectors/provider";
import { freshAccessToken, type AccessOutcome, type TokenStore } from "../connectors/tokens";

/**
 * Calls to Linear with a connection's own token (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN12), as
 * Asana's session makes them: the access token is refreshed only under the token row's lease, which matters more here,
 * since Linear answers every refresh with a new refresh token; a call Linear refuses as unauthenticated refreshes once
 * and is sent again; and a short rate limit is waited out once. The token is used for Linear's own API only.
 */

/** Why no call could be made: the connection needs a person, another refresh holds the lease, or Linear did not answer. */
export class LinearAccessError extends Error {
  constructor(readonly outcome: Exclude<AccessOutcome, { ok: true }>) {
    super(`Linear access: ${outcome.reason}`);
    this.name = "LinearAccessError";
  }
}

export interface LinearSession {
  call<T>(read: (accessToken: string) => Promise<T>): Promise<T>;
}

export function linearSession(input: {
  provider: Pick<ConnectingProvider, "refresh">;
  tokens: TokenStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): LinearSession {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let accessToken: string | null = null;

  async function token(refused?: string): Promise<string> {
    const outcome = await freshAccessToken({ store: input.tokens, refresh: input.provider.refresh, now, sleep, ...(refused ? { refused } : {}) });
    if (!outcome.ok) throw new LinearAccessError(outcome);
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
