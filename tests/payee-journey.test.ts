import { describe, expect, it, vi } from "vitest";
import { amountsLine, groupAddress, looksLikeAddress, maskAddress, moveOn, payeeStage, payeeView, paymentState, type PayeeLinkStatus, type PayeePayment } from "@/lib/payee-journey";

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

  it("asks for the invoice after the address, on a link that asks for one not yet sent (payee invoice link P4)", () => {
    expect(payeeStage(status({ linkState: "open", address: null, asksInvoice: true }))).toBe("address");
    expect(payeeStage(status({ asksInvoice: true, invoiceSent: false, addressConfirmed: false }))).toBe("invoice");
    expect(payeeStage(status({ asksInvoice: true, invoiceSent: true, addressConfirmed: false }))).toBe("confirming");
    expect(payeeStage(status({ asksInvoice: false, invoiceSent: false }))).toBe("paying");
  });

  it("never lets the invoice outrank a payment on its way or paid to a confirmed address", () => {
    const asked = { asksInvoice: true, invoiceSent: false };
    expect(payeeStage(status({ ...asked, payments: [payment({ kind: "invoice", status: "matched" })] }))).toBe("paying");
    expect(payeeStage(status({ ...asked, payments: [payment({ status: "paid", txRef: "0xabc" })] }))).toBe("paid");
    // A payment only being prepared, or an address not yet confirmed, leaves the invoice first.
    expect(payeeStage(status({ ...asked, payments: [payment({ status: "verified" })] }))).toBe("invoice");
    expect(payeeStage(status({ ...asked, addressConfirmed: false, payments: [payment({ status: "paid", txRef: "0xabc" })] }))).toBe("invoice");
  });

  it("follows the payments once the address is confirmed, and is paid when every one is", () => {
    expect(payeeStage(status())).toBe("paying");
    expect(payeeStage(status({ payments: [payment({ status: "paid", txRef: "0xabc" }), payment({ status: "held" })] }))).toBe("paying");
    expect(payeeStage(status({ payments: [payment({ status: "paid", txRef: "0xabc" })] }))).toBe("paid");
    expect(payeeStage(status({ payments: [] }))).toBe("paying");
  });
});

describe("payeeView and moveOn (payee step advance S1, S2, S6)", () => {
  const held = payment({ kind: "invoice", title: "Logo", status: "flagged", txRef: "0xdead", settledAt: "2026-10-03T00:00:00Z", scheduledFor: "2026-10-04" });

  it("gives the page the address masked, and each payment's state as one the page tells apart or review (R1, R3, R4)", () => {
    const view = payeeView(status({ payments: [payment(), held, payment({ status: "paid", txRef: "0xabc", settledAt: "2026-10-05T00:00:00Z" })] }));
    expect(view.address).toBe(maskAddress(ADDRESS));
    expect(view.payments.map((entry) => entry.status)).toEqual(["verified", "review", "paid"]);
    expect(JSON.stringify(view)).not.toContain(ADDRESS);
    expect(JSON.stringify(view)).not.toMatch(/flag/i);
    // A transaction and its dates only where the page shows them.
    expect(view.payments[1]).toMatchObject({ txRef: null, settledAt: null, scheduledFor: null });
    expect(view.payments[2]).toMatchObject({ txRef: "0xabc", settledAt: "2026-10-05T00:00:00Z" });
    expect(payeeView(status({ payments: [payment({ status: "scheduled", scheduledFor: "2026-10-09" })] })).payments[0].scheduledFor).toBe("2026-10-09");
  });

  it("keeps nothing else the status read returns", () => {
    const read = { ...status(), chainOpen: true, counterpartyId: "cp-1", offersChain: true, addressMirror: false } as PayeeLinkStatus;
    for (const key of ["chainOpen", "counterpartyId", "offersChain", "addressMirror"]) expect(Object.keys(payeeView(read))).not.toContain(key);
  });

  it("gives an unused link's address on file only when the payee may keep it, never a shadow-mode mirror (P4)", () => {
    const open = { linkState: "open" as const, asksInvoice: true, addressConfirmed: true };
    expect(payeeView(status({ ...open, addressMirror: false })).address).toBe(maskAddress(ADDRESS));
    expect(payeeView(status({ ...open, addressMirror: true })).address).toBeNull();
    // Once the link is used, the address on file is the one its screens show, masked.
    expect(payeeView(status({ addressMirror: true })).address).toBe(maskAddress(ADDRESS));
  });

  it("leaves every screen as the full status drew it: the same stage and the same words", () => {
    const reads = [
      status({ linkState: "open", address: null, addressConfirmed: false }),
      status({ asksInvoice: true, invoiceSent: false, addressConfirmed: false }),
      status({ addressConfirmed: false, payments: [held] }),
      status({ payments: [payment({ status: "matched" }), held, payment({ status: "pending", kind: "invoice" })] }),
      status({ payments: [payment({ status: "paid", txRef: "sim_1" })] }),
      status({ address: null, addressConfirmed: false }),
    ];
    for (const read of reads) {
      const view = payeeView(read);
      expect(payeeStage(view)).toBe(payeeStage(read));
      expect(view.payments.map((entry) => paymentState(entry, "Northstar"))).toEqual(read.payments.map((entry) => paymentState(entry, "Northstar")));
      if (read.address) expect(maskAddress(view.address as string)).toBe(maskAddress(read.address));
    }
  });

  it("moves on with the status an action answered with, or refreshes without one", () => {
    const onSent = vi.fn();
    const refresh = vi.fn();
    const now = status();
    moveOn({ status: now }, onSent, refresh);
    expect(onSent).toHaveBeenCalledWith(now);
    expect(refresh).not.toHaveBeenCalled();
    moveOn({}, onSent, refresh);
    moveOn({ status: now }, undefined, refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onSent).toHaveBeenCalledTimes(1);
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
