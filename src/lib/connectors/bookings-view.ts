import type { Network } from "../network";
import { accountName } from "./booking";
import type { PostingRow } from "./booking-run";
import { billsByExternalId, postingsOf } from "./booking-store";
import type { Connection } from "./connections";
import { alreadyPaid, hasScopes, postingFingerprint, type PostingState } from "./posting";
import { PROVIDER_LABELS, type AccountingProvider, type ProviderId, type SourceStatus } from "./provider";

/**
 * The bookings on Bills & receivables, **To book in Xero** (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md
 * W6, W10): each draft as the change it makes in the tool, field by field, with the fingerprint of exactly that view
 * when it can be approved now, or why it cannot; below, those booked, not booked and failed. Read in the workspace's
 * scope from the rows: no call to the provider, no token. Everything here can cross into the client component.
 */

export interface BookingRowView {
  id: string;
  state: PostingState;
  supplier: string;
  billNumber: string | null;
  amount: string;
  currency: string;
  paidOn: string;
  reference: string;
  /** The account it is booked from: the one chosen now for a draft, the one approved once it was. */
  account: string | null;
  /** The bill in the tool as the last sync left it, and as it will be after this payment. */
  billNow: { amountDue: string; status: SourceStatus } | null;
  billAfter: { amountDue: string; status: "paid" | "part paid" } | null;
  network: Network;
  shadow: boolean;
  paidAmount: string;
  paidToken: string;
  networkFee: string | null;
  /** Present when it can be approved now: what the page sends back with it. */
  fingerprint: string | null;
  /** Why it cannot be approved now, when it is waiting for review. */
  blocked: string | null;
  /** Where it is, in words. */
  words: string;
  paymentId: string | null;
}

export type BookingsView =
  | { state: "hidden" }
  | {
      state: "list";
      provider: ProviderId;
      connectionId: string;
      label: string;
      organisation: string | null;
      /** The write scope is missing: the card offers Allow Vestiarion to book payments. */
      scopeMissing: boolean;
      accountChosen: boolean;
      toReview: BookingRowView[];
      done: BookingRowView[];
    };

const TO_REVIEW: ReadonlySet<PostingState> = new Set(["draft", "failed", "sending", "sent"]);
/** The settled bookings shown under the list: the latest. */
const DONE_SHOWN = 20;

function digits(currency: string): number {
  return currency === "JPY" || currency === "KRW" || currency === "IDR" ? 0 : 2;
}

function after(amountDue: string, amount: string, currency: string): { amountDue: string; status: "paid" | "part paid" } {
  const left = Math.max(0, Number(amountDue) - Number(amount));
  const rounded = left.toFixed(digits(currency));
  return { amountDue: rounded, status: Number(rounded) === 0 ? "paid" : "part paid" };
}

/** Where a booking is, in words: the same words on the list, the card and the trail. */
export function postingWords(posting: Pick<PostingRow, "state" | "message" | "externalPaymentId">, label: string): string {
  switch (posting.state) {
    case "draft":
      return "Waiting for review";
    case "sending":
      return `Being booked in ${label} now`;
    case "sent":
      return `Sent to ${label}; confirming it`;
    case "confirmed":
      return `Booked in ${label}`;
    case "failed":
      return posting.message ?? `Not booked in ${label} yet`;
    case "refused":
      return posting.message ?? "Not booked";
  }
}

export function bookingRows(input: {
  postings: readonly PostingRow[];
  bills: ReadonlyMap<string, { amountDue: string; status: SourceStatus; number: string | null; contactName: string }>;
  connection: Pick<Connection, "paymentAccount" | "scopes">;
  writeScopes: readonly string[];
  label: string;
}): { toReview: BookingRowView[]; done: BookingRowView[] } {
  const scopeOk = hasScopes(input.connection.scopes, input.writeScopes);
  const account = input.connection.paymentAccount;
  const rows = input.postings.map((posting): BookingRowView => {
    const bill = input.bills.get(posting.billExternalId) ?? null;
    const reviewable = posting.state === "draft" || posting.state === "failed";
    const billClosed = bill !== null && (bill.status === "paid" || bill.status === "voided" || bill.status === "deleted" || Number(bill.amountDue) <= 0);
    const blocked = !reviewable
      ? null
      : !scopeOk
        ? "Allow Vestiarion to book payments first."
        : !account
          ? "Choose where payments are booked."
          : bill === null
            ? `This bill is no longer among those ${input.label} brought in.`
            : billClosed
              ? bill.status === "paid" || Number(bill.amountDue) <= 0
                ? alreadyPaid(input.label)
                : `The bill was ${bill.status} in ${input.label}.`
              : null;
    const shownAccount = reviewable ? account : (posting.account ?? account);
    const fingerprint =
      reviewable && blocked === null && account && bill
        ? postingFingerprint({
            billExternalId: posting.billExternalId,
            bill: { amountDue: bill.amountDue, status: bill.status },
            amount: posting.amount,
            currency: posting.currency,
            accountId: account.id,
            paidOn: posting.paidOn,
            reference: posting.reference,
          })
        : null;
    return {
      id: posting.id,
      state: posting.state,
      supplier: bill?.contactName ?? "Supplier",
      billNumber: bill?.number ?? null,
      amount: posting.amount,
      currency: posting.currency,
      paidOn: posting.paidOn,
      reference: posting.reference,
      account: shownAccount ? accountName(shownAccount) : null,
      billNow: bill ? { amountDue: bill.amountDue, status: bill.status } : null,
      billAfter: bill && !billClosed ? after(bill.amountDue, posting.amount, posting.currency) : null,
      network: posting.network,
      shadow: posting.shadow,
      paidAmount: posting.paidAmount,
      paidToken: posting.paidToken,
      networkFee: posting.networkFee,
      fingerprint,
      blocked,
      words: postingWords(posting, input.label),
      paymentId: posting.externalPaymentId,
    };
  });
  return {
    toReview: rows.filter((row) => TO_REVIEW.has(row.state)),
    done: rows.filter((row) => !TO_REVIEW.has(row.state)).slice(0, DONE_SHOWN),
  };
}

/** The list on Bills & receivables: hidden for a provider that does not book, without a connection, or once disconnected. */
export async function accountingBookings(connection: Connection | null, provider: AccountingProvider | null): Promise<BookingsView> {
  if (!connection || connection.status === "revoked" || !provider?.booking) return { state: "hidden" };
  const postings = await postingsOf(connection.id);
  if (postings.length === 0) return { state: "hidden" };
  const bills = await billsByExternalId(
    connection.id,
    postings.map((posting) => posting.billExternalId)
  );
  const label = PROVIDER_LABELS[connection.provider];
  const { toReview, done } = bookingRows({ postings, bills, connection, writeScopes: provider.booking.writeScopes, label });
  return {
    state: "list",
    provider: connection.provider,
    connectionId: connection.id,
    label,
    organisation: connection.externalOrgName,
    scopeMissing: !hasScopes(connection.scopes, provider.booking.writeScopes),
    accountChosen: connection.paymentAccount !== null,
    toReview,
    done,
  };
}
