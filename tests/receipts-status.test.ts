import { describe, expect, it } from "vitest";
import type { ReceiptFacts } from "@/lib/receipts/facts";
import { receiptStatus, receiptTime } from "@/lib/receipts/status";

/**
 * A receipt says plainly where its payment is, and from which source (settlement lifecycle L7, I17): confirmed by
 * Circle, as the paying workspace recorded it; reconciled only once this page found the transfer on the chain and the
 * signed entry that records it.
 */

const facts: ReceiptFacts = {
  amount: 2,
  token: "USDC",
  paidAt: "2026-10-01T08:28:26.857Z",
  payee: `0x${"22".repeat(20)}`,
  chain: "ARC-TESTNET",
  txHash: `0x${"ab".repeat(32)}`,
  route: "direct",
};
const ok = { ok: true } as const;

describe("receiptStatus", () => {
  it("is reconciled when every check passes, naming the block and the entry", () => {
    expect(receiptStatus({ facts, records: { seq: 580 }, checks: { signed: ok, recorded: ok, onChain: { state: "matches", block: 314 } } })).toEqual({
      state: "reconciled",
      label: "Reconciled",
      sentence:
        "Confirmed by Circle on 1 October 2026, 08:28 UTC, as the paying workspace recorded it. This page found the transfer on Arc testnet in block 314, and entry #580 in the workspace's signed ledger records it.",
    });
  });

  it("is only confirmed while a check could not be made, and says which", () => {
    const unread = receiptStatus({ facts, records: { seq: 580 }, checks: { signed: ok, recorded: ok, onChain: { state: "unreadable" } } });
    expect(unread).toMatchObject({ state: "confirmed", label: "Confirmed" });
    expect(unread.sentence).toBe("Confirmed by Circle on 1 October 2026, 08:28 UTC, as the paying workspace recorded it. Not reconciled just now: Arc testnet did not answer this page.");
    const unrecorded = receiptStatus({ facts, records: { seq: 580 }, checks: { signed: ok, recorded: { ok: null, reason: "x" }, onChain: { state: "matches", block: 1 } } });
    expect(unrecorded.sentence).toContain("Not reconciled just now: the entry that records it could not be checked here.");
    const unsigned = receiptStatus({ facts, records: { seq: 580 }, checks: { signed: { ok: null, reason: "x" }, recorded: ok, onChain: { state: "matches", block: 1 } } });
    expect(unsigned.sentence).toContain("Not reconciled just now: the workspace's signature could not be checked here.");
    // Never "does not pass" for a check that could not be made (receipts review #10).
    for (const status of [unread, unrecorded, unsigned]) expect(status.sentence).not.toContain("does not pass");
  });

  it("is not reconciled when a check does not pass", () => {
    for (const checks of [
      { signed: { ok: false, reason: "x" } as const, recorded: ok, onChain: { state: "matches", block: 1 } as const },
      { signed: ok, recorded: { ok: false, reason: "x" } as const, onChain: { state: "matches", block: 1 } as const },
      { signed: ok, recorded: ok, onChain: { state: "mismatch", reason: "x" } as const },
    ]) {
      expect(receiptStatus({ facts, records: { seq: 580 }, checks })).toEqual({
        state: "not_reconciled",
        label: "Not reconciled",
        sentence: "Confirmed by Circle on 1 October 2026, 08:28 UTC, as the paying workspace recorded it. A check below does not pass, so it is not reconciled.",
      });
    }
  });

  it("names the chain the payee was paid on, from its own id", () => {
    const mainnet = receiptStatus({ facts: { ...facts, chain: "ARC" }, records: { seq: 1 }, checks: { signed: ok, recorded: ok, onChain: { state: "unreadable" } } });
    expect(mainnet.sentence).toContain("Not reconciled just now: Arc mainnet did not answer this page.");
    expect(mainnet.sentence).not.toContain("testnet");
  });
});

describe("receiptTime", () => {
  it("is the same on the server and in every browser, and empty for a time that is not one", () => {
    expect(receiptTime("2026-10-01T08:28:26.857Z")).toBe("1 October 2026, 08:28 UTC");
    expect(receiptTime("")).toBe("");
  });
});
