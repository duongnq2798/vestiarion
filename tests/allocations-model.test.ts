import { describe, expect, it } from "vitest";
import { matchTransfer } from "@/lib/agent/receipts";
import {
  allocationErrorFromDb,
  amountWords,
  paymentBalance,
  planApplication,
  planReversal,
  receivableBalance,
  toMicros,
  parseAmount,
  type AllocationRow,
  type PaymentIn,
  type ReceivableIn,
} from "@/lib/allocations/model";

/**
 * Applying money received to receivables, pure (docs/superpowers/specs/2026-10-12-allocations-design.md L4, L6–L8):
 * what each receivable owes and each payment has left, and what one press may write, refused in the same cases the
 * database refuses, in plain words, before anything is written.
 */

const M = (amount: number) => toMicros(amount);

const receivable = (id: string, amount: number, over: Partial<ReceivableIn> = {}): ReceivableIn => ({
  id,
  counterpartyId: "acme",
  customer: "Acme Corp",
  amount: M(amount),
  currency: "USDC",
  status: "pending",
  dueDate: "2026-10-15T12:00:00Z",
  createdAt: "2026-10-01T09:00:00Z",
  memo: `Invoice ${id}`,
  poReference: null,
  ...over,
});

const payment = (id: string, amount: number, over: Partial<PaymentIn> = {}): PaymentIn => ({
  id,
  circleTxId: `circle-${id}`,
  txHash: `0x${"ab".repeat(32)}`,
  from: "0x2222222222222222222222222222222222222222",
  amount: M(amount),
  currency: "USDC",
  receivedAt: "2026-10-12T09:00:00Z",
  wholeMatch: null,
  reference: null,
  ...over,
});

let rowCount = 0;
const row = (over: Partial<AllocationRow> & Pick<AllocationRow, "invoiceId" | "amount">): AllocationRow => {
  rowCount += 1;
  return {
    id: `row-${rowCount}`,
    kind: "payment",
    transferId: "p1",
    currency: "USDC",
    reverses: null,
    reason: null,
    basis: "person",
    paymentSeq: rowCount,
    createdBy: "person-1",
    createdAt: `2026-10-12T10:00:${String(rowCount % 60).padStart(2, "0")}Z`,
    ...over,
  };
};

describe("amounts", () => {
  it("are kept in millionths, as whole numbers, so sums never drift", () => {
    expect(M(0.1) + M(0.2)).toBe(M(0.3));
    expect(M(99.7) + M(0.3)).toBe(M(100));
    expect(toMicros("12.500000")).toBe(12_500_000);
  });

  it("read as people type them, and as many places as USDC has", () => {
    expect(parseAmount("1250")).toBe(M(1250));
    expect(parseAmount("1,250.00")).toBe(M(1250));
    expect(parseAmount(" 99.7 ")).toBe(M(99.7));
    expect(parseAmount("0.000001")).toBe(1);
    for (const bad of ["", "0", "-5", "1.0000001", "12,50", "abc", "1e3"]) expect(parseAmount(bad), bad).toBeNull();
  });

  it("are written with their currency, to the cent or as finely as they need", () => {
    expect(amountWords(M(1250), "USDC")).toBe("1,250.00 USDC");
    expect(amountWords(M(99.7), "EURC")).toBe("99.70 EURC");
    expect(amountWords(1_234_567, "USDC")).toBe("1.234567 USDC");
  });
});

