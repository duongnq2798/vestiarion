import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dealCollection,
  differing,
  evidenceUrl,
  fieldConflicts,
  fieldWords,
  normalField,
  readReceiptFields,
  RECEIPT_FIELDS,
  RECEIPT_PROPERTIES,
  receiptFields,
  receiptLink,
  receiptReality,
  seenOf,
  type AppliedPayment,
  type CollectionInput,
  type DealReceivable,
  type ReceiptFields,
} from "@/lib/connectors/crm-receipts";

/**
 * What a deal planned from a CRM has collected, and the fields written back to it
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R1, R2, R4, R5): only money that arrived on Arc and was
 * applied counts, a part payment is partial, a fee is never collected; the reality rule; and whether a person changed a
 * field in the CRM since Vestiarion last wrote it.
 */

const HASH = `0x${"ab".repeat(32)}`;
const HASH_2 = `0x${"cd".repeat(32)}`;

const receivable = (id: string, amount: number, extra: Partial<DealReceivable> = {}): DealReceivable => ({
  id,
  amount,
  currency: "USDC",
  status: "pending",
  dueOn: "2026-10-26",
  originalCurrency: null,
  originalAmount: null,
  ...extra,
});

const payment = (transferId: string, invoiceId: string, amount: number, receivedAt: string, extra: Partial<AppliedPayment> = {}): AppliedPayment => ({
  transferId,
  invoiceId,
  amount,
  receivedAt,
  txHash: HASH,
  chain: "ARC-TESTNET",
  ...extra,
});

const input = (extra: Partial<CollectionInput> = {}): CollectionInput => ({
  deal: { currency: "USDC", digits: 2, status: "active" },
  receivables: [],
  payments: [],
  fees: [],
  notInvoicedMinor: 0,
  today: "2026-10-13",
  ...extra,
});

