import { describe, expect, it } from "vitest";
import { checkedCsv, checkedFileName, FLAG_COLUMN } from "@/lib/bill-check/csv";
import { checkBills, COMPARED_PER_BUCKET } from "@/lib/bill-check/findings";
import { MAX_CHECK_BILLS, questionsOf, startingAnswers, unansweredOf } from "@/lib/bill-check/read";
import { SAMPLE_SOURCE, sampleBillList } from "@/lib/bill-check/sample";
import { readTable } from "@/lib/bill-import/table";

/**
 * What the free bill list check finds (docs/superpowers/specs/2026-10-28-check-bills-design.md CB5–CB8, CB10): likely
 * duplicates by vendor, scored by the agent's own `scoreDuplicate` and its invoice numbers compared; runs of the same
 * amount about a month apart, kept apart; the discounts and late fees of the next 7 days with what each is worth; and
 * the list back with a flag column.
 */

const TODAY = "2026-10-28";
const HEADER = "Vendor,Invoice,Description,PO,Due date,Amount,Currency";

function check(rows: string[], header = HEADER, today = TODAY) {
  const table = readTable([header, ...rows].join("\n"));
  const answers = startingAnswers(table);
  expect(unansweredOf(questionsOf(table, answers), answers)).toBeNull();
  return { table, answers, result: checkBills(table, answers, today) };
}

