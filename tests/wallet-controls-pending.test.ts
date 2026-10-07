import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { forgetPendingControl, keepPendingControl, pendingControl, settleControl } from "@/lib/treasury/pending-control";
import type { RecordAnswer } from "@/lib/passkey-treasury";

/**
 * A control a treasury's wallet sent from this browser, kept until the server records it (treasury wallet controls,
 * review I1): a page reloaded, or a confirmation slower than the page waits, asks about it again instead of leaving the
 * agent unpaused after a stop, or its spending limit behind the contract's figures.
 */

const TX = `0x${"c7".repeat(32)}` as Hex;
const OP = `0x${"0e".repeat(32)}` as Hex;
const ORG = "own-wallet-co";
const LABEL = "Arc mainnet";

function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const answer = (state: RecordAnswer["state"], ok = true, message = ""): RecordAnswer => ({ ok, state, message });
const settle = (store: ReturnType<typeof memoryStore>, record: (txHash: string) => Promise<RecordAnswer>, outcome: Parameters<typeof settleControl>[0]["outcome"] = { kind: "sent", txHash: TX }) => {
  const say = vi.fn();
  return { say, settled: settleControl({ store, orgSlug: ORG, kind: "stop", outcome, record, tries: 3, waitMs: 0, sleep: async () => {}, label: LABEL, say }) };
};

describe("settleControl", () => {
  it("keeps the control before it asks, and forgets it once recorded", async () => {
    const store = memoryStore();
    const record = vi.fn(async () => {
      expect(pendingControl(store, ORG)).toEqual({ kind: "stop", txHash: TX });
      return record.mock.calls.length < 2 ? answer("pending") : answer("verified");
    });
    const { settled } = settle(store, record);
    expect(await settled).toBe("verified");
    expect(record).toHaveBeenCalledWith(TX);
    expect(pendingControl(store, ORG)).toBeNull();
  });

  it("keeps it when the chain has not shown it after the tries, and says a reload asks again", async () => {
    const store = memoryStore();
    const { settled, say } = settle(store, async () => answer("pending"));
    expect(await settled).toBe("pending");
    expect(pendingControl(store, ORG)).toEqual({ kind: "stop", txHash: TX });
    expect(say).toHaveBeenLastCalledWith(`Sent. ${LABEL} has not confirmed it yet; reload this page in a minute to check it again. It is not sent twice.`);
  });

  it("keeps a passkey's user operation until its transaction is known, without asking the server", async () => {
    const store = memoryStore();
    const record = vi.fn(async () => answer("verified"));
    const { settled } = settle(store, record, { kind: "unconfirmed", userOpHash: OP });
    expect(await settled).toBe("pending");
    expect(record).not.toHaveBeenCalled();
    expect(pendingControl(store, ORG)).toEqual({ kind: "stop", userOpHash: OP });
  });

  it("forgets one the server refused, and says why in its words", async () => {
    const store = memoryStore();
    const { settled } = settle(store, async () => answer(null, false, "That transaction is not this change on the contract; nothing was recorded."));
    await expect(settled).rejects.toThrow("That transaction is not this change on the contract; nothing was recorded.");
    expect(pendingControl(store, ORG)).toBeNull();
  });

  it("forgets one that reverted, which cost only its fee", async () => {
    const store = memoryStore();
    const { settled } = settle(store, async () => answer("verified"), { kind: "reverted", txHash: TX });
    await expect(settled).rejects.toThrow(`${LABEL} did not carry it out; only its network fee was spent.`);
    expect(pendingControl(store, ORG)).toBeNull();
  });
});

describe("pendingControl", () => {
  it("reads back only a control it could have kept", () => {
    const key = `vestiarion.wallet-treasury.${ORG}.control`;
    expect(pendingControl(memoryStore({ [key]: "{not json" }), ORG)).toBeNull();
    expect(pendingControl(memoryStore({ [key]: JSON.stringify({ kind: "withdraw", txHash: TX }) }), ORG)).toBeNull();
    expect(pendingControl(memoryStore({ [key]: JSON.stringify({ kind: "stop" }) }), ORG)).toBeNull();
    expect(pendingControl(memoryStore({ [key]: JSON.stringify({ kind: "stop", txHash: "0x12" }) }), ORG)).toBeNull();
    expect(pendingControl(memoryStore({ [key]: JSON.stringify({ kind: "figures", txHash: TX, extra: 1 }) }), ORG)).toEqual({ kind: "figures", txHash: TX });
    expect(pendingControl(null, ORG)).toBeNull();
  });

  it("keeps one per workspace, and forgets it", () => {
    const store = memoryStore();
    keepPendingControl(store, ORG, { kind: "resume", txHash: TX });
    expect(pendingControl(store, "another-co")).toBeNull();
    forgetPendingControl(store, ORG);
    expect(pendingControl(store, ORG)).toBeNull();
  });
});
