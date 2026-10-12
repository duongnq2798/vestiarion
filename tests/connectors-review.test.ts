import { describe, expect, it } from "vitest";
import { fatesOf, type Conversion, type ImportWorkspace } from "@/lib/bill-import/rows";
import { conversionKey } from "@/lib/bill-import/rows";
import {
  newSupplierLimit, partlyPaidSince, placeholderId, reviewItems, reviewRow, reviewRowView, supplierOf, type AddedInvoice, type StagedBillView, type Supplier,
} from "@/lib/connectors/review";

/**
 * Bills from Xero through the bill list's own check (docs/superpowers/specs/2026-10-12-xero-connector-design.md X11):
 * each bill read as a row of a list, its supplier found by its link, by name, or added as new, and given its fate by
 * `fatesOf` with the import's facts, so the duplicates, currency and decimals rules are the import's, word for word.
 */

const bill = (fields: Partial<StagedBillView> = {}): StagedBillView => ({
  id: "row-1",
  connectionId: "conn-1",
  externalId: "bill-1",
  contactExternalId: "contact-1",
  contactName: "PowerDirect",
  number: "PD-4471",
  reference: null,
  currency: "USD",
  total: "1250",
  amountDue: "1250",
  issuedOn: "2026-10-03",
  dueOn: "2026-10-28",
  sourceStatus: "open",
  reviewState: "review",
  firstSeenAt: "2026-10-12T08:00:00.000Z",
  ...fields,
});