describe("likely duplicates (CB5)", () => {
  it("finds a bill sent twice, with the agent's own explanation, its confidence and what is at stake", () => {
    const { result } = check([
      "Maple Street Cleaning,MS-301,Office cleaning,,2026-11-03,450.00,USD",
      "Maple Street Cleaning,MS-301,Office cleaning,,2026-11-03,450.00,USD",
    ]);
    expect(result.duplicates).toHaveLength(1);
    const [vendor] = result.duplicates;
    expect(vendor.vendor).toBe("Maple Street Cleaning");
    expect(vendor.atStake).toEqual([{ currency: "USD", amount: 450 }]);
    const [finding] = vendor.findings;
    expect(finding.bill.line).toBe(3);
    expect(finding.other.line).toBe(2);
    // A list does not say what is paid: no status in the sentence, and no more than 0.85.
    expect(finding.confidence).toBe(0.85);
    expect(finding.explanation).toBe(
      "Same counterparty, same 450 USD, same description as invoice due 2026-11-03 with the same due date, and no purchase order distinguishes them."
    );
    expect(finding.numberWords).toBe("Row 2 has the same invoice number, MS-301.");
    expect(finding.atStake).toEqual({ amount: "450", currency: "USD" });
    expect(result.atStake).toEqual([{ currency: "USD", amount: 450 }]);
  });

  it("finds the same purchase order billed again, and an invoice number written another way, under one vendor name", () => {
    const { result } = check([
      "Bluebell Print Co.,BP-1042,Brochures,PO-881,2026-11-07,1250.00,USD",
      "Bluebell Print Co,bp 1042,Brochures (sent again),PO 881,2026-11-09,1250.00,USD",
    ]);
    const [finding] = result.duplicates[0].findings;
    expect(result.duplicates[0].vendor).toBe("Bluebell Print Co.");
    expect(finding.explanation).toBe("Bills the same purchase order for the same 1250 USD as invoice due 2026-11-07 2 day(s) apart. Paying both would pay one obligation twice.");
    expect(finding.numberWords).toBe("Row 2 has the same invoice number, BP-1042, written bp 1042 here.");
    expect(finding.confidence).toBe(0.85);
  });

  it("finds an invoice number billed again for a different amount, as a purchase order billed twice is", () => {
    const { result } = check([
      "Lakeside Freight,LF-3310,Freight,,2026-11-06,980.00,USD",
      "Lakeside Freight,LF3310,Freight and handling,,2026-11-20,1080.00,USD",
    ]);
    const [finding] = result.duplicates[0].findings;
    expect(finding.explanation).toBeNull();
    expect(finding.confidence).toBe(0.55);
    expect(finding.numberWords).toBe("Row 2 has the same invoice number, LF-3310, written LF3310 here, for a different amount: 980.00 USD.");
    expect(finding.atStake).toEqual({ amount: "1080", currency: "USD" });
  });

  it("shows each bill with its strongest match only: a bill sent three times is two findings", () => {
    const row = "Maple Street Cleaning,MS-301,Office cleaning,,2026-11-03,450.00,USD";
    const { result } = check([row, row, row]);
    expect(result.duplicates[0].findings.map((finding) => [finding.bill.line, finding.other.line])).toEqual([
      [3, 2],
      [4, 3],
    ]);
    expect(result.atStake).toEqual([{ currency: "USD", amount: 900 }]);
  });

  it("never pairs two vendors, nor the same figure in two currencies, nor different invoice numbers a week apart", () => {
    const { result } = check([
      "Harbor Studio Ltd,HS-1,Design,,2026-11-03,100.00,USD",
      "Harbor Studio,HS-2,Design,,2026-11-03,100.00,EUR",
      "Juniper Office Supply,JO-1,Design,,2026-11-03,100.00,USD",
      "Redwood Legal,RL-1,Contract review,,2026-11-01,1800.00,USD",
      "Redwood Legal,RL-2,Contract review,,2026-11-08,1800.00,USD",
    ]);
    expect(result.duplicates).toEqual([]);
    expect(result.checked).toBe(5);
    expect(result.vendors).toBe(3);
  });

  it("puts the vendor with the strongest finding first", () => {
    const { result } = check([
      "Lakeside Freight,LF-3310,Freight,,2026-11-06,980.00,USD",
      "Lakeside Freight,LF3310,Freight,,2026-11-20,1080.00,USD",
      "Maple Street Cleaning,MS-301,Office cleaning,,2026-11-03,450.00,USD",
      "Maple Street Cleaning,MS-301,Office cleaning,,2026-11-03,450.00,USD",
    ]);
    expect(result.duplicates.map((vendor) => vendor.vendor)).toEqual(["Maple Street Cleaning", "Lakeside Freight"]);
    expect(result.atStake).toEqual([{ currency: "USD", amount: 1530 }]);
  });

  it(`compares each bill with at most ${COMPARED_PER_BUCKET} bills of its amount before it, the ones due closest`, () => {
    // The same bill 151 days later, with bills of its amount between: a month before it, so the recurring rule spares them.
    for (const [between, found] of [
      [COMPARED_PER_BUCKET - 1, 2],
      [COMPARED_PER_BUCKET, null],
    ] as const) {
      const middle = Array.from({ length: between }, (_, index) => `Northwind,,Item ${index},,2026-05-01,10.00,USD`);
      const rows = ["Northwind,,Hosting,,2026-01-01,10.00,USD", ...middle, "Northwind,,Hosting,,2026-06-01,10.00,USD"];
      const { result } = check(rows);
      const last = result.duplicates[0]?.findings.find((finding) => finding.bill.line === rows.length + 1);
      expect(last?.other.line ?? null).toBe(found);
    }
  });
});

describe("same amount, about a month apart (CB6)", () => {
  it("lists a monthly charge as a run, kept out of the likely duplicates by the recurring rule", () => {
    const { result } = check([
      "Northwind Hosting,NH-2207,Cloud hosting,,2026-09-04,240.00,USD",
      "Northwind Hosting,NH-2241,Cloud hosting,,2026-10-03,240.00,USD",
      "Northwind Hosting,NH-2275,Cloud hosting,,2026-11-01,240.00,USD",
      "Northwind Hosting,NH-2290,Backups,,2026-11-01,30.00,USD",
    ]);
    expect(result.duplicates).toEqual([]);
    expect(result.monthApart).toHaveLength(1);
    expect(result.monthApart[0]).toMatchObject({ vendor: "Northwind Hosting", amount: "240", currency: "USD", gaps: [29, 29] });
    expect(result.monthApart[0].bills.map((bill) => bill.line)).toEqual([2, 3, 4]);
  });

  it("shows a pair a month apart with no invoice numbers, which the agent's rule would not report", () => {
    const { result } = check(["Northwind Hosting,,Cloud hosting,,2026-10-03,240.00,USD", "Northwind Hosting,,Cloud hosting,,2026-11-02,240.00,USD"]);
    expect(result.duplicates).toEqual([]);
    expect(result.monthApart.map((run) => run.bills.map((bill) => bill.line))).toEqual([[2, 3]]);
  });

  it("leaves a pair a month apart that is a likely duplicate out of the runs", () => {
    const { result } = check(["Bluebell Print Co,BP-1,Brochures,PO-881,2026-10-03,1250.00,USD", "Bluebell Print Co,BP-2,Brochures,PO-881,2026-11-02,1250.00,USD"]);
    expect(result.duplicates[0].findings).toHaveLength(1);
    expect(result.monthApart).toEqual([]);
  });
});

