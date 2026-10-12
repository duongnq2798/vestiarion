import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authEventOf, mapAccounts, mapBill, mapBillsPage, mapConnections, mapContactsPage, mapTokens, xeroAmount, xeroDay, xeroTime,
} from "@/lib/xero/map";

/**
 * Xero's JSON in the core's shapes (docs/superpowers/specs/2026-10-12-xero-connector-design.md X6), against recorded
 * Xero-shaped answers: bills and what each status means, both forms of Xero's dates, amounts as exact decimals,
 * currencies, paging, suppliers among contacts, the accounts a payment can be booked to, and the organisations of one
 * authorization.
 */

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(process.cwd(), "tests", "fixtures", "xero", name), "utf8"));
const NOW = Date.parse("2026-10-12T07:10:00.000Z");

describe("Xero's dates and amounts", () => {
  it("reads a day from its string form or its /Date()/ form", () => {
    expect(xeroDay("2026-10-28T00:00:00", null)).toBe("2026-10-28");
    expect(xeroDay(undefined, "/Date(1793145600000+0000)/")).toBe("2026-10-28");
    expect(xeroDay("", "/Date(1793145600000)/")).toBe("2026-10-28");
    expect(xeroDay(null, null)).toBeNull();
    expect(xeroDay("not a day", "/Date(x)/")).toBeNull();
  });

  it("reads an update time to the millisecond", () => {
    expect(xeroTime("/Date(1791789322093+0000)/")).toBe("2026-10-12T07:15:22.093Z");
    expect(xeroTime("2026-10-12T07:15:22.093")).toBe("2026-10-12T07:15:22.093Z");
    expect(xeroTime(42)).toBeNull();
  });

  it("keeps an amount as an exact decimal, without float noise", () => {
    expect(xeroAmount(1250.0)).toBe("1250");
    expect(xeroAmount(820.5)).toBe("820.5");
    expect(xeroAmount(0.1 + 0.2)).toBe("0.3");
    expect(xeroAmount(98000)).toBe("98000");
    expect(xeroAmount(0)).toBe("0");
    expect(xeroAmount(Number.NaN)).toBeNull();
    expect(xeroAmount("12")).toBeNull();
  });
});

describe("bills", () => {
  const page1 = mapBillsPage(fixture("invoices-backfill-page-1.json"), 1, 100);

  it("maps an approved bill with an amount due as open, with its supplier, number, amounts, days and version", () => {
    expect(page1.items[0]).toEqual({
      externalId: "0f4c1f4e-1d7a-4e0f-9a9d-6c2d3c1a0001",
      version: "2026-10-12T07:15:22.093Z",
      updatedAt: "2026-10-12T07:15:22.093Z",
      contactExternalId: "c1a0e2f4-6b1d-4a6c-8f3e-0000000000a1",
      contactName: "PowerDirect",
      number: "PD-4471",
      reference: null,
      currency: "USD",
      total: "1250",
      amountDue: "1250",
      issuedOn: "2026-10-03",
      dueOn: "2026-10-28",
      status: "open",
    });
  });

  it("keeps what is left to pay of a part-paid bill, beside its total", () => {
    expect(page1.items[1]).toMatchObject({ number: "SMC-0902", reference: "Office lease", total: "1220.5", amountDue: "820.5", status: "open", dueOn: "2026-09-20" });
  });

  it("reads a due day given only in the /Date()/ form, in a currency without decimals", () => {
    expect(page1.items[2]).toMatchObject({ currency: "JPY", amountDue: "98000", dueOn: "2026-10-24", issuedOn: "2026-10-10" });
  });

  it("is not the last page while Xero's pagination says more follow", () => {
    expect(page1).toMatchObject({ page: 1, last: false });
    expect(page1.items).toHaveLength(3);
  });

  it("calls an approved bill with nothing due paid, and ends on the last page", () => {
    const page2 = mapBillsPage(fixture("invoices-backfill-page-2.json"), 2, 100);
    expect(page2.last).toBe(true);
    expect(page2.items[0]).toMatchObject({ status: "paid", amountDue: "0", currency: "GBP", number: null });
  });

  it("maps every later status, and leaves sales invoices out", () => {
    const changed = mapBillsPage(fixture("invoices-modified.json"), 1, 100);
    expect(changed.items.map((bill) => [bill.number, bill.status])).toEqual([
      ["PD-4471", "paid"],
      ["OLD-1", "voided"],
      ["DR-9", "draft"],
      ["SB-2", "draft"],
      ["DEL-3", "deleted"],
    ]);
    expect(changed.last).toBe(true);
  });

  it("ends without pagination when a page holds fewer than asked for", () => {
    const body = { Invoices: (fixture("invoices-modified.json") as { Invoices: unknown[] }).Invoices };
    expect(mapBillsPage(body, 1, 100).last).toBe(true);
    expect(mapBillsPage({ Invoices: Array.from({ length: 3 }, () => ({})) }, 1, 3).last).toBe(false);
  });

  it("leaves out a bill it cannot read: no id, no currency code, no update time", () => {
    const good = (fixture("invoices-backfill-page-1.json") as { Invoices: Record<string, unknown>[] }).Invoices[0];
    expect(mapBill({ ...good, InvoiceID: undefined })).toBeNull();
    expect(mapBill({ ...good, CurrencyCode: "usd" })).toBeNull();
    expect(mapBill({ ...good, UpdatedDateUTC: undefined })).toBeNull();
    expect(mapBill({ ...good, Status: "SOMETHING_NEW" })).toBeNull();
    expect(mapBill({ ...good, Contact: { ContactID: "c", Name: "" } })).toMatchObject({ contactName: "Unnamed supplier" });
  });

  it("refuses an answer that is not Xero's", () => {
    expect(() => mapBillsPage({ nothing: true }, 1, 100)).toThrow(/Invoices/);
    expect(() => mapBillsPage(null, 1, 100)).toThrow(/Invoices/);
  });
});

