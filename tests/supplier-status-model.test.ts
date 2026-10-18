import { describe, expect, it } from "vitest";
import { buildSupplierStatus, standingOf, supplierLinkRows, type SupplierBillIn } from "@/lib/supplier-status/model";
import { generateSupplierStatusToken, supplierStatusTokenHash } from "@/lib/supplier-status/token";

/**
 * A supplier's payment status, pure (docs/superpowers/specs/2026-10-18-supplier-status-design.md V2): where each bill
 * stands in the supplier's words, never why a bill is held; open bills by what happens next; recent payments with their
 * transaction; what is still to be paid per currency, never summed across currencies.
 */

const EXPLORER = "https://explorer.testnet.arc.io/tx/";
const TX = "0x1adfad848f00fdadf7021ba1f1ac30505146c40c220eac8cbca36cfc479e3a7b";
const NOW = Date.parse("2026-10-18T09:00:00Z");

function bill(fields: Partial<SupplierBillIn> & { id: string }): SupplierBillIn {
  return {
    amount: 45,
    currency: "USDC",
    dueDate: "2026-10-24",
    memo: null,
    poReference: null,
    status: "pending",
    scheduledFor: null,
    settledAt: null,
    txHash: null,
    inFlight: false,
    ...fields,
  };
}

describe("standingOf", () => {
  it("reads each status in the supplier's terms, and never shows a rejected bill", () => {
    expect(standingOf({ status: "pending", inFlight: false })).toBe("received");
    // A payable's processing is a person deciding it in Approvals, before any payment exists (review).
    for (const status of ["held", "flagged", "awaiting_info", "processing", "something_new"]) expect(standingOf({ status, inFlight: false })).toBe("reviewing");
    expect(standingOf({ status: "scheduled", inFlight: false })).toBe("scheduled");
    // A payable's matched is a payment submitted and not yet confirmed, whatever its payment read says (review).
    expect(standingOf({ status: "matched", inFlight: false })).toBe("on_its_way");
    // A payment started on a held or scheduled bill is on its way, whatever the bill's status says yet.
    expect(standingOf({ status: "held", inFlight: true })).toBe("on_its_way");
    expect(standingOf({ status: "paid", inFlight: false })).toBe("paid");
    expect(standingOf({ status: "rejected", inFlight: false })).toBeNull();
  });
});