describe("dealCollection", () => {
  it("says nothing invoiced yet for a deal with no receivable", () => {
    const collection = dealCollection(input({ notInvoicedMinor: 500000 }));
    expect(collection).toMatchObject({ collectedMinor: 0, stillOwedMinor: 0, notInvoicedMinor: 500000, status: "nothing_invoiced", reconciliation: "no_receipts", lastReceipt: null });
  });

  it("counts a part payment as partial: the rest of that invoice is still owed", () => {
    const collection = dealCollection(
      input({ receivables: [receivable("r1", 5000)], payments: [payment("t1", "r1", 2000, "2026-10-12T09:30:00Z")], notInvoicedMinor: 1000000 })
    );
    expect(collection).toMatchObject({ collectedMinor: 200000, stillOwedMinor: 300000, invoicedMinor: 500000, status: "partly_paid", reconciliation: "reconciled", receipts: 1 });
    expect(collection.lastReceipt).toEqual({ on: "2026-10-12", minor: 200000, txHash: HASH, network: "arc-testnet" });
  });

  it("says awaiting payment, then overdue, while nothing arrived", () => {
    expect(dealCollection(input({ receivables: [receivable("r1", 5000)] })).status).toBe("awaiting_payment");
    const late = dealCollection(input({ receivables: [receivable("r1", 5000, { dueOn: "2026-10-01" })] }));
    expect(late).toMatchObject({ status: "overdue", overdueMinor: 500000, stillOwedMinor: 500000, collectedMinor: 0 });
  });

  it("counts a whole match as all of the invoice, paid to date while lines wait to be invoiced, paid in full when none do", () => {
    const settled = [receivable("r1", 5000, { status: "received" })];
    const paid = [payment("t1", "r1", 5000, "2026-10-12T10:00:00Z")];
    expect(dealCollection(input({ receivables: settled, payments: paid, notInvoicedMinor: 1000000 })).status).toBe("paid_to_date");
    expect(dealCollection(input({ receivables: settled, payments: paid })).status).toBe("paid_in_full");
    // A cancelled deal's planned lines are not coming: what was invoiced is paid in full.
    expect(dealCollection(input({ deal: { currency: "USDC", digits: 2, status: "cancelled" }, receivables: settled, payments: paid, notInvoicedMinor: 1000000 })).status).toBe("paid_in_full");
  });

  it("never collects a fee a person marked: it settles the invoice, and the customer did not pay it", () => {
    const collection = dealCollection(
      input({ receivables: [receivable("r1", 5000, { status: "received" })], payments: [payment("t1", "r1", 4990, "2026-10-12T10:00:00Z")], fees: [{ invoiceId: "r1", amount: 10 }] })
    );
    expect(collection).toMatchObject({ collectedMinor: 499000, feesMinor: 1000, stillOwedMinor: 0, status: "paid_in_full" });
  });

  it("does not count an invoice marked received with no payment on Arc, and asks for a review", () => {
    const collection = dealCollection(input({ receivables: [receivable("r1", 5000, { status: "received" })] }));
    expect(collection).toMatchObject({ collectedMinor: 0, stillOwedMinor: 0, unverifiedMinor: 500000, reconciliation: "needs_review" });
  });

  it("leaves rejected invoices out, and tells the latest payment by when it arrived, across invoices", () => {
    const collection = dealCollection(
      input({
        receivables: [receivable("r1", 3000), receivable("r2", 2000), receivable("r3", 900, { status: "rejected" })],
        payments: [
          payment("t1", "r1", 3000, "2026-10-10T10:00:00Z"),
          payment("t2", "r2", 1500, "2026-10-12T11:00:00Z", { txHash: HASH_2 }),
          payment("t2", "r1", 0, "2026-10-12T11:00:00Z", { txHash: HASH_2 }),
        ],
      })
    );
    expect(collection).toMatchObject({ invoicedMinor: 500000, collectedMinor: 450000, stillOwedMinor: 50000, receipts: 2 });
    expect(collection.lastReceipt).toMatchObject({ on: "2026-10-12", minor: 150000, txHash: HASH_2 });
  });

  it("tells a shadow-mode deal in its own currency at each invoice's own rate", () => {
    const collection = dealCollection(
      input({
        deal: { currency: "SGD", digits: 2, status: "active" },
        receivables: [receivable("r1", 3700, { originalCurrency: "SGD", originalAmount: 5000 })],
        payments: [payment("t1", "r1", 1850, "2026-10-12T10:00:00Z")],
      })
    );
    expect(collection).toMatchObject({ currency: "SGD", collectedMinor: 250000, stillOwedMinor: 250000, status: "partly_paid" });
  });

  it("leaves out an invoice in a currency the deal cannot be told in", () => {
    const collection = dealCollection(input({ receivables: [receivable("r1", 5000, { currency: "EURC" })] }));
    expect(collection).toMatchObject({ leftOut: 1, invoicedMinor: 0, status: "nothing_invoiced" });
  });

  it("names the network a payment arrived on: Arc mainnet only when Circle says ARC", () => {
    const collection = dealCollection(input({ receivables: [receivable("r1", 50)], payments: [payment("t1", "r1", 50, "2026-10-12T10:00:00Z", { chain: "ARC" })] }));
    expect(collection.lastReceipt?.network).toBe("arc-mainnet");
  });
});

