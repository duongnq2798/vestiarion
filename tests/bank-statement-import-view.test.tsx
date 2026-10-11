import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import BankStatementImport, { defaultTicks } from "@/components/BankStatementImport";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { readStatement } from "@/lib/bank-statement/lines";
import { matchStatement, type StatementBill } from "@/lib/bank-statement/match";

/**
 * The report's Import a bank statement card (docs/superpowers/specs/2026-10-10-bank-statement-design.md B1-B8, B12):
 * it reads a pasted statement at once, asks how its dates are written when they read two ways, shows the lines read, the
 * period and the statement's own balance check, labelled as the bank's figures, and then the bills each line of money
 * out paid, ticking only the unique exact matches.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/bank-statement", () => ({ previewStatementAction: vi.fn(), importStatementAction: vi.fn() }));

// Cells pasted from a spreadsheet: tab-separated, the bank's own lines above the header, every date day-and-month.
const PASTED = [
  "Account\tDBS operating 123-456",
  "Date\tDescription\tWithdrawal\tDeposit\tBalance",
  "03/04/2026\tGIRO NORTHWIND CLOUD INV-2207\t1,250.00\t\t3,750.00",
  "05/04/2026\tCustomer payment\t\t200.00\t3,950.00",
  "09/04/2026\tATLAS COMPUTE\t45.50\t\t3,904.50",
  "10/04/2026\tCARD FEE\t5.00\t\t3,899.50",
  "Closing balance\t\t\t\t3,899.50",
].join("\n");

const html = (node: ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim();

const BILLS: StatementBill[] = [
  { id: "00000000-0000-4000-8000-0000000000b1", payee: "Northwind Cloud Pte Ltd", memo: "INV-2207", amount: 1250, currency: "SGD", createdAt: "2026-04-01T09:00:00Z", dueDate: "2026-04-15", current: null },
  { id: "00000000-0000-4000-8000-0000000000b2", payee: "Atlas Compute", memo: null, amount: 45.5, currency: "SGD", createdAt: "2026-04-01T09:00:00Z", dueDate: "2026-04-10", current: null },
  { id: "00000000-0000-4000-8000-0000000000b3", payee: "Kestrel Payroll", memo: null, amount: 5, currency: "SGD", createdAt: "2026-04-01T09:00:00Z", dueDate: null, current: null },
  { id: "00000000-0000-4000-8000-0000000000b4", payee: "Harbor Print", memo: null, amount: 5, currency: "SGD", createdAt: "2026-04-01T09:00:00Z", dueDate: null, current: null },
];

describe("BankStatementImport", () => {
  it("reads pasted cells at once and asks how the dates are written when they read two ways", () => {
    const words = text(html(<BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: PASTED, name: null, choices: { currency: "SGD" } }} />));
    expect(words).toContain("How the pasted cells are read");
    expect(words).toContain("How are the dates written? 03/04/2026 reads two ways.");
    expect(words).toContain("Day first: 03/04/2026 is Apr 3, 2026");
    expect(words).toContain("Month first: 03/04/2026 is Mar 4, 2026");
    // Nothing is read, matched or checked until it is answered.
    expect(words).not.toContain("lines read");
    expect(words).not.toContain("balance adds up");
  });

  it("shows the lines read, the period and the statement's own balance check, labelled as the bank's money", () => {
    const markup = html(
      <BankStatementImport orgSlug="northstar" accounts={["DBS operating"]} initial={{ text: PASTED, name: null, account: "DBS operating", choices: { currency: "SGD", dateOrder: "dmy" } }} />
    );
    const words = text(markup);
    expect(words).toContain("4 lines read, from Apr 3, 2026 to Apr 10, 2026: 3 money out, 1 money in. Money in is never matched to bills.");
    expect(words).toContain("The statement's balance adds up, in SGD");
    expect(words).toContain("Opening balance 5,000.00 SGD, money out 1,300.50 SGD, money in 200.00 SGD, closing balance 3,899.50 SGD.");
    expect(words).toContain("These are your bank statement's own figures for the account: the agent never counts or spends this money.");
    expect(words).toContain("1 row not read as lines");
    expect(words).toContain("Named before: DBS operating");
    expect(markup).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Find the bills/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Find the bills/);
  });

  it("says when a file is not UTF-8 and was read as Windows-1252, and only then", () => {
    const legacy = text(html(<BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: PASTED, name: "umsaetze.csv", legacy: true, choices: { currency: "SGD", dateOrder: "dmy" } }} />));
    expect(legacy).toContain("This file is not saved as UTF-8, and is read as Windows-1252. If names look wrong below, paste the cells from a spreadsheet instead.");
    const utf8 = text(html(<BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: PASTED, name: "statement.csv", choices: { currency: "SGD", dateOrder: "dmy" } }} />));
    expect(utf8).not.toContain("not saved as UTF-8");
  });

  it("names the first line whose balance does not add up, and what it should have been", () => {
    const broken = PASTED.replace("3,904.50", "3,905.40");
    const words = text(html(<BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: broken, name: "statement.csv", choices: { currency: "SGD", dateOrder: "dmy" } }} />));
    expect(words).toContain("The statement's balance does not add up at line 5, in SGD");
    expect(words).toContain("After line 5 the balance should be 3,904.50 SGD; the statement says 3,905.40 SGD.");
    expect(words).toContain("A statement cut from a longer one can start mid-day: you can still match its lines.");
  });

  it("says when money in and out read the wrong way round", () => {
    const columns = { bookingDate: 0, valueDate: null, description: 1, payee: null, amount: null, moneyOut: 3, moneyIn: 2, reference: null, currency: null, balance: 4 };
    const words = text(html(<BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: PASTED, name: null, choices: { currency: "SGD", dateOrder: "dmy", columns } }} />));
    expect(words).toContain("The statement's balance adds up only with money in and money out swapped, in SGD");
  });

  it("lists each line of money out with the bill it paid and why, ticking only the unique exact matches", () => {
    const choices = { currency: "SGD", dateOrder: "dmy" as const };
    const lines = readStatement(PASTED, choices, "2026-10-11").lines;
    const matches = matchStatement(lines, BILLS, lines.map(() => null));
    const markup = html(
      <BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: PASTED, name: null, account: "DBS operating", choices, found: { lines, matches } }} />
    );
    const words = text(markup);
    expect(words).toContain("Northwind Cloud Pte Ltd, 1,250.00 SGD, due Apr 15, 2026");
    expect(words).toContain("Invoice number found: INV-2207");
    expect(words).toContain("Atlas Compute, 45.50 SGD, due Apr 10, 2026");
    expect(words).toContain("Choose the bill");
    expect(words).toContain("1 line of money in is not matched: receivables are not part of this import.");
    expect(words).toContain("Save 2 payments");
    // Two exact matches ticked; the line with two bills to choose from is not.
    expect(markup.match(/role="checkbox" aria-checked="true"/g)).toHaveLength(2);
    expect(markup.match(/role="checkbox" aria-checked="false"/g)).toHaveLength(1);
    expect(markup).toContain("Save line 6");
  });

  it("says a line used before and a line already recorded, ticking neither", () => {
    const choices = { currency: "SGD", dateOrder: "dmy" as const };
    const lines = readStatement(PASTED, choices, "2026-10-11").lines;
    const recorded = { ...BILLS[1], current: { id: "rec-1", outcome: "paid" as const, paidOn: "2026-04-09", amount: 45.5, currency: "SGD", source: "form" as const } };
    const matches = matchStatement(lines, [BILLS[0], recorded], [{ invoiceId: BILLS[0].id, payee: BILLS[0].payee }, null, null, null]);
    const words = text(html(<BankStatementImport orgSlug="northstar" accounts={[]} initial={{ text: PASTED, name: null, choices, found: { lines, matches } }} />));
    expect(words).toContain("Already used for Northwind Cloud Pte Ltd");
    expect(words).toContain("Already recorded for Atlas Compute");
    expect(words).toContain("No bill matches");
    expect(words).toContain("Nothing ticked");
  });

  it("starts with the unique exact matches ticked", () => {
    const lines = readStatement(PASTED, { currency: "SGD", dateOrder: "dmy" }, "2026-10-11").lines;
    const matches = matchStatement(lines, BILLS, lines.map(() => null));
    expect(defaultTicks(matches)).toEqual({ 3: BILLS[0].id, 5: BILLS[1].id });
  });
});