describe("a receivable's balance", () => {
  it("is open with nothing applied, part paid with some, paid with none owed", () => {
    const invoice = receivable("inv-1", 900);
    expect(receivableBalance(invoice, [], false)).toMatchObject({ state: "open", applied: 0, outstanding: M(900) });
    const part = [row({ invoiceId: "inv-1", amount: M(300) })];
    expect(receivableBalance(invoice, part, false)).toMatchObject({ state: "part_paid", paid: M(300), fees: 0, applied: M(300), outstanding: M(600) });
    const settled = receivable("inv-1", 900, { status: "received" });
    const full = [...part, row({ invoiceId: "inv-1", amount: M(600), transferId: "p2" })];
    expect(receivableBalance(settled, full, false)).toMatchObject({ state: "paid", paid: M(900), outstanding: 0 });
  });

  it("counts a fee as applied, never as paid by the customer", () => {
    const rows = [row({ invoiceId: "inv-1", amount: M(99.7) }), row({ invoiceId: "inv-1", kind: "fee", transferId: null, paymentSeq: null, basis: null, amount: M(0.3), reason: "Transfer fee" })];
    const balance = receivableBalance(receivable("inv-1", 100, { status: "received" }), rows, false);
    expect(balance).toMatchObject({ state: "paid", paid: M(99.7), fees: M(0.3), applied: M(100), outstanding: 0 });
    expect(balance.lines.map((line) => line.kind)).toEqual(["payment", "fee"]);
  });

  it("leaves a reversed row out, so the outstanding is freed", () => {
    const applied = row({ invoiceId: "inv-1", amount: M(300) });
    const reversal = row({ invoiceId: "inv-1", kind: "reversal", amount: M(300), reverses: applied.id, reason: "Wrong invoice", basis: null });
    const balance = receivableBalance(receivable("inv-1", 900), [applied, reversal], false);
    expect(balance).toMatchObject({ state: "open", applied: 0, outstanding: M(900), lines: [] });
  });

  it("owes nothing once matched whole or received another way, and nothing once rejected", () => {
    expect(receivableBalance(receivable("inv-1", 50, { status: "received" }), [], true)).toMatchObject({ state: "paid", paid: M(50), outstanding: 0, wholeMatch: true });
    expect(receivableBalance(receivable("inv-1", 50, { status: "rejected" }), [], false)).toMatchObject({ state: "closed", outstanding: 0 });
  });
});

describe("a payment's balance", () => {
  it("has what is not applied yet, its version, and the customer its applications name", () => {
    const receivables = new Map([["inv-1", receivable("inv-1", 900)]]);
    const rows = [row({ invoiceId: "inv-1", amount: M(300), transferId: "p1", paymentSeq: 1 })];
    expect(paymentBalance(payment("p1", 500), rows, receivables)).toMatchObject({ applied: M(300), unapplied: M(200), version: 1, customerId: "acme" });
    expect(paymentBalance(payment("p2", 500), rows, receivables)).toMatchObject({ applied: 0, unapplied: M(500), version: 0, customerId: null });
  });

  it("has nothing left once matched whole", () => {
    expect(paymentBalance(payment("p1", 500, { wholeMatch: "inv-9" }), [], new Map())).toMatchObject({ applied: M(500), unapplied: 0 });
  });

  it("counts a reversal toward its version, and frees what it reversed", () => {
    const applied = row({ invoiceId: "inv-1", amount: M(300), transferId: "p1", paymentSeq: 1 });
    const reversal = row({ invoiceId: "inv-1", kind: "reversal", amount: M(300), transferId: "p1", paymentSeq: 2, reverses: applied.id, reason: "Undo", basis: null });
    const receivables = new Map([["inv-1", receivable("inv-1", 900)]]);
    expect(paymentBalance(payment("p1", 500), [applied, reversal], receivables)).toMatchObject({ applied: 0, unapplied: M(500), version: 2, customerId: null });
  });
});

