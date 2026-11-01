import type { ConnectingProvider } from "../connectors/provider";
import { freshAccessToken, type AccessOutcome, type TokenStore } from "../connectors/tokens";
import { GoogleError } from "../googlesheets/http";

/**
 * Calls to Google Drive with a connection's own token (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md
 * GD13), as Linear's session makes them: the access token is refreshed only under the token row's lease; a call Google
 * refuses with a 401 refreshes once, with the refused token, and is sent again; and a second 401 means the access was
 * removed, so it throws `reconnect`. A short rate limit is waited out inside the call (`googleCall`). The token goes to
 * Google's own API only.
 */

/** Why no call could be made: the connection needs a person, another refresh holds the lease, or Google did not answer. */
export class DriveAccessError extends Error {
  constructor(readonly outcome: Exclude<AccessOutcome, { ok: true }>) {
    super(`Google Drive access: ${outcome.reason}`);
    this.name = "DriveAccessError";
  }
}

export interface DriveSession {
  call<T>(read: (accessToken: string) => Promise<T>): Promise<T>;
}

export function driveSession(input: { provider: Pick<ConnectingProvider, "refresh">; tokens: TokenStore; now?: () => number; sleep?: (ms: number) => Promise<void> }): DriveSession {
  let accessToken: string | null = null;

  async function token(refused?: string): Promise<string> {
    const outcome = await freshAccessToken({
      store: input.tokens,
      refresh: input.provider.refresh,
      ...(input.now ? { now: input.now } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
      ...(refused ? { refused } : {}),
    });
    if (!outcome.ok) throw new DriveAccessError(outcome);
    accessToken = outcome.accessToken;
    return outcome.accessToken;
  }

  return {
    async call<T>(read: (accessToken: string) => Promise<T>): Promise<T> {
      const first = accessToken ?? (await token());
      try {
        return await read(first);
      } catch (error) {
        if (!(error instanceof GoogleError) || error.failure !== "unauthorized") throw error;
      }
      const again = await token(first);
      try {
        return await read(again);
      } catch (error) {
        // A refreshed token refused too: the access was removed in the Google Account (GD13).
        if (error instanceof GoogleError && error.failure === "unauthorized") throw new GoogleError("reconnect", "Google Drive: a refreshed token was refused");
        throw error;
      }
    },
  };
}

/** Whether a failure means the connection needs a person to reconnect (GD13). */
export function needsReconnect(error: unknown): boolean {
  if (error instanceof DriveAccessError) return error.outcome.reason === "reconnect" || error.outcome.reason === "missing";
  return error instanceof GoogleError && (error.failure === "reconnect" || error.failure === "unauthorized");
}
