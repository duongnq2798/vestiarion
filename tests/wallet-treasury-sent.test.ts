import { describe, expect, it, vi } from "vitest";
import { forgetSent, recordSent, rememberSent, sentHash, type RecordAnswer, type SentStore } from "@/lib/treasury/sent-transaction";

/**
 * A transaction the owner's wallet sent for a setup step (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md
 * W8, W9), kept in the browser until the server records it: a page reloaded or closed before the chain showed it asks
 * again for the same transaction, instead of having the owner send a second contract. A moment the chain cannot be
 * read is waited out; a refusal is final.
 */

const HASH = `0x${"d1".repeat(32)}`;
const OTHER = `0x${"e2".repeat(32)}`;

function store(): SentStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

const refusing: SentStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const answers = (...list: RecordAnswer[]) => {
  const record = vi.fn<(hash: string) => Promise<RecordAnswer>>();
  for (const answer of list) record.mockResolvedValueOnce(answer);
  return record;
};
const pending: RecordAnswer = { ok: true, message: "", state: "pending" };
const verified: RecordAnswer = { ok: true, message: "", state: "verified" };
const unreadable: RecordAnswer = { ok: false, message: "The chain could not be read just now; nothing was recorded. Try again in a moment.", state: null, chainUnreadable: true };
const refused: RecordAnswer = { ok: false, message: "That deployment was not sent from this workspace's wallet.", state: null };
const sleep = vi.fn(async () => {});

describe("a sent transaction, kept in the browser", () => {
  it("is kept per workspace and per step, and forgotten on its own", () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", HASH);
    rememberSent(kept, "own-wallet-co", "approve", OTHER);
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBe(HASH);
    expect(sentHash(kept, "own-wallet-co", "approve")).toBe(OTHER);
    expect(sentHash(kept, "another-co", "deploy")).toBeNull();
    forgetSent(kept, "own-wallet-co", "deploy");
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBeNull();
    expect(sentHash(kept, "own-wallet-co", "approve")).toBe(OTHER);
  });

  it("is read only as a transaction hash", () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", "<script>");
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBeNull();
  });

  it("is nothing, without failing, where the browser refuses storage", () => {
    expect(() => rememberSent(refusing, "own-wallet-co", "deploy", HASH)).not.toThrow();
    expect(sentHash(refusing, "own-wallet-co", "deploy")).toBeNull();
    expect(() => forgetSent(refusing, "own-wallet-co", "deploy")).not.toThrow();
    expect(sentHash(null, "own-wallet-co", "deploy")).toBeNull();
  });
});

describe("recordSent", () => {
  const input = (kept: SentStore, record: (hash: string) => Promise<RecordAnswer>, tries = 3) => ({
    store: kept,
    orgSlug: "own-wallet-co",
    step: "deploy" as const,
    hash: HASH,
    record,
    tries,
    waitMs: 5_000,
    sleep,
  });

  it("asks until the chain shows it, then forgets it", async () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", HASH);
    const record = answers(pending, verified);
    expect(await recordSent(input(kept, record))).toBe("verified");
    expect(record).toHaveBeenCalledWith(HASH);
    expect(record).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBeNull();
  });

  it("keeps it while the chain has not shown it, to ask again after a reload", async () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", HASH);
    expect(await recordSent(input(kept, answers(pending, pending, pending)))).toBe("pending");
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBe(HASH);
  });

  it("waits out a moment the chain cannot be read", async () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", HASH);
    expect(await recordSent(input(kept, answers(unreadable, verified)))).toBe("verified");
  });

  it("says so when the chain is still unreadable at the last try, and keeps it", async () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", HASH);
    await expect(recordSent(input(kept, answers(pending, unreadable), 2))).rejects.toThrow(unreadable.message);
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBe(HASH);
  });

  it("gives a refusal in its own words, and forgets a transaction that will never be recorded", async () => {
    const kept = store();
    rememberSent(kept, "own-wallet-co", "deploy", HASH);
    await expect(recordSent(input(kept, answers(refused)))).rejects.toThrow(refused.message);
    expect(sentHash(kept, "own-wallet-co", "deploy")).toBeNull();
  });
});
