import crypto from "node:crypto";
import type { ProviderTokens, RefreshOutcome } from "./provider";

/**
 * A connection's access token, refreshed so two refreshes never race
 * (docs/superpowers/specs/2026-10-12-xero-connector-design.md X5). A provider that rotates its refresh token (Xero
 * does, on every use) locks a connection out when two refreshes send the same refresh token, or when a slower one
 * stores its pair over a newer one. So a refresh happens only under the token row's lease, outside any transaction,
 * and is stored only by the lease's holder over the version it read (`accounting_token_lease`,
 * `accounting_token_store`, migration 0101). A caller that finds the lease taken waits and reads what its holder
 * stored. The store is injected: `token-store.ts` is the database's, the tests have their own.
 */

/** A token row, opened. */
export interface StoredTokens {
  id: string;
  version: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface TokenStore {
  read(): Promise<StoredTokens | null>;
  /** The row as it is now, when the lease was free and is now `holder`'s; null when another holder has it. */
  lease(holder: string, seconds: number): Promise<StoredTokens | null>;
  /** Stores a refreshed pair only for the lease's holder over `version`: false when either changed. */
  store(holder: string, version: number, tokens: ProviderTokens): Promise<boolean>;
  release(holder: string): Promise<void>;
}

export type AccessOutcome =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "reconnect" | "busy" | "missing" }
  | { ok: false; reason: "unavailable"; retryAfterMs: number | null };

/** An access token with less than this left is refreshed first. */
export const EXPIRY_MARGIN_MS = 60_000;
/** A refresh's lease: far longer than one token request takes. */
export const LEASE_SECONDS = 60;
const WAITS = 10;
const WAIT_MS = 500;

const usable = (row: StoredTokens, nowMs: number) => row.expiresAt - nowMs > EXPIRY_MARGIN_MS;

export async function freshAccessToken(input: {
  store: TokenStore;
  refresh: (refreshToken: string) => Promise<RefreshOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The access token the provider just refused (a 401): refreshed whatever its expiry says, unless it was replaced already. */
  refused?: string;
  holder?: string;
}): Promise<AccessOutcome> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { store } = input;
  // Good to use: not the token just refused, and not about to expire.
  const good = (row: StoredTokens) => row.accessToken !== input.refused && usable(row, now());

  const current = await store.read();
  if (!current) return { ok: false, reason: "missing" };
  if (good(current)) return { ok: true, accessToken: current.accessToken };

  const holder = input.holder ?? crypto.randomUUID();
  for (let attempt = 0; attempt <= WAITS; attempt += 1) {
    const leased = await store.lease(holder, LEASE_SECONDS);
    if (leased) {
      // Another holder may have stored a pair between the read and this lease: use it.
      if (good(leased)) {
        await store.release(holder);
        return { ok: true, accessToken: leased.accessToken };
      }
      const outcome = await input.refresh(leased.refreshToken);
      if (!outcome.ok) {
        await store.release(holder);
        return outcome.reason === "reconnect" ? { ok: false, reason: "reconnect" } : { ok: false, reason: "unavailable", retryAfterMs: outcome.retryAfterMs };
      }
      if (!(await store.store(holder, leased.version, outcome.tokens))) {
        // The lease ran out during the refresh and another holder has the row now: its pair stands. This run's access
        // token still works until it expires; the refresh token it came with is dropped.
        console.error("connector: a refreshed token was not stored, the lease had moved on", leased.id);
      }
      return { ok: true, accessToken: outcome.tokens.accessToken };
    }
    if (attempt === WAITS) break;
    await sleep(WAIT_MS);
    const after = await store.read();
    if (after && good(after)) return { ok: true, accessToken: after.accessToken };
  }
  return { ok: false, reason: "busy" };
}