const SHADOW_USD: ImportWorkspace = { shadowOn: true, shadowCurrency: "USD", network: "arc-testnet" };
const PLAIN: ImportWorkspace = { shadowOn: false, shadowCurrency: null, network: "arc-testnet" };
const MAINNET: ImportWorkspace = { shadowOn: false, shadowCurrency: null, network: "arc-mainnet" };
const ACME = { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1", name: "PowerDirect Ltd" };
const OTHER = { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2", name: "SMART Agency" };

const conversion = (currency: string, amount: string, usdc: number): [string, Conversion] => [
  conversionKey(currency, amount),
  { ok: true, usdc, original: { currency, amount: Number(amount), perUsd: 1, source: "test", at: "2026-10-12T08:00:00.000Z" } },
];

describe("supplierOf", () => {
  it("is the counterparty the contact is linked to, under its own name now", () => {
    expect(supplierOf(bill(), new Map([["contact-1", ACME.id]]), [ACME, OTHER])).toEqual({ kind: "linked", counterpartyId: ACME.id, name: "PowerDirect Ltd" });
  });

  it("is the one counterparty with the contact's name, legal suffixes aside", () => {
    expect(supplierOf(bill(), new Map(), [ACME, OTHER])).toEqual({ kind: "matched", counterpartyId: ACME.id, name: "PowerDirect Ltd" });
  });

  it("is new when no counterparty has the name, under a stable placeholder", () => {
    const supplier = supplierOf(bill({ contactName: "Akiba Parts K.K." }), new Map(), [ACME]);
    expect(supplier).toEqual({ kind: "new", counterpartyId: placeholderId("Akiba Parts K.K."), name: "Akiba Parts K.K." });
    expect(placeholderId("Akiba Parts K.K.")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(placeholderId("akiba parts k.k.")).toBe(placeholderId("Akiba Parts K.K."));
  });

  it("is ambiguous when more than one counterparty has the name", () => {
    expect(supplierOf(bill(), new Map(), [ACME, { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e3", name: "PowerDirect" }, { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e4", name: "powerdirect" }])).toEqual({
      kind: "ambiguous",
      name: "PowerDirect",
    });
  });

  it("falls back to the name when the linked counterparty is gone", () => {
    expect(supplierOf(bill(), new Map([["contact-1", "0b6c1c9e-4a4f-4a7e-9b1e-0000000000ff"]]), [ACME])).toMatchObject({ kind: "matched", counterpartyId: ACME.id });
  });
});

describe("reviewRow", () => {
  const linked: Supplier = { kind: "linked", counterpartyId: ACME.id, name: "PowerDirect Ltd" };

  it("reads a bill as a payable row: what is left to pay, its due day, its number first in the memo", () => {
    expect(reviewRow(bill({ reference: "Electricity, September" }), 0, linked, SHADOW_USD, true, "Xero")).toMatchObject({
      line: 1, problems: [], counterparty: "PowerDirect Ltd", direction: "payable", amount: "1250", currency: "USD", dueDate: "2026-10-28",
      invoiceNumber: "PD-4471", memo: "Invoice PD-4471: Electricity, September", goodsReceived: true, poReference: null,
    });
  });

  it("says why a currency is not taken, in the import's own words, and never offers VND", () => {
    expect(reviewRow(bill(), 0, linked, PLAIN, false, "Xero").problems).toEqual([
      "Bills in USD are taken in shadow mode only. Turn it on for USD in Settings, or convert the amount to USDC.",
    ]);
    expect(reviewRow(bill({ currency: "SGD" }), 0, linked, SHADOW_USD, false, "Xero").problems).toEqual([
      "This workspace's shadow mode takes bills in USD. Convert the amount to USD or USDC.",
    ]);
    expect(reviewRow(bill({ currency: "VND", amountDue: "1000000" }), 0, linked, PLAIN, false, "Xero").problems).toEqual([
      "Vestiarion takes bills in USDC or EURC. Convert the amount to USDC.",
    ]);
    expect(reviewRow(bill(), 0, linked, MAINNET, false, "Xero").problems).toEqual(["Vestiarion takes bills in USDC or EURC. Convert the amount to USDC."]);
  });

  it("holds an amount to its currency's decimals, and a bill to its due day", () => {
    expect(reviewRow(bill({ currency: "JPY", amountDue: "98000.5" }), 0, linked, { ...SHADOW_USD, shadowCurrency: "JPY" }, false, "Xero").problems).toEqual([
      "Amount due “98000.5” has decimals, and JPY amounts are whole numbers.",
    ]);
    expect(reviewRow(bill({ dueOn: null }), 0, linked, SHADOW_USD, false, "Xero").problems).toEqual([`No due date in Xero.`]);
  });

  it("keeps the memo within the form's 280 characters", () => {
    const memo = reviewRow(bill({ reference: "x".repeat(400) }), 0, linked, SHADOW_USD, false, "Xero").memo ?? "";
    expect(memo.length).toBeLessThanOrEqual(280);
    expect(memo.startsWith("Invoice PD-4471: ")).toBe(true);
  });
});

describe("reviewItems through fatesOf", () => {
  const facts = (counterparties: Array<{ id: string; name: string }>, conversions: Array<[string, Conversion]>, existing = []) => ({
    counterparties,
    existing,
    conversions: new Map(conversions),
  });

  it("adds a bill at its USDC amount in shadow mode, with its own figure kept", () => {
    const bills = [bill()];
    const suppliers: Supplier[] = [{ kind: "linked", counterpartyId: ACME.id, name: ACME.name }];
    const rows = bills.map((b, i) => reviewRow(b, i, suppliers[i], SHADOW_USD, false, "Xero"));
    const fates = fatesOf(rows, facts([ACME], [conversion("USD", "1250", 1249.5)]));
    const [item] = reviewItems(bills, suppliers, fates, "Xero");
    expect(item.fate).toMatchObject({ status: "add", counterpartyId: ACME.id, usdc: "1249.5", invoice: { amount: "1249.5", currency: "USDC", direction: "payable" } });
  });

  it("refuses an ambiguous supplier with the import's words, and adds a new one under its placeholder", () => {
    const bills = [bill(), bill({ id: "row-2", externalId: "bill-2", contactExternalId: "contact-9", contactName: "Akiba Parts K.K.", number: "AK-77", amountDue: "300" })];
    const twins = [{ id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e3", name: "PowerDirect" }, { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e4", name: "PowerDirect" }];
    const suppliers = bills.map((b) => supplierOf(b, new Map(), twins));
    const rows = bills.map((b, i) => reviewRow(b, i, suppliers[i], SHADOW_USD, false, "Xero"));
    const placeholder = { id: placeholderId("Akiba Parts K.K."), name: "Akiba Parts K.K." };
    const fates = fatesOf(rows, facts([...twins, placeholder], [conversion("USD", "1250", 1250), conversion("USD", "300", 300)]));
    const items = reviewItems(bills, suppliers, fates, "Xero");
    expect(items[0].fate).toMatchObject({ status: "error", reason: expect.stringContaining("matches more than one counterparty in this workspace") });
    expect(items[1]).toMatchObject({ supplier: { kind: "new" }, fate: { status: "add", counterpartyId: placeholder.id } });
  });

  it("finds a bill already in Vestiarion, and a bill Xero lists twice, saying which", () => {
    const bills = [bill(), bill({ id: "row-2", externalId: "bill-2" })];
    const suppliers: Supplier[] = bills.map(() => ({ kind: "linked", counterpartyId: ACME.id, name: ACME.name }));
    const rows = bills.map((b, i) => reviewRow(b, i, suppliers[i], SHADOW_USD, false, "Xero"));
    const once = reviewItems(bills, suppliers, fatesOf(rows, facts([ACME], [conversion("USD", "1250", 1250)])), "Xero");
    expect(once[1].fate).toMatchObject({ status: "duplicate", reason: "Same as bill PD-4471 from Xero." });
    const existing = [{ id: "inv-1", counterpartyId: ACME.id, dueDate: "2026-10-28", amount: "1250", currency: "USDC", originalAmount: "1250", originalCurrency: "USD", poReference: null, memo: "Invoice PD-4471" }];
    const already = reviewItems(bills.slice(0, 1), suppliers, fatesOf(rows.slice(0, 1), facts([ACME], [conversion("USD", "1250", 1250)], existing as never)), "Xero");
    expect(already[0].fate).toMatchObject({ status: "duplicate", invoiceId: "inv-1", reason: "Already in Vestiarion: same counterparty, amount, due date and reference." });
  });
});

describe("newSupplierLimit", () => {
  it("is the largest USDC amount of the new supplier's bills being added", () => {
    const placeholder = placeholderId("Akiba Parts K.K.");
    const fates = [
      { status: "add", counterpartyId: placeholder, invoice: { amount: "300" } },
      { status: "add", counterpartyId: placeholder, invoice: { amount: "1200.5" } },
      { status: "add", counterpartyId: ACME.id, invoice: { amount: "9000" } },
      { status: "error", reason: "x" },
    ];
    expect(newSupplierLimit(fates as never, placeholder)).toBe("1200.50");
  });
});

describe("partly paid bills (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md Q9)", () => {
  it("offers a partly paid bill at what is left, with its whole total beside it", () => {
    const partly = bill({ total: "1000", amountDue: "400" });
    const rows = [reviewRow(partly, 0, { kind: "linked", counterpartyId: ACME.id, name: ACME.name }, SHADOW_USD, false, "QuickBooks")];
    expect(rows[0].amount).toBe("400");
    const [item] = reviewItems([partly], [{ kind: "linked", counterpartyId: ACME.id, name: ACME.name }], fatesOf(rows, { counterparties: [ACME], existing: [], conversions: new Map([conversion("USD", "400", 400)]) }), "QuickBooks");
    expect(reviewRowView(item)).toMatchObject({ amount: "400", total: "1000", currency: "USD", usdc: "400", status: "add" });
  });

  const added = (fields: Partial<{ amount_due: string; total: string; currency: string }> = {}) => ({
    id: "row-1", external_id: "bill-1", contact_name: "PowerDirect", number: "PD-4471", currency: "USD", total: "1250", amount_due: "400", ...fields,
  });
  const invoice = (fields: Partial<AddedInvoice> = {}): AddedInvoice => ({
    id: "inv-1", amount: "1249.5", currency: "USDC", original_amount: "1250", original_currency: "USD", status: "pending", ...fields,
  });

  it("flags a bill added at more than the tool says is due now, by the invoice's own figure", () => {
    expect(partlyPaidSince([added()], new Map([["bill-1", invoice()]]))).toEqual([
      { id: "row-1", supplier: "PowerDirect", number: "PD-4471", currency: "USD", left: "400", added: "1250" },
    ]);
    // Outside shadow mode the invoice's amount is the figure, when it is in the bill's currency.
    expect(partlyPaidSince([added({ currency: "EURC" })], new Map([["bill-1", invoice({ amount: "1250", currency: "EURC", original_amount: null, original_currency: null })]]))).toHaveLength(1);
  });

  it("leaves alone a bill added at its balance, one paid or rejected in Vestiarion, and one with no invoice", () => {
    expect(partlyPaidSince([added()], new Map([["bill-1", invoice({ original_amount: "400" })]]))).toEqual([]);
    expect(partlyPaidSince([added()], new Map([["bill-1", invoice({ status: "paid" })]]))).toEqual([]);
    expect(partlyPaidSince([added()], new Map([["bill-1", invoice({ status: "rejected" })]]))).toEqual([]);
    expect(partlyPaidSince([added()], new Map())).toEqual([]);
    expect(partlyPaidSince([added({ currency: "JPY" })], new Map([["bill-1", invoice()]]))).toEqual([]);
  });
});
