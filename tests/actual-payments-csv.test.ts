import { describe, expect, it } from "vitest";
import { actualCurrency, actualMethod, paidDay } from "@/lib/actual-payment-fields";
import type { ActualRecord } from "@/lib/actual-payment-fields";
import { actualsCsvTemplate, ACTUALS_CSV_MAX_ROWS, matchActualsCsv, parseActualsCsv, type MatchBill } from "@/lib/actual-payments-csv";

/**
 * What the business paid, from a CSV (docs/superpowers/specs/2026-10-10-actual-payments-design.md A6): each row names a
 * payable by its Vestiarion id or its invoice number, and is previewed before anything is saved: new, a correction of
 * the bill's record, the same as recorded, or not matched, with why.
 */

const TODAY = "2026-10-10";
const ID_A = "018f8ce0-1557-7b54-a931-4d777f6bf001";
const ID_B = "018f8ce0-1557-7b54-a931-4d777f6bf002";
const ID_C = "018f8ce0-1557-7b54-a931-4d777f6bf003";

function matchBill(id: string, over: Partial<MatchBill> = {}): MatchBill {
  return { id, memo: null, payee: "Northwind", amount: 100, currency: "USDC", bill: null, dueDate: "2026-10-15T00:00:00.000Z", current: null, ...over };
}

function record(over: Partial<ActualRecord> = {}): ActualRecord {
  return {
    id: "rec-1",
    invoiceId: ID_A,
    outcome: "paid",
    paidOn: "2026-10-05",
    amount: 100,
    currency: "USDC",
    method: "bank_transfer",
    reference: "BANK-1",
    note: null,
    reason: null,
    replaces: null,
    source: "form",
    recordedBy: null,
    recordedAt: "2026-10-06T00:00:00.000Z",
    ...over,
  };
}

describe("the fields of a record", () => {
  it("reads a currency as three capitals, USDC or EURC", () => {
    expect(actualCurrency(" eur ")).toBe("EUR");
    expect(actualCurrency("usdc")).toBe("USDC");
    expect(actualCurrency("EURC")).toBe("EURC");
    expect(actualCurrency("USDT")).toBeNull();
    expect(actualCurrency("dollars")).toBeNull();
  });

  it("reads a method by its code or its words; blank is other", () => {
    expect(actualMethod("")).toBe("other");
    expect(actualMethod("Bank transfer")).toBe("bank_transfer");
    expect(actualMethod("bank-transfer")).toBe("bank_transfer");
    expect(actualMethod("CARD")).toBe("card");
    expect(actualMethod("cheque")).toBeNull();
  });

  it("reads a paid day as a real day, not before 2000 and not more than a day ahead", () => {
    expect(paidDay("2026-10-09", TODAY)).toBe("2026-10-09");
    expect(paidDay("2026-10-11", TODAY)).toBe("2026-10-11");
    expect(paidDay("2026-10-12", TODAY)).toBeNull();
    expect(paidDay("2026-02-30", TODAY)).toBeNull();
    expect(paidDay("09/10/2026", TODAY)).toBeNull();
    expect(paidDay("1999-12-31", TODAY)).toBeNull();
  });
});

describe("parseActualsCsv", () => {
  it("reads the columns by their headers, in any order and case, with currency, reference and method optional", () => {
    const rows = parseActualsCsv(`﻿Amount,Invoice,Paid date\n"1,250.00",INV-2207,2026-10-09\n`);
    expect(rows).toEqual([{ line: 2, invoice: "INV-2207", paidDate: "2026-10-09", amount: "1,250.00", currency: "", reference: "", method: "" }]);
  });

  it("takes invoice_id or invoice_number for the bill, and paid_on for the day", () => {
    expect(parseActualsCsv(`invoice_id,paid_on,amount\n${ID_A},2026-10-09,10`)[0]).toMatchObject({ invoice: ID_A, paidDate: "2026-10-09" });
    expect(parseActualsCsv(`invoice_number,paid_date,amount\nA-1,2026-10-09,10`)[0]).toMatchObject({ invoice: "A-1" });
  });

  it("says which columns are missing, and refuses a file with no row or too many", () => {
    expect(() => parseActualsCsv("invoice,amount\nA-1,10")).toThrow("Missing CSV column: paid_date");
    expect(() => parseActualsCsv("invoice,paid_date,amount\n")).toThrow("The CSV has a header but no payment.");
    const many = Array.from({ length: ACTUALS_CSV_MAX_ROWS + 1 }, (_, index) => `A-${index},2026-10-09,10`).join("\n");
    expect(() => parseActualsCsv(`invoice,paid_date,amount\n${many}`)).toThrow(`Import at most ${ACTUALS_CSV_MAX_ROWS} payments at a time.`);
  });

  it("leaves out a row with neither a day nor an amount, as the template's unfilled rows", () => {
    const rows = parseActualsCsv(`invoice,payee,paid_date,amount,currency\n${ID_A},Northwind,,,USDC\n${ID_B},Contabo,2026-10-09,30,USDC`);
    expect(rows.map((row) => row.invoice)).toEqual([ID_B]);
  });
});

