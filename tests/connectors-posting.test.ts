import { describe, expect, it } from "vitest";
import type { ExternalBill, ExternalPayment } from "@/lib/connectors/provider";
import {
  billCheck,
  bookingReality,
  hasScopes,
  idempotencyKey,
  minorUnits,
  needsOrganisation,
  paymentMatches,
  postingFacts,
  postingFingerprint,
  REALITY_REFUSAL,
  type PaidInvoice,
} from "@/lib/connectors/posting";

/**
 * The pure core of booking payments made on Arc (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W1,
 * W4, W6, W7): the reality rule, the amount and currency written, the fingerprint of what a person saw, the bill's
 * check before sending, and whether what the provider holds is what was sent.
 */

const HASH = `0x${"3c".repeat(32)}`;

describe("bookingReality (W1)", () => {
  it("books a payment on Arc mainnet outside shadow mode into any organisation", () => {
    expect(bookingReality({ network: "arc-mainnet", shadow: false }, false)).toEqual({ ok: true });
    expect(bookingReality({ network: "arc-mainnet", shadow: false }, true)).toEqual({ ok: true });
    expect(bookingReality({ network: "arc-mainnet", shadow: false }, null)).toEqual({ ok: true });
    expect(needsOrganisation({ network: "arc-mainnet", shadow: false })).toBe(false);
  });

  it("books a payment on Arc testnet only into a demo organisation", () => {
    expect(bookingReality({ network: "arc-testnet", shadow: false }, true)).toEqual({ ok: true });
    expect(bookingReality({ network: "arc-testnet", shadow: false }, false)).toEqual({ ok: false, refused: true, reason: "testnet" });
    expect(needsOrganisation({ network: "arc-testnet", shadow: false })).toBe(true);
  });

  it("books a payment in shadow mode only into a demo organisation, on whatever network", () => {
    expect(bookingReality({ network: "arc-testnet", shadow: true }, true)).toEqual({ ok: true });
    expect(bookingReality({ network: "arc-testnet", shadow: true }, false)).toEqual({ ok: false, refused: true, reason: "shadow" });
    expect(bookingReality({ network: "arc-mainnet", shadow: true }, false)).toEqual({ ok: false, refused: true, reason: "shadow" });
  });

  it("never takes an organisation it could not read for a demo one, nor refuses it for good", () => {
    expect(bookingReality({ network: "arc-testnet", shadow: true }, null)).toEqual({ ok: false, refused: false });
  });

  it("says why in the same words everywhere", () => {
    expect(REALITY_REFUSAL).toBe("Not booked: payments in shadow mode and on Arc testnet are never booked into your real books.");
  });
});

const invoice = (fields: Partial<PaidInvoice> = {}): PaidInvoice => ({
  amount: 31.39,
  currency: "USDC",
  paidAmount: 31.39,
  originalCurrency: null,
  originalAmount: null,
  txRef: HASH,
  settledAt: "2026-10-12T09:15:00.000Z",
  ...fields,
});
const intent = { txHash: HASH, confirmedAt: "2026-10-12T09:14:41.000Z", feeUsd: 0.0021, bridgeFee: null };

