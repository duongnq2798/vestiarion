import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextCache } from "./support/fake-next-cache";

/**
 * The public figures' shared cache (docs/superpowers/specs/2026-11-19-public-figures-cache-design.md): Next.js's data
 * cache, kept per deployment and fresh for a minute, which a read that fails never enters.
 */

vi.mock("next/cache", async () => (await import("./support/fake-next-cache")).nextCache);

async function load() {
  vi.resetModules();
  return import("@/lib/platform/public-cache");
}

beforeEach(() => {
  nextCache.clear();
  nextCache.registered.length = 0;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("publicRead", () => {
  it("keeps an entry fresh for a minute, the freshness the pages have always promised (PF2)", async () => {
    const { PUBLIC_READ_SECONDS, publicRead } = await load();
    publicRead("open-numbers", async () => 1);
    expect(PUBLIC_READ_SECONDS).toBe(60);
    expect(nextCache.registered).toEqual([{ keyParts: ["public-figures", "", "open-numbers"], revalidate: 60 }]);
  });

  it("keys every entry by the deployment, so a value never reaches code that expects another shape (PF4)", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_123");
    const { publicRead } = await load();
    publicRead("landing-team-journeys", async () => 1);
    expect(nextCache.registered[0].keyParts).toEqual(["public-figures", "dpl_123", "landing-team-journeys"]);
  });

  it("answers the same arguments from the cache inside Next.js, and other arguments with a read of their own (PF1)", async () => {
    const { publicRead } = await load();
    const read = vi.fn(async (network: string) => ({ network, at: "2026-11-19T00:00:00Z" }));
    const cached = publicRead("open-numbers", read);
    await cached("arc-testnet");
    expect(await cached("arc-testnet")).toEqual({ network: "arc-testnet", at: "2026-11-19T00:00:00Z" });
    expect(read).toHaveBeenCalledTimes(1);
    await cached("arc-mainnet");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never keeps a read that failed: its caller gets the error, and the next call reads again (PF3)", async () => {
    const { publicRead } = await load();
    const read = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue(7);
    const cached = publicRead("recent-team-decisions", read);
    await expect(cached()).rejects.toThrow("connection reset");
    expect(await cached()).toBe(7);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads the database itself outside Next.js, where there is no cache to keep entries in", async () => {
    vi.stubEnv("NEXT_RUNTIME", "");
    const { publicRead } = await load();
    const read = vi.fn(async () => 1);
    const cached = publicRead("latest-team-decision", read);
    await cached();
    await cached();
    expect(read).toHaveBeenCalledTimes(2);
    expect(nextCache.reads()).toBe(0);
  });
});
