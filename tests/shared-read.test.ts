import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `sharedRead` keeps a public figure in Next's data cache (src/lib/platform/shared-read.ts). These run Next's own
 * `unstable_cache` against a data cache held in memory, the one a deployment finds on `globalThis.__incrementalCache`,
 * so a Next upgrade that changed what it keeps fails here: a read that failed must never be kept, and the copy is
 * keyed by the key given, not by the values the read closes over.
 */

// Next's server sets this before any of its modules load; they read it once, when imported.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

const { SHARED_READ_SECONDS, sharedRead } = await import("@/lib/platform/shared-read");

interface Kept {
  value: { kind: "FETCH"; data: { body: string } };
  revalidate: number;
  at: number;
}

function memoryCache(now: () => number) {
  const entries = new Map<string, Kept>();
  const sets: Array<{ key: string; revalidate: number }> = [];
  return {
    entries,
    sets,
    isOnDemandRevalidate: false,
    async generateSimpleCacheKey(key: string) {
      return key;
    },
    async get(key: string) {
      const entry = entries.get(key);
      if (!entry) return null;
      return { value: entry.value, isStale: now() - entry.at > entry.revalidate * 1000 };
    },
    async set(key: string, data: { data: { body: string }; revalidate: number }) {
      sets.push({ key, revalidate: data.revalidate });
      entries.set(key, { value: { kind: "FETCH", data: { body: data.data.body } }, revalidate: data.revalidate, at: now() });
    },
  };
}

const scope = globalThis as { __incrementalCache?: unknown };
let clock = 0;
let cache: ReturnType<typeof memoryCache>;

beforeEach(() => {
  clock = 1_000_000;
  cache = memoryCache(() => clock);
  scope.__incrementalCache = cache;
});

afterEach(() => {
  delete scope.__incrementalCache;
});

describe("sharedRead", () => {
  it("keeps a read for SHARED_READ_SECONDS, then reads again", async () => {
    const read = vi.fn(async () => ({ payments: 7 }));
    expect(await sharedRead(["open_numbers", "arc-testnet:all"], read)).toEqual({ payments: 7 });
    clock += (SHARED_READ_SECONDS - 1) * 1000;
    expect(await sharedRead(["open_numbers", "arc-testnet:all"], read)).toEqual({ payments: 7 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.sets).toEqual([{ key: expect.stringContaining("shared-read,open_numbers,arc-testnet:all"), revalidate: 300 }]);

    clock += 2_000;
    read.mockResolvedValueOnce({ payments: 8 });
    expect(await sharedRead(["open_numbers", "arc-testnet:all"], read)).toEqual({ payments: 8 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing from a read that failed, so the next one asks the database again", async () => {
    const read = vi
      .fn<() => Promise<{ payments: number }>>()
      .mockRejectedValueOnce(new Error("canceling statement due to statement timeout"))
      .mockResolvedValueOnce({ payments: 7 });
    await expect(sharedRead(["open_outcomes", "arc-mainnet:all"], read)).rejects.toThrow("statement timeout");
    expect(cache.entries.size).toBe(0);
    expect(await sharedRead(["open_outcomes", "arc-mainnet:all"], read)).toEqual({ payments: 7 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps each key apart, and keys on the key alone: what the read closes over must be named in it", async () => {
    const readFor = (network: string) => async () => ({ network });
    expect(await sharedRead(["open_numbers", "arc-mainnet:all"], readFor("arc-mainnet"))).toEqual({ network: "arc-mainnet" });
    expect(await sharedRead(["open_numbers", "arc-testnet:all"], readFor("arc-testnet"))).toEqual({ network: "arc-testnet" });
    // The same key with other values closed over is the copy already kept.
    expect(await sharedRead(["open_numbers", "arc-mainnet:all"], readFor("arc-testnet"))).toEqual({ network: "arc-mainnet" });
    expect(cache.entries.size).toBe(2);
  });
});