describe("postingFacts (W4)", () => {
  it("books USDC as USD at what left, on the day it was confirmed, with the Arc transaction as reference", () => {
    expect(postingFacts({ invoice: invoice(), intent, billCurrency: "USD" })).toEqual({
      ok: true,
      facts: { amount: "31.39", currency: "USD", paidOn: "2026-10-12", reference: HASH, paidAmount: "31.39", paidToken: "USDC", networkFee: "0.0021" },
    });
  });

  it("books EURC as EUR", () => {
    const outcome = postingFacts({ invoice: invoice({ currency: "EURC", amount: 120, paidAmount: null }), intent: { ...intent, feeUsd: null }, billCurrency: "EUR" });
    expect(outcome).toMatchObject({ ok: true, facts: { amount: "120.00", currency: "EUR", paidToken: "EURC", networkFee: null } });
  });

  it("books a shadow bill at its original amount in the business's own currency", () => {
    const outcome = postingFacts({ invoice: invoice({ amount: 41.62, paidAmount: 41.62, originalCurrency: "SGD", originalAmount: 54.13 }), intent, billCurrency: "SGD" });
    expect(outcome).toMatchObject({ ok: true, facts: { amount: "54.13", currency: "SGD", paidAmount: "41.62", paidToken: "USDC" } });
  });

  it("books the same share of the original amount when an early-payment discount took part off", () => {
    const outcome = postingFacts({ invoice: invoice({ amount: 100, paidAmount: 98, originalCurrency: "AUD", originalAmount: 150 }), intent, billCurrency: "AUD" });
    expect(outcome).toMatchObject({ ok: true, facts: { amount: "147.00", currency: "AUD" } });
  });

  it("writes a currency without minor units without them", () => {
    const outcome = postingFacts({ invoice: invoice({ amount: 30.12, paidAmount: null, originalCurrency: "JPY", originalAmount: 4500 }), intent, billCurrency: "JPY" });
    expect(outcome).toMatchObject({ ok: true, facts: { amount: "4500", currency: "JPY" } });
    expect(minorUnits(31.385, "USD")).toBe("31.39");
  });

  it("refuses a payment in another currency than the bill's, never converting it again", () => {
    expect(postingFacts({ invoice: invoice(), intent, billCurrency: "SGD" })).toEqual({
      ok: false,
      reason: "currency",
      message: "The bill is in SGD in Xero, and this payment is in USD: book it by hand.",
    });
  });

  it("drafts nothing without a transaction hash or a confirmed day", () => {
    expect(postingFacts({ invoice: invoice({ txRef: "sim-123" }), intent: { ...intent, txHash: null }, billCurrency: "USD" })).toEqual({ ok: false, reason: "unreadable" });
    expect(postingFacts({ invoice: invoice({ settledAt: null }), intent: { ...intent, confirmedAt: null }, billCurrency: "USD" })).toEqual({ ok: false, reason: "unreadable" });
  });

  it("adds a payout's bridge fee to the network fee shown apart", () => {
    expect(postingFacts({ invoice: invoice(), intent: { ...intent, bridgeFee: 0.25 }, billCurrency: "USD" })).toMatchObject({ ok: true, facts: { networkFee: "0.2521" } });
  });
});

const shown = { amountDue: "31.39", status: "open" as const };
const fingerprint = (fields: Partial<Parameters<typeof postingFingerprint>[0]> = {}) =>
  postingFingerprint({ billExternalId: "bill-1", bill: shown, amount: "31.39", currency: "USD", accountId: "acc-090", paidOn: "2026-10-12", reference: HASH, ...fields });

