import { describe, expect, it } from "vitest";
import { findHeaderRow, suggestColumns } from "@/lib/bank-statement/columns";

/**
 * Which column is which (docs/superpowers/specs/2026-10-10-bank-statement-design.md B2, B3): suggested from the header's
 * words, for the person to confirm; the header row found below the lines a bank adds above it.
 */

const NONE = { bookingDate: null, valueDate: null, description: null, payee: null, amount: null, moneyOut: null, moneyIn: null, reference: null, currency: null, balance: null };

describe("suggestColumns", () => {
  it("maps a signed amount statement", () => {
    expect(suggestColumns(["Posting Date", "Value Date", "Description", "Amount (SGD)", "Running Balance", "Ref."])).toEqual({
      ...NONE,
      bookingDate: 0,
      valueDate: 1,
      description: 2,
      amount: 3,
      balance: 4,
      reference: 5,
    });
  });

  it("maps money out and money in columns, ahead of a lone amount", () => {
    expect(suggestColumns(["Transaction Date", "Narrative", "Withdrawal Amount", "Deposit Amount", "Balance", "Currency", "Beneficiary"])).toEqual({
      ...NONE,
      bookingDate: 0,
      description: 1,
      moneyOut: 2,
      moneyIn: 3,
      balance: 4,
      currency: 5,
      payee: 6,
    });
    expect(suggestColumns(["Date", "Details", "Debit", "Credit", "Amount"])).toMatchObject({ moneyOut: 2, moneyIn: 3, amount: null });
    expect(suggestColumns(["Date", "Particulars", "Money out", "Money in"])).toMatchObject({ description: 1, moneyOut: 2, moneyIn: 3 });
  });

  it("reads the words of a few banks' own languages", () => {
    expect(suggestColumns(["Buchungstag", "Valutadatum", "Verwendungszweck", "Betrag", "Saldo", "Währung"])).toEqual({
      ...NONE,
      bookingDate: 0,
      valueDate: 1,
      description: 2,
      amount: 3,
      balance: 4,
      currency: 5,
    });
  });

  it("keeps a lone amount over one column of a single direction, and reads in and out only as whole headers", () => {
    expect(suggestColumns(["Date", "Description", "Amount in SGD", "Debit/Credit"])).toMatchObject({ amount: 2, moneyOut: null, moneyIn: null });
    expect(suggestColumns(["Date", "Text", "Out", "In"])).toMatchObject({ description: 1, moneyOut: 2, moneyIn: 3, amount: null });
    expect(suggestColumns(["Date", "Text", "DR", "CR"])).toMatchObject({ moneyOut: 2, moneyIn: 3 });
    expect(suggestColumns(["Date", "Sign in", "Amount"])).toMatchObject({ moneyIn: null, amount: 2 });
  });

  it("leaves a column it does not know unmapped", () => {
    expect(suggestColumns(["Account", "Type"])).toEqual(NONE);
  });
});

describe("findHeaderRow", () => {
  const record = (line: number, cells: string[]) => ({ line, cells });

  it("finds the header below the account and period lines", () => {
    const records = [record(1, ["Account: DBS 123-456"]), record(2, ["Period", "01/10/2026 - 31/10/2026"]), record(4, ["Date", "Description", "Withdrawal", "Deposit", "Balance"]), record(5, ["03/10/2026", "Northwind", "120.00", "", "4880.00"])];
    expect(findHeaderRow(records)).toBe(2);
  });

  it("says there is no header when the first row is already a line", () => {
    expect(findHeaderRow([record(1, ["03/10/2026", "Northwind", "-120.00"]), record(2, ["04/10/2026", "Atlas", "-5.00"])])).toBe(-1);
  });

  it("takes the first row when no row names its columns and it holds no date", () => {
    expect(findHeaderRow([record(1, ["When", "What", "How much"]), record(2, ["03/10/2026", "Northwind", "-120.00"])])).toBe(0);
  });
});