describe("buildSupplierStatus", () => {
  const view = buildSupplierStatus({
    orgName: "Pinecrest Studio",
    supplierName: "Cobalt Cloud",
    expiresAt: "2026-11-17T09:00:00Z",
    now: NOW,
    explorerTx: EXPLORER,
    bills: [
      bill({ id: "held", status: "held", amount: 140, memo: "CC-2026-1020 render farm", poReference: "PO-CC-1020", dueDate: "2026-10-22" }),
      bill({ id: "set", status: "scheduled", scheduledFor: "2026-10-24T00:00:00Z", memo: "CC-2026-1017 GPU hosting" }),
      bill({ id: "new", status: "pending", amount: 30, dueDate: "2026-10-17" }),
      bill({ id: "eurc", status: "pending", amount: 12.5, currency: "EURC", dueDate: "2026-10-30" }),
      bill({ id: "sending", status: "matched", amount: 4, dueDate: "2026-10-25" }),
      bill({ id: "paid-old", status: "paid", amount: 90, settledAt: "2026-10-12T10:00:00Z", txHash: `0x${"a".repeat(64)}` }),
      bill({ id: "paid-new", status: "paid", amount: 50, settledAt: "2026-10-17T21:44:13Z", txHash: TX }),
      bill({ id: "paid-bank", status: "paid", amount: 10, settledAt: "2026-10-15T10:00:00Z" }),
      bill({ id: "paid-sim", status: "paid", amount: 2, settledAt: "2026-10-14T10:00:00Z", txHash: "sim_7f3a" }),
      bill({ id: "refused", status: "rejected", amount: 999 }),
    ],
  });

  it("names the business, the supplier, the day read and the day the link stops", () => {
    expect(view).toMatchObject({ orgName: "Pinecrest Studio", supplierName: "Cobalt Cloud", asOf: "Oct 18, 2026", until: "Nov 17, 2026" });
  });

  it("orders open bills by what happens next, in the supplier's words, with no reason for a hold", () => {
    expect(view.open.map((line) => [line.id, line.words])).toEqual([
      ["sending", "Payment on its way"],
      ["set", "To be paid on Oct 24, 2026"],
      ["held", "Being reviewed"],
      ["new", "Received"],
      ["eurc", "Received"],
    ]);
    const held = view.open.find((line) => line.id === "held");
    expect(held).toMatchObject({ reference: "CC-2026-1020 render farm", poReference: "PO-CC-1020", amount: "140.00 USDC", due: "Oct 22, 2026", txUrl: null });
    // A bill with no memo is named by its due day.
    expect(view.open.find((line) => line.id === "new")?.reference).toBe("Bill due Oct 17, 2026");
  });

  it("lists recent payments newest first, each with its transaction when it has one on Arc, and never a rejected bill", () => {
    expect(view.paid.map((line) => [line.id, line.words, line.txUrl])).toEqual([
      ["paid-new", "Paid on Oct 17, 2026", `${EXPLORER}${TX}`],
      ["paid-bank", "Paid on Oct 15, 2026", null],
      // A simulated payment's reference is not a transaction the explorer can open.
      ["paid-sim", "Paid on Oct 14, 2026", null],
      ["paid-old", "Paid on Oct 12, 2026", `${EXPLORER}0x${"a".repeat(64)}`],
    ]);
    expect(view.linksTransactions).toBe(true);
    expect([...view.open, ...view.paid].some((line) => line.id === "refused")).toBe(false);
  });

  it("totals what is still to be paid per currency, never summed across currencies", () => {
    // 140 held + 45 set + 30 received + 4 on its way; the paid and the rejected bills count for nothing.
    expect(view.stillToBePaid).toEqual(["12.50 EURC", "219.00 USDC"]);
  });

  it("says nothing is waiting when every bill is paid", () => {
    const paidUp = buildSupplierStatus({
      orgName: "Pinecrest Studio",
      supplierName: "Cobalt Cloud",
      expiresAt: "2026-11-17T09:00:00Z",
      now: NOW,
      explorerTx: EXPLORER,
      bills: [bill({ id: "paid", status: "paid", settledAt: "2026-10-17T00:00:00Z" })],
    });
    expect(paidUp.open).toEqual([]);
    expect(paidUp.stillToBePaid).toEqual([]);
    expect(paidUp.linksTransactions).toBe(false);
    expect(paidUp.simulated).toBe(false);
  });
});

describe("supplierLinkRows", () => {
  it("puts live links first, newest first, with the supplier and who made each", () => {
    const rows = supplierLinkRows(
      [
        { id: "old", counterpartyId: "a", createdBy: "u1", createdAt: "2026-09-01T00:00:00Z", expiresAt: "2026-09-08T00:00:00Z", expired: true },
        { id: "live", counterpartyId: "b", createdBy: null, createdAt: "2026-10-18T00:00:00Z", expiresAt: "2026-11-17T00:00:00Z", expired: false },
      ],
      new Map([
        ["a", "Lumen Print Co."],
        ["b", "Cobalt Cloud"],
      ]),
      new Map([["u1", "owner@example.com"]])
    );
    expect(rows).toEqual([
      { id: "live", supplierName: "Cobalt Cloud", until: "Works until Nov 17, 2026", expired: false, made: "Made by a former member on Oct 18, 2026" },
      { id: "old", supplierName: "Lumen Print Co.", until: "Expired Sep 8, 2026", expired: true, made: "Made by owner@example.com on Sep 1, 2026" },
    ]);
  });
});

describe("the link's token", () => {
  it("is vxv_ and 43 characters, kept only as the SHA-256 of its secret, and nothing else is looked up", () => {
    const { token, secretHash } = generateSupplierStatusToken(() => Buffer.alloc(32, 7));
    expect(token).toMatch(/^vxv_[A-Za-z0-9_-]{43}$/);
    expect(supplierStatusTokenHash(token)).toBe(secretHash);
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(supplierStatusTokenHash(token.replace("vxv_", "vxc_"))).toBeNull();
    expect(supplierStatusTokenHash("vxv_short")).toBeNull();
  });
});