describe("receiptFields", () => {
  it("writes amounts to the currency's places, statuses as values, and links to the explorer and the deal", () => {
    const collection = dealCollection(input({ receivables: [receivable("r1", 5000)], payments: [payment("t1", "r1", 2000, "2026-10-12T09:30:00Z")] }));
    const fields = receiptFields(collection, evidenceUrl("https://www.vestiarion.xyz/", "northstar", "d-1"));
    expect(fields).toEqual({
      vestiarion_collected: "2000.00",
      vestiarion_still_owed: "3000.00",
      vestiarion_currency: "USDC",
      vestiarion_collection_status: "partly_paid",
      vestiarion_last_receipt_date: "2026-10-12",
      vestiarion_last_receipt_amount: "2000.00",
      vestiarion_last_receipt_link: `https://explorer.testnet.arc.io/tx/${HASH}`,
      vestiarion_reconciliation: "reconciled",
      vestiarion_evidence_link: "https://www.vestiarion.xyz/o/northstar/invoices/deals/d-1",
    });
    expect(Object.keys(fields)).toEqual([...RECEIPT_FIELDS]);
  });

  it("leaves the last receipt empty before any, and a link empty for a hash that is not one", () => {
    const fields = receiptFields(dealCollection(input()), "https://example.test/o/x/invoices/deals/d");
    expect(fields).toMatchObject({ vestiarion_last_receipt_date: "", vestiarion_last_receipt_amount: "", vestiarion_last_receipt_link: "" });
    expect(receiptLink({ txHash: "0x12", network: "arc-testnet" })).toBe("");
  });

  it("defines a property for each field, owned by Vestiarion, with the statuses as options", () => {
    expect(RECEIPT_PROPERTIES.map((property) => property.name)).toEqual([...RECEIPT_FIELDS]);
    for (const property of RECEIPT_PROPERTIES) {
      expect(property.name).toMatch(/^vestiarion_[a-z_]+$/);
      expect(property.description).toMatch(/Written by Vestiarion/);
    }
    const status = RECEIPT_PROPERTIES.find((property) => property.name === "vestiarion_collection_status");
    expect(status?.options?.map((option) => option.value)).toEqual(["paid_in_full", "paid_to_date", "partly_paid", "overdue", "awaiting_payment", "nothing_invoiced"]);
  });

  it("reads stored fields back, every one there as text", () => {
    expect(readReceiptFields({ vestiarion_collected: "1" })?.vestiarion_still_owed).toBe("");
    expect(readReceiptFields({ vestiarion_collected: 1 })).toBeNull();
    expect(readReceiptFields(null)).toBeNull();
  });
});

const FIELDS: ReceiptFields = {
  vestiarion_collected: "2000.00",
  vestiarion_still_owed: "3000.00",
  vestiarion_currency: "USDC",
  vestiarion_collection_status: "partly_paid",
  vestiarion_last_receipt_date: "2026-10-12",
  vestiarion_last_receipt_amount: "2000.00",
  vestiarion_last_receipt_link: `https://explorer.testnet.arc.io/tx/${HASH}`,
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: "https://www.vestiarion.xyz/o/northstar/invoices/deals/d-1",
};

