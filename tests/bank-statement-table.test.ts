import { describe, expect, it } from "vitest";
import { detectDelimiter, readTable, splitRecords, StatementReadError } from "@/lib/bank-statement/table";

/**
 * Reading a bank statement's table (docs/superpowers/specs/2026-10-10-bank-statement-design.md B2): the delimiter, quoted
 * fields, and each record's line in the file, as a spreadsheet numbers it.
 */

describe("splitRecords", () => {
  it("reads quoted fields holding the delimiter, a doubled quote or a line break, and keeps each record's line", () => {
    const text = 'Date,Description,Amount\n2026-10-03,"Northwind, Cloud ""Pro""",-120.00\n\n2026-10-04,"Two\nlines",5\r\n2026-10-05,Plain,7';
    expect(splitRecords(text, ",")).toEqual([
      { line: 1, cells: ["Date", "Description", "Amount"] },
      { line: 2, cells: ["2026-10-03", 'Northwind, Cloud "Pro"', "-120.00"] },
      { line: 4, cells: ["2026-10-04", "Two\nlines", "5"] },
      { line: 6, cells: ["2026-10-05", "Plain", "7"] },
    ]);
  });

  it("keeps a quote inside an unquoted field as it is", () => {
    expect(splitRecords('a,12" pipe,b', ",")).toEqual([{ line: 1, cells: ["a", '12" pipe', "b"] }]);
  });

  it("refuses a quoted field that is never closed", () => {
    expect(() => splitRecords('a,"never closed\nb,c', ",")).toThrow(StatementReadError);
  });
});

describe("detectDelimiter", () => {
  it("finds a comma, a semicolon with decimal commas, a tab from a pasted spreadsheet, and a pipe", () => {
    expect(detectDelimiter("Date,Description,Amount\n2026-10-03,Northwind,-120.00\n2026-10-04,Atlas,-5.00")).toBe(",");
    expect(detectDelimiter("Datum;Verwendungszweck;Betrag;Saldo\n03.10.2026;Northwind;-1.250,00;5.000,00\n04.10.2026;Atlas;-5,00;4.995,00")).toBe(";");
    expect(detectDelimiter("Date\tDescription\tAmount\n03/10/2026\tNorthwind, Cloud\t-120.00\n04/10/2026\tAtlas\t-5.00")).toBe("\t");
    expect(detectDelimiter("Date|Description|Amount\n2026-10-03|Northwind|-120.00")).toBe("|");
  });

  it("is not thrown by the lines above the header that banks add", () => {
    const text = "Account: DBS 123-456\nPeriod: 01/10/2026 to 31/10/2026\n\nDate;Description;Withdrawal;Deposit;Balance\n03/10/2026;Northwind;120,00;;4.880,00\n05/10/2026;Salary;;1.000,00;5.880,00";
    expect(detectDelimiter(text)).toBe(";");
  });
});

describe("readTable", () => {
  it("drops a byte order mark and takes a first line sep= as the delimiter", () => {
    const table = readTable("\uFEFFsep=;\nDate;Amount\n2026-10-03;-1,50");
    expect(table.delimiter).toBe(";");
    expect(table.records).toEqual([
      { line: 2, cells: ["Date", "Amount"] },
      { line: 3, cells: ["2026-10-03", "-1,50"] },
    ]);
  });

  it("uses the delimiter the person chose", () => {
    expect(readTable("a,b;c", ";").records).toEqual([{ line: 1, cells: ["a,b", "c"] }]);
  });

  it("refuses an empty file in words", () => {
    expect(() => readTable(" \n\n")).toThrow("The statement is empty.");
  });
});
