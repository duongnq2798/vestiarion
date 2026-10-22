import { describe, expect, it } from "vitest";
import { matchStatement, sameNumber, type BookBill, type BookPayment } from "@/lib/vendor-statement/match";
import type { VendorStatementLine } from "@/lib/vendor-statement/read";

/**
 * A vendor's statement against the books (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS3, VS4): by
 * number, then by amount and the closest day; payments within 10 days; what is left on either side; the balances.
 */

let next = 1;
const charge = (on: string, number: string | null, amount: number, more: Partial<VendorStatementLine> = {}): VendorStatementLine => ({
  line: ++next, on, number, description: "Invoice", kind: "charge", amount, currency: "USD", balance: null, ...more,
});
const payment = (on: string, amount: number, more: Partial<VendorStatementLine> = {}): VendorStatementLine => ({
  line: ++next, on, number: null, description: "Payment received", kind: "payment", amount, currency: "USD", balance: null, ...more,
});
const bill = (id: string, number: string | null, amount: number, addedOn: string, more: Partial<BookBill> = {}): BookBill => ({
  id, number, memo: null, amount, currency: "USDC", original: null, addedOn, status: "pending", ...more,
});
const paid = (invoiceId: string, amount: number, paidOn: string): BookPayment => ({ invoiceId, amount, currency: "USDC", paidOn, txUrl: `https://explorer.arc.io/tx/0x${invoiceId}` });

describe("charges", () => {
  it("match a bill by its number, whatever the spaces, dashes and case, and say when the amount differs", () => {
    expect(sameNumber(" inv - 2207 ")).toBe(sameNumber("INV2207"));
    const result = matchStatement({
      lines: [charge("2026-10-01", "inv 2207", 100), charge("2026-10-02", "INV-2208", 55)],
      bills: [bill("a", "INV-2207", 100, "2026-10-03"), bill("b", "INV2208", 50, "2026-10-03")],
      payments: [],
      currency: "USD",
    });
    expect(result.counts).toMatchObject({ charges: 2, matchedCharges: 2 });
    expect(result.differs).toEqual([expect.objectContaining({ number: "INV-2208", billId: "b", theirs: 55, ours: 50 })]);
    expect(result.missing).toEqual([]);
  });

  it("match by amount and the closest day within 45 days when no number names the bill, and say what is missing", () => {
    const result = matchStatement({
      lines: [charge("2026-10-10", null, 80), charge("2026-10-20", "INV-9", 300)],
      bills: [bill("far", null, 80, "2026-08-01"), bill("near", null, 80, "2026-10-14"), bill("closer", null, 80, "2026-10-11", { status: "paid" })],
      payments: [],
      currency: "USD",
    });
    expect(result.counts.matchedCharges).toBe(1);
    expect(result.missing).toEqual([expect.objectContaining({ number: "INV-9", amount: 300 })]);
    // The closest within 45 days took it: the bill added on Oct 11, not the one on Oct 14 or in August.
    expect(result.notListed.map((entry) => entry.billId)).toEqual(["near"]);
  });

  it("never take by amount a bill another line names by number, in whatever order the statement lists them (review 1)", () => {
    // Newest first: INV-11 comes before INV-10, both 99. Only INV-10 is on the books.
    const result = matchStatement({ lines: [charge("2026-10-09", "INV-11", 99), charge("2026-10-02", "INV-10", 99)], bills: [bill("ten", "INV-10", 99, "2026-10-02")], payments: [], currency: "USD" });
    expect(result.missing).toEqual([expect.objectContaining({ number: "INV-11" })]);
    expect(result.notListed).toEqual([]);
  });

  it("match a number to the first word of a memo only, never to part of one (review 1)", () => {
    const result = matchStatement({
      lines: [charge("2026-10-01", "1001", 10), charge("2026-10-02", "10012", 20), charge("2026-10-03", "2026", 30)],
      bills: [bill("paper", null, 20, "2026-10-02", { memo: "10012 Paper" }), bill("own", "1001", 10, "2026-10-01"), bill("year", null, 31, "2026-10-03", { memo: "Rent for October 2026" })],
      payments: [],
      currency: "USD",
    });
    expect(result.counts.matchedCharges).toBe(2);
    expect(result.differs).toEqual([]);
    expect(result.missing).toEqual([expect.objectContaining({ number: "2026" })]);
  });

  it("say a charge for a bill rejected here apart, never as missing (review 4)", () => {
    const result = matchStatement({ lines: [charge("2026-10-01", "INV-7", 40)], bills: [bill("r", "INV-7", 40, "2026-10-01", { status: "rejected" })], payments: [], currency: "USD" });
    expect(result.missing).toEqual([]);
    expect(result.rejected).toEqual([{ line: expect.any(Number), number: "INV-7", billId: "r", amount: 40 }]);
    expect(result.notListed).toEqual([]);
  });

  it("say what is listed twice, on their statement or here", () => {
    const result = matchStatement({
      lines: [charge("2026-10-01", "INV-1", 10), charge("2026-10-02", "INV-1", 10)],
      bills: [bill("a", "INV-1", 10, "2026-10-01"), bill("b", "INV-5", 20, "2026-10-01"), bill("c", "inv5", 20, "2026-10-02")],
      payments: [],
      currency: "USD",
    });
    expect(result.twice).toEqual([
      { number: "INV1", lines: [expect.any(Number), expect.any(Number)], billIds: ["a"] },
      { number: "INV5", lines: [], billIds: ["b", "c"] },
    ]);
  });

  it("read a number an imported bill keeps at the head of its memo", () => {
    const result = matchStatement({ lines: [charge("2026-10-01", "LP-2026-117", 2)], bills: [bill("a", null, 2.5, "2026-10-01", { memo: "LP-2026-117 · print run" })], payments: [], currency: "USD" });
    expect(result.differs).toEqual([expect.objectContaining({ billId: "a", theirs: 2, ours: 2.5 })]);
  });
});