describe("matchActualsCsv", () => {
  const parse = (body: string) => parseActualsCsv(`invoice,paid_date,amount,currency,reference,method\n${body}`);

  it("matches by Vestiarion id, in any case, and reads a blank currency as the bill's own", () => {
    const [row] = matchActualsCsv(parse(`${ID_A.toUpperCase()},2026-10-09,"1,170.00",,BANK-9,Bank transfer`), [matchBill(ID_A, { bill: { amount: 1170, currency: "EUR" }, amount: 1349.1 })], TODAY);
    expect(row).toEqual({
      line: 2,
      status: "new",
      invoiceId: ID_A,
      payee: "Northwind",
      record: { paidOn: "2026-10-09", amount: 1170, currency: "EUR", method: "bank_transfer", reference: "BANK-9" },
      replaces: null,
    });
  });

  it("matches an invoice number carried as a whole word in one payable's memo, ignoring case", () => {
    const bills = [matchBill(ID_A, { memo: "Invoice INV-2207, October hosting" }), matchBill(ID_B, { memo: "Invoice INV-22070" }), matchBill(ID_C, { memo: null })];
    const [row] = matchActualsCsv(parse("#inv-2207,2026-10-09,100,,,"), bills, TODAY);
    expect(row).toMatchObject({ status: "new", invoiceId: ID_A });
  });

  it("leaves a row unmatched when no payable or more than one carries its number, or its id is unknown", () => {
    const bills = [matchBill(ID_A, { memo: "INV-1 part 1" }), matchBill(ID_B, { memo: "INV-1 part 2" })];
    const rows = matchActualsCsv(parse(`INV-1,2026-10-09,100,,,\nINV-9,2026-10-09,100,,,\n${ID_C},2026-10-09,100,,,`), bills, TODAY);
    expect(rows).toEqual([
      { line: 2, status: "unmatched", invoice: "INV-1", why: "2 payables carry that invoice number in their memo. Use the Vestiarion invoice id instead." },
      { line: 3, status: "unmatched", invoice: "INV-9", why: "No payable carries that invoice number in its memo." },
      { line: 4, status: "unmatched", invoice: ID_C, why: "No payable in this workspace has that id." },
    ]);
  });

  it("says why a field cannot be read", () => {
    const bills = [matchBill(ID_A), matchBill(ID_B), matchBill(ID_C)];
    const rows = matchActualsCsv(parse(`${ID_A},09/10/2026,100,,,\n${ID_B},2026-10-09,abc,,,\n${ID_C},2026-10-09,100,dollars,,`), bills, TODAY);
    expect(rows.map((row) => (row.status === "invalid" ? row.why : row.status))).toEqual([
      "The paid date is not a day on or before tomorrow, written as YYYY-MM-DD.",
      "The amount is not one above zero, such as 1,250.00.",
      "The currency is not a three-letter code, USDC or EURC.",
    ]);
  });

  it("refuses a second row for a bill already in the file", () => {
    const rows = matchActualsCsv(parse(`${ID_A},2026-10-09,100,,,\n${ID_A},2026-10-10,100,,,`), [matchBill(ID_A)], TODAY);
    expect(rows[1]).toEqual({ line: 3, status: "invalid", invoice: ID_A, why: "Row 2 is for the same bill." });
  });

  it("corrects a bill's record when the row differs from it, and skips it when the row is the same", () => {
    const recorded = matchBill(ID_A, { current: record() });
    const same = matchActualsCsv(parse(`${ID_A},2026-10-05,100.00,USDC,BANK-1,bank transfer`), [recorded], TODAY);
    expect(same[0]).toMatchObject({ status: "same", replaces: "rec-1" });
    const changed = matchActualsCsv(parse(`${ID_A},2026-10-06,100.00,USDC,BANK-1,bank transfer`), [recorded], TODAY);
    expect(changed[0]).toMatchObject({ status: "correction", replaces: "rec-1" });
    const afterNotPaid = matchActualsCsv(parse(`${ID_A},2026-10-05,100,,,`), [matchBill(ID_A, { current: record({ outcome: "not_paid", paidOn: null, amount: null, currency: null, method: null, reference: null, reason: "No" }) })], TODAY);
    expect(afterNotPaid[0]).toMatchObject({ status: "correction", replaces: "rec-1" });
  });
});

describe("actualsCsvTemplate", () => {
  it("lists the bills not recorded yet with their ids, payees, amounts and due days, ready to fill and import", () => {
    const csv = actualsCsvTemplate([matchBill(ID_A, { payee: 'Atlas "Compute", Ltd', bill: { amount: 1170, currency: "EUR" } }), matchBill(ID_B)]);
    expect(csv.split("\n")).toEqual([
      "invoice,payee,bill_amount,bill_currency,due_date,paid_date,amount,currency,method,reference",
      `${ID_A},"Atlas ""Compute"", Ltd",1170.00,EUR,2026-10-15,,,EUR,,`,
      `${ID_B},Northwind,100.00,USDC,2026-10-15,,,USDC,,`,
    ]);
    // It reads back as nothing to import until a row is filled in.
    expect(() => parseActualsCsv(csv)).toThrow("The CSV has a header but no payment.");
  });
});
