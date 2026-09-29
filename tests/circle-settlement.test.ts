import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitSettlement, type SettlementClient } from "@/lib/circle/settlement";

/**
 * What a transfer Circle has accepted became. A failure to *read* its state
 * is not a failed transfer: Circle already holds a transaction id, the money
 * may have moved, and recording it as failed lets it be rejected or paid
 * again by hand. Only Circle saying so makes it failed.
 *
 * The rejections below have the shapes @circle-fin/developer-controlled-wallets
 * 10.8.1 actually produces: its wait throws a plain Error naming a terminal
 * state, and an AbortError (whose cause is the TimeoutError) when its signal
 * fires — never an error named TimeoutError itself.
 */

function sdkTimeout(): Error {
  const cause = new Error("The operation was aborted due to timeout");
  cause.name = "TimeoutError";
  const error = new DOMException("The operation was aborted", "AbortError") as unknown as Error;
  Object.defineProperty(error, "cause", { value: cause });
  return error;
}

function sdkTerminal(state: string): Error {
  return new Error(`Transaction tx-1 ${state} (INSUFFICIENT_NATIVE_TOKEN): details`);
}

function transaction(state: string, extra: Record<string, unknown> = {}) {
  return { data: { transaction: { id: "tx-1", state, createDate: "2026-09-29T00:00:00Z", ...extra } } };
}

function client(wait: () => Promise<unknown>, reread?: () => Promise<unknown>): SettlementClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getTransaction: vi.fn(async (input: { id: string; waitForState?: string }) => {
      calls.push(input);
      if (input.waitForState) return wait();
      if (!reread) throw new Error("no reread expected");
      return reread();
    }) as unknown as SettlementClient["getTransaction"],
  };
}

const never = () => new Promise<never>(() => {});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

describe("awaitSettlement", () => {
  it("is confirmed when Circle reports the transfer confirmed", async () => {
    const c = client(async () => transaction("CONFIRMED", { txHash: "0xabc" }));
    const result = await awaitSettlement(c, "tx-1");
    expect(result.status).toBe("confirmed");
    expect(result.transaction?.txHash).toBe("0xabc");
    expect(c.calls).toHaveLength(1);
  });

  it("is pending when Circle has not confirmed it yet", async () => {
    const c = client(async () => transaction("SENT"));
    expect((await awaitSettlement(c, "tx-1")).status).toBe("pending");
  });

  it("reads again when the wait runs out, and stays pending while Circle has not settled it", async () => {
    const c = client(async () => { throw sdkTimeout(); }, async () => transaction("SENT"));
    const result = await awaitSettlement(c, "tx-1");
    expect(result.status).toBe("pending");
    expect(c.calls).toEqual([
      expect.objectContaining({ id: "tx-1", waitForState: "CONFIRMED" }),
      { id: "tx-1" },
    ]);
  });

  it("is confirmed when the wait ran out just before Circle confirmed", async () => {
    const c = client(async () => { throw sdkTimeout(); }, async () => transaction("COMPLETE", { txHash: "0x1" }));
    expect((await awaitSettlement(c, "tx-1")).status).toBe("confirmed");
  });

  it.each(["FAILED", "CANCELLED", "DENIED", "STUCK"])("is failed when Circle reports %s", async (state) => {
    const c = client(async () => { throw sdkTerminal(state); }, async () => transaction(state));
    expect((await awaitSettlement(c, "tx-1")).status).toBe("failed");
  });

  it("is confirmed when a network error hid a transfer that settled", async () => {
    const c = client(async () => { throw new TypeError("fetch failed"); }, async () => transaction("COMPLETE", { txHash: "0xdef" }));
    const result = await awaitSettlement(c, "tx-1");
    expect(result.status).toBe("confirmed");
    expect(result.transaction?.txHash).toBe("0xdef");
  });

  it("is pending when the transfer's state cannot be read at all", async () => {
    const c = client(async () => { throw new TypeError("fetch failed"); }, async () => { throw new TypeError("fetch failed"); });
    expect((await awaitSettlement(c, "tx-1")).status).toBe("pending");
    // Each failed read is logged with the transaction id and the error's message only.
    expect(warn.mock.calls).toEqual([
      ["circle: settlement read failed", "tx-1", "fetch failed"],
      ["circle: settlement read failed", "tx-1", "fetch failed"],
    ]);
  });

  it("is pending when the second read returns no transaction", async () => {
    const c = client(async () => { throw new Error("boom"); }, async () => ({ data: {} }));
    expect((await awaitSettlement(c, "tx-1")).status).toBe("pending");
  });

  it("does not hang on a request that never answers: the wait and the second read each give up", async () => {
    vi.useFakeTimers();
    const c = client(never, never);
    const settled = awaitSettlement(c, "tx-1", { waitMs: 1_000, rereadMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 - 1);
    expect(c.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toEqual({ status: "pending" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
