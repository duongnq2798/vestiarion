import { describe, expect, it } from "vitest";
import { decodeList, readTable, TableError } from "@/lib/bill-import/table";

const cells = (text: string) => readTable(text).rows.map((row) => row.cells);

describe("readTable", () => {
  it("reads a comma list", () => {
    const table = readTable("Supplier,Total\nKanto Paper,1200\n");
    expect(table.delimiter).toBe(",");
    expect(table.rows).toEqual([
      { line: 1, cells: ["Supplier", "Total"] },
      { line: 2, cells: ["Kanto Paper", "1200"] },
    ]);
  });

  it("reads rows pasted from a spreadsheet, which arrive tab-separated", () => {
    const table = readTable("Supplier\tTotal\tDue\r\nKanto Paper\t1,200.50\t15/10/2026\r\n");
    expect(table.delimiter).toBe("\t");
    expect(table.rows[1].cells).toEqual(["Kanto Paper", "1,200.50", "15/10/2026"]);
  });

  it("reads a semicolon list whose amounts hold commas", () => {
    const table = readTable("Lieferant;Betrag;Fällig\nMüller GmbH;1.234,50;15.10.2026\n");
    expect(table.delimiter).toBe(";");
    expect(table.rows[1].cells).toEqual(["Müller GmbH", "1.234,50", "15.10.2026"]);
  });

  it("reads quoted fields with doubled quotes, delimiters and line breaks inside", () => {
    expect(cells('Supplier,Memo\n"Acme, Inc","Design ""system""\nphase 1"\n')).toEqual([
      ["Supplier", "Memo"],
      ["Acme, Inc", 'Design "system"\nphase 1'],
    ]);
  });

  it("drops a byte-order mark", () => {
    expect(cells("﻿Supplier,Total\nA,1")[0][0]).toBe("Supplier");
  });

  it("skips blank rows but keeps each row's number as the spreadsheet shows it", () => {
    const table = readTable("Supplier,Total\n\nA,1\n,\nB,2\n\n");
    expect(table.rows.map((row) => [row.line, row.cells[0]])).toEqual([
      [1, "Supplier"],
      [3, "A"],
      [5, "B"],
    ]);
  });

  it("counts a row with a line break inside a quoted field once", () => {
    const table = readTable('Supplier,Memo\nA,"two\nlines"\nB,x\n');
    expect(table.rows.map((row) => row.line)).toEqual([1, 2, 3]);
  });

  it("prefers the delimiter that splits the first line into the most columns", () => {
    expect(readTable("a;b;c\n1,5;2;3").delimiter).toBe(";");
    expect(readTable("a,b,c\n1;2;3").delimiter).toBe(",");
    expect(readTable("one column\nvalue").delimiter).toBe(",");
  });

  it("ignores delimiters inside quotes when choosing one", () => {
    expect(readTable('"a,b,c";d\n1;2').delimiter).toBe(";");
  });

  it("refuses a quoted field that is never closed", () => {
    expect(() => readTable('Supplier,Memo\nA,"open')).toThrow(TableError);
    expect(() => readTable('Supplier,Memo\nA,"open')).toThrow("A quoted field is never closed");
  });

  it("refuses an empty list", () => {
    expect(() => readTable(" \n\n")).toThrow("The list is empty");
  });

  it("reads a file as UTF-8, and one that is not as Excel's Windows-1252, saying so", () => {
    expect(decodeList(new TextEncoder().encode("Supplier\n株式会社カントー"))).toEqual({ text: "Supplier\n株式会社カントー", legacy: false });
    expect(decodeList(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]))).toEqual({ text: "Müller", legacy: true });
  });

  it("trims each cell's surrounding spaces", () => {
    expect(cells(" Supplier , Total \n Kanto , 1 ")[1]).toEqual(["Kanto", "1"]);
  });
});
