import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { chainModes, getChainProvider } from "@/lib/circle";
import { LiveProvider } from "@/lib/circle/liveProvider";
import type { SwapCallParams } from "@/lib/circle/types";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * R12: an organization's Circle credentials can be *stored* but unreadable —
 * sealed under a master key this deployment no longer holds, or corrupted in
 * transit. That must never look like "no Circle credentials configured",
 * which is sandbox mode and would let a live organization's payments quietly
 * simulate while its invoices are marked paid (spec §5.4).
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function withUnreadableCredentials(reason: string) {
  return { ...config, chain: { ...config.chain, credentialsUnreadable: reason } };
}

describe("getChainProvider — stored Circle credentials that cannot be read", () => {
  it("refuses rather than falling back to simulated payments", () => {
    const reason = "could not decrypt circle_api_key_enc of organization x: wrong master key, or the ciphertext was altered or moved";
    runWith({ ...orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), config: withUnreadableCredentials(reason) }, () => {
      expect(() => getChainProvider()).toThrow(
        `This organization's Circle credentials are stored but could not be read (${reason}); refusing to fall back to simulated payments`
      );
    });
  });

  it("does not refuse an organization with no stored Circle credentials at all", () => {
    runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), () => {
      expect(() => getChainProvider()).not.toThrow();
      expect(getChainProvider().mode).toBe("simulate");
    });
  });
});

describe("chainModes — must render a page even when getChainProvider() refuses", () => {
  it("reports simulate/simulate without constructing a provider", () => {
    const reason = "could not decrypt circle_entity_secret_enc of organization x: wrong master key, or the ciphertext was altered or moved";
    runWith({ ...orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), config: withUnreadableCredentials(reason) }, () => {
      expect(chainModes()).toEqual({ mode: "simulate", earnMode: "simulate" });
    });
  });

  it("still reports the real provider's modes when credentials are readable", () => {
    // Placeholder credentials build the real HybridProvider — live payments,
    // simulated yield — because constructing Circle's SDK client makes no
    // request. That answer differs from the simulate/simulate shortcut
    // above, so this can tell the provider from the shortcut.
    const readable = { ...config, chain: { ...config.chain, circleApiKey: "placeholder-api-key", circleEntitySecret: "placeholder-entity-secret" } };
    runWith({ ...orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), config: readable }, () => {
      expect(chainModes()).toEqual({ mode: "live", earnMode: "simulate" });
    });
  });
});

describe("getChainProvider — a live workspace's provider offers everything its live leg can do", () => {
  // A workspace with Circle credentials gets the HybridProvider: live payments, simulated yield. Every
  // optional capability the agent checks for (`provider.swapForEurc && …`) must reach the live leg, or
  // the agent silently never uses it in production. Before this, the swap (EURC swap spec S6) was missing.
  const readable = { ...config, chain: { ...config.chain, circleApiKey: "placeholder-api-key", circleEntitySecret: "placeholder-entity-secret" } };
  const inLiveWorkspace = <T,>(fn: () => T) => runWith({ ...orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), config: readable }, fn);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swaps USDC for EURC through the live leg", async () => {
    const answer = { approve: { txId: "a", txHash: "0xa", state: "COMPLETE" }, execute: { txId: "e", txHash: "0xe", state: "COMPLETE" } };
    const swap = vi.spyOn(LiveProvider.prototype, "swapForEurc").mockResolvedValue(answer as never);
    const params = { fromAccountId: "operating" } as unknown as SwapCallParams;
    await inLiveWorkspace(async () => {
      const provider = getChainProvider();
      expect(provider.mode).toBe("live");
      expect(typeof provider.swapForEurc).toBe("function");
      expect(await provider.swapForEurc!(params)).toBe(answer);
    });
    expect(swap).toHaveBeenCalledWith(params);
  });

  it("reads inbound transfers through the live leg (receivables on Arc)", async () => {
    const inbound = vi.spyOn(LiveProvider.prototype, "listInboundTransfers").mockResolvedValue([]);
    await inLiveWorkspace(async () => {
      const provider = getChainProvider();
      expect(typeof provider.listInboundTransfers).toBe("function");
      expect(await provider.listInboundTransfers!("operating", "2026-10-01T00:00:00Z")).toEqual([]);
    });
    expect(inbound).toHaveBeenCalledWith("operating", "2026-10-01T00:00:00Z");
  });

  it("reads a token balance through the live leg", async () => {
    const balance = vi.spyOn(LiveProvider.prototype, "getTokenBalance").mockResolvedValue({ balance: 3 } as never);
    await inLiveWorkspace(async () => {
      expect(await getChainProvider().getTokenBalance!("operating", "EURC")).toEqual({ balance: 3 });
    });
    expect(balance).toHaveBeenCalledWith("operating", "EURC");
  });
});

describe("getChainProvider — the USYC reserve (USYC live design R1)", () => {
  const readable = (usycLive: boolean) => ({ ...config, chain: { ...config.chain, circleApiKey: "placeholder-api-key", circleEntitySecret: "placeholder-entity-secret", usycLive } });
  const inWorkspace = <T,>(usycLive: boolean, fn: () => T) => runWith({ ...orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), config: readable(usycLive) }, fn);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is real USYC, through the live leg, once the workspace turned it on", async () => {
    const result = { txRef: "0xd", positionValue: 10, apy: 0 };
    const deposit = vi.spyOn(LiveProvider.prototype, "depositToEarn").mockResolvedValue(result);
    const position = vi.spyOn(LiveProvider.prototype, "getEarnPosition").mockResolvedValue({ shares: 1, valueUsdc: 1.13, price: 1.13 });
    await inWorkspace(true, async () => {
      expect(chainModes()).toEqual({ mode: "live", earnMode: "live" });
      const params = { accountId: "op", reserveAccountId: "res", key: "k", amount: 10 };
      expect(await getChainProvider().depositToEarn(params)).toBe(result);
      expect(await getChainProvider().getEarnPosition!("res")).toEqual({ shares: 1, valueUsdc: 1.13, price: 1.13 });
    });
    expect(deposit).toHaveBeenCalledWith({ accountId: "op", reserveAccountId: "res", key: "k", amount: 10 });
    expect(position).toHaveBeenCalledWith("res");
  });

  it("stays simulated, never touching the live leg, until it is turned on", async () => {
    const deposit = vi.spyOn(LiveProvider.prototype, "depositToEarn");
    await inWorkspace(false, async () => {
      expect(chainModes()).toEqual({ mode: "live", earnMode: "simulate" });
      await expect(getChainProvider().getEarnPosition!("res")).rejects.toThrow("The USYC reserve is simulated");
    });
    expect(deposit).not.toHaveBeenCalled();
  });
});
