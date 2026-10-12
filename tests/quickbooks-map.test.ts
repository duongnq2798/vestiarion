import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderError } from "@/lib/connectors/provider";
import {
  billsLackCurrency, mapBankAccounts, mapBill, mapBillsPage, mapCompany, mapCount, mapDeletedBills, mapHomeCurrency, mapTokens, mapVendorsPage, qbAmount, qbDay,
  qbFilterTime, qbTime, qbVersion,
} from "@/lib/quickbooks/map";

/**
 * QuickBooks Online's JSON in the core's shapes (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q6,
 * Q8, Q9), against recorded QuickBooks-shaped answers: a bill's balance and what it means (open, partly paid, paid,
 * voided, deleted through change data capture), its vendor, currency (USD, JPY with no decimals, none at all), days and
 * update time, the version that orders two changes in one second, paging and counts, vendors, bank accounts, the
 * company, tokens, and a Fault.
 */

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "quickbooks", name), "utf8"));
const misc = fixture("misc.json") as Record<string, unknown>;
const NOW = Date.parse("2026-10-12T10:00:00.000Z");

describe("QuickBooks's times, days, amounts and versions", () => {
  it("reads an update time with its offset, to the millisecond in UTC", () => {
    expect(qbTime("2026-10-11T23:15:22-07:00")).toBe("2026-10-12T06:15:22.000Z");
    expect(qbTime("2026-10-12T06:15:22.5Z")).toBe("2026-10-12T06:15:22.500Z");
    // Without a zone the instant is unknown: never guessed.
    expect(qbTime("2026-10-12T06:15:22")).toBeNull();
    expect(qbTime(42)).toBeNull();
  });

  it("reads a day, and refuses one that is not on the calendar", () => {
    expect(qbDay("2026-10-28")).toBe("2026-10-28");
    expect(qbDay("2026-02-30")).toBeNull();
    expect(qbDay(undefined)).toBeNull();
  });

  it("keeps an amount as an exact decimal, without float noise", () => {
    expect(qbAmount(1250.0)).toBe("1250");
    expect(qbAmount(210.55)).toBe("210.55");
    expect(qbAmount(0.1 + 0.2)).toBe("0.3");
    expect(qbAmount(98000)).toBe("98000");
    expect(qbAmount("12")).toBeNull();
    expect(qbAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("orders two changes in the same second by the sync token, and a deletion after both", () => {
    const first = qbVersion("2026-10-12T06:15:22.000Z", "3");
    const second = qbVersion("2026-10-12T06:15:22.000Z", "10");
    expect(first).toBe("2026-10-12T06:15:22.000Z#00000003");
    expect(second > first).toBe(true);
    expect(qbVersion("2026-10-12T06:15:22.000Z", "deleted") > second).toBe(true);
    expect(qbVersion("2026-10-12T06:15:22.000Z", null)).toBe("2026-10-12T06:15:22.000Z#00000000");
  });

  it("writes a time for a query in UTC to the second, floored", () => {
    expect(qbFilterTime("2026-10-12T09:55:00.999Z")).toBe("2026-10-12T09:55:00Z");
  });
});

describe("bills", () => {
  const page = mapBillsPage(fixture("bills-backfill-page-1.json"), 1, 100, 3, null);

  it("maps an open bill with its vendor, number, memo, currency, total, balance, days and version", () => {
    expect(page.items[0]).toEqual({
      externalId: "146",
      version: "2026-10-12T06:15:22.000Z#00000000",
      updatedAt: "2026-10-12T06:15:22.000Z",
      contactExternalId: "56",
      contactName: "PowerDirect",
      number: "PD-4471",
      reference: "Electricity, September",
      currency: "USD",
      total: "1250",
      amountDue: "1250",
      issuedOn: "2026-10-03",
      dueOn: "2026-10-28",
      status: "open",
    });
  });

  it("offers a partly paid bill at its balance, with its total beside it", () => {
    expect(page.items[1]).toMatchObject({ externalId: "147", total: "1000", amountDue: "400", status: "open", version: "2026-10-12T07:05:00.000Z#00000003" });
  });

  it("keeps a JPY bill in whole yen, as QuickBooks wrote it", () => {
    expect(page.items[2]).toMatchObject({ externalId: "148", currency: "JPY", total: "98000", amountDue: "98000", contactName: "Akiba Parts K.K." });
  });

  it("ends the read on a short page, or when the count says the page reached it", () => {
    expect(page).toMatchObject({ page: 1, last: true, total: 3 });
    expect(mapBillsPage(fixture("bills-backfill-page-1.json"), 1, 3, 7, null)).toMatchObject({ last: false, total: 7 });
    expect(mapBillsPage(fixture("bills-backfill-page-1.json"), 2, 3, 6, null)).toMatchObject({ last: true });
    expect(mapBillsPage(misc.empty, 1, 100, 0, null)).toEqual({ items: [], page: 1, last: true, total: 0 });
  });

  it("says a bill paid in full is paid, and one voided in QuickBooks' screens is voided, without its memo", () => {
    const later = mapBillsPage(fixture("bills-modified.json"), 1, 100, null, "USD");
    expect(later.items[0]).toMatchObject({ externalId: "146", status: "paid", amountDue: "0", version: "2026-10-12T09:30:00.000Z#00000002" });
    expect(later.items[1]).toMatchObject({ externalId: "139", status: "voided", total: "0", reference: null });
  });

  it("gives a bill with no currency the company's home currency, and leaves it out when that is unknown", () => {
    const body = fixture("bills-modified.json");
    expect(billsLackCurrency(body)).toBe(true);
    expect(billsLackCurrency(fixture("bills-backfill-page-1.json"))).toBe(false);
    expect(mapBillsPage(body, 1, 100, null, "USD").items[2]).toMatchObject({ externalId: "152", currency: "USD", total: "210.55", amountDue: "210.55" });
    const unknown = mapBillsPage(body, 1, 100, null, null);
    expect(unknown.items.map((bill) => bill.externalId)).toEqual(["146", "139"]);
    // The page still ends by what QuickBooks sent, not by what read.
    expect(unknown.last).toBe(true);
  });

  it("leaves out a bill that does not read, never guessing its facts", () => {
    expect(mapBill({ Id: "1", MetaData: { LastUpdatedTime: "2026-10-12T00:00:00-07:00" }, TotalAmt: 5 }, "USD")).toBeNull();
    expect(mapBill({ Id: "1", SyncToken: "0", MetaData: { LastUpdatedTime: "2026-10-12T00:00:00" }, TotalAmt: 5, Balance: 5, CurrencyRef: { value: "USD" } }, null)).toBeNull();
    expect(mapBill("a bill", "USD")).toBeNull();
  });

  it("refuses an answer that is a Fault, or not a query's", () => {
    expect(() => mapBillsPage(misc.fault, 1, 100, null, null)).toThrow(ProviderError);
    expect(() => mapBillsPage({ nope: true }, 1, 100, null, null)).toThrow(/did not read/);
  });

  it("reads a count, and nothing from an answer without one", () => {
    expect(mapCount(misc.count)).toBe(3);
    expect(mapCount(misc.empty)).toBeNull();
    expect(() => mapCount(misc.fault)).toThrow(ProviderError);
  });
});

describe("bills deleted in QuickBooks, from change data capture", () => {
  it("names a deleted bill by its id and time alone, and leaves the changed ones to the query", () => {
    expect(mapDeletedBills(fixture("cdc-bills.json"))).toEqual([
      {
        externalId: "148",
        version: "2026-10-12T09:40:00.000Z#deleted",
        updatedAt: "2026-10-12T09:40:00.000Z",
        contactExternalId: null,
        contactName: "Unnamed vendor",
        number: null,
        reference: null,
        currency: "XXX",
        total: "0",
        amountDue: "0",
        issuedOn: null,
        dueOn: null,
        status: "deleted",
        factsKnown: false,
      },
    ]);
  });

  it("reads an answer with no change as none", () => {
    expect(mapDeletedBills(misc.cdcEmpty)).toEqual([]);
    expect(() => mapDeletedBills(misc.fault)).toThrow(ProviderError);
  });
});

describe("vendors", () => {
  it("keeps every vendor as a supplier, an inactive one archived, and leaves out one without an id", () => {
    const page = mapVendorsPage(fixture("vendors-page.json"), 1, 100);
    expect(page.items).toEqual([
      { externalId: "56", version: "2026-10-01T17:00:00.000Z#00000000", updatedAt: "2026-10-01T17:00:00.000Z", name: "PowerDirect", isSupplier: true, archived: false },
      { externalId: "42", version: "2026-10-05T17:00:00.000Z#00000002", updatedAt: "2026-10-05T17:00:00.000Z", name: "Old Courier Co", isSupplier: true, archived: true },
    ]);
    expect(page.last).toBe(true);
  });
});

describe("bank accounts (I14)", () => {
  it("offers the active bank accounts, by name, never an expense account or an inactive one", () => {
    expect(mapBankAccounts(fixture("accounts-bank.json"))).toEqual([
      { externalId: "92", code: "1090", name: "Arc USDC wallet", type: "Bank", currency: "USD", bank: true },
      { externalId: "35", code: null, name: "Checking", type: "Bank", currency: "USD", bank: true },
    ]);
    expect(mapBankAccounts(misc.empty)).toEqual([]);
  });
});

describe("the company, its home currency, and tokens", () => {
  it("names the company the callback named", () => {
    expect(mapCompany(fixture("companyinfo.json"), "9341455327810551")).toEqual({ externalOrgId: "9341455327810551", name: "Sandbox Company_US_1", connectionId: null });
    expect(mapCompany({ CompanyInfo: {} }, "9341455327810551").name).toBe("QuickBooks company");
    expect(() => mapCompany(misc.fault, "1")).toThrow(ProviderError);
  });

  it("reads the home currency from the preferences", () => {
    expect(mapHomeCurrency(misc.preferences)).toBe("USD");
    expect(mapHomeCurrency({ Preferences: {} })).toBeNull();
  });

  it("reads Intuit's token answer, keeping the scope asked for since the answer names none", () => {
    expect(mapTokens(misc.token, NOW, ["com.intuit.quickbooks.accounting"])).toEqual({
      accessToken: "eyJlbmMiOiJBMTI4Q0JDLUhTMjU2IiwiYWxnIjoiZGlyIn0..fixture-access",
      refreshToken: "AB11799999999fixturerefresh",
      expiresAt: NOW + 3_600_000,
      scopes: ["com.intuit.quickbooks.accounting"],
    });
    expect(() => mapTokens({ access_token: "a" }, NOW, [])).toThrow(/no refresh_token/);
    expect(() => mapTokens({ refresh_token: "r" }, NOW, [])).toThrow(/no access_token/);
  });
});
