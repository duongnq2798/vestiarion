import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { billAmount, usdcFor } from "@/lib/bill-amount";
import { detectMapping } from "@/lib/bill-import/columns";
import {
  conversionKey,
  conversionsNeeded,
  countFates,
  failedRowsCsv,
  fatesOf,
  MAX_BILLS,
  memoWithInvoiceNumber,
  questionsFor,
  readRows,
  startingSettings,
  unanswered,
  type Conversion,
  type ExistingInvoice,
  type ImportSettings,
  type ImportWorkspace,
  type RowFate,
} from "@/lib/bill-import/rows";
import { readTable } from "@/lib/bill-import/table";

/**
 * A bill list read row by row and given its fate (import design B3–B13), against a 100-row list with seeded problems:
 * a month-first date in a day-first list, a day that does not exist, a misspelt amount, a fractional yen, an unknown
 * currency, a currency the workspace does not take, no counterparty, one it does not hold, one it holds twice, a
 * credit note, a won amount on a yen row, no due date, no amount, a row given twice, and two bills already added.
 */

const FIXTURE = readFileSync(path.join(process.cwd(), "tests", "fixtures", "bill-import", "bills-100.csv"), "utf8");

const SHADOW_JPY: ImportWorkspace = { shadowOn: true, shadowCurrency: "JPY", network: "arc-testnet" };
const PLAIN: ImportWorkspace = { shadowOn: false, shadowCurrency: null, network: "arc-testnet" };
const MAINNET: ImportWorkspace = { shadowOn: false, shadowCurrency: null, network: "arc-mainnet" };

