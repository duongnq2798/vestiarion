import { describe, expect, it } from "vitest";
import { NO_COLUMNS } from "@/lib/bank-statement/columns";
import { lineIdentity, readStatement, statementAccount, type StatementLine } from "@/lib/bank-statement/lines";

/**
 * A statement's lines (docs/superpowers/specs/2026-10-10-bank-statement-design.md B3-B5, B9): each row read with the
 * columns, the date order and the decimal mark chosen for the whole file, signed as money out or in, in its currency's
 * minor units; the rows that are not lines skipped with why; the period; and the statement checked against its own
 * running balance.
 */

const TODAY = "2026-10-11";

const SIGNED = [
  "Account: DBS 123-456,,,",
  "Date,Description,Amount,Balance",
  "03/10/2026,NORTHWIND CLOUD INV-2207,-1250.00,3750.00",
  "05/10/2026,Salary refund,200.00,3950.00",
  "13/10/2026,Atlas Compute,-45.50,3904.50",
  "Closing balance,,,3904.50",
].join("\n");

describe("readStatement", () => {
  it("reads a signed amount column below the bank's own lines, in minor units, with the period", () => {
    const read = readStatement(SIGNED, { currency: "sgd" }, "2026-10-20");
    expect(read.problems).toEqual([]);
    expect(read.questions).toEqual([]);
    expect(read.headerRow).toBe(1);
    expect(read.dateOrder).toBe("dmy");
    expect(read.decimalMark).toBe(".");
    expect(read.lines.map((line) => [line.line, line.bookedOn, line.minor, line.currency, line.description, line.balance])).toEqual([
      [3, "2026-10-03", -125000, "SGD", "NORTHWIND CLOUD INV-2207", 375000],
      [4, "2026-10-05", 20000, "SGD", "Salary refund", 395000],
      [5, "2026-10-13", -4550, "SGD", "Atlas Compute", 390450],
    ]);
    expect(read.skipped).toEqual([{ line: 6, why: "No date: not a line of the statement." }]);
    expect(read.period).toEqual({ from: "2026-10-03", to: "2026-10-13" });
  });

  it("reads money out as positive in a signed column when the person says so, and DR or CR after a value either way", () => {
    const text = "Date,Description,Amount\n2026-10-03,Northwind,1250.00\n2026-10-04,Refund,45.00 CR\n2026-10-05,Atlas,10.00 DR";
    expect(readStatement(text, { currency: "EUR", outIs: "positive" }, TODAY).lines.map((line) => line.minor)).toEqual([-125000, 4500, -1000]);
    expect(readStatement(text, { currency: "EUR" }, TODAY).lines.map((line) => line.minor)).toEqual([125000, 4500, -1000]);
  });

  it("reads money out and money in columns, each value's own sign ignored, with a semicolon and decimal commas", () => {
    const text = [
      "Buchungstag;Valutadatum;Verwendungszweck;Empfänger;Soll;Haben;Saldo;Währung",
      "03.10.2026;04.10.2026;Rechnung RE-77;Northwind GmbH;-1.250,00;;3.750,00;EUR",
      "05.10.2026;05.10.2026;Gutschrift;Kunde AG;;200,00;3.950,00;EUR",
    ].join("\n");
    const read = readStatement(text, {}, TODAY);
    expect(read.problems).toEqual([]);
    expect(read.decimalMark).toBe(",");
    expect(read.lines.map((line) => [line.bookedOn, line.valueOn, line.minor, line.currency, line.payee, line.balance])).toEqual([
      ["2026-10-03", "2026-10-04", -125000, "EUR", "Northwind GmbH", 375000],
      ["2026-10-05", "2026-10-05", 20000, "EUR", "Kunde AG", 395000],
    ]);
  });

  it("refuses a row with both money out and money in, a value that is not an amount, and a day after tomorrow, row by row", () => {
    const text = ["Date,Details,Withdrawal,Deposit", "2026-10-03,Both,10.00,5.00", "2026-10-04,Typo,1O.00,", "2026-10-13,Future,3.00,", "2026-10-12,Tomorrow,4.00,"].join("\n");
    const read = readStatement(text, { currency: "USD" }, TODAY);
    expect(read.lines.map((line) => line.description)).toEqual(["Tomorrow"]);
    expect(read.skipped).toEqual([
      { line: 2, why: "Both money out and money in are filled in." },
      { line: 3, why: '"1O.00" is not an amount in USD.' },
      { line: 4, why: "Dated after tomorrow." },
    ]);
  });

  it("keeps the yen whole, asks nothing about its thousands, and refuses its decimals", () => {
    // A yen account needs no answer about 125,000: it has no decimals for the comma to be.
    const whole = readStatement("Date,Description,Amount\n2026-10-03,Tokyo Office,\"-125,000\"\n2026-10-04,Rent,\"-3,000\"", { currency: "JPY" }, TODAY);
    expect(whole.questions).toEqual([]);
    expect(whole.lines.map((line) => line.minor)).toEqual([-125000, -3000]);
    const odd = readStatement("Date,Description,Amount\n2026-10-03,Tokyo Office,\"-125,000\"\n2026-10-04,Odd,-12.5", { currency: "JPY" }, TODAY);
    expect(odd.lines.map((line) => line.minor)).toEqual([-125000]);
    expect(odd.skipped).toEqual([{ line: 3, why: '"-12.5" is not an amount in JPY.' }]);
  });

  it("asks the date order and the decimal mark when the file allows two readings, and reads with the answers", () => {
    const text = "Date,Description,Amount\n03/04/2026,Northwind,\"-1,500\"\n05/04/2026,Atlas,-250";
    const asked = readStatement(text, { currency: "USD" }, TODAY);
    expect(asked.lines).toEqual([]);
    expect(asked.questions).toEqual([
      { kind: "dateOrder", example: "03/04/2026", readings: [{ order: "dmy", day: "2026-04-03" }, { order: "mdy", day: "2026-03-04" }] },
      { kind: "decimalMark", example: "-1,500" },
    ]);
    const answered = readStatement(text, { currency: "USD", dateOrder: "mdy", decimalMark: "." }, TODAY);
    expect(answered.questions).toEqual([]);
    expect(answered.lines.map((line) => [line.bookedOn, line.minor])).toEqual([
      ["2026-03-04", -150000],
      ["2026-05-04", -25000],
    ]);
  });

  it("says what is missing: the currency, the columns, and a choice made twice", () => {
    expect(readStatement("Date,Description,Amount\n2026-10-03,A,-1", {}, TODAY).problems).toEqual(["Type the account's currency, such as SGD, EUR or USDC."]);
    expect(readStatement("When,What,How much\n2026-10-03,A,-1", { currency: "USD" }, TODAY).problems).toEqual([
      "Choose the column with the booking date.",
      "Choose the column with the description.",
      "Choose the amount column, or the money out and money in columns.",
    ]);
    const columns = { ...NO_COLUMNS, bookingDate: 0, description: 1, amount: 2, moneyOut: 2 };
    expect(readStatement("When,What,How much\n2026-10-03,A,-1", { currency: "USD", columns }, TODAY).problems).toEqual([
      "One column is chosen for both Amount and Money out.",
      "Choose either one amount column, or money out and money in, not both.",
    ]);
  });

  it("asks the account's currency for a currency column with blank cells, and reads them in it", () => {
    const text = "Date,Description,Amount,Currency\n2026-10-03,Northwind,-120.00,EUR\n2026-10-04,Atlas,-5.00,";
    const blank = readStatement(text, {}, TODAY);
    expect(blank.needsCurrency).toBe(true);
    expect(blank.lines.map((line) => line.currency)).toEqual(["EUR"]);
    expect(blank.skipped).toEqual([{ line: 3, why: "No currency: type the account's currency." }]);
    expect(readStatement(text, { currency: "EUR" }, TODAY).lines.map((line) => line.currency)).toEqual(["EUR", "EUR"]);
    expect(readStatement("Date,Description,Amount,Currency\n2026-10-03,Northwind,-120.00,EUR", {}, TODAY).needsCurrency).toBe(false);
  });

  it("shows each column's first value under the header, so a column is known by what it holds", () => {
    const text = "Date,Description,Money out,Money in,Balance\n2026-10-01,Opening balance,,,100.00\n2026-10-02,Northwind,40.00,,60.00\n2026-10-03,Refund,,5.00,65.00";
    expect(readStatement(text, { currency: "USD" }, TODAY).example).toEqual(["2026-10-01", "Opening balance", "40.00", "5.00", "100.00"]);
  });

  it("reads a file with no header row from the columns the person chose", () => {
    const columns = { ...NO_COLUMNS, bookingDate: 0, description: 1, amount: 2 };
    const read = readStatement("2026-10-03,Northwind,-120.00\n2026-10-04,Atlas,-5.00", { currency: "USD", columns }, TODAY);
    expect(read.headerRow).toBe(-1);
    expect(read.headers).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(read.lines.map((line) => line.line)).toEqual([1, 2]);
  });

  it("names a date no order reads, and passes over text in the date column that is no date at all", () => {
    const conflict = readStatement("Date,Description,Amount\n13/10/2026,A,-1\n10/13/2026,B,-2", { currency: "USD" }, TODAY);
    expect(conflict.problems).toEqual(['"10/13/2026" on line 3 is not a date in the order the other dates are written.']);
    const footer = readStatement("Date,Description,Amount\n2026-10-03,A,-1\nPage 1 of 2,,", { currency: "USD" }, TODAY);
    expect(footer.problems).toEqual([]);
    expect(footer.skipped).toEqual([{ line: 3, why: '"Page 1 of 2" is not a date.' }]);
  });

  it("refuses two decimal marks in one file, showing both", () => {
    const read = readStatement("Date,Description,Amount\n2026-10-03,A,-12.50\n2026-10-04,B,\"-3,25\"", { currency: "EUR" }, TODAY);
    expect(read.problems).toEqual(['"-12.50" and "-3,25" are written with different decimal marks.']);
  });

  it("refuses a statement longer than 2,000 lines", () => {
    const rows = Array.from({ length: 2001 }, (_, index) => `2026-10-03,Line ${index},-1.00`);
    expect(readStatement(`Date,Description,Amount\n${rows.join("\n")}`, { currency: "USD" }, TODAY).problems).toEqual([
      "The statement has more than 2,000 lines. Import a shorter period.",
    ]);
  });

  it("refuses in words a file of many short rows, within 2 MB, rather than failing on its size", () => {
    const rows = Array.from({ length: 135_000 }, () => "20261003,A,-1");
    const text = `Date,Description,Amount\n${rows.join("\n")}`;
    expect(text.length).toBeLessThan(2_000_000);
    expect(readStatement(text, { currency: "USD" }, TODAY).problems).toEqual(["The statement has more than 2,000 lines. Import a shorter period."]);
  });

  it("keeps two identical lines as two, marked as looking the same, each with its own place", () => {
    const text = "Date,Description,Amount\n2026-10-03,Card fee,-5.00\n2026-10-03,Card fee,-5.00\n2026-10-04,Card fee,-5.00";
    const lines = readStatement(text, { currency: "USD" }, TODAY).lines;
    expect(lines.map((line) => [line.occurrence, line.lookalike])).toEqual([
      [0, true],
      [1, true],
      [0, false],
    ]);
    expect(lineIdentity("Main  account", lines[0])).not.toBe(lineIdentity("Main account", lines[1]));
    expect(lineIdentity(" MAIN account ", lines[0])).toBe(lineIdentity("main account", lines[0]));
  });
});