describe("deadlines in the next 7 days (CB7)", () => {
  const header = "Vendor,Invoice,Due date,Amount,Currency,Discount %,Discount deadline,Late fee percent,Late fee amount,Late fee starts";

  it("lists the discounts ending and the late fees starting in the next 7 days, nearest first, with what each is worth", () => {
    const { result } = check(
      [
        "Lakeside Freight,LF-1,2026-11-06,980.00,USD,2,2026-10-31,,,",
        "Juniper Office Supply,JO-1,2026-10-29,412.00,USD,,,1.5,,",
        "Orchard Signs,OS-1,2026-11-02,145.00,USD,,,,25.00,2026-11-04",
        "Today Co,T-1,2026-11-06,100.00,USD,1,2026-10-28,,,",
        "Late Co,L-1,2026-11-06,100.00,USD,1,2026-10-27,,,",
        "Far Co,F-1,2026-11-30,100.00,USD,1,2026-11-04,,,2026-11-30",
        "Started Co,S-1,2026-10-27,100.00,USD,,,1.5,,2026-10-28",
        "Far Fee Co,FF-1,2026-11-04,100.00,USD,,,1.5,,2026-11-05",
      ],
      header
    );
    expect(result.terms).toEqual({ discount: true, lateFee: true });
    expect(result.deadlines.map((deadline) => [deadline.bill.line, deadline.kind, deadline.lastDay, deadline.daysLeft])).toEqual([
      [5, "discount", "2026-10-28", 0],
      [3, "late_fee", "2026-10-29", 1],
      [2, "discount", "2026-10-31", 3],
      [4, "late_fee", "2026-11-03", 6],
    ]);
    expect(result.deadlines.map((deadline) => deadline.words)).toEqual([
      "Pay by Oct 28, 2026 to keep the 1% early-payment discount: 1.00 USD.",
      "Pay by Oct 29, 2026 to avoid a 1.5% monthly late fee: 6.18 USD a month.",
      "Pay by Oct 31, 2026 to keep the 2% early-payment discount: 19.60 USD.",
      "Pay by Nov 3, 2026 to avoid a 25.00 USD late fee.",
    ]);
    expect(result.deadlines[2].worth).toEqual({ amount: 19.6, currency: "USD" });
  });

  it("says which terms the list has, so a list without them gets no deadlines", () => {
    expect(check(["Northwind,N-1,Hosting,,2026-11-01,240.00,USD"]).result).toMatchObject({ terms: { discount: false, lateFee: false }, deadlines: [] });
    const fees = check(["Northwind,2026-11-01,240.00,1.5"], "Vendor,Due date,Amount,Late fee percent").result;
    expect(fees.terms).toEqual({ discount: false, lateFee: true });
  });
});