describe("payments", () => {
  it("match ours of the same amount within 10 days, list ours they do not, and theirs we have no record of", () => {
    const result = matchStatement({
      lines: [charge("2026-10-01", "INV-1", 100), charge("2026-10-02", "INV-2", 40), payment("2026-10-08", 100), payment("2026-10-20", 999)],
      bills: [bill("a", "INV-1", 100, "2026-10-01", { status: "paid" }), bill("b", "INV-2", 40, "2026-10-02", { status: "paid" })],
      payments: [paid("a", 100, "2026-10-02"), paid("b", 40, "2026-10-12")],
      currency: "USD",
    });
    expect(result.counts).toMatchObject({ payments: 2, matchedPayments: 1 });
    expect(result.paidNotListed).toEqual([{ billId: "b", number: "INV-2", amount: 40, paidOn: "2026-10-12", txUrl: "https://explorer.arc.io/tx/0xb" }]);
    expect(result.unknownPayments).toEqual([expect.objectContaining({ on: "2026-10-20", amount: 999 })]);
  });

  it("leave out a payment of ours outside the statement's days", () => {
    const result = matchStatement({ lines: [charge("2026-10-01", "INV-1", 10)], bills: [bill("a", "INV-1", 10, "2026-10-01")], payments: [paid("a", 10, "2026-11-30")], currency: "USD" });
    expect(result.paidNotListed).toEqual([]);
  });
});

describe("currencies and balances", () => {
  it("compare USD with USDC, EUR with EURC, a bill's own business currency, and another currency by number only", () => {
    const eur = matchStatement({ lines: [charge("2026-10-01", "F-1", 90, { currency: "EUR" })], bills: [bill("a", "F-1", 95, "2026-10-01", { currency: "EURC" })], payments: [], currency: "EUR" });
    expect(eur.differs).toEqual([expect.objectContaining({ theirs: 90, ours: 95 })]);
    const sgd = matchStatement({
      lines: [charge("2026-10-01", null, 135, { currency: "SGD" })],
      bills: [bill("a", null, 100, "2026-10-01", { original: { amount: 135, currency: "SGD" } })],
      payments: [],
      currency: "SGD",
    });
    expect(sgd.counts.matchedCharges).toBe(1);
    const other = matchStatement({ lines: [charge("2026-10-01", "X-1", 135, { currency: "GBP" })], bills: [bill("a", "X-1", 100, "2026-10-01")], payments: [], currency: "GBP" });
    expect(other.counts.matchedCharges).toBe(1);
    expect(other.differs).toEqual([]);
    // Said, so a clean result is never claimed for an amount nobody compared (review 7).
    expect(other.notCompared).toEqual([{ line: expect.any(Number), number: "X-1", billId: "a" }]);
  });

  it("give their last printed balance beside what our open bills add up to", () => {
    const result = matchStatement({
      lines: [charge("2026-10-01", "INV-1", 100, { balance: 100 }), charge("2026-10-05", "INV-2", 50, { balance: 150 }), payment("2026-10-09", 100, { balance: 50 })],
      bills: [bill("a", "INV-1", 100, "2026-10-01", { status: "paid" }), bill("b", "INV-2", 50, "2026-10-05"), bill("c", null, 7, "2026-10-06", { status: "rejected" })],
      payments: [paid("a", 100, "2026-10-08")],
      currency: "USD",
    });
    expect(result.balance).toEqual({ theirs: 50, ours: 50, otherCurrency: 0 });
    expect(result.period).toEqual({ from: "2026-10-01", to: "2026-10-09" });
  });

  it("take the balance written last on the last day of a statement listed newest first, and leave out later and other bills (review 6)", () => {
    const result = matchStatement({
      lines: [charge("2026-10-09", "INV-3", 20, { balance: 170 }), charge("2026-10-09", "INV-2", 50, { balance: 150 }), charge("2026-10-01", "INV-1", 100, { balance: 100 })],
      bills: [bill("a", "INV-1", 100, "2026-10-01"), bill("b", "INV-2", 50, "2026-10-09"), bill("later", null, 5, "2026-10-15"), bill("sgd", null, 7, "2026-10-02", { currency: "SGD" })],
      payments: [],
      currency: "USD",
    });
    expect(result.balance).toEqual({ theirs: 170, ours: 150, otherCurrency: 1 });
  });
});
