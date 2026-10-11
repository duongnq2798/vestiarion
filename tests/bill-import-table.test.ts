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

  it("keeps an inch mark in rows pasted from a spreadsheet, which never quotes such a cell, and merges no rows", () => {
    const pasted = [
      "Supplier\tDescription\tTotal\tDue date",
      "Acme\tPipe 12\" PVC\t100.00\t2026-11-01",
      "Beta\tElbows\t200.00\t2026-11-02",
      "Gamma\tValves\t300.00\t2026-11-03",
      "Delta\tBolt 6\" steel\t400.00\t2026-11-04",
      "Echo\tWasher\t500.00\t2026-11-05",
    ].join("\r\n");
    const table = readTable(pasted);
    expect(table.delimiter).toBe("\t");
    expect(table.rows.map((row) => [row.line, ...row.cells])).toEqual([
      [1, "Supplier", "Description", "Total", "Due date"],
      [2, "Acme", "Pipe 12\" PVC", "100.00", "2026-11-01"],
      [3, "Beta", "Elbows", "200.00", "2026-11-02"],
      [4, "Gamma", "Valves", "300.00", "2026-11-03"],
      [5, "Delta", "Bolt 6\" steel", "400.00", "2026-11-04"],
      [6, "Echo", "Washer", "500.00", "2026-11-05"],
    ]);
  });

  it("keeps an inch mark in a comma list's unquoted cell, even last in its cell", () => {
    expect(cells('Supplier,Size,Total\nAcme,12" pipe,100\nBeta,6",200\nGamma,ok,300\n')).toEqual([
      ["Supplier", "Size", "Total"],
      ["Acme", '12" pipe', "100"],
      ["Beta", '6"', "200"],
      ["Gamma", "ok", "300"],
    ]);
  });

  it("reads a pasted cell that only starts with a quoted word as it is written", () => {
    expect(cells('Supplier\tMemo\tTotal\nAcme\t"Rush" order\t100\nBeta\tBolt 6"\t200\n')).toEqual([
      ["Supplier", "Memo", "Total"],
      ["Acme", '"Rush" order', "100"],
      ["Beta", 'Bolt 6"', "200"],
    ]);
    expect(cells('Supplier,Memo,Total\nAcme,"Rush" order,100\n')[1]).toEqual(["Acme", '"Rush" order', "100"]);
  });

  it("keeps a quote a CSV writer forgot to double inside a quoted field", () => {
    expect(cells('Supplier,Memo,Total\nAcme,"Pipe 12" PVC, grey",100\n')[1]).toEqual(["Acme", 'Pipe 12" PVC, grey', "100"]);
  });

  it("reads an empty quoted field and one that is only a doubled quote", () => {
    expect(cells('a,b,c\n"",x,""""\n')[1]).toEqual(["", "x", '"']);
  });

  it("counts no delimiter that a mid-cell quote seems to hide or show when choosing one", () => {
    expect(readTable('Name\tSize 12"\tQty\tNote "a,b,c,d"\nA\t1\t2\t3').delimiter).toBe("\t");
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