describe("the balance check", () => {
  it("says every line adds up, with the opening and closing balance and the money out and in", () => {
    const read = readStatement(SIGNED, { currency: "SGD" }, "2026-10-20");
    expect(read.balances).toEqual([{ currency: "SGD", status: "adds_up", opening: 500000, closing: 390450, out: 129550, in: 20000, mismatch: null, newestFirst: false }]);
  });

  it("names the first line that does not add up, and what the balance should have been", () => {
    const text = SIGNED.replace("13/10/2026,Atlas Compute,-45.50,3904.50", "13/10/2026,Atlas Compute,-45.50,3905.40");
    expect(readStatement(text, { currency: "SGD" }, "2026-10-20").balances[0]).toMatchObject({ status: "mismatch", mismatch: { line: 5, expected: 390450, found: 390540 } });
  });

  it("says when every line adds up only with money in and out the other way round", () => {
    expect(readStatement(SIGNED, { currency: "SGD", outIs: "positive" }, "2026-10-20").balances[0]).toMatchObject({ status: "reversed", mismatch: null });
  });

  it("reads a statement listed newest first the other way, and checks across lines with no balance printed", () => {
    const text = ["Date,Description,Amount,Balance", "13/10/2026,Atlas Compute,-45.50,3904.50", "05/10/2026,Salary refund,200.00,", "03/10/2026,NORTHWIND,-1250.00,3750.00", "01/10/2026,Opening balance,,5000.00"].join("\n");
    const read = readStatement(text, { currency: "SGD" }, "2026-10-20");
    expect(read.balances[0]).toMatchObject({ status: "adds_up", opening: 500000, closing: 390450, newestFirst: true });
    expect(read.skipped).toEqual([{ line: 5, why: "A balance with no amount: used only for the balance check." }]);
  });

  it("checks nothing without a balance column", () => {
    expect(readStatement("Date,Description,Amount\n2026-10-03,A,-1", { currency: "USD" }, TODAY).balances).toEqual([]);
  });
});

describe("statementAccount", () => {
  it("takes the account as named, spaces collapsed, up to 80 characters", () => {
    expect(statementAccount("  DBS   operating ")).toBe("DBS operating");
    expect(statementAccount(" ")).toBeNull();
    expect(statementAccount("x".repeat(81))).toBeNull();
  });
});

// The type is the module's contract with the matcher and the server.
export type { StatementLine };