describe("postingFingerprint (W6)", () => {
  it("is the same for the same view, whatever the decimals' spelling or the hash's case", () => {
    expect(fingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint({ amount: "31.390", bill: { amountDue: "31.3900", status: "open" }, reference: HASH.toUpperCase().replace("0X", "0x") })).toBe(fingerprint());
  });

  it("changes with every field a person saw", () => {
    const base = fingerprint();
    for (const change of [
      { billExternalId: "bill-2" },
      { bill: { amountDue: "20", status: "open" as const } },
      { bill: { amountDue: "31.39", status: "paid" as const } },
      { amount: "31.38" },
      { currency: "EUR" },
      { accountId: "acc-091" },
      { paidOn: "2026-10-13" },
      { reference: `0x${"4d".repeat(32)}` },
    ]) {
      expect(fingerprint(change), JSON.stringify(change)).not.toBe(base);
    }
  });

  it("names the booking and what was approved in the provider's idempotency key", () => {
    const key = idempotencyKey("2f0d7d2e-1111-4a4a-8b8b-000000000001", fingerprint());
    expect(key).toBe(`vestiarion-booking-2f0d7d2e-1111-4a4a-8b8b-000000000001-${fingerprint().slice(0, 16)}`);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});

const bill = (fields: Partial<ExternalBill> = {}): ExternalBill => ({
  externalId: "bill-1",
  version: "2026-10-12T08:00:00.000Z",
  updatedAt: "2026-10-12T08:00:00.000Z",
  contactExternalId: "c-1",
  contactName: "Xero",
  number: "INV-0001",
  reference: null,
  currency: "USD",
  total: "31.39",
  amountDue: "31.39",
  issuedOn: "2026-10-01",
  dueOn: "2026-10-20",
  status: "open",
  ...fields,
});
const posting = { amount: "31.39", currency: "USD" };

describe("billCheck (W7)", () => {
  it("lets an open bill with the amount due the person saw take the payment", () => {
    expect(billCheck(bill(), posting, shown, "Xero")).toEqual({ ok: true });
  });

  it("refuses a bill already paid in Xero", () => {
    expect(billCheck(bill({ status: "paid", amountDue: "0" }), posting, shown, "Xero")).toEqual({ ok: false, kind: "refused", reason: "already_paid", message: "Already paid in Xero." });
    expect(billCheck(bill({ amountDue: "0" }), posting, shown, "Xero")).toMatchObject({ kind: "refused", reason: "already_paid" });
  });

  it("refuses a bill gone, voided or deleted", () => {
    expect(billCheck(null, posting, shown, "Xero")).toMatchObject({ kind: "refused", reason: "bill_closed" });
    expect(billCheck(bill({ status: "voided" }), posting, shown, "Xero")).toMatchObject({ kind: "refused", reason: "bill_closed", message: "The bill was voided in Xero: nothing to book against." });
  });

  it("refuses a bill in another currency", () => {
    expect(billCheck(bill({ currency: "EUR" }), posting, shown, "Xero")).toMatchObject({ kind: "refused", reason: "currency" });
  });

  it("calls a bill whose amount due changed since it was shown stale, and sends nothing", () => {
    expect(billCheck(bill({ amountDue: "20.00" }), posting, shown, "Xero")).toEqual({
      ok: false,
      kind: "stale",
      message: "Xero now says 20.00 USD is due on this bill. Sync now, then look at this booking again.",
    });
    expect(billCheck(bill({ status: "draft" }), posting, shown, "Xero")).toMatchObject({ kind: "stale" });
  });

  it("refuses a bill part paid in Xero before it was shown", () => {
    expect(billCheck(bill({ amountDue: "10.00" }), posting, { amountDue: "10", status: "open" }, "Xero")).toMatchObject({ kind: "refused", reason: "already_paid" });
  });
});

const sent = { billExternalId: "bill-1", accountExternalId: "acc-090", amount: "31.39", currency: "USD", date: "2026-10-12", reference: HASH };
const held = (fields: Partial<ExternalPayment> = {}): ExternalPayment => ({
  externalId: "pay-1",
  billExternalId: "bill-1",
  accountExternalId: "acc-090",
  amount: "31.39",
  currency: "USD",
  date: "2026-10-12",
  reference: HASH,
  status: "active",
  ...fields,
});

describe("paymentMatches (W7)", () => {
  it("confirms the payment sent", () => {
    expect(paymentMatches(sent, held(), "Xero")).toEqual({ ok: true });
    expect(paymentMatches(sent, held({ accountExternalId: null, reference: HASH.toUpperCase().replace("0X", "0x") }), "Xero")).toEqual({ ok: true });
  });

  it("tells a deleted one from another one", () => {
    expect(paymentMatches(sent, held({ status: "deleted" }), "Xero")).toMatchObject({ ok: false, deleted: true });
    expect(paymentMatches(sent, held({ amount: "30" }), "Xero")).toMatchObject({ ok: false, deleted: false });
    expect(paymentMatches(sent, held({ billExternalId: "bill-2" }), "Xero")).toMatchObject({ ok: false, deleted: false });
  });
});

describe("hasScopes (W8)", () => {
  it("needs every write scope", () => {
    expect(hasScopes(["offline_access", "accounting.invoices.read", "accounting.payments"], ["accounting.payments"])).toBe(true);
    expect(hasScopes(["offline_access", "accounting.invoices.read"], ["accounting.payments"])).toBe(false);
  });
});
