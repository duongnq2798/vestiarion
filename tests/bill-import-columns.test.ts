import { describe, expect, it } from "vitest";
import { columnNames, detectMapping, headerKey, IMPORT_FIELDS, looksLikeHeader, sampleValues } from "@/lib/bill-import/columns";
import { readTable } from "@/lib/bill-import/table";

/** The fixed template the CSV import has always offered: its columns keep their meaning. */
const OLD_TEMPLATE_HEADER = "direction,counterparty,amount,memo,po_reference,goods_received,due_date,early_pay_discount_pct,discount_deadline,currency";

describe("headerKey", () => {
  it("ignores case, spaces, dots, dashes, underscores, slashes and #", () => {
    expect(headerKey(" Invoice No. ")).toBe("invoiceno");
    expect(headerKey("PO #")).toBe("po");
    expect(headerKey("due_date")).toBe("duedate");
    expect(headerKey("AP/AR")).toBe("apar");
    expect(headerKey("Amount-Due")).toBe("amountdue");
  });
});

describe("detectMapping", () => {
  it("maps every column of the old template to its own field", () => {
    const mapping = detectMapping(OLD_TEMPLATE_HEADER.split(","));
    expect(mapping).toEqual({
      direction: 0,
      counterparty: 1,
      amount: 2,
      memo: 3,
      poReference: 4,
      goodsReceived: 5,
      dueDate: 6,
      discountPct: 7,
      discountDeadline: 8,
      currency: 9,
    });
  });

  it.each([
    ["Vendor", "counterparty"],
    ["Supplier", "counterparty"],
    ["Payee", "counterparty"],
    ["Counterparty", "counterparty"],
    ["Customer", "counterparty"],
    ["Client name", "counterparty"],
    ["Amount", "amount"],
    ["Total", "amount"],
    ["Amount due", "amount"],
    ["Balance", "amount"],
    ["Due date", "dueDate"],
    ["Due", "dueDate"],
    ["Payment due", "dueDate"],
    ["Invoice no", "invoiceNumber"],
    ["Invoice #", "invoiceNumber"],
    ["Number", "invoiceNumber"],
    ["Bill no", "invoiceNumber"],
    ["Reference", "invoiceNumber"],
    ["PO", "poReference"],
    ["PO number", "poReference"],
    ["Purchase order", "poReference"],
    ["Currency", "currency"],
    ["Memo", "memo"],
    ["Description", "memo"],
    ["Goods received", "goodsReceived"],
    ["Direction", "direction"],
    ["Discount %", "discountPct"],
    ["Discount deadline", "discountDeadline"],
  ] as const)("reads “%s” as %s", (header, field) => {
    expect(detectMapping(["Something else", header])).toEqual({ [field]: 1 });
  });

  it("never takes a bare Date, an invoice date or a Type column", () => {
    expect(detectMapping(["Date", "Invoice date", "Type", "Category"])).toEqual({});
  });

  it("gives a column to one field only, and a field one column only", () => {
    expect(detectMapping(["Supplier", "Customer", "Total", "Amount"])).toEqual({ counterparty: 0, amount: 3 });
  });

  it("matches nothing to the column the failed-rows download adds", () => {
    expect(detectMapping(["Why it can't be added"])).toEqual({});
  });

  it("has a field for each part of an invoice the import fills", () => {
    expect(IMPORT_FIELDS).toEqual([
      "counterparty", "amount", "dueDate", "invoiceNumber", "poReference", "currency", "memo", "goodsReceived", "direction", "discountPct", "discountDeadline",
    ]);
  });
});

describe("looksLikeHeader and columnNames", () => {
  it("reads a first row with any known name as the column names", () => {
    expect(looksLikeHeader(["Supplier", "Whatever"])).toBe(true);
    expect(looksLikeHeader(["Kanto Paper", "1200", "2026-10-15"])).toBe(false);
  });

  it("names the columns from the header, or by letter when there is none", () => {
    const table = readTable("Supplier,,Total\nA,x,1,extra\n");
    expect(columnNames(table, true)).toEqual(["Supplier", "Column B", "Total", "Column D"]);
    expect(columnNames(table, false)).toEqual(["Column A", "Column B", "Column C", "Column D"]);
  });

  it("gives up to three sample values from the bills, skipping blanks", () => {
    const table = readTable("Supplier,Total\nA,1\nB,\nC,3\nD,4\nE,5");
    expect(sampleValues(table, true, 1)).toEqual(["1", "3", "4"]);
    expect(sampleValues(table, false, 0)).toEqual(["Supplier", "A", "B"]);
  });
});
