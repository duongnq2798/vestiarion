import { describe, expect, it } from "vitest";
import { bookedBadge, bookedLine, bookingFromEntries } from "@/lib/connectors/booked";
import type { PostingRow } from "@/lib/connectors/booking-run";
import { bookingRows } from "@/lib/connectors/bookings-view";
import { postingFingerprint, REALITY_REFUSAL } from "@/lib/connectors/posting";
import type { SourceStatus } from "@/lib/connectors/provider";
import { buildEvidenceChain } from "@/lib/evidence-chain";
import { ALICE, entry, INVOICE, okChecks, paidInFull, step } from "./support/evidence-fixtures";

/**
 * Where a payable's booking is, said the same way everywhere (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W6, W9, W10): from its signed entries for the card, the settlement track and the evidence chain, and from its rows
 * for the review list.
 */

const PAYMENT = "b26fd49a-cbae-470a-a8f8-bcbc119e0379";
const HASH = `0x${"3c".repeat(32)}`;
const ACCOUNT = { id: "6f7594f2-f059-4d56-9e67-47ac9733bfe9", code: "091", name: "Arc USDC wallet", currency: "USD" };
const base = { provider: "xero", connectionId: "conn-1", postingId: "posting-1", invoiceId: INVOICE };

const DRAFTED = entry(70, "10:00:00", "system", "accounting_payment_drafted", { ...base, billId: "bill-1", amount: "12.50", currency: "USD", paidOn: "2026-10-05", reference: HASH, network: "arc-testnet", shadow: true });
const APPROVED = entry(71, "10:05:00", "human", "accounting_payment_approved", { ...base, by: ALICE, account: ACCOUNT, amount: "12.50", currency: "USD" });
const SENT = entry(72, "10:05:01", "system", "accounting_payment_sent", { ...base, paymentId: PAYMENT, adopted: false });
const CONFIRMED = entry(73, "10:05:02", "system", "accounting_payment_confirmed", { ...base, paymentId: PAYMENT, amount: "12.50", currency: "USD", account: ACCOUNT });
const REFUSED = entry(74, "10:00:00", "system", "accounting_payment_refused", { ...base, reason: "reality", message: REALITY_REFUSAL });

describe("bookingFromEntries (W10)", () => {
  it("is none for a payable no booking entry is about", () => {
    expect(bookingFromEntries([entry(1, "09:00:00", "agent", "ap_pay", { invoiceId: INVOICE })], INVOICE)).toBeNull();
  });

  it("follows a booking to its read-back, with the payment, the account and who approved it", () => {
    const mark = bookingFromEntries([CONFIRMED, DRAFTED, SENT, APPROVED], INVOICE);
    expect(mark).toMatchObject({ label: "Xero", state: "confirmed", seq: 73, paymentId: PAYMENT, account: "Arc USDC wallet (091)", amount: "12.50", currency: "USD", approvedBy: ALICE, approvedSeq: 71 });
    expect(bookedBadge(mark)).toBe("Booked in Xero");
    expect(bookedLine(mark!)).toEqual({ title: "Booked in Xero", text: `Payment (${PAYMENT}) from Arc USDC wallet (091): stated by Xero when Vestiarion read it back.`, reached: true });
  });

  it("says a booking not read back yet is sent, a draft waits for review, and a refusal says why", () => {
    expect(bookedBadge(bookingFromEntries([DRAFTED, APPROVED, SENT], INVOICE))).toBe("Sent to Xero");
    const draft = bookingFromEntries([DRAFTED], INVOICE)!;
    expect(bookedBadge(draft)).toBeNull();
    expect(bookedLine(draft)).toMatchObject({ title: "Not booked in Xero yet", reached: false });
    const refused = bookingFromEntries([REFUSED], INVOICE)!;
    expect(refused).toMatchObject({ state: "refused", reason: "reality", message: REALITY_REFUSAL });
    expect(bookedLine(refused)).toEqual({ title: "Not booked in Xero", text: REALITY_REFUSAL, reached: false });
  });
});

describe("the evidence chain's step, The books (W10)", () => {
  const chainWith = (entries: ReturnType<typeof entry>[]) => {
    const input = paidInFull();
    const all = [...input.entries, ...entries];
    return buildEvidenceChain({ ...input, entries: all, checks: { ...input.checks, entries: okChecks(all) } });
  };

  it("is not there for a payable never drafted for booking", () => {
    expect(buildEvidenceChain(paidInFull()).steps.map((one) => one.id)).not.toContain("books");
  });

  it("comes after the payment, verified outside once Xero answered the read-back, naming who approved it", () => {
    const chain = chainWith([DRAFTED, APPROVED, SENT, CONFIRMED]);
    expect(chain.steps.map((one) => one.id)).toEqual(["agreed", "delivered", "bill", "payee", "decision", "people", "payment", "books", "receipt", "signatures"]);
    const books = step(chain, "books");
    expect(books.kind).toBe("verified");
    expect(books.facts[0]).toMatchObject({
      kind: "verified",
      text: `Booked in Xero as payment ${PAYMENT} of 12.50 USD from Arc USDC wallet (091): stated by Xero when Vestiarion read it back.`,
      seqs: [71, 73],
    });
    expect(books.facts[0].notes?.[0]).toBe("Approved by alice@northstar.test before it was sent.");
    // Its entries are among those the signatures step checks.
    expect(step(chain, "signatures").facts[0].seqs).toEqual(expect.arrayContaining([70, 71, 72, 73]));
  });

  it("never reads a booking sent and not read back as verified", () => {
    expect(step(chainWith([DRAFTED, APPROVED, SENT]), "books").kind).toBe("unreachable");
  });

  it("says a draft is missing, with how to fill it, and the reality rule's refusal is checked by code", () => {
    expect(step(chainWith([DRAFTED]), "books").facts[0]).toMatchObject({ kind: "missing", fill: expect.stringContaining("To book in Xero") });
    expect(step(chainWith([REFUSED]), "books").facts[0]).toMatchObject({ kind: "checked", text: REALITY_REFUSAL });
  });

  it("leaves the payment step's own label alone", () => {
    expect(step(chainWith([DRAFTED]), "payment").kind).toBe(step(buildEvidenceChain(paidInFull()), "payment").kind);
  });
});