describe("contacts", () => {
  it("keeps suppliers only, archived ones marked, and pages by Xero's count", () => {
    const page = mapContactsPage(fixture("contacts-page.json"), 1, 100);
    expect(page.items).toEqual([
      { externalId: "c1a0e2f4-6b1d-4a6c-8f3e-0000000000a1", version: "2026-10-12T07:15:22.093Z", updatedAt: "2026-10-12T07:15:22.093Z", name: "PowerDirect", isSupplier: true, archived: false },
      { externalId: "c1a0e2f4-6b1d-4a6c-8f3e-0000000000a5", version: "2026-10-12T07:31:45.120Z", updatedAt: "2026-10-12T07:31:45.120Z", name: "Hoyt Productions", isSupplier: true, archived: true },
    ]);
    expect(page.last).toBe(true);
  });
});

describe("accounts", () => {
  it("offers active bank accounts and accounts that take payments, never revenue, expense or archived ones", () => {
    const accounts = mapAccounts(fixture("accounts.json"));
    expect(accounts.map((account) => account.code)).toEqual(["090", "091", "092", "610"]);
    expect(accounts[1]).toEqual({ externalId: "6f7594f2-f059-4d56-9e67-47ac9733bfe9", code: "091", name: "Arc USDC wallet", type: "BANK", currency: "USD", bank: true });
    expect(accounts[3]).toMatchObject({ name: "Stablecoin clearing", bank: false, currency: null });
  });
});

describe("tokens and organisations", () => {
  it("reads Xero's token answer, its expiry and scopes", () => {
    const tokens = mapTokens(fixture("token.json"), NOW);
    expect(tokens.expiresAt).toBe(NOW + 1_800_000);
    expect(tokens.refreshToken).toMatch(/^3a1f/);
    expect(tokens.scopes).toEqual(["accounting.invoices.read", "accounting.contacts.read", "accounting.settings.read", "offline_access"]);
    expect(() => mapTokens({ access_token: "x" }, NOW)).toThrow(/refresh_token/);
  });

  it("reads the authorization's event from the access token, and nothing from a token that is not a JWT", () => {
    const { access_token } = fixture("token.json") as { access_token: string };
    expect(authEventOf(access_token)).toBe("d99ecdfe-391d-43d2-b834-17636ba90e8d");
    expect(authEventOf("opaque")).toBeNull();
  });

  it("offers the organisations of this authorization, never a practice", () => {
    expect(mapConnections(fixture("connections.json"), "d99ecdfe-391d-43d2-b834-17636ba90e8d")).toEqual([
      { externalOrgId: "70784a63-d24b-46a9-a4db-0e70a274b056", name: "Demo Company (Global)", connectionId: "e1eede29-f875-4a5d-8470-17f6a29a88b1" },
      { externalOrgId: "e0da6937-de07-4a14-adee-37abfac298ce", name: "Northstar Studio Pte Ltd", connectionId: "32587c85-a9b3-4306-ac30-b416e8f2c841" },
    ]);
  });

  it("offers every organisation listed when the token names no event, or none of them", () => {
    expect(mapConnections(fixture("connections.json"), null)).toHaveLength(3);
    expect(mapConnections(fixture("connections.json"), "00000000-0000-4000-8000-000000000000")).toHaveLength(3);
  });
});