const KANTO = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const LION = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c2";
const COUNTERPARTIES = [
  { id: KANTO, name: "Kanto Paper Co., Ltd." },
  { id: LION, name: "Lion City Logistics Pte Ltd" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3", name: "Manila Print House" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c4", name: "Seoul Office Supply" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5", name: "Penang Parts Sdn Bhd" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c6", name: "Northwind Hosting" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7", name: "Northwind Hosting" },
];

/** Two bills added before: one by its invoice number in the memo, one by its purchase order; and one that matches neither. */
const EXISTING: ExistingInvoice[] = [
  {
    id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000e0001", counterpartyId: KANTO, dueDate: "2026-10-20", amount: "586.67", currency: "USDC",
    originalAmount: "88000", originalCurrency: "JPY", poReference: null, memo: "Invoice KP-2001: Paper",
  },
  {
    id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000e0002", counterpartyId: LION, dueDate: "2026-11-05", amount: "2500", currency: "USDC",
    originalAmount: null, originalCurrency: null, poReference: "PO-777", memo: "Freight",
  },
  {
    id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000e0003", counterpartyId: KANTO, dueDate: "2026-12-01", amount: "800", currency: "USDC",
    originalAmount: "120000", originalCurrency: "JPY", poReference: null, memo: "Invoice KP-9999",
  },
];

const RATE = { perUsd: 150, source: "ExchangeRate-API", at: "2026-10-10T00:02:31.000Z" };

/** The conversions the server works out through the shadow path, here at a fixed rate of 150 yen to the dollar. */
function conversions(rows: ReturnType<typeof readRows>): Map<string, Conversion> {
  return new Map(
    conversionsNeeded(rows).map(({ currency, amount }) => {
      const usdc = usdcFor(billAmount(amount, currency) ?? 0, RATE.perUsd);
      const conversion: Conversion = usdc === null
        ? { ok: false, reason: "That bill comes to less than 0.01 USDC at the day's rate." }
        : { ok: true, usdc, original: { currency, amount: Number(amount), perUsd: RATE.perUsd, source: RATE.source, at: RATE.at } };
      return [conversionKey(currency, amount), conversion];
    })
  );
}

function fixtureFates(existing: ExistingInvoice[] = EXISTING, text = FIXTURE) {
  const table = readTable(text);
  const settings: ImportSettings = { ...startingSettings(table, SHADOW_JPY), direction: "payable", dateOrder: "dmy" };
  const rows = readRows(table, settings, SHADOW_JPY);
  return { table, settings, rows, fates: fatesOf(rows, { counterparties: COUNTERPARTIES, existing, conversions: conversions(rows) }) };
}

const at = (fates: RowFate[], line: number) => {
  const fate = fates.find((candidate) => candidate.line === line);
  if (!fate) throw new Error(`no row ${line}`);
  return fate;
};

describe("the 100-row list", () => {
  it("matches its columns and asks only what it cannot know", () => {
    const table = readTable(FIXTURE);
    const settings = startingSettings(table, SHADOW_JPY);
    expect(settings).toEqual({
      hasHeader: true,
      mapping: { counterparty: 0, invoiceNumber: 1, memo: 2, dueDate: 3, amount: 4, currency: 5, poReference: 6 },
      direction: null,
      dateOrder: null,
      decimalMark: null,
      currency: "JPY",
      goodsReceived: false,
    });
    const questions = questionsFor(table, settings, SHADOW_JPY);
    expect(questions).toMatchObject({
      missing: [],
      direction: true,
      dateOrder: { ask: true, mixed: true, order: null },
      decimalMark: { ask: false, mark: "." },
      bills: 100,
    });
    expect(unanswered(questions, settings)).toBe("Choose whether the list holds bills to pay or invoices to collect.");
    expect(unanswered(questions, { ...settings, direction: "payable" })).toBe("Choose whether the list's dates are day first or month first.");
    expect(unanswered(questions, { ...settings, direction: "payable", dateOrder: "dmy" })).toBeNull();
  });

  it("adds 84 bills, finds 3 already there, and says why 13 cannot be added", () => {
    const { fates } = fixtureFates();
    expect(fates).toHaveLength(100);
    expect(countFates(fates)).toEqual({ add: 84, duplicate: 3, error: 13 });
  });

  it("says why each seeded row cannot be added, in words the person can act on", () => {
    const { fates } = fixtureFates();
    const reasons = Object.fromEntries(fates.filter((fate) => fate.status === "error").map((fate) => [fate.line, fate.status === "error" ? fate.reason : ""]));
    expect(reasons).toEqual({
      7: "Due date “10/15/2026” does not fit the list's day-first dates.",
      14: "Due date “31/02/2026” is not a real day.",
      21: "Amount “12O0” is not a number.",
      28: "Amount “¥1,500.5” has decimals, and JPY amounts are whole numbers.",
      35: "XYZ is not a currency code.",
      42: "This workspace's shadow mode takes bills in JPY. Convert the amount to JPY or USDC.",
      49: "No counterparty name.",
      56: "No counterparty named “Unknown Vendor KK” in this workspace. Add it in Counterparties, then import this row again.",
      63: "“Northwind Hosting” matches more than one counterparty in this workspace. Add this bill with the invoice form.",
      70: "Amount “-500” is negative: a credit note is not a bill.",
      77: "The amount is written in ₩, but the row's currency is JPY.",
      84: "No due date.",
      91: "No amount.",
    });
  });

  it("finds a row given twice, and the bills already in the workspace, with what each matches", () => {
    const { fates } = fixtureFates();
    expect(at(fates, 95)).toMatchObject({ status: "duplicate", sameAsLine: 5, invoiceId: null, reason: "Same as row 5 of this list." });
    expect(at(fates, 98)).toMatchObject({ status: "duplicate", invoiceId: EXISTING[0].id, sameAsLine: null, reason: "Already in Vestiarion: same counterparty, amount, due date and reference." });
    expect(at(fates, 101)).toMatchObject({ status: "duplicate", invoiceId: EXISTING[1].id });
  });

  it("adds a yen bill at its USDC amount with the bill's own figure, and a USDC bill exactly as written", () => {
    const { fates } = fixtureFates();
    const yen = at(fates, 2);
    expect(yen).toMatchObject({
      status: "add",
      counterpartyId: KANTO,
      counterparty: "Kanto Paper Co., Ltd.",
      amount: "100000",
      currency: "JPY",
      usdc: "666.67",
      dueDate: "2026-10-13",
      reference: "KP-1000",
      invoiceNumber: "KP-1000",
      original: { currency: "JPY", amount: 100000, perUsd: 150, source: "ExchangeRate-API", at: RATE.at },
      invoice: {
        direction: "payable", counterpartyId: KANTO, amount: "666.67", currency: "USDC", memo: "Invoice KP-1000: Copy paper",
        poReference: "PO-300", goodsReceived: false, dueDate: "2026-10-13", earlyPayDiscountPct: null, discountDeadline: null,
      },
    });
    const usdc = at(fates, 4);
    expect(usdc).toMatchObject({ status: "add", amount: "1021", currency: "USDC", usdc: null, original: null, invoice: { amount: "1021", currency: "USDC" } });
    const eurc = at(fates, 5);
    expect(eurc).toMatchObject({ status: "add", amount: "509.75", currency: "EURC", invoice: { amount: "509.75", currency: "EURC" } });
  });

  it("reads a counterparty written in capitals with a legal suffix as the one the workspace holds", () => {
    const { fates } = fixtureFates();
    expect(at(fates, 3)).toMatchObject({ status: "add", counterpartyId: LION, counterparty: "Lion City Logistics Pte Ltd", currency: "JPY" });
  });

  it("adds nothing new once every row it added is in the workspace: importing the same list twice adds the rows once", () => {
    const first = fixtureFates();
    const added: ExistingInvoice[] = first.fates.flatMap((fate, index) =>
      fate.status === "add"
        ? [{
            id: `0b6c1c9e-4a4f-4a7e-9b1e-${String(index).padStart(12, "0")}`, counterpartyId: fate.counterpartyId, dueDate: fate.invoice.dueDate,
            amount: fate.invoice.amount, currency: fate.invoice.currency, originalAmount: fate.original ? String(fate.original.amount) : null,
            originalCurrency: fate.original?.currency ?? null, poReference: fate.invoice.poReference, memo: fate.invoice.memo,
          }]
        : []
    );
    const second = fixtureFates([...EXISTING, ...added]);
    expect(countFates(second.fates)).toEqual({ add: 0, duplicate: 87, error: 13 });
    // Each row added the first time is matched to the invoice it became: it keeps its id.
    const firstAdded = first.fates.filter((fate) => fate.status === "add").map((fate) => fate.line);
    for (const [index, line] of firstAdded.entries()) {
      expect(at(second.fates, line)).toMatchObject({ status: "duplicate", invoiceId: added[index].id });
    }
  });
});

describe("the rows that cannot be added, out and back in (I08)", () => {
  it("are every failed row as the list wrote it, with the reason in a last column the import ignores", () => {
    const { table, settings, fates } = fixtureFates();
    const csv = failedRowsCsv(table, settings, fates);
    expect(csv.startsWith("﻿")).toBe(true);
    const back = readTable(csv);
    expect(back.rows).toHaveLength(14);
    expect(back.rows[0].cells).toEqual(["Supplier", "Invoice No.", "Description", "Due", "Total", "Currency", "PO", "Why it can't be added"]);
    expect(detectMapping(back.rows[0].cells)).toEqual(detectMapping(table.rows[0].cells));
    const original = table.rows.find((row) => row.line === 21)?.cells;
    expect(back.rows.find((row) => row.cells[4] === "12O0")?.cells).toEqual([...(original ?? []), "Amount “12O0” is not a number."]);
  });

  it("come back fixed and are added, while the rest still say why", () => {
    const { table, settings, fates } = fixtureFates();
    const fixed = failedRowsCsv(table, settings, fates).replace("12O0", "1200").replace("31/02/2026", "28/02/2026");
    const again = readTable(fixed);
    const againSettings: ImportSettings = { ...startingSettings(again, SHADOW_JPY), direction: "payable", dateOrder: "dmy" };
    const rows = readRows(again, againSettings, SHADOW_JPY);
    const result = fatesOf(rows, { counterparties: COUNTERPARTIES, existing: EXISTING, conversions: conversions(rows) });
    expect(countFates(result)).toEqual({ add: 2, duplicate: 0, error: 11 });
  });

  it("is a semicolon list when the list was one, and nothing when every row could be added", () => {
    const table = readTable("Supplier;Total;Due\nNobody;1,5;2026-10-15\n");
    const settings: ImportSettings = { ...startingSettings(table, PLAIN), direction: "payable" };
    const rows = readRows(table, settings, PLAIN);
    const fates = fatesOf(rows, { counterparties: [], existing: [], conversions: new Map() });
    expect(failedRowsCsv(table, settings, fates).split("\r\n")[0]).toBe("﻿Supplier;Total;Due;Why it can't be added");
    expect(failedRowsCsv(table, settings, [])).toBe("");
  });
});

describe("a list's questions", () => {
  it("asks day or month first when every date reads both ways, and reads them as answered", () => {
    const table = readTable("Vendor,Amount,Due date\nKanto Paper,10,03/04/2026\nKanto Paper,11,05/06/2026\n");
    const settings = startingSettings(table, PLAIN);
    const questions = questionsFor(table, settings, PLAIN);
    expect(questions.dateOrder).toEqual({ order: null, ask: true, mixed: false });
    const rows = (order: "dmy" | "mdy") => readRows(table, { ...settings, direction: "payable", dateOrder: order }, PLAIN).map((row) => row.dueDate);
    expect(rows("dmy")).toEqual(["2026-04-03", "2026-06-05"]);
    expect(rows("mdy")).toEqual(["2026-03-04", "2026-05-06"]);
  });

  it("asks how amounts are written when 1,234 reads both ways", () => {
    const table = readTable("Vendor\tAmount\tDue\nKanto Paper\t1,234\t2026-10-15\n");
    const settings = startingSettings(table, PLAIN);
    expect(questionsFor(table, settings, PLAIN).decimalMark).toEqual({ mark: null, ask: true, mixed: false });
    expect(unanswered(questionsFor(table, settings, PLAIN), { ...settings, direction: "payable" })).toBe("Choose how the list writes its amounts: 1,234.50 or 1.234,50.");
    const read = (mark: "." | ",") => readRows(table, { ...settings, direction: "payable", decimalMark: mark }, PLAIN)[0].amount;
    expect(read(".")).toBe("1234");
    expect(read(",")).toBe("1.234");
  });

  it("names the columns a row cannot be added without", () => {
    const table = readTable("Vendor,Notes\nKanto,x\n");
    const questions = questionsFor(table, startingSettings(table, PLAIN), PLAIN);
    expect(questions.missing).toEqual(["amount", "dueDate"]);
    expect(unanswered(questions, { ...startingSettings(table, PLAIN), direction: "payable" })).toBe("Choose the column for Amount and Due date.");
  });

  it("refuses a list of more than 200 bills before reading a row", () => {
    const text = ["Vendor,Amount,Due", ...Array.from({ length: MAX_BILLS + 1 }, (_, index) => `Kanto,${index + 1},2026-10-15`)].join("\n");
    const table = readTable(text);
    const questions = questionsFor(table, startingSettings(table, PLAIN), PLAIN);
    expect(questions.bills).toBe(201);
    expect(unanswered(questions, { ...startingSettings(table, PLAIN), direction: "payable" })).toBe("Import at most 200 bills at a time. Split the list.");
  });

  it("reads a list without column names when the first row is a bill", () => {
    const table = readTable("Kanto Paper\t1200\t2026-10-15\n");
    const settings = startingSettings(table, PLAIN);
    expect(settings.hasHeader).toBe(false);
    expect(settings.mapping).toEqual({});
    const rows = readRows(table, { ...settings, mapping: { counterparty: 0, amount: 1, dueDate: 2 }, direction: "payable" }, PLAIN);
    expect(rows[0]).toMatchObject({ line: 1, counterparty: "Kanto Paper", amount: "1200", dueDate: "2026-10-15" });
  });

  it("starts the list's currency at the one its symbols name, when the workspace takes it", () => {
    const euros = readTable("Vendor,Amount,Due\nA,€5,2026-10-15\nB,€6,2026-10-15\n");
    expect(startingSettings(euros, PLAIN).currency).toBe("EURC");
    const dollars = readTable("Vendor,Amount,Due\nA,$5,2026-10-15\n");
    expect(startingSettings(dollars, PLAIN).currency).toBe("USDC");
    const won = readTable("Vendor,Amount,Due\nA,₩5000,2026-10-15\n");
    expect(startingSettings(won, PLAIN).currency).toBe("USDC");
    expect(startingSettings(won, { shadowOn: true, shadowCurrency: "KRW", network: "arc-testnet" }).currency).toBe("KRW");
  });
});

describe("a row's fields", () => {
  const plainFates = (text: string, settings: Partial<ImportSettings> = {}, workspace: ImportWorkspace = PLAIN) => {
    const table = readTable(text);
    const rows = readRows(table, { ...startingSettings(table, workspace), direction: "payable", ...settings }, workspace);
    return fatesOf(rows, { counterparties: COUNTERPARTIES, existing: [], conversions: conversions(rows) });
  };
  const reason = (fate: RowFate) => (fate.status === "error" ? fate.reason : fate.status);

  it("reads the old template unchanged: direction, goods received, the discount and the currency", () => {
    const template =
      "direction,counterparty,amount,memo,po_reference,goods_received,due_date,early_pay_discount_pct,discount_deadline,currency\n" +
      "payable,Kanto Paper Co.  Ltd.,100.00,Invoice memo,PO-100,true,2026-10-15,2,2026-10-10,EURC\n" +
      "receivable,Manila Print House,0.5,,,,2026-10-31,,,\n";
    const [payable, receivable] = plainFates(template, { direction: null });
    expect(payable).toMatchObject({
      status: "add",
      invoice: {
        direction: "payable", counterpartyId: KANTO, amount: "100", currency: "EURC", memo: "Invoice memo", poReference: "PO-100",
        goodsReceived: true, dueDate: "2026-10-15", earlyPayDiscountPct: "2", discountDeadline: "2026-10-10",
      },
    });
    expect(receivable).toMatchObject({ status: "add", invoice: { direction: "receivable", amount: "0.5", currency: "USDC", goodsReceived: false, memo: null } });
  });

  it("reads a direction column's words, and refuses one it does not know", () => {
    const fates = plainFates("Vendor,Amount,Due,AP/AR\nKanto Paper,1,2026-10-15,AP\nKanto Paper,2,2026-10-15,To collect\nKanto Paper,3,2026-10-15,maybe\nKanto Paper,4,2026-10-15,\n", { direction: null });
    expect(fates.map((fate) => (fate.status === "add" ? fate.invoice.direction : reason(fate)))).toEqual([
      "payable",
      "receivable",
      "Bill or invoice “maybe” is not one Vestiarion knows: write payable or receivable.",
      "No direction: write payable or receivable.",
    ]);
  });

  it("marks goods received for every bill when the person says so and the list has no column", () => {
    const [fate] = plainFates("Vendor,Amount,Due\nKanto Paper,1,2026-10-15\n", { goodsReceived: true });
    expect(fate).toMatchObject({ status: "add", invoice: { goodsReceived: true } });
    const [unknown] = plainFates("Vendor,Amount,Due,Received\nKanto Paper,1,2026-10-15,perhaps\n");
    expect(reason(unknown)).toBe("Goods received “perhaps” is not yes or no.");
  });

  it("starts the memo with the invoice number, once, and refuses a memo too long", () => {
    expect(memoWithInvoiceNumber("INV-7", "Hosting")).toBe("Invoice INV-7: Hosting");
    expect(memoWithInvoiceNumber("INV-7", null)).toBe("Invoice INV-7");
    expect(memoWithInvoiceNumber("INV-7", "Hosting for INV-7")).toBe("Hosting for INV-7");
    expect(memoWithInvoiceNumber(null, "Hosting")).toBe("Hosting");
    const [long] = plainFates(`Vendor,Amount,Due,Invoice no,Memo\nKanto Paper,1,2026-10-15,INV-1,${"x".repeat(270)}\n`);
    expect(reason(long)).toBe("The memo, with the invoice number, is longer than 280 characters.");
  });

  it("refuses a bill in another currency outside shadow mode, saying how to add it, and never suggests shadow mode for VND", () => {
    const text = "Vendor,Amount,Due,Currency\nKanto Paper,120000,2026-10-15,JPY\nKanto Paper,2500000,2026-10-15,VND\n";
    expect(plainFates(text).map(reason)).toEqual([
      "Bills in JPY are taken in shadow mode only. Turn it on for JPY in Settings, or convert the amount to USDC.",
      "Vestiarion takes bills in USDC or EURC. Convert the amount to USDC.",
    ]);
    expect(plainFates(text, {}, MAINNET).map(reason)).toEqual([
      "Vestiarion takes bills in USDC or EURC. Convert the amount to USDC.",
      "Vestiarion takes bills in USDC or EURC. Convert the amount to USDC.",
    ]);
  });

  it("refuses a currency symbol that names several when nothing says which", () => {
    // In a list whose currency is the yen, a dollar sign could be any dollar; in a USDC list it is USDC.
    const [fate] = plainFates("Vendor,Amount,Due,Currency\nKanto Paper,5,2026-10-15,$\n", {}, SHADOW_JPY);
    expect(reason(fate)).toBe("Currency “$” could be several currencies: write its code, such as USD.");
    expect(plainFates("Vendor,Amount,Due,Currency\nKanto Paper,5,2026-10-15,$\n")[0]).toMatchObject({ status: "add", invoice: { currency: "USDC" } });
  });

  it("keeps a USDC amount exact to its sixth decimal, from the cell to the invoice (I07)", () => {
    const [fate] = plainFates('Vendor,Amount,Due\nKanto Paper,"1,234.567891",2026-10-15\n');
    expect(fate).toMatchObject({ status: "add", invoice: { amount: "1234.567891", currency: "USDC" } });
  });

  it("refuses a discount without its deadline, as the invoice form does", () => {
    const [fate] = plainFates("Vendor,Amount,Due,Discount %\nKanto Paper,5,2026-10-15,2\n");
    expect(reason(fate)).toBe("Discount deadline: Enter the last day the discount applies, on or before the due date, or clear the discount.");
  });

  it("says when the day's rate could not be read for a bill in the business's own currency", () => {
    const table = readTable("Vendor,Amount,Due\nKanto Paper,¥5000,2026-10-15\n");
    const rows = readRows(table, { ...startingSettings(table, SHADOW_JPY), direction: "payable" }, SHADOW_JPY);
    const [fate] = fatesOf(rows, { counterparties: COUNTERPARTIES, existing: [], conversions: new Map() });
    expect(reason(fate)).toBe("The day's rate could not be read. Try again in a moment.");
    const [failed] = fatesOf(rows, {
      counterparties: COUNTERPARTIES, existing: [], conversions: new Map([[conversionKey("JPY", "5000"), { ok: false, reason: "There is no rate for JPY. Choose another currency." }]]),
    });
    expect(reason(failed)).toBe("There is no rate for JPY. Choose another currency.");
  });

  it("does not take a bill for one already added when its due date differs", () => {
    const table = readTable("Vendor,Invoice no,Amount,Due\nKanto Paper,KP-9999,¥120000,2026-12-02\nKanto Paper,kp-9999,¥120000,2026-12-01\n");
    const rows = readRows(table, { ...startingSettings(table, SHADOW_JPY), direction: "payable" }, SHADOW_JPY);
    const fates = fatesOf(rows, { counterparties: COUNTERPARTIES, existing: EXISTING, conversions: conversions(rows) });
    expect(fates.map((fate) => fate.status)).toEqual(["add", "duplicate"]);
  });
});
