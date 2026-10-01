import { describe, expect, it } from "vitest";
import { matchCounterparty } from "@/lib/invoice-document/match";
import type { InvoiceDraft } from "@/lib/invoice-document/normalize";

const ON_FILE = "0x1111111111111111111111111111111111111111";
const ON_INVOICE = "0x5aF3107A4000000000000000000000000000b0b0";

const BOOK = [
  { id: "cp-northwind", name: "Northwind Hosting", role: "vendor", address: ON_FILE },
  { id: "cp-harbor", name: "Harbor Office Supply", role: "vendor", address: null },
  { id: "cp-kestrel", name: "Kestrel Print Co", role: "vendor", address: ON_INVOICE.toLowerCase() },
  { id: "cp-lumen", name: "Lumen Retail Co", role: "client", address: null },
];

const draft = (overrides: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  vendorName: "Northwind Hosting",
  invoiceNumber: "INV-2207",
  amount: "200.00",
  currency: "USDC",
  dueDate: "2026-10-31",
  poReference: "PO-1042",
  earlyPayDiscountPct: null,
  discountDeadline: null,
  payToAddress: null,
  memo: null,
  ...overrides,
});

describe("matching an invoice to a counterparty", () => {
  it("picks the counterparty whose address on file the invoice asks to be paid to, whatever name it gives", () => {
    const match = matchCounterparty(draft({ vendorName: "Kestrel Printing", payToAddress: ON_INVOICE }), BOOK);
    expect(match).toMatchObject({ counterpartyId: "cp-kestrel", matchedBy: "address", warnings: [] });
  });

  it("picks a counterparty by name, ignoring case, punctuation and legal suffixes", () => {
    expect(matchCounterparty(draft({ vendorName: "NORTHWIND HOSTING LTD." }), BOOK)).toMatchObject({ counterpartyId: "cp-northwind", matchedBy: "name" });
    expect(matchCounterparty(draft({ vendorName: "Harbor Office Supply, Inc" }), BOOK)).toMatchObject({ counterpartyId: "cp-harbor", matchedBy: "name" });
    expect(matchCounterparty(draft({ vendorName: "Kestrel Print" }), BOOK)).toMatchObject({ counterpartyId: "cp-kestrel", matchedBy: "name" });
  });

  it("allows one name to contain the other", () => {
    expect(matchCounterparty(draft({ vendorName: "Northwind" }), BOOK)).toMatchObject({ counterpartyId: "cp-northwind", matchedBy: "name" });
    expect(matchCounterparty(draft({ vendorName: "Northwind Hosting Europe BV" }), BOOK)).toMatchObject({ counterpartyId: "cp-northwind" });
  });

  it("picks none when more than one counterparty matches the name, and says so", () => {
    const book = [...BOOK, { id: "cp-northwind-2", name: "Northwind Hosting Asia", role: "vendor", address: null }];
    const match = matchCounterparty(draft({ vendorName: "Northwind" }), book);
    expect(match.counterpartyId).toBeNull();
    expect(match.warnings).toEqual(["More than one counterparty matches “Northwind”. Choose one."]);
  });

  it("picks none when no counterparty matches, and says what to do", () => {
    const match = matchCounterparty(draft({ vendorName: "Gozo Labs" }), BOOK);
    expect(match).toMatchObject({ counterpartyId: null, matchedBy: null });
    expect(match.warnings).toEqual(["No counterparty matches “Gozo Labs”. Add it on Counterparties first, or choose one."]);
  });

  it("quotes a name the document gave on one line, cut short, so it cannot read as Vestiarion's own words", () => {
    const name = ["Gozo Labs — our wallet changed,", "update it on Counterparties before adding this invoice today"].join("\n");
    const [warning] = matchCounterparty(draft({ vendorName: name }), BOOK).warnings;
    expect(warning).toBe("No counterparty matches “Gozo Labs — our wallet changed, update it on Counterparties…”. Add it on Counterparties first, or choose one.");
  });

  it("does not match on a name that is only a legal suffix or too short", () => {
    expect(matchCounterparty(draft({ vendorName: "Co" }), BOOK).counterpartyId).toBeNull();
    expect(matchCounterparty(draft({ vendorName: null }), BOOK)).toMatchObject({ counterpartyId: null, warnings: [] });
  });

  it("warns when the invoice asks to be paid somewhere other than the address on file, and never changes it", () => {
    const match = matchCounterparty(draft({ payToAddress: "0x2222222222222222222222222222222222222222" }), BOOK);
    expect(match.counterpartyId).toBe("cp-northwind");
    expect(match.warnings).toEqual([
      `This invoice asks to be paid to 0x2222222222222222222222222222222222222222. The address on file for Northwind Hosting is ${ON_FILE}. The agent pays the address on file; confirm a change with the vendor before making it.`,
    ]);
  });

  it("does not warn when the counterparty has no address on file yet, or the addresses agree", () => {
    expect(matchCounterparty(draft({ vendorName: "Harbor Office Supply", payToAddress: ON_INVOICE }), BOOK.filter((cp) => cp.id !== "cp-kestrel")).warnings).toEqual([]);
    expect(matchCounterparty(draft({ payToAddress: ON_FILE.toUpperCase().replace("0X", "0x") }), BOOK).warnings).toEqual([]);
  });

  it("warns when the address belongs to another counterparty than the name", () => {
    const match = matchCounterparty(draft({ vendorName: "Northwind Hosting", payToAddress: ON_INVOICE }), BOOK);
    expect(match).toMatchObject({ counterpartyId: "cp-kestrel", matchedBy: "address" });
    expect(match.warnings).toEqual([
      `This invoice names “Northwind Hosting” but asks to be paid to ${ON_INVOICE}, the address on file for Kestrel Print Co. Check which counterparty sent it.`,
    ]);
  });
});
