import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/accounting-bookings", () => ({ approveBookingsAction: vi.fn() }));
vi.mock("@/app/actions/xero", () => ({
  syncXeroNowAction: vi.fn(),
  disconnectXeroAction: vi.fn(),
  loadXeroAccountsAction: vi.fn(),
  chooseXeroAccountAction: vi.fn(),
  addXeroBillsAction: vi.fn(),
  dismissXeroBillsAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { AccountingBookings } from "@/components/AccountingBookings";
import XeroPanel from "@/components/XeroPanel";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { SettlementTrack } from "@/components/vx/SettlementTrack";
import { invoiceDecision } from "@/components/vx/map";
import { bookingFromEntries } from "@/lib/connectors/booked";
import type { BookingRowView } from "@/lib/connectors/bookings-view";
import type { AccountingPanelView } from "@/lib/connectors/panel";
import { REALITY_REFUSAL } from "@/lib/connectors/posting";
import type { LedgerEntry } from "@/lib/ledger";
import type { InvoiceRow } from "@/lib/queries";
import { reduceSettlement } from "@/lib/settlement";

/**
 * Where a booking shows (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W6, W8, W10): To book in Xero
 * on Bills & receivables, the Settings card's Allow Vestiarion to book payments, the paid bill's badge, and the last row
 * of Where the payment is.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const HASH = `0x${"3c".repeat(32)}`;
const PAYMENT = "b26fd49a-cbae-470a-a8f8-bcbc119e0379";
const INVOICE = "4c6d0f1e-0000-4000-8000-00000000b001";

const row = (fields: Partial<BookingRowView> = {}): BookingRowView => ({
  id: "posting-1",
  state: "draft",
  supplier: "Xero",
  billNumber: "Inv-2026-10",
  amount: "31.39",
  currency: "USD",
  paidOn: "2026-10-12",
  reference: HASH,
  account: "Arc USDC wallet (091)",
  billNow: { amountDue: "31.39", status: "open" },
  billAfter: { amountDue: "0.00", status: "paid" },
  network: "arc-testnet",
  shadow: true,
  paidAmount: "31.39",
  paidToken: "USDC",
  networkFee: "0.0021",
  fingerprint: "f".repeat(64),
  blocked: null,
  words: "Waiting for review",
  paymentId: null,
  ...fields,
});

const bookings = (fields: Partial<Parameters<typeof AccountingBookings>[0]> = {}) =>
  renderToStaticMarkup(
    <AccountingBookings
      orgSlug="acme"
      connectionId="conn-1"
      label="Xero"
      organisation="Demo Company (Global)"
      scopeMissing={false}
      accountChosen
      toReview={[row()]}
      done={[]}
      canBook
      connectHref="/integrations/xero/connect?org=acme"
      {...fields}
    />
  );

describe("To book in Xero (W6)", () => {
  it("shows each payment as the change it makes in Xero, now and after, with the payment on Arc and its fee apart", () => {
    const markup = bookings();
    const words = text(markup);
    expect(words).toContain("To book in Xero: 1 payment");
    expect(words).toContain("nothing is written to Xero until you approve it");
    expect(words).toContain("Bill Inv-2026-10 amount due 31.39 USD 0.00 USD");
    expect(words).toContain("Bill status Awaiting payment Paid");
    expect(words).toContain("Payment none 31.39 USD");
    expect(words).toContain("Paid from · Arc USDC wallet (091)");
    expect(words).toContain("Date · Oct 12, 2026");
    expect(words).toContain("Paid on Arc testnet: 31.39 USDC, in shadow mode · network fee 0.0021 USDC, not booked");
    expect(words).toContain("Approve and book");
    expect(words).toContain("booked only into a Xero demo company, never into your real books");
    // The fingerprint of exactly this view goes with the ticked booking.
    expect(markup).toContain(`value="posting-1:${"f".repeat(64)}"`);
  });

  it("offers Allow Vestiarion to book payments, and asks for the account, before anything can be approved", () => {
    const words = text(bookings({ scopeMissing: true, accountChosen: false, toReview: [row({ fingerprint: null, blocked: "Allow Vestiarion to book payments first." })] }));
    expect(words).toContain("Xero has not allowed Vestiarion to book payments yet.");
    expect(words).toContain("Allow Vestiarion to book payments");
    expect(words).toContain("Choose where payments are booked, under Xero in Settings");
    expect(words).toContain("Allow Vestiarion to book payments first.");
  });

  it("lists what was booked, and what was not with why", () => {
    const words = text(
      bookings({
        toReview: [],
        done: [row({ id: "a", state: "confirmed", words: "Booked in Xero", paymentId: PAYMENT }), row({ id: "b", state: "refused", words: REALITY_REFUSAL, billNumber: "NC-1", supplier: "Net Connect" })],
      })
    );
    expect(words).toContain("Booked in Xero · b26fd49a…");
    expect(words).toContain(`Net Connect · NC-1 · 31.39 USD: ${REALITY_REFUSAL}`);
  });

  it("lets only an owner or admin approve", () => {
    const words = text(bookings({ canBook: false }));
    expect(words).toContain("An owner or admin approves bookings in Xero.");
    expect(words).not.toContain("Approve and book");
  });
});

const connected: Extract<AccountingPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-1",
  status: { tone: "ok", title: "Connected to Demo Company (Global)", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "Demo Company (Global)",
  waiting: 0,
  closedAfterAdded: 0,
  paymentAccount: { id: "a", code: "091", name: "Arc USDC wallet", currency: "USD" },
  sample: null,
};

describe("the Settings card (W8)", () => {
  it("asks an owner or admin to allow booking on a connection made without the write scope, through the connect page", () => {
    const words = text(renderToStaticMarkup(<XeroPanel orgSlug="acme" view={{ ...connected, bookingAllowed: false }} canManage notice={null} />));
    expect(words).toContain("Xero has not allowed Vestiarion to book payments yet.");
    expect(words).toContain("Allow Vestiarion to book payments");
    expect(text(renderToStaticMarkup(<XeroPanel orgSlug="acme" view={{ ...connected, bookingAllowed: true }} canManage notice={null} />))).not.toContain("Allow Vestiarion to book payments");
    expect(text(renderToStaticMarkup(<XeroPanel orgSlug="acme" view={{ ...connected, bookingAllowed: false }} canManage={false} notice={null} />))).toContain("An owner or admin allows it.");
  });
});

const entry = (seq: number, action: string, detail: Record<string, unknown>): LedgerEntry => ({
  seq,
  id: `e-${seq}`,
  ts: `2026-10-12T09:${String(seq).padStart(2, "0")}:00.000Z`,
  actor: "system",
  domain: "ap",
  action,
  summary: action,
  detail,
  bodyHash: "h",
  signature: "s",
  prevHash: "p",
  hash: `hash-${seq}`,
  signingKeyId: null,
});
const BASE = { provider: "xero", postingId: "posting-1", invoiceId: INVOICE };
const BOOKED = [
  entry(20, "ap_pay", { invoiceId: INVOICE, execution: { resultingStatus: "paid", txRef: HASH } }),
  entry(30, "accounting_payment_drafted", { ...BASE, amount: "31.39", currency: "USD" }),
  entry(31, "accounting_payment_approved", { ...BASE, by: "u", account: { id: "a", code: "091", name: "Arc USDC wallet" } }),
  entry(32, "accounting_payment_sent", { ...BASE, paymentId: PAYMENT }),
  entry(33, "accounting_payment_confirmed", { ...BASE, paymentId: PAYMENT, amount: "31.39", currency: "USD" }),
];

describe("the paid bill (W10)", () => {
  it("says Where the payment is ends booked in Xero, stated by Xero when read back", () => {
    const settlement = reduceSettlement({ facts: [{ kind: "confirmed", at: "2026-10-12T09:15:00.000Z", attempt: 1, refs: [HASH], txHash: HASH }], books: { paid: true, txRef: HASH, at: "2026-10-12T09:16:00.000Z" }, crossChain: false, simulated: false });
    const words = text(
      renderToStaticMarkup(<SettlementTrack id={INVOICE} settlement={settlement} orgSlug="acme" network="arc-testnet" now={Date.parse("2026-10-12T10:00:00Z")} booking={bookingFromEntries(BOOKED, INVOICE)} />)
    );
    expect(words).toContain(`Booked in Xero`);
    expect(words).toContain(`Payment (${PAYMENT}) from Arc USDC wallet (091): stated by Xero when Vestiarion read it back.`);
    expect(words).toContain("#0033");
  });

  it("puts Booked in Xero on the card, and keeps the agent's own decision as the card's entry", () => {
    const invoice = {
      id: INVOICE,
      direction: "payable",
      counterparty_id: "cp",
      counterparty_name: "Xero",
      amount: 31.39,
      currency: "USDC",
      memo: "Invoice Inv-2026-10",
      po_reference: null,
      goods_received: true,
      due_date: "2026-10-20T12:00:00.000Z",
      status: "paid",
      tx_ref: HASH,
      decided_at: "2026-10-12T09:15:00.000Z",
      settled_at: "2026-10-12T09:16:00.000Z",
      created_at: "2026-10-12T09:00:00.000Z",
      agent_reasoning: "Paid.",
    } as unknown as InvoiceRow;
    const decision = invoiceDecision(invoice, undefined, [...BOOKED].reverse(), { network: "arc-testnet" });
    expect(decision.booked).toMatchObject({ state: "confirmed", paymentId: PAYMENT });
    expect(decision.auditSeq).toBe(20);
    expect(text(renderToStaticMarkup(<DecisionCard decision={decision} orgSlug="acme" />))).toContain("Booked in Xero");
  });
});