describe("comparing what the CRM holds", () => {
  it("reads numbers without trailing zeros, days from instants, and none as empty", () => {
    expect(normalField("vestiarion_collected", "2000.00")).toBe("2000");
    expect(normalField("vestiarion_collected", "2000.50")).toBe("2000.5");
    expect(normalField("vestiarion_last_receipt_date", "1760227200000")).toBe("2025-10-12");
    expect(normalField("vestiarion_last_receipt_date", "2026-10-12T00:00:00Z")).toBe("2026-10-12");
    expect(normalField("vestiarion_currency", null)).toBe("");
    expect(differing(FIELDS, { ...FIELDS, vestiarion_collected: "2000", vestiarion_last_receipt_date: "2026-10-12T00:00:00.000Z" })).toEqual([]);
  });

  it("reads a number handed back in exponent form, or with a sign, as the same number", () => {
    expect(normalField("vestiarion_collected", "2E+3")).toBe("2000");
    expect(normalField("vestiarion_collected", "1.25E+3")).toBe("1250");
    expect(normalField("vestiarion_collected", "1.2345e2")).toBe("123.45");
    expect(normalField("vestiarion_collected", "1.5E-1")).toBe("0.15");
    expect(normalField("vestiarion_collected", "+3000.00")).toBe("3000");
    expect(normalField("vestiarion_collected", "0E-2")).toBe("0");
    expect(normalField("vestiarion_collected", "0.00")).toBe("0");
    expect(normalField("vestiarion_collected", "-0")).toBe("0");
    expect(differing(FIELDS, { ...FIELDS, vestiarion_collected: "2E+3", vestiarion_still_owed: "3E+3", vestiarion_last_receipt_amount: "2.000E+3" })).toEqual([]);
    // Another figure is still another figure.
    expect(differing(FIELDS, { ...FIELDS, vestiarion_collected: "2.1E+3" })).toEqual(["vestiarion_collected"]);
  });

  it("finds no conflict where the CRM holds what Vestiarion last wrote", () => {
    expect(fieldConflicts({ owned: FIELDS, held: FIELDS, next: { ...FIELDS, vestiarion_collected: "5000.00" } })).toEqual([]);
  });

  it("reports a field someone changed since, with what Vestiarion last wrote, what the CRM holds and what would be written", () => {
    const conflicts = fieldConflicts({ owned: FIELDS, held: { ...FIELDS, vestiarion_still_owed: "0" }, next: { ...FIELDS, vestiarion_still_owed: "1000.00" } });
    expect(conflicts).toEqual([{ field: "vestiarion_still_owed", ours: "3000", theirs: "0", next: "1000" }]);
  });

  it("before a first write, takes any value already there as someone else's", () => {
    const empty = Object.fromEntries(RECEIPT_FIELDS.map((name) => [name, null]));
    expect(fieldConflicts({ owned: null, held: empty, next: FIELDS })).toEqual([]);
    expect(fieldConflicts({ owned: null, held: { ...empty, vestiarion_collected: "10" }, next: FIELDS }).map((conflict) => conflict.field)).toEqual(["vestiarion_collected"]);
  });

  it("writes over only what the person saw: another change since is still a conflict", () => {
    const held = { ...FIELDS, vestiarion_still_owed: "0" };
    const conflicts = fieldConflicts({ owned: FIELDS, held, next: FIELDS });
    expect(fieldConflicts({ owned: FIELDS, held, next: FIELDS, seen: seenOf(conflicts) })).toEqual([]);
    expect(fieldConflicts({ owned: FIELDS, held: { ...held, vestiarion_still_owed: "1" }, next: FIELDS, seen: seenOf(conflicts) })).toHaveLength(1);
  });

  it("says a field's value in words", () => {
    expect(fieldWords("vestiarion_collected", "12500.00", "USDC")).toBe("12,500.00 USDC");
    expect(fieldWords("vestiarion_collection_status", "partly_paid", "USDC")).toBe("Partly paid");
    expect(fieldWords("vestiarion_reconciliation", "needs_review", "USDC")).toBe("Needs review");
    expect(fieldWords("vestiarion_last_receipt_date", "", "USDC")).toBe("none");
  });
});

describe("receiptReality", () => {
  it("writes payments on Arc mainnet outside shadow mode to any account", () => {
    expect(receiptReality({ network: "arc-mainnet", shadow: false }, false)).toEqual({ ok: true });
    expect(receiptReality({ network: "arc-mainnet", shadow: false }, null)).toEqual({ ok: true });
  });

  it("writes payments on Arc testnet, and in shadow mode, only to a test account", () => {
    expect(receiptReality({ network: "arc-testnet", shadow: false }, true)).toEqual({ ok: true });
    expect(receiptReality({ network: "arc-testnet", shadow: false }, false)).toEqual({ ok: false, refused: true, reason: "testnet" });
    expect(receiptReality({ network: "arc-mainnet", shadow: true }, false)).toEqual({ ok: false, refused: true, reason: "shadow" });
  });

  it("neither writes nor refuses before the account was read", () => {
    expect(receiptReality({ network: "arc-testnet", shadow: false }, null)).toEqual({ ok: false, refused: false });
  });
});

describe("nothing that moves money reads the receipts", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  it("keeps the agent, the payments, the allocations and the money commands away from crm-receipts", () => {
    const root = process.cwd();
    const watched = [
      ...files(path.join(root, "src", "lib", "agent")),
      ...files(path.join(root, "src", "lib", "allocations")),
      path.join(root, "src", "lib", "payments.ts"),
      ...["payables.ts", "milestones.ts", "allocations.ts", "payment-plan.ts", "bookings.ts"].map((name) => path.join(root, "src", "lib", "commands", name)),
    ];
    for (const file of watched) expect(readFileSync(file, "utf8"), path.relative(root, file)).not.toMatch(/crm-receipts/);
  });
});
