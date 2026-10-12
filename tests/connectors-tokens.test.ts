import { describe, expect, it, vi } from "vitest";
import type { ProviderTokens, RefreshOutcome } from "@/lib/connectors/provider";
import { freshAccessToken, type StoredTokens, type TokenStore } from "@/lib/connectors/tokens";

/**
 * A refresh that cannot race (docs/superpowers/specs/2026-10-12-xero-connector-design.md X5). The provider rotates its
 * refresh token on every use, so two refreshes with the same one, or a slower one storing over a newer pair, would lock
 * the connection out. Here the store behaves as the database's lease and compare-and-set do, against a clock the test
 * moves.
 */

const NOW = Date.parse("2026-10-12T08:00:00.000Z");

/** The token row and its two functions, as migration 0101 has them. */
function memoryStore(initial: StoredTokens) {
  let row = { ...initial, leaseHolder: null as string | null, leaseUntil: 0 };
  let clock = NOW;
  const store: TokenStore = {
    async read() {
      return { id: row.id, version: row.version, accessToken: row.accessToken, refreshToken: row.refreshToken, expiresAt: row.expiresAt, scopes: row.scopes };
    },
    async lease(holder, seconds) {
      if (row.leaseHolder !== null && row.leaseUntil > clock) return null;
      row = { ...row, leaseHolder: holder, leaseUntil: clock + seconds * 1000 };
      return store.read();
    },
    async store(holder, version, tokens) {
      if (row.leaseHolder !== holder || row.version !== version) return false;
      row = { ...row, ...tokens, version: row.version + 1, leaseHolder: null, leaseUntil: 0 };
      return true;
    },
    async release(holder) {
      if (row.leaseHolder === holder) row = { ...row, leaseHolder: null, leaseUntil: 0 };
    },
  };
  return { store, get: () => row, tick: (ms: number) => (clock += ms), steal: (holder: string) => (row = { ...row, leaseHolder: holder, leaseUntil: clock + 60_000 }) };
}

const expiring: StoredTokens = { id: "tok-1", version: 3, accessToken: "access-old", refreshToken: "refresh-old", expiresAt: NOW + 30_000, scopes: ["offline_access"] };
const fresh: ProviderTokens = { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: NOW + 1_800_000, scopes: ["offline_access"] };

describe("freshAccessToken", () => {
  it("gives the access token while it has more than a minute left, without a lease or a refresh", async () => {
    const memory = memoryStore({ ...expiring, expiresAt: NOW + 120_000 });
    const refresh = vi.fn();
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW })).toEqual({ ok: true, accessToken: "access-old" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token under the lease and stores the new pair over the version it read", async () => {
    const memory = memoryStore(expiring);
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: fresh }));
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW })).toEqual({ ok: true, accessToken: "access-new" });
    expect(refresh).toHaveBeenCalledWith("refresh-old");
    expect(memory.get()).toMatchObject({ version: 4, accessToken: "access-new", refreshToken: "refresh-new", leaseHolder: null });
  });

  it("sends one refresh for two callers at once: the second waits and reads what the first stored", async () => {
    const memory = memoryStore(expiring);
    let finish: (outcome: RefreshOutcome) => void = () => undefined;
    const refresh = vi.fn(() => new Promise<RefreshOutcome>((resolve) => (finish = resolve)));
    const sleep = vi.fn(async () => {
      // While the second caller waits, the first one's refresh answers.
      finish({ ok: true, tokens: fresh });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const first = freshAccessToken({ store: memory.store, refresh, now: () => NOW, sleep });
    const second = freshAccessToken({ store: memory.store, refresh, now: () => NOW, sleep });
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, accessToken: "access-new" },
      { ok: true, accessToken: "access-new" },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(memory.get().version).toBe(4);
  });

  it("never stores over a newer pair: a refresh that lost its lease keeps the row as the newer holder left it", async () => {
    const memory = memoryStore(expiring);
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => {
      // The lease ran out during a slow refresh, and another holder took it.
      memory.steal("someone-else");
      return { ok: true, tokens: fresh };
    });
    const outcome = await freshAccessToken({ store: memory.store, refresh, now: () => NOW });
    expect(outcome).toEqual({ ok: true, accessToken: "access-new" });
    expect(memory.get()).toMatchObject({ version: 3, refreshToken: "refresh-old", leaseHolder: "someone-else" });
  });

  it("uses a pair another holder stored between the read and the lease, without refreshing", async () => {
    const memory = memoryStore(expiring);
    const refresh = vi.fn();
    const store: TokenStore = {
      ...memory.store,
      async lease(holder, seconds) {
        const leased = await memory.store.lease(holder, seconds);
        return leased ? { ...leased, version: 4, accessToken: "access-theirs", expiresAt: NOW + 1_800_000 } : null;
      },
    };
    expect(await freshAccessToken({ store, refresh, now: () => NOW })).toEqual({ ok: true, accessToken: "access-theirs" });
    expect(refresh).not.toHaveBeenCalled();
    expect(memory.get().leaseHolder).toBeNull();
  });

  it("asks for a reconnect when the provider refuses the refresh token, and lets the lease go", async () => {
    const memory = memoryStore(expiring);
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: false, reason: "reconnect" }));
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW })).toEqual({ ok: false, reason: "reconnect" });
    expect(memory.get()).toMatchObject({ version: 3, leaseHolder: null });
  });

  it("says the provider is unavailable, with its wait, when the refresh fails for now", async () => {
    const memory = memoryStore(expiring);
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: false, reason: "unavailable", retryAfterMs: 30_000 }));
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW })).toEqual({ ok: false, reason: "unavailable", retryAfterMs: 30_000 });
    expect(memory.get().leaseHolder).toBeNull();
  });

  it("says busy when another holder keeps the lease and stores nothing while it waits", async () => {
    const memory = memoryStore(expiring);
    memory.steal("someone-else");
    const refresh = vi.fn();
    const sleep = vi.fn(async () => undefined);
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW, sleep })).toEqual({ ok: false, reason: "busy" });
    expect(refresh).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalled();
  });

  it("refreshes a token the provider just refused, however long it has left, unless another holder already did", async () => {
    const memory = memoryStore({ ...expiring, expiresAt: NOW + 1_000_000 });
    const refresh = vi.fn(async (): Promise<RefreshOutcome> => ({ ok: true, tokens: fresh }));
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW, refused: "access-old" })).toEqual({ ok: true, accessToken: "access-new" });
    expect(refresh).toHaveBeenCalledTimes(1);
    // The token refused is no longer the one stored: the newer one is given without another refresh.
    expect(await freshAccessToken({ store: memory.store, refresh, now: () => NOW, refused: "access-old" })).toEqual({ ok: true, accessToken: "access-new" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("says missing when the connection has no tokens", async () => {
    const store: TokenStore = { read: async () => null, lease: async () => null, store: async () => false, release: async () => undefined };
    expect(await freshAccessToken({ store, refresh: vi.fn(), now: () => NOW })).toEqual({ ok: false, reason: "missing" });
  });
});