describe("the list back with a flag column (CB8)", () => {
  it("returns every row as written, with what the check found on it in a last column", () => {
    const { table, answers, result } = check(
      [
        "Maple Street Cleaning,MS-301,Office cleaning,2026-11-03,450.00,,",
        "Maple Street Cleaning,MS-301,Office cleaning,2026-11-03,450.00,,",
        'Lakeside Freight,LF-3310,"Freight, October",2026-11-06,980.00,2,2026-10-31',
        "Orchard Signs,OS-14,Decals,2026-02-30,145.00,,",
        "Northwind Hosting,NH-1,Hosting,2026-10-03,240.00,,",
        "Northwind Hosting,NH-2,Hosting,2026-11-02,240.00,,",
      ],
      "Vendor,Invoice,Description,Due date,Amount,Discount %,Discount deadline"
    );
    const csv = checkedCsv(table, answers, result);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")).toEqual([
      `Vendor,Invoice,Description,Due date,Amount,Discount %,Discount deadline,${FLAG_COLUMN}`,
      "Maple Street Cleaning,MS-301,Office cleaning,2026-11-03,450.00,,,Row 3 may be a duplicate of this bill",
      "Maple Street Cleaning,MS-301,Office cleaning,2026-11-03,450.00,,,Likely duplicate of row 2 (confidence 0.85)",
      'Lakeside Freight,LF-3310,"Freight, October",2026-11-06,980.00,2,2026-10-31,"Discount ends Oct 31, 2026: 19.60 USD"',
      "Orchard Signs,OS-14,Decals,2026-02-30,145.00,,,Not checked: Due date “2026-02-30” is not a real day.",
      "Northwind Hosting,NH-1,Hosting,2026-10-03,240.00,,,\"Same amount about a month apart: rows 6, 7\"",
      "Northwind Hosting,NH-2,Hosting,2026-11-02,240.00,,,\"Same amount about a month apart: rows 6, 7\"",
      "",
    ]);
    expect(FLAG_COLUMN).toBe("Bill check");
  });

  it("keeps a semicolon list's delimiter", () => {
    const table = readTable("Vendor;Amount;Due date\nNorthwind;240,00;13.11.2026");
    const answers = startingAnswers(table);
    const csv = checkedCsv(table, answers, checkBills(table, answers, TODAY));
    expect(csv.slice(1)).toBe(`Vendor;Amount;Due date;${FLAG_COLUMN}\r\nNorthwind;240,00;13.11.2026;\r\n`);
  });

  it(`says which rows past the ${MAX_CHECK_BILLS.toLocaleString("en-US")}th were not checked`, () => {
    const rows = Array.from({ length: MAX_CHECK_BILLS + 1 }, (_, index) => `Vendor ${index},10.00,2026-11-02`);
    const table = readTable(["Vendor,Amount,Due date", ...rows].join("\n"));
    const answers = startingAnswers(table);
    const lines = checkedCsv(table, answers, checkBills(table, answers, TODAY)).split("\r\n");
    expect(lines.at(-3)).toBe(`Vendor ${MAX_CHECK_BILLS - 1},10.00,2026-11-02,`);
    expect(lines.at(-2)).toBe(`Vendor ${MAX_CHECK_BILLS},10.00,2026-11-02,"Not checked: only the first 5,000 bills are checked."`);
  });

  it("names the file after the list", () => {
    expect(checkedFileName("Unpaid bills (Oct).csv")).toBe("Unpaid-bills-Oct-checked.csv");
    expect(checkedFileName(SAMPLE_SOURCE)).toBe("Sample-list-made-up-vendors-checked.csv");
  });
});

describe("the sample list (CB10)", () => {
  it("is made-up vendors in USD, dated from today, and shows every kind of finding", () => {
    expect(SAMPLE_SOURCE).toBe("Sample list (made-up vendors)");
    const text = sampleBillList(TODAY);
    expect(text).not.toMatch(/VND/);
    const table = readTable(text);
    const answers = startingAnswers(table);
    expect(unansweredOf(questionsOf(table, answers), answers)).toBeNull();
    const result = checkBills(table, answers, TODAY);
    expect(result.duplicates.map((vendor) => vendor.vendor)).toEqual(["Bluebell Print Co.", "Maple Street Cleaning"]);
    expect(result.duplicates[0].findings[0].numberWords).toContain("written");
    expect(result.atStake).toEqual([{ currency: "USD", amount: 1700 }]);
    expect(result.monthApart.map((run) => run.vendor)).toEqual(["Northwind Hosting"]);
    expect(result.deadlines.map((deadline) => [deadline.bill.vendor, deadline.kind])).toEqual([
      ["Lakeside Freight", "discount"],
      ["Juniper Office Supply", "late_fee"],
    ]);
    expect(result.bills.filter((bill) => !bill.checked).map((bill) => bill.vendor)).toEqual(["Orchard Signs"]);
    // Another day, the same findings: its dates move with today.
    const later = checkBills(readTable(sampleBillList("2027-03-01")), answers, "2027-03-01");
    expect(later.deadlines).toHaveLength(2);
    expect(later.duplicates).toHaveLength(2);
  });
});
