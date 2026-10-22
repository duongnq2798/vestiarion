import { describe, expect, it } from "vitest";
import { readVendorStatement, suggestVendorColumns, vendorLines } from "@/lib/vendor-statement/read";

/**
 * Reading a vendor's statement of account (docs/superpowers/specs/2026-10-22-vendor-statement-design.md VS2): the bank
 * statement's reader, with a vendor's columns and its charges written positive by default.
 */

const TODAY = "2026-10-22";

describe("a vendor's columns", () => {
  it("names the date, the invoice number, the description, the charges, the payments and the balance", () => {
    expect(suggestVendorColumns(["Date", "Invoice No.", "Description", "Debit", "Credit", "Balance"])).toMatchObject({
      bookingDate: 0,
      reference: 1,
      description: 2,
      moneyOut: 3,
      moneyIn: 4,
      amount: null,
      balance: 5,
    });
    expect(suggestVendorColumns(["Posting date", "Document", "Type", "Amount", "Running balance"])).toMatchObject({ bookingDate: 0, reference: 1, description: 2, amount: 3, balance: 4 });
    expect(suggestVendorColumns(["Date", "Doc no", "Charges", "Payments"])).toMatchObject({ reference: 1, moneyOut: 2, moneyIn: 3, amount: null });
  });
});

describe("reading it", () => {
  it("reads a charge as positive in one amount column, and a payment as negative, unless told otherwise", () => {
    const text = ["Date,Document,Type,Amount,Balance", "2026-10-01,INV-1001,Invoice,100.00,100.00", "2026-10-03,INV-1002,Invoice,50.00,150.00", "2026-10-05,PMT-77,Payment,-100.00,50.00"].join("\n");
    const lines = vendorLines(readVendorStatement(text, { currency: "USD" }, TODAY).lines);
    expect(lines.map((line) => [line.kind, line.number, line.amount, line.balance])).toEqual([
      ["charge", "INV-1001", 100, 100],
      ["charge", "INV-1002", 50, 150],
      ["payment", "PMT-77", 100, 50],
    ]);
    const flipped = vendorLines(readVendorStatement(text, { currency: "USD", outIs: "negative" }, TODAY).lines);
    expect(flipped.map((line) => line.kind)).toEqual(["payment", "payment", "charge"]);
  });

  it("reads charges and payments in two columns, and asks the currency when no column gives it", () => {
    const text = ["Date,Invoice No,Description,Debit,Credit", "2026-10-01,INV-1,Design work,240.00,", "2026-10-09,,Payment received,,240.00"].join("\n");
    expect(readVendorStatement(text, {}, TODAY).problems).toContain("Type the account's currency, such as SGD, EUR or USDC.");
    const lines = vendorLines(readVendorStatement(text, { currency: "USD" }, TODAY).lines);
    expect(lines).toEqual([
      { line: 2, on: "2026-10-01", number: "INV-1", description: "Design work", kind: "charge", amount: 240, currency: "USD", balance: null },
      { line: 3, on: "2026-10-09", number: null, description: "Payment received", kind: "payment", amount: 240, currency: "USD", balance: null },
    ]);
  });
});
