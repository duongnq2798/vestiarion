import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/bill-import", () => ({ checkBillListAction: vi.fn(), importBillListAction: vi.fn() }));

import BillImport, { CheckStep, ColumnsStep, DoneStep, failedRowsFileName, grouped } from "@/components/intake/BillImport";
import { countFates, countImported, importMessage, startingSettings, type ImportedFate } from "@/lib/bill-import/rows";
import { SAMPLE_LIST, SAMPLE_WORKSPACE, sampleFates, sampleImport } from "@/lib/bill-import/sample";
import { readTable } from "@/lib/bill-import/table";

/**
 * The import panel (import design B1, B3, B11, B13), as it renders: the list step first, then the columns with what only
 * the person can say, the check with every row's fate, and the result. Its steps are rendered here from the sample
 * list, read and checked as the panel reads them; the browser runs the same flow on the design page.
 */

const noop = () => {};
const table = readTable(SAMPLE_LIST);
const list = { text: SAMPLE_LIST, source: "Pasted rows", table, legacy: false };
const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

describe("the Import a list tab", () => {
  const markup = decode(renderToStaticMarkup(<BillImport orgSlug="acme" workspace={{ shadowOn: false, shadowCurrency: null, network: "arc-testnet" }} />));

  it("starts with the list: a file, or rows pasted from a spreadsheet, and nothing added before a check", () => {
    expect(markup).toContain("1. Your list");
    expect(markup).toContain("Choose a CSV file, or drop one here");
    expect(markup).toContain("Your own columns, dates and number format. Up to 200 bills and 1 MB. Nothing is added until you check the rows and confirm.");
    expect(markup).toContain("Or paste rows from Excel or Google Sheets");
    expect(markup).toMatch(/<textarea[^>]*name="pasted"/);
    expect(markup).toContain("Read the pasted rows");
    expect(markup).toContain("Copy a CSV template");
  });
});

describe("the columns step", () => {
  it("shows each field with the column it reads and its values, and asks whether the rows are bills or invoices", () => {
    const settings = startingSettings(table, SAMPLE_WORKSPACE);
    const markup = decode(renderToStaticMarkup(<ColumnsStep list={list} settings={settings} workspace={SAMPLE_WORKSPACE} onChange={noop} onCheck={noop} onRestart={noop} pending={false} error="" />));
    expect(markup).toContain("Pasted rows</span>: 6 bills, 6 columns.");
    expect(markup).toContain("The first row holds column names");
    expect(markup).toContain("Which column is which");
    expect(markup).toContain("Reads: Kanto Paper · Lion City Logistics Pte Ltd · Manila Print House");
    expect(markup).toContain("Reads: ¥120,000 · 1,250.00 · ¥48,500");
    // The fields the list does not have wait folded, each one choice away.
    expect(markup).toContain("Not in the list: Purchase order, Goods received, Bill or invoice, Early-payment discount (%), Discount deadline");
    expect(markup).toContain("These rows are");
    expect(markup).toContain("Bills to pay");
    expect(markup).toContain("Invoices to collect");
    expect(markup).toContain("A bill in JPY is paid in USDC at the day's rate.");
    expect(markup).toContain("The goods or services on every bill were received");
    expect(markup).toContain("Choose whether the list holds bills to pay or invoices to collect.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Check 6 rows/s);
  });

  it("asks day or month first, and how amounts are written, only when the list cannot say", () => {
    const ambiguous = readTable("Vendor\tAmount\tDue\nKanto Paper\t1,234\t03/04/2026\n");
    // In USDC, 1,234 reads two ways; in yen it could only be a thousand and more.
    const plain = { shadowOn: false, shadowCurrency: null, network: "arc-testnet" as const };
    const settings = { ...startingSettings(ambiguous, plain), direction: "payable" as const };
    const markup = decode(
      renderToStaticMarkup(
        <ColumnsStep list={{ ...list, table: ambiguous }} settings={settings} workspace={plain} onChange={noop} onCheck={noop} onRestart={noop} pending={false} error="" />
      )
    );
    expect(markup).toContain("Dates like 03/04/2026 are written");
    expect(markup).toContain("Day first (15/10/2026)");
    expect(markup).toContain("Month first (10/15/2026)");
    expect(markup).toContain("Amounts like 1,234 are written");
    expect(markup).toContain("A comma before the cents.");
  });
});

describe("the check step", () => {
  const settings = { ...startingSettings(table, SAMPLE_WORKSPACE), direction: "payable" as const };
  const checked = sampleFates(SAMPLE_LIST, settings, []);
  if (!checked.ok) throw new Error(checked.message);

  it("counts what is added, already there and refused, and shows every row's fate with the reason", () => {
    const markup = decode(renderToStaticMarkup(<CheckStep check={{ fates: checked.fates, counts: countFates(checked.fates) }} onBack={noop} onImport={noop} onDownload={noop} pending={false} error="" />));
    expect(markup).toContain("To add: 3");
    expect(markup).toContain("Already in Vestiarion: 0");
    expect(markup).toContain("Can't add: 3");
    expect(markup).toContain("Nothing has been added yet.");
    expect(markup).toContain("120,000 JPY");
    expect(markup).toContain("800.00 USDC at the day's rate");
    expect(markup).toContain("Due date “31/02/2026” is not a real day.");
    expect(markup).toContain("Amount “¥1,500.5” has decimals, and JPY amounts are whole numbers.");
    expect(markup).toContain("No counterparty named “Harbor Movers” in this workspace. Add it in Counterparties, then import this row again.");
    expect(markup).toContain("Download the rows that can't be added");
    expect(markup).toContain("Add 3 bills");
    expect(markup).toContain("Change columns");
  });

  it("says what was added, and offers the rows that could not be, after the import", () => {
    const fates: ImportedFate[] = sampleImport(checked.fates, []);
    const counts = countImported(fates);
    const markup = decode(renderToStaticMarkup(<DoneStep result={{ fates, counts, message: importMessage(counts) }} onDownload={noop} onRestart={noop} />));
    expect(markup).toContain("Added 3 bills. 3 can't be added.");
    expect(markup).toContain("The agent usually decides on each payable within a minute.");
    expect(markup).toContain(">Added<");
    expect(markup).toContain("Download the rows that can't be added");
    expect(markup).toContain("Import another list");
  });
});

describe("the panel's words and files", () => {
  it("groups thousands without changing a digit, with cents in a currency that has them", () => {
    expect(grouped("1234567.891234", "USDC")).toBe("1,234,567.891234");
    expect(grouped("800", "USDC")).toBe("800.00");
    expect(grouped("1250.5", "SGD")).toBe("1,250.50");
    expect(grouped("120000", "JPY")).toBe("120,000");
  });

  it("names the failed rows after the list", () => {
    expect(failedRowsFileName("June bills.csv")).toBe("June-bills-not-added.csv");
    expect(failedRowsFileName("Pasted rows")).toBe("Pasted-rows-not-added.csv");
    expect(failedRowsFileName("請求書.csv")).toBe("請求書-not-added.csv");
  });
});
