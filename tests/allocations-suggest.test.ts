import { describe, expect, it } from "vitest";
import { toMicros, type AllocationRow, type PaymentIn, type ReceivableIn } from "@/lib/allocations/model";
import { COMBINATION_POOL, suggestAllocations, SUGGESTIONS_PER_PAYMENT, type Customer } from "@/lib/allocations/suggest";

/**
 * Suggestions for applying a payment (docs/superpowers/specs/2026-10-12-allocations-design.md L9): by reference, by the
 * customer it comes from, then by amounts, each with why; bounded and deterministic, at most 3 per payment.
 */

const M = (amount: number) => toMicros(amount);
const ACME_ADDRESS = "0x2222222222222222222222222222222222222222";

const ACME: Customer = { id: "acme", name: "Acme Corp", address: ACME_ADDRESS };
const BEACON: Customer = { id: "beacon", name: "Beacon Labs", address: "0x3333333333333333333333333333333333333333" };
const CEDAR: Customer = { id: "cedar", name: "Cedar Co", address: null };

let due = 0;
const receivable = (id: string, amount: number, over: Partial<ReceivableIn> = {}): ReceivableIn => {
  due += 1;
  return {
    id,
    counterpartyId: "acme",
    customer: "Acme Corp",
    amount: M(amount),
    currency: "USDC",
    status: "pending",
    dueDate: `2026-10-${String(due).padStart(2, "0")}T12:00:00Z`,
    createdAt: "2026-09-01T09:00:00Z",
    memo: `Invoice ${id}`,
    poReference: null,
    ...over,
  };
};

const payment = (amount: number, over: Partial<PaymentIn> = {}): PaymentIn => ({
  id: "p1",
  circleTxId: "circle-p1",
  txHash: `0x${"ab".repeat(32)}`,
  from: ACME_ADDRESS,
  amount: M(amount),
  currency: "USDC",
  receivedAt: "2026-10-12T09:00:00Z",
  wholeMatch: null,
  reference: null,
  ...over,
});

const suggest = (p: PaymentIn, receivables: ReceivableIn[], rows: AllocationRow[] = [], customers: Customer[] = [ACME, BEACON, CEDAR]) =>
  suggestAllocations({ payment: p, book: { receivables, rows, wholeMatched: new Set() }, customers });

describe("from the customer whose address sent it", () => {
  it("suggests the receivable whose outstanding is the payment, exactly, first", () => {
    const [older, exact] = [receivable("INV-1", 500), receivable("INV-2", 300)];
    const [first] = suggest(payment(300), [older, exact]);
    expect(first).toMatchObject({ rule: "exact", customerId: "acme", lines: [{ invoiceId: "INV-2", amount: M(300) }], fee: null, creditLeft: 0 });
    expect(first.why).toBe("From Acme Corp's address on file, and exactly what is still owed on Invoice INV-2.");
  });

  it("suggests 2 to 4 of its receivables that add up to the payment exactly: one payment for several invoices", () => {
    const receivables = [receivable("INV-1", 300), receivable("INV-2", 250), receivable("INV-3", 200), receivable("INV-4", 400)];
    const [first] = suggest(payment(900), receivables);
    // No two add up to 900.00; the first three that do, oldest due first, are INV-1, INV-3 and INV-4.
    expect(first).toMatchObject({
      rule: "combination",
      lines: [{ invoiceId: "INV-1", amount: M(300) }, { invoiceId: "INV-3", amount: M(200) }, { invoiceId: "INV-4", amount: M(400) }],
      creditLeft: 0,
    });
    expect(first.why).toBe("From Acme Corp's address on file, and it pays Invoice INV-1, Invoice INV-3 and Invoice INV-4 exactly: 900.00 USDC.");
  });

  it("applies oldest due first, leaving the last part paid", () => {
    const receivables = [receivable("INV-1", 300), receivable("INV-2", 500)];
    const suggestions = suggest(payment(450), receivables);
    const oldest = suggestions.find((s) => s.rule === "oldest_first");
    expect(oldest).toMatchObject({ lines: [{ invoiceId: "INV-1", amount: M(300) }, { invoiceId: "INV-2", amount: M(150) }], creditLeft: 0 });
    expect(oldest?.why).toBe("From Acme Corp's address on file. Oldest due first: Invoice INV-1 in full, and 150.00 USDC of Invoice INV-2, which stays part paid.");
  });

  it("keeps what is paid beyond everything owed as the customer's credit", () => {
    const suggestions = suggest(payment(1000), [receivable("INV-1", 300), receivable("INV-2", 500)]);
    const oldest = suggestions.find((s) => s.rule === "oldest_first");
    expect(oldest).toMatchObject({ lines: [{ invoiceId: "INV-1", amount: M(300) }, { invoiceId: "INV-2", amount: M(500) }], creditLeft: M(200) });
    expect(oldest?.why).toBe("From Acme Corp's address on file. Oldest due first: Invoice INV-1 and Invoice INV-2 in full. 200.00 USDC is left as credit for Acme Corp.");
  });

  it("suggests a payment a little short as a possible fee, within 1% and 5.00", () => {
    const [first] = suggest(payment(99.7), [receivable("INV-1", 100)]);
    expect(first).toMatchObject({ rule: "short_fee", lines: [{ invoiceId: "INV-1", amount: M(99.7) }], fee: { invoiceId: "INV-1", amount: M(0.3) } });
    expect(first.why).toBe("From Acme Corp's address on file, and 0.30 USDC short of what is owed on Invoice INV-1, which may be a fee: mark it as one with a reason, or leave it owed.");
    // 2% short is not a fee; 6.00 short of 1,000.00 is not either.
    expect(suggest(payment(98), [receivable("INV-1", 100)]).some((s) => s.rule === "short_fee")).toBe(false);
    expect(suggest(payment(994), [receivable("INV-1", 1000)]).some((s) => s.rule === "short_fee")).toBe(false);
  });

  it("names the customer its earlier applications name, for what is left of it", () => {
    const rows: AllocationRow[] = [
      { id: "row-1", kind: "payment", invoiceId: "INV-1", transferId: "p1", amount: M(300), currency: "USDC", reverses: null, reason: null, basis: "person", paymentSeq: 1, createdBy: "u", createdAt: "2026-10-12T10:00:00Z" },
    ];
    const receivables = [receivable("INV-1", 300, { status: "received" }), receivable("INV-9", 200)];
    const [first] = suggest(payment(500, { from: null }), receivables, rows);
    expect(first).toMatchObject({ rule: "exact", customerId: "acme", lines: [{ invoiceId: "INV-9", amount: M(200) }] });
    expect(first.why).toBe("Left from a payment applied to Acme Corp before, and exactly what is still owed on Invoice INV-9.");
  });
});

