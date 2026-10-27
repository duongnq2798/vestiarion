import { describe, expect, it } from "vitest";
import {
  CHECK_FIELDS,
  checkMapping,
  MAX_CHECK_BILLS,
  questionsOf,
  readBills,
  startingAnswers,
  unansweredOf,
  vendorKeyOf,
  type CheckAnswers,
} from "@/lib/bill-check/read";
import { readTable } from "@/lib/bill-import/table";

/**
 * The free bill list check's reader (docs/superpowers/specs/2026-10-28-check-bills-design.md CB2, CB3, CB4): a list's
 * columns matched as the bill import matches them, the questions only the person can answer, and each bill read to what
 * the check compares, with what is wrong with it in words. Nothing here belongs to a workspace.
 */

const answersFor = (text: string, change: Partial<CheckAnswers> = {}) => {
  const table = readTable(text);
  return { table, answers: { ...startingAnswers(table), ...change } };
};

describe("the columns (CB3)", () => {
  it("reads the first row as column names and matches each field as the import does, leaving out what the check does not use", () => {
    const { answers } = answersFor("Vendor Name,Bill Number,Due Date,Total,Currency Code,Status,Received,Type\nNorthwind,NH-1,2026-11-02,240.00,USD,Open,yes,payable");
    expect(answers.hasHeader).toBe(true);
    expect(answers.mapping).toEqual({ counterparty: 0, invoiceNumber: 1, dueDate: 2, amount: 3, currency: 4 });
    expect(CHECK_FIELDS).not.toContain("direction");
    expect(CHECK_FIELDS).not.toContain("goodsReceived");
    expect(checkMapping(["Direction", "Goods received", "Supplier"])).toEqual({ counterparty: 2 });
    expect(answers.dateOrder).toBeNull();
    expect(answers.decimalMark).toBeNull();
  });

  it("starts with no column names, and nothing matched, for a list without them", () => {
    const { answers } = answersFor("Northwind\t240.00\t2026-11-02");
    expect(answers.hasHeader).toBe(false);
    expect(answers.mapping).toEqual({});
  });

  it("needs the counterparty, the amount and the due date, each from its own column", () => {
    const { table, answers } = answersFor("Vendor,Amount\nNorthwind,240.00");
    expect(unansweredOf(questionsOf(table, answers), answers)).toBe("Choose the column for Due date.");
    const twice = { ...answers, mapping: { counterparty: 0, amount: 1, dueDate: 1 } };
    expect(unansweredOf(questionsOf(table, twice), twice)).toBe("Choose a different column for each field.");
    const empty = answersFor("Vendor,Amount,Due date");
    expect(unansweredOf(questionsOf(empty.table, empty.answers), empty.answers)).toBe("The list has no bills under its column names.");
  });

  it("asks day or month first only when the list's dates can be read both ways, from every date column", () => {
    const { table, answers } = answersFor("Vendor,Amount,Due date,Discount deadline\nNorthwind,240.00,03/04/2026,02/04/2026");
    const questions = questionsOf(table, answers);
    expect(questions.dateOrder).toMatchObject({ ask: true, orders: ["dmy", "mdy"] });
    expect(unansweredOf(questions, answers)).toBe("Choose whether the list's dates are day first or month first.");
    expect(unansweredOf(questions, { ...answers, dateOrder: "dmy" })).toBeNull();
    // A late fee's first day of 15/04 settles it: day first.
    const settled = answersFor("Vendor,Amount,Due date,Late fee starts\nNorthwind,240.00,03/04/2026,15/04/2026");
    expect(questionsOf(settled.table, settled.answers).dateOrder).toMatchObject({ ask: false, order: "dmy" });
  });

  it("asks how amounts are written only when one reads two ways", () => {
    const { table, answers } = answersFor("Vendor\tAmount\tDue date\nNorthwind\t1,234\t2026-11-02");
    expect(unansweredOf(questionsOf(table, answers), answers)).toBe("Choose how the list writes its amounts: 1,234.50 or 1.234,50.");
    expect(unansweredOf(questionsOf(table, answers), { ...answers, decimalMark: "," })).toBeNull();
  });

  it("asks the list's currency only for rows that say none, starting at the first one their symbols fit", () => {
    const plain = answersFor("Vendor,Amount,Due date\nNorthwind,240.00,2026-11-02");
    expect(plain.answers.currency).toBe("USD");
    expect(questionsOf(plain.table, plain.answers).currency).toBe(true);
    // A euro or pound sign names its currency: no row needs the list's.
    const signed = answersFor("Vendor\tAmount\tDue date\nNorthwind\t€240.00\t2026-11-02\nHarbor\t£12.00\t2026-11-03");
    expect(questionsOf(signed.table, signed.answers).currency).toBe(false);
    expect(readBills(signed.table, signed.answers).map((bill) => bill.currency)).toEqual(["EUR", "GBP"]);
    // A yen sign could be the yuan too: the list's currency starts at the yen, the one of the two offered.
    expect(answersFor("Vendor\tAmount\tDue date\nNorthwind\t¥24000\t2026-11-02").answers.currency).toBe("JPY");
    const clash = answersFor("Vendor\tAmount\tDue date\nNorthwind\t$240.00\t2026-11-02\nHarbor\t¥1200\t2026-11-03");
    expect(clash.answers.currency).toBeNull();
    expect(unansweredOf(questionsOf(clash.table, clash.answers), clash.answers)).toBe("Choose the list's currency.");
  });
});

