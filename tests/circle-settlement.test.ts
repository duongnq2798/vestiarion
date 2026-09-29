import { describe, expect, it, vi } from "vitest";
import { awaitSettlement, type SettlementClient } from "@/lib/circle/settlement";

/**
 * What a transfer Circle has accepted became. A failure to *read* its state
 * is not a failed transfer: Circle already holds a transaction id, the money
 * may have moved, and recording it as failed lets it be rejected or paid
 * again by hand. Only Circle saying so makes it failed.
 */

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
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

  it("is pending after a timeout, without reading again", async () => {
    const c = client(async () => { throw timeoutError(); });
    const result = await awaitSettlement(c, "tx-1");
    expect(result.status).toBe("pending");
    expect(c.calls).toHaveLength(1);
  });

  it("reads the transfer again after any other error, and takes Circle's answer: failed", async () => {
    const c = client(async () => { throw new Error("transaction reached a terminal state"); }, async () => transaction("FAILED"));
    const result = await awaitSettlement(c, "tx-1");
    expect(result.status).toBe("failed");
    expect(c.calls).toEqual([
      expect.objectContaining({ id: "tx-1", waitForState: "CONFIRMED" }),
      { id: "tx-1" },
    ]);
  });

  it.each(["CANCELLED", "DENIED", "STUCK"])("treats %s as failed", async (state) => {
    const c = client(async () => { throw new Error("terminal"); }, async () => transaction(state));
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
  });

  it("is pending when the second read returns no transaction", async () => {
    const c = client(async () => { throw new Error("boom"); }, async () => ({ data: {} }));
    expect((await awaitSettlement(c, "tx-1")).status).toBe("pending");
  });
});