describe("with no customer known", () => {
  const unknown = { from: "0x9999999999999999999999999999999999999999" };

  it("suggests the one receivable whose outstanding is the payment, or each of a few, saying how many", () => {
    const only = suggest(payment(250, unknown), [receivable("INV-1", 250), receivable("INV-2", 400, { counterpartyId: "beacon", customer: "Beacon Labs" })]);
    expect(only[0]).toMatchObject({ rule: "exact", customerId: "acme", lines: [{ invoiceId: "INV-1", amount: M(250) }] });
    expect(only[0].why).toBe("Exactly what is still owed on Invoice INV-1 from Acme Corp, the only open invoice of that amount.");

    const several = suggest(payment(250, unknown), [receivable("INV-1", 250), receivable("INV-2", 250, { counterpartyId: "beacon", customer: "Beacon Labs" })]);
    expect(several.map((s) => s.lines[0].invoiceId)).toEqual(["INV-1", "INV-2"]);
    expect(several[1].why).toBe("Exactly what is still owed on Invoice INV-2 from Beacon Labs, one of 2 open invoices of that amount: check who sent it.");
  });

  it("suggests receivables of one customer that add up to it", () => {
    const receivables = [receivable("INV-1", 100), receivable("INV-2", 150, { counterpartyId: "beacon", customer: "Beacon Labs" }), receivable("INV-3", 50, { counterpartyId: "beacon", customer: "Beacon Labs" })];
    const [first] = suggest(payment(200, unknown), receivables);
    expect(first).toMatchObject({ rule: "combination", customerId: "beacon" });
    expect(first.why).toBe("It pays Beacon Labs' Invoice INV-2 and Invoice INV-3 exactly: 200.00 USDC.");
  });

  it("suggests nothing it cannot tell", () => {
    expect(suggest(payment(77, unknown), [receivable("INV-1", 100), receivable("INV-2", 300)])).toEqual([]);
  });
});

describe("by reference", () => {
  it("suggests the receivable whose invoice number is the payment's reference", () => {
    const receivables = [receivable("INV-1", 100, { memo: "Invoice KP-1042: Copy paper" }), receivable("INV-2", 100, { memo: "Invoice KP-1043: Toner" })];
    const [first] = suggest(payment(100, { reference: "kp-1043", from: null }), receivables);
    expect(first).toMatchObject({ rule: "reference", lines: [{ invoiceId: "INV-2", amount: M(100) }] });
    expect(first.why).toBe("Its reference, kp-1043, is on Invoice KP-1043: Toner.");
  });
});

describe("the rules' bounds", () => {
  it("never suggests across currencies, nor a closed receivable", () => {
    expect(suggest(payment(100), [receivable("INV-1", 100, { currency: "EURC" }), receivable("INV-2", 100, { status: "rejected" })])).toEqual([]);
  });

  it("keeps at most 3 suggestions for a payment", () => {
    const receivables = Array.from({ length: 6 }, (_, index) => receivable(`INV-${index}`, 250, { counterpartyId: "cedar", customer: "Cedar Co" }));
    expect(suggest(payment(250, { from: null }), receivables)).toHaveLength(SUGGESTIONS_PER_PAYMENT);
  });

  it("looks for sums among the 12 oldest due only", () => {
    const receivables = Array.from({ length: 14 }, (_, index) => receivable(`INV-${String(index).padStart(2, "0")}`, index < COMBINATION_POOL ? 1000 + index : 7));
    // Only the two newest add up to 14.00, and they are past the pool.
    expect(suggest(payment(14), receivables).some((s) => s.rule === "combination")).toBe(false);
  });

  it("gives the same suggestions whatever order the rows come in, and quickly on many", () => {
    const receivables = Array.from({ length: 40 }, (_, index) => receivable(`INV-${String(index).padStart(2, "0")}`, 100 + (index % 7) * 25));
    const started = performance.now();
    const forward = suggest(payment(475), receivables);
    const backward = suggest(payment(475), [...receivables].reverse(), [], [CEDAR, BEACON, ACME]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(backward).toEqual(forward);
    expect(forward.length).toBeGreaterThan(0);
  });
});