describe("each bill as read (CB4)", () => {
  const list = [
    "Supplier,Invoice No.,Description,PO,Due,Total,Currency,Discount %,Discount until,Late fee per month (%),Late fee starts",
    "Bluebell Print Co.,BP-1042,Brochures,PO-881,2026-11-07,\"1,250.00\",USD,2,2026-10-30,1.5,2026-11-10",
    "Northwind Hosting,NH-7,Hosting,,2026-11-02,240,,,,1.5,",
    ",X-1,,,2026-11-02,10.00,USD,,,,",
    "Harbor,H-1,,,2026-02-30,10.00,USD,,,,",
    "Lakeside Freight,LF-1,,,2026-11-02,ten,USD,,,,",
    "Juniper,J-1,,,2026-11-02,10.00,XYZ,,,,",
    "Orchard,O-1,,,2026-11-02,10.00,USD,150,,12,2026-10-01",
  ].join("\n");
  const { table, answers } = answersFor(list);
  const bills = readBills(table, answers);

  it("reads a bill's every field, its discount and its late fee", () => {
    expect(bills[0]).toMatchObject({
      line: 2,
      vendor: "Bluebell Print Co.",
      vendorKey: "bluebell print",
      amount: "1250",
      currency: "USD",
      dueDate: "2026-11-07",
      invoiceNumber: "BP-1042",
      poReference: "PO-881",
      memo: "Brochures",
      discount: { pct: 2, deadline: "2026-10-30" },
      lateFee: { kind: "percent_month", value: 1.5, startsOn: "2026-11-10" },
      problems: [],
      checked: true,
    });
  });

  it("groups a vendor by its name without case, punctuation or a legal suffix, keeping letters outside a to z", () => {
    const { table, answers } = answersFor(
      ["Vendor,Due,Amount", "Bluebell Print Co.,2026-11-02,10.00", "東京 Design Ltd.,2026-11-02,10.00", "大阪 Design,2026-11-02,10.00", "Магазин 1,2026-11-02,10.00", "Straße GmbH,2026-11-02,10.00", "東京,2026-11-02,10.00"].join("\n")
    );
    expect(readBills(table, answers).map((bill) => bill.vendorKey)).toEqual(["bluebell print", "東京 design", "大阪 design", "магазин 1", "straße", "東京"]);
  });

  it("keeps the marks of letters outside a to z in the vendor key, and leaves out only Latin accents", () => {
    const names = ["राम Traders", "रमा Traders", "バス商事", "パス商事", "ハス商事", "สมศรี", "สมศร", "Май", "Маи"];
    expect(new Set(names.map(vendorKeyOf)).size).toBe(names.length);
    // One name written another way is one key: in parts, in half-width letters, with a Latin accent or a legal suffix.
    expect(vendorKeyOf("バス商事".normalize("NFD"))).toBe(vendorKeyOf("バス商事"));
    expect(vendorKeyOf("ﾊﾞｽ商事 Ltd.")).toBe(vendorKeyOf("バス商事"));
    expect(vendorKeyOf("Café Nord")).toBe("cafe nord");
    expect(vendorKeyOf("東京 Café")).toBe("東京 cafe");
  });

  it("takes the list's currency for a row that does not say, and starts a late fee without a first day the day after the due date (LF1)", () => {
    expect(bills[1]).toMatchObject({ currency: "USD", amount: "240", lateFee: { kind: "percent_month", value: 1.5, startsOn: "2026-11-03" }, checked: true });
  });

  it("leaves a bill out of the check, and says why, when its counterparty, amount, currency or due date cannot be read", () => {
    expect(bills[2]).toMatchObject({ checked: false, problems: ["No counterparty name."] });
    expect(bills[3]).toMatchObject({ checked: false, problems: ["Due date “2026-02-30” is not a real day."] });
    expect(bills[4]).toMatchObject({ checked: false, problems: ["Amount “ten” is not a number."] });
    expect(bills[5]).toMatchObject({ checked: false, problems: ["XYZ is not a currency code."] });
  });

  it("checks a bill whose discount or late fee cannot be read, without them", () => {
    expect(bills[6]).toMatchObject({ checked: true, discount: null, lateFee: null });
    expect(bills[6].problems).toEqual([
      "Early-payment discount “150” is not a percent above 0 and below 100.",
      "Late fee “12” is not a percent above 0 and at most 10 a month.",
    ]);
  });

  it("says when a discount has no deadline, a late fee is given twice, or starts before the due date", () => {
    const more = answersFor(
      [
        "Vendor,Amount,Due date,Discount %,Discount deadline,Late fee percent,Late fee amount,Late fee starts",
        "Northwind,240.00,2026-11-02,2,,,,",
        "Harbor,100.00,2026-11-02,,,1.5,25.00,",
        "Juniper,100.00,2026-11-02,,,,25.00,2026-10-01",
        "Orchard,100.00,2026-11-02,,,,25.00,2026-11-05",
      ].join("\n")
    );
    const read = readBills(more.table, more.answers);
    expect(read[0].problems).toEqual(["An early-payment discount needs its deadline: it is left out."]);
    expect(read[1].problems).toEqual(["Give a late fee as a percent a month or a fixed amount, not both."]);
    expect(read[2].problems).toEqual(["The late fee cannot start before the due date."]);
    expect(read[3]).toMatchObject({ lateFee: { kind: "fixed", value: 25, startsOn: "2026-11-05" }, problems: [] });
    for (const bill of read) expect(bill.checked).toBe(true);
  });

  it("reads a currency from the amount's own symbol, and refuses a symbol that disagrees with the row's currency", () => {
    const symbols = answersFor("Vendor\tAmount\tDue date\tCurrency\nNorthwind\t£240.00\t2026-11-02\t\nHarbor\t€10.00\t2026-11-02\tUSD", { currency: "USD" });
    const read = readBills(symbols.table, symbols.answers);
    expect(read[0]).toMatchObject({ currency: "GBP", amount: "240", checked: true });
    expect(read[1]).toMatchObject({ checked: false, problems: ["The amount is written in €, but the row's currency is USD."] });
  });

  it("reads a list's dates in the order the person chose", () => {
    const dates = answersFor("Vendor,Amount,Due date\nNorthwind,240.00,03/04/2026", { dateOrder: "mdy" });
    expect(readBills(dates.table, dates.answers)[0].dueDate).toBe("2026-03-04");
  });
});

describe("the cap (CB2)", () => {
  it(`checks at most ${MAX_CHECK_BILLS} bills, and counts the ones left out`, () => {
    const rows = Array.from({ length: MAX_CHECK_BILLS + 3 }, (_, index) => `Vendor ${index},10.00,2026-11-02`);
    const { table, answers } = answersFor(["Vendor,Amount,Due date", ...rows].join("\n"));
    const questions = questionsOf(table, answers);
    expect(questions.bills).toBe(MAX_CHECK_BILLS);
    expect(questions.leftOut).toBe(3);
    expect(readBills(table, answers)).toHaveLength(MAX_CHECK_BILLS);
  });
});
