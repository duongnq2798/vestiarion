import { describe, expect, it } from "vitest";
import { amountsLine, groupAddress, looksLikeAddress, maskAddress, payeeStage, paymentState, type PayeeLinkStatus, type PayeePayment } from "@/lib/payee-journey";

/** The freelancer's side of a payment (docs/superpowers/specs/2026-10-02-freelancer-journey-design.md §2–§4). */

const ADDRESS = "0x1234567890abcdef1234567890abcdef1234abcd";

const payment = (over: Partial<PayeePayment> = {}): PayeePayment => ({
  kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "verified", txRef: null, settledAt: null, scheduledFor: null, ...over,
});

const status = (over: Partial<PayeeLinkStatus> = {}): PayeeLinkStatus => ({
  orgName: "Northstar", payeeName: "Linh Tran", chain: "ARC-TESTNET", linkState: "used", expiresAt: "2026-10-09T00:00:00Z", usedAt: "2026-10-02T09:00:00Z",
  statusUntil: "2026-11-01T09:00:00Z", address: ADDRESS, addressConfirmed: true, payments: [payment()], ...over,
});

describe("payeeStage", () => {
  it("asks for the address while the link is unused", () => {
    expect(payeeStage(status({ linkState: "open", address: null, addressConfirmed: false }))).toBe("address");
  });

  it("waits for the business to confirm an address it has not confirmed", () => {
    expect(payeeStage(status({ addressConfirmed: false }))).toBe("confirming");
    expect(payeeStage(status({ address: null, addressConfirmed: false }))).toBe("confirming");
  });

  it("follows the payments once the address is confirmed, and is paid when every one is", () => {
    expect(payeeStage(status())).toBe("paying");
    expect(payeeStage(status({ payments: [payment({ status: "paid", txRef: "0xabc" }), payment({ status: "held" })] }))).toBe("paying");
    expect(payeeStage(status({ payments: [payment({ status: "paid", txRef: "0xabc" })] }))).toBe("paid");
    expect(payeeStage(status({ payments: [] }))).toBe("paying");
  });
});

describe("paymentState (R3)", () => {
  it.each([
    [payment({ status: "pending" }), "Waiting for Northstar to approve the work", "waiting"],
    [payment({ status: "verified" }), "Being prepared", "progress"],
    [payment({ status: "held" }), "With Northstar for review", "review"],
    [payment({ status: "paid", txRef: "0xabc" }), "Paid", "done"],
    [payment({ kind: "invoice", status: "pending" }), "Being prepared", "progress"],
    [payment({ kind: "invoice", status: "matched" }), "On its way", "progress"],
    [payment({ kind: "invoice", status: "scheduled", scheduledFor: "2026-10-11T00:00:00Z" }), "Scheduled for Oct 11, 2026", "progress"],
    [payment({ kind: "invoice", status: "flagged" }), "With Northstar for review", "review"],
    [payment({ kind: "invoice", status: "awaiting_info" }), "With Northstar for review", "review"],
    [payment({ kind: "invoice", status: "processing" }), "With Northstar for review", "review"],
  ])("%# names the payment's state without its reason", (p, label, tone) => {
    expect(paymentState(p, "Northstar")).toEqual({ label, tone });
  });
});

describe("addresses (R4)", () => {
  it("masks an address to its first six and last four characters", () => {
    expect(maskAddress(ADDRESS)).toBe("0x1234…abcd");
  });

  it("groups an address in fours after 0x, to read back", () => {
    expect(groupAddress(ADDRESS)).toEqual(["0x", "1234", "5678", "90ab", "cdef", "1234", "5678", "90ab", "cdef", "1234", "abcd"]);
  });

  it("knows a wallet address when it sees one, around stray spaces", () => {
    expect(looksLikeAddress(` ${ADDRESS} `)).toBe(true);
    expect(looksLikeAddress(ADDRESS.slice(0, 41))).toBe(false);
    expect(looksLikeAddress("1234567890abcdef1234567890abcdef1234abcd")).toBe(false);
    expect(looksLikeAddress("0xZZ34567890abcdef1234567890abcdef1234abcd")).toBe(false);
  });
});

describe("amountsLine", () => {
  it("adds amounts by currency, USDC first", () => {
    expect(amountsLine([payment(), payment({ amount: 5.5 })])).toBe("30.50 USDC");
    expect(amountsLine([payment({ currency: "EURC", amount: 10 }), payment()])).toBe("25.00 USDC and 10.00 EURC");
    expect(amountsLine([])).toBe("");
  });
});