const posting = (fields: Partial<PostingRow> = {}): PostingRow => ({
  id: "posting-1",
  connectionId: "conn-1",
  provider: "xero",
  externalOrgId: "tenant-1",
  invoiceId: INVOICE,
  billExternalId: "bill-1",
  amount: "31.39",
  currency: "USD",
  paidOn: "2026-10-12",
  reference: HASH,
  network: "arc-testnet",
  shadow: true,
  paidAmount: "31.39",
  paidToken: "USDC",
  networkFee: "0.0021",
  organisationDemo: true,
  state: "draft",
  reason: null,
  message: null,
  account: null,
  fingerprint: null,
  attempts: 0,
  externalPaymentId: null,
  sendingUntil: null,
  approvedBy: null,
  approvedAt: null,
  sentAt: null,
  confirmedAt: null,
  createdAt: "2026-10-12T09:20:00.000Z",
  ...fields,
});

type SyncedBill = { amountDue: string; status: SourceStatus; number: string | null; contactName: string };
const bills = new Map<string, SyncedBill>([["bill-1", { amountDue: "31.39", status: "open", number: "Inv-2026-10", contactName: "Xero" }]]);
const SCOPES = ["offline_access", "accounting.payments"];

describe("bookingRows (W6)", () => {
  it("shows a draft as the change it makes in Xero, with the fingerprint of exactly that view", () => {
    const { toReview, done } = bookingRows({ postings: [posting()], bills, connection: { paymentAccount: ACCOUNT, scopes: SCOPES }, writeScopes: ["accounting.payments"], label: "Xero" });
    expect(done).toEqual([]);
    expect(toReview[0]).toMatchObject({
      supplier: "Xero",
      billNumber: "Inv-2026-10",
      account: "Arc USDC wallet (091)",
      billNow: { amountDue: "31.39", status: "open" },
      billAfter: { amountDue: "0.00", status: "paid" },
      blocked: null,
      words: "Waiting for review",
    });
    expect(toReview[0].fingerprint).toBe(
      postingFingerprint({ billExternalId: "bill-1", bill: { amountDue: "31.39", status: "open" }, amount: "31.39", currency: "USD", accountId: ACCOUNT.id, paidOn: "2026-10-12", reference: HASH })
    );
  });

  it("says why a draft cannot be approved yet, and gives it no fingerprint", () => {
    const view = (connection: { paymentAccount: typeof ACCOUNT | null; scopes: string[] }, rows = bills) =>
      bookingRows({ postings: [posting()], bills: rows, connection, writeScopes: ["accounting.payments"], label: "Xero" }).toReview[0];
    expect(view({ paymentAccount: ACCOUNT, scopes: ["offline_access"] })).toMatchObject({ blocked: "Allow Vestiarion to book payments first.", fingerprint: null });
    expect(view({ paymentAccount: null, scopes: SCOPES })).toMatchObject({ blocked: "Choose where payments are booked.", fingerprint: null });
    expect(view({ paymentAccount: ACCOUNT, scopes: SCOPES }, new Map<string, SyncedBill>([["bill-1", { ...bills.get("bill-1")!, status: "paid", amountDue: "0" }]]))).toMatchObject({
      blocked: "Already paid in Xero.",
      fingerprint: null,
    });
  });

  it("lists bookings done below, booked or not, with why", () => {
    const { toReview, done } = bookingRows({
      postings: [posting({ id: "a", state: "confirmed", externalPaymentId: PAYMENT, account: ACCOUNT }), posting({ id: "b", state: "refused", reason: "reality", message: REALITY_REFUSAL }), posting({ id: "c", state: "failed", message: "Xero did not answer." })],
      bills,
      connection: { paymentAccount: ACCOUNT, scopes: SCOPES },
      writeScopes: ["accounting.payments"],
      label: "Xero",
    });
    expect(done.map((row) => [row.id, row.words])).toEqual([
      ["a", "Booked in Xero"],
      ["b", REALITY_REFUSAL],
    ]);
    expect(toReview).toMatchObject([{ id: "c", words: "Xero did not answer.", fingerprint: expect.any(String) }]);
  });
});
