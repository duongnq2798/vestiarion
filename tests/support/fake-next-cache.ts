/**
 * A stand-in for Next.js's `unstable_cache`, which the public figures' shared cache wraps (src/lib/platform/public-cache.ts).
 * It records how each reader was registered, and keeps what a read returned by its key parts and arguments until
 * `clear()`. As in Next.js, a read that throws is not kept, a kept value comes back through JSON, and freshness is the
 * `revalidate` it was registered with, which the tests assert rather than wait out.
 *
 * A test file mocks `next/cache` with this one instance:
 * `vi.mock("next/cache", async () => (await import("./support/fake-next-cache")).nextCache)`, and stubs `NEXT_RUNTIME`
 * to `nodejs` for the reads to go through it.
 */

export interface Registration {
  keyParts: string[];
  revalidate: number | false | undefined;
}

function fakeNextCache() {
  const registered: Registration[] = [];
  const entries = new Map<string, string>();
  let reads = 0;
  function unstable_cache<A extends unknown[], T>(
    read: (...args: A) => Promise<T>,
    keyParts: string[] = [],
    options: { revalidate?: number | false } = {},
  ): (...args: A) => Promise<T> {
    registered.push({ keyParts, revalidate: options.revalidate });
    return async (...args: A) => {
      const key = JSON.stringify([keyParts, args]);
      const held = entries.get(key);
      if (held !== undefined) return JSON.parse(held) as T;
      reads += 1;
      const value = await read(...args);
      entries.set(key, JSON.stringify(value));
      return value;
    };
  }
  return {
    unstable_cache,
    registered,
    /** The entries held, by key parts and arguments, as JSON. */
    entries,
    /** How many reads missed and ran the reader. */
    reads: () => reads,
    clear() {
      entries.clear();
      reads = 0;
    },
  };
}

// One instance even when a test resets its modules and this file is evaluated again.
const held = globalThis as { fakeNextCache?: ReturnType<typeof fakeNextCache> };
export const nextCache = (held.fakeNextCache ??= fakeNextCache());