describe("planApplication", () => {
  const book = (receivables: ReceivableIn[], rows: AllocationRow[] = [], wholeMatched: string[] = []) => ({ receivables, rows, wholeMatched: new Set(wholeMatched) });

  it("applies part of a receivable, numbering the row after the version seen", () => {
    const plan = planApplication({ payment: payment("p1", 300), version: 0, lines: [{ invoiceId: "inv-1", amount: M(300) }], fees: [] }, book([receivable("inv-1", 900)]), "person");
    expect(plan).toEqual({
      ok: true,
      rows: [{ kind: "payment", invoiceId: "inv-1", transferId: "p1", amount: M(300), currency: "USDC", reason: null, basis: "person", paymentSeq: 1 }],
      unappliedAfter: 0,
      outstandingAfter: new Map([["inv-1", M(600)]]),
    });
  });

  it("applies one payment to three receivables, in receivable order, each settled", () => {
    const receivables = [receivable("inv-c", 400), receivable("inv-a", 300), receivable("inv-b", 200)];
    const plan = planApplication(
      { payment: payment("p1", 900), version: 0, lines: [{ invoiceId: "inv-c", amount: M(400) }, { invoiceId: "inv-a", amount: M(300) }, { invoiceId: "inv-b", amount: M(200) }], fees: [] },
      book(receivables),
      "person"
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.rows.map((planned) => [planned.invoiceId, planned.paymentSeq])).toEqual([["inv-a", 1], ["inv-b", 2], ["inv-c", 3]]);
    expect([...plan.outstandingAfter.values()]).toEqual([0, 0, 0]);
    expect(plan.unappliedAfter).toBe(0);
  });

  it("leaves what is paid beyond the open amounts on the payment, as credit", () => {
    const plan = planApplication({ payment: payment("p1", 1000), version: 0, lines: [{ invoiceId: "inv-1", amount: M(900) }], fees: [] }, book([receivable("inv-1", 900)]), "person");
    expect(plan).toMatchObject({ ok: true, unappliedAfter: M(100) });
  });

  it("records a difference as a fee with its reason, after the payment beside it", () => {
    const plan = planApplication(
      { payment: payment("p1", 99.7), version: 0, lines: [{ invoiceId: "inv-1", amount: M(99.7) }], fees: [{ invoiceId: "inv-1", amount: M(0.3), reason: "  Transfer fee  " }] },
      book([receivable("inv-1", 100)]),
      "person"
    );
    expect(plan.ok && plan.rows).toEqual([
      { kind: "payment", invoiceId: "inv-1", transferId: "p1", amount: M(99.7), currency: "USDC", reason: null, basis: "person", paymentSeq: 1 },
      { kind: "fee", invoiceId: "inv-1", transferId: null, amount: M(0.3), currency: "USDC", reason: "Transfer fee", basis: null, paymentSeq: null },
    ]);
    expect(plan.ok && plan.outstandingAfter.get("inv-1")).toBe(0);
  });

  it("records a fee later, beside a payment applied before, with no payment of its own", () => {
    const rows = [row({ invoiceId: "inv-1", amount: M(99.7), transferId: "p1", paymentSeq: 1 })];
    const plan = planApplication({ payment: null, version: null, lines: [], fees: [{ invoiceId: "inv-1", amount: M(0.3), reason: "Bank fee" }] }, book([receivable("inv-1", 100)], rows), "person");
    expect(plan).toMatchObject({ ok: true, rows: [{ kind: "fee", amount: M(0.3) }] });
  });

  it("refuses a fee without a reason, too long a reason, or with no payment beside it", () => {
    const one = book([receivable("inv-1", 100)]);
    const fee = (reason: string, lines = [{ invoiceId: "inv-1", amount: M(99.7) }]) =>
      planApplication({ payment: payment("p1", 99.7), version: 0, lines, fees: [{ invoiceId: "inv-1", amount: M(0.3), reason }] }, one, "person");
    expect(fee(" ")).toMatchObject({ ok: false, code: "reason_required" });
    expect(fee("x".repeat(281))).toMatchObject({ ok: false, code: "reason_too_long" });
    expect(planApplication({ payment: null, version: null, lines: [], fees: [{ invoiceId: "inv-1", amount: M(0.3), reason: "Fee" }] }, one, "person")).toMatchObject({
      ok: false,
      code: "fee_without_payment",
    });
  });

  it("refuses different currencies, whatever the amounts", () => {
    const plan = planApplication(
      { payment: payment("p1", 100, { currency: "USDC" }), version: 0, lines: [{ invoiceId: "inv-1", amount: M(100) }], fees: [] },
      book([receivable("inv-1", 100, { currency: "EURC" })]),
      "person"
    );
    expect(plan).toMatchObject({ ok: false, code: "currency" });
  });

  it("refuses more than the payment has left, or than a receivable owes", () => {
    const rows = [row({ invoiceId: "inv-0", amount: M(60), transferId: "p1", paymentSeq: 1 })];
    const receivables = [receivable("inv-0", 60), receivable("inv-1", 100)];
    expect(planApplication({ payment: payment("p1", 100), version: 1, lines: [{ invoiceId: "inv-1", amount: M(50) }], fees: [] }, book(receivables, rows), "person")).toMatchObject({
      ok: false,
      code: "exceeds_payment",
    });
    expect(planApplication({ payment: payment("p2", 500), version: 0, lines: [{ invoiceId: "inv-1", amount: M(101) }], fees: [] }, book(receivables), "person")).toMatchObject({
      ok: false,
      code: "exceeds_receivable",
    });
  });

  it("refuses another customer's receivable for a payment already applied to one", () => {
    const rows = [row({ invoiceId: "inv-1", amount: M(50), transferId: "p1", paymentSeq: 1 })];
    const receivables = [receivable("inv-1", 50), receivable("inv-2", 50, { counterpartyId: "beacon", customer: "Beacon Labs" })];
    expect(planApplication({ payment: payment("p1", 100), version: 1, lines: [{ invoiceId: "inv-2", amount: M(50) }], fees: [] }, book(receivables, rows), "person")).toMatchObject({
      ok: false,
      code: "other_customer",
    });
    expect(
      planApplication(
        { payment: payment("p2", 100), version: 0, lines: [{ invoiceId: "inv-1", amount: M(50) }, { invoiceId: "inv-2", amount: M(50) }], fees: [] },
        book(receivables),
        "person"
      )
    ).toMatchObject({ ok: false, code: "other_customer" });
  });

  it("refuses a version that moved since the person read the payment", () => {
    const rows = [row({ invoiceId: "inv-1", amount: M(10), transferId: "p1", paymentSeq: 1 })];
    expect(planApplication({ payment: payment("p1", 100), version: 0, lines: [{ invoiceId: "inv-1", amount: M(10) }], fees: [] }, book([receivable("inv-1", 100)], rows), "person")).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  it("refuses a closed receivable, one matched whole, a payment matched whole, a payable, nothing, a zero and a repeat", () => {
    const receivables = [receivable("inv-1", 100, { status: "received" }), receivable("inv-2", 100), receivable("inv-3", 100)];
    const apply = (lines: Array<{ invoiceId: string; amount: number }>, over: Partial<PaymentIn> = {}, whole: string[] = []) =>
      planApplication({ payment: payment("p1", 100, over), version: 0, lines, fees: [] }, book(receivables, [], whole), "person");
    expect(apply([{ invoiceId: "inv-1", amount: M(10) }])).toMatchObject({ ok: false, code: "closed" });
    expect(apply([{ invoiceId: "inv-2", amount: M(10) }], {}, ["inv-2"])).toMatchObject({ ok: false, code: "receivable_matched" });
    expect(apply([{ invoiceId: "inv-2", amount: M(10) }], { wholeMatch: "inv-9" })).toMatchObject({ ok: false, code: "payment_matched" });
    expect(apply([{ invoiceId: "inv-404", amount: M(10) }])).toMatchObject({ ok: false, code: "not_a_receivable" });
    expect(apply([])).toMatchObject({ ok: false, code: "nothing" });
    expect(apply([{ invoiceId: "inv-2", amount: 0 }])).toMatchObject({ ok: false, code: "amount" });
    expect(apply([{ invoiceId: "inv-2", amount: M(10) }, { invoiceId: "inv-2", amount: M(10) }])).toMatchObject({ ok: false, code: "duplicate" });
  });
});

describe("planReversal", () => {
  it("reverses one row with a reason, freeing what it applied", () => {
    const applied = row({ invoiceId: "inv-1", amount: M(300), transferId: "p1", paymentSeq: 1 });
    expect(planReversal({ allocationId: applied.id, reason: " Wrong invoice " }, [applied])).toEqual({
      ok: true,
      rows: [{ kind: "reversal", invoiceId: "inv-1", transferId: "p1", amount: M(300), currency: "USDC", reason: "Wrong invoice", reverses: applied.id, paymentSeq: null }],
    });
  });

  it("takes the fees beside a customer's last payment with it, fees first", () => {
    const applied = row({ invoiceId: "inv-1", amount: M(99.7), transferId: "p1", paymentSeq: 1 });
    const fee = row({ invoiceId: "inv-1", kind: "fee", amount: M(0.3), transferId: null, paymentSeq: null, basis: null, reason: "Transfer fee" });
    const plan = planReversal({ allocationId: applied.id, reason: "Not theirs" }, [applied, fee]);
    expect(plan.ok && plan.rows.map((planned) => [planned.reverses, planned.transferId])).toEqual([
      [fee.id, null],
      [applied.id, "p1"],
    ]);
    // With another payment still beside it, the fee stays.
    const other = row({ invoiceId: "inv-1", amount: M(10), transferId: "p2", paymentSeq: 1 });
    const kept = planReversal({ allocationId: applied.id, reason: "Not theirs" }, [applied, fee, other]);
    expect(kept.ok && kept.rows.map((planned) => planned.reverses)).toEqual([applied.id]);
  });

  it("refuses an unknown row, a reversal, a row reversed already, and no reason", () => {
    const applied = row({ invoiceId: "inv-1", amount: M(300) });
    const reversal = row({ invoiceId: "inv-1", kind: "reversal", amount: M(300), reverses: applied.id, reason: "Undo", basis: null });
    expect(planReversal({ allocationId: "nope", reason: "x" }, [applied])).toMatchObject({ ok: false, code: "not_found" });
    expect(planReversal({ allocationId: reversal.id, reason: "x" }, [applied, reversal])).toMatchObject({ ok: false, code: "not_reversible" });
    expect(planReversal({ allocationId: applied.id, reason: "x" }, [applied, reversal])).toMatchObject({ ok: false, code: "already_reversed" });
    expect(planReversal({ allocationId: applied.id, reason: "" }, [applied])).toMatchObject({ ok: false, code: "reason_required" });
  });
});

describe("the database's refusals", () => {
  it("read in the same plain words as the plan's", () => {
    expect(allocationErrorFromDb({ code: "P0001", message: "allocation_exceeds_payment: more than the payment brought" })?.code).toBe("exceeds_payment");
    expect(allocationErrorFromDb({ code: "P0001", message: "allocation_stale: the payment changed since it was read" })?.code).toBe("stale");
    expect(allocationErrorFromDb({ code: "23505", message: 'duplicate key value violates unique constraint "receivable_allocations_payment_seq"' })?.code).toBe("stale");
    expect(allocationErrorFromDb({ code: "23505", message: 'duplicate key value violates unique constraint "receivable_allocations_one_reversal"' })?.code).toBe("already_reversed");
    expect(allocationErrorFromDb({ code: "PGRST205", message: "Could not find the table 'public.receivable_allocations' in the schema cache" })?.code).toBe("not_ready");
    expect(allocationErrorFromDb({ code: "XX000", message: "something else" })).toBeNull();
  });
});

describe("the exact single match", () => {
  it("is still matchTransfer's, unchanged: the full amount of the one receivable", () => {
    const transfer = { circleTxId: "c-1", txHash: "0xabc", from: "0x2222222222222222222222222222222222222222", amount: 12.5, token: "USDC" as const, chain: "ARC-TESTNET", receivedAt: "2026-10-01T15:00:05Z" };
    const open = [{ id: "inv-1", counterpartyId: "cp-1", clientName: "Acme", amount: 12.5, currency: "USDC" as const, dueDate: "2026-10-15T12:00:00Z", clientAddress: transfer.from, createdAt: "2026-10-01T09:00:00Z", hasPayLink: true }];
    expect(matchTransfer(transfer, open)).toEqual({ invoiceId: "inv-1", matchedBy: "sender" });
    expect(matchTransfer({ ...transfer, amount: 6.25 }, open)).toBeNull();
  });
});
