import type { LedgerEntryInput } from "../ledger";
import type { Network } from "../network";
import type { Connection, PaymentAccount } from "./connections";
import {
  billCheck,
  bookingReality,
  idempotencyKey,
  needsOrganisation,
  paymentMatches,
  paymentToBook,
  postingFacts,
  postingFingerprint,
  REALITY_REFUSAL,
  alreadyPaid,
  type ConfirmedIntent,
  type PaidInvoice,
  type PostingFacts,
  type PostingState,
  type ShownBill,
} from "./posting";
import { ProviderError, type BookingProvider, type ExternalPayment, type OrganisationFacts, type ProviderId, type SourceStatus } from "./provider";

/**
 * Booking payments made on Arc, run by run (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md W3, W6,
 * W7, W9): drafting the bookings of payments confirmed since the last run, a person's approval that sends one, and the
 * read-back of those sent. The provider and the database are injected (`booking-store.ts` is the real store), so every
 * branch is tested without either. No call to the provider happens inside a database write; each transition is a
 * compare-and-set on the booking's state, followed by its signed entry.
 */

/** A booking as the runs read it. */
export interface PostingRow {
  id: string;
  connectionId: string;
  provider: ProviderId;
  externalOrgId: string;
  invoiceId: string;
  billExternalId: string;
  amount: string;
  currency: string;
  paidOn: string;
  reference: string;
  network: Network;
  shadow: boolean;
  paidAmount: string;
  paidToken: "USDC" | "EURC";
  networkFee: string | null;
  organisationDemo: boolean | null;
  state: PostingState;
  reason: string | null;
  message: string | null;
  account: PaymentAccount | null;
  fingerprint: string | null;
  attempts: number;
  externalPaymentId: string | null;
  sendingUntil: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

/** A payable paid on Arc, brought in from a bill of this connection, with no booking yet. */
export interface Candidate {
  invoiceId: string;
  billExternalId: string;
  network: Network;
  invoice: PaidInvoice;
  intent: ConfirmedIntent;
  /** The bill as the last sync left it; null when the review list never kept it. */
  bill: { currency: string; sourceStatus: SourceStatus; amountDue: string; number: string | null; contactName: string } | null;
}

export interface NewPosting {
  invoiceId: string;
  billExternalId: string;
  facts: PostingFacts;
  network: Network;
  shadow: boolean;
  organisationDemo: boolean | null;
  state: "draft" | "refused";
  reason: string | null;
  message: string | null;
}

/** The columns a transition writes. */
export interface PostingPatch {
  reason: string | null;
  message: string | null;
  account: PaymentAccount;
  fingerprint: string;
  approvedBy: string;
  approvedAt: string;
  sendingUntil: string | null;
  attempts: number;
  externalPaymentId: string;
  sentAt: string;
  confirmedAt: string;
  organisationDemo: boolean | null;
}

export interface BookingStore {
  /** The connection's payables paid on Arc from its bills, with no booking yet. */
  candidates(connection: Connection): Promise<Candidate[]>;
  /** Whether the workspace is in shadow mode now. */
  shadowOn(): Promise<boolean>;
  /** Inserts a booking; null when the payable has one already (one per payable and provider). */
  insert(connection: Connection, posting: NewPosting): Promise<PostingRow | null>;
  /**
   * Moves a booking to `to` from one of `from`, as a compare-and-set (and over `attempts` when given): the row after, or
   * null when it was in none of them. `sending` counts as a `from` only once its lease ran out, when `nowIso` is given.
   */
  move(posting: PostingRow, from: readonly PostingState[], to: PostingState, patch: Partial<PostingPatch>, options?: { leaseOverAt?: string }): Promise<PostingRow | null>;
  /** The connection's drafts, each with its bill as the last sync left it (null when it is no longer kept). */
  drafts(connectionId: string): Promise<Array<{ posting: PostingRow; bill: { status: SourceStatus; amountDue: string } | null }>>;
  /** Sent and not yet confirmed, and sending past its lease: what a run reads back. */
  inFlight(connectionId: string, nowIso: string): Promise<PostingRow[]>;
  /** Appends a signed entry, best effort: the transition stands either way. */
  record(entry: LedgerEntryInput): Promise<void>;
}

export interface BookingDeps {
  connection: Connection;
  booking: BookingProvider;
  /** "Xero" */
  label: string;
  store: BookingStore;
  now?: () => number;
}

/** How long an approval's send holds its booking: far longer than four calls to the provider take. */
export const SENDING_LEASE_MS = 2 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const money = (amount: string, currency: string) => `${Number(amount).toLocaleString("en-US", { minimumFractionDigits: currency === "JPY" ? 0 : 2, maximumFractionDigits: 6 })} ${currency}`;

function base(deps: BookingDeps, posting: Pick<PostingRow, "id" | "invoiceId">) {
  return { provider: deps.connection.provider, connectionId: deps.connection.id, postingId: posting.id, invoiceId: posting.invoiceId };
}

async function refusedEntry(deps: BookingDeps, posting: PostingRow, reason: string, message: string): Promise<void> {
  await deps.store.record({
    actor: "system",
    domain: "ap",
    action: "accounting_payment_refused",
    summary: `Not booked in ${deps.label}: ${message}`,
    detail: { ...base(deps, posting), billId: posting.billExternalId, reason, message, network: posting.network, shadow: posting.shadow, organisationDemo: posting.organisationDemo, amount: posting.amount, currency: posting.currency, reference: posting.reference },
  });
}

/**
 * Drafts the bookings of the payments confirmed on Arc since the last run (W3). Reads only the database, and the
 * organisation once when a payment needs the reality rule; when that read fails, those payments wait for the next run,
 * never guessed. A booking the rule refuses, or whose bill the last sync saw paid in the tool, is recorded refused at
 * once, with why. Never sends anything.
 */
export async function draftPostings(deps: BookingDeps & { accessToken: () => Promise<string | null> }): Promise<{ drafted: number; refused: number; waiting: number }> {
  const result = { drafted: 0, refused: 0, waiting: 0 };
  const candidates = await deps.store.candidates(deps.connection);
  if (candidates.length === 0) return result;
  const shadowNow = await deps.store.shadowOn();
  const shadowOf = (candidate: Candidate) => shadowNow || candidate.invoice.originalCurrency !== null;
  let organisation: OrganisationFacts | null = null;
  if (candidates.some((candidate) => needsOrganisation({ network: candidate.network, shadow: shadowOf(candidate) }))) {
    try {
      const token = await deps.accessToken();
      if (token) organisation = await deps.booking.organisation({ accessToken: token, externalOrgId: deps.connection.externalOrgId });
    } catch (error) {
      console.error("booking: the organisation was not read", deps.connection.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  for (const candidate of candidates) {
    if (!candidate.bill) continue;
    const shadow = shadowOf(candidate);
    const facts = postingFacts({ invoice: candidate.invoice, intent: candidate.intent, billCurrency: candidate.bill.currency });
    if (!facts.ok && facts.reason === "unreadable") continue;
    const reality = bookingReality({ network: candidate.network, shadow }, organisation?.demo ?? null);
    if (!reality.ok && !reality.refused) {
      result.waiting += 1;
      continue;
    }
    // Facts for a refusal on the currency: the stablecoin's own, so the row still says what was paid.
    const written: PostingFacts = facts.ok
      ? facts.facts
      : {
          amount: String(candidate.invoice.paidAmount ?? candidate.invoice.amount),
          currency: candidate.invoice.currency === "EURC" ? "EUR" : "USD",
          paidOn: new Date(candidate.intent.confirmedAt ?? candidate.invoice.settledAt ?? Date.now()).toISOString().slice(0, 10),
          reference: candidate.intent.txHash ?? candidate.invoice.txRef ?? "",
          paidAmount: String(candidate.invoice.paidAmount ?? candidate.invoice.amount),
          paidToken: candidate.invoice.currency === "EURC" ? "EURC" : "USDC",
          networkFee: null,
        };
    const refusal = !reality.ok
      ? { reason: "reality", message: REALITY_REFUSAL }
      : !facts.ok
        ? { reason: "currency", message: facts.message }
        : candidate.bill.sourceStatus === "paid" || Number(candidate.bill.amountDue) <= 0
          ? { reason: "already_paid", message: alreadyPaid(deps.label) }
          : null;
    const row = await deps.store.insert(deps.connection, {
      invoiceId: candidate.invoiceId,
      billExternalId: candidate.billExternalId,
      facts: written,
      network: candidate.network,
      shadow,
      organisationDemo: organisation?.demo ?? null,
      state: refusal ? "refused" : "draft",
      reason: refusal?.reason ?? null,
      message: refusal?.message ?? null,
    });
    if (!row) continue;
    const bill = candidate.bill.number ? `bill ${candidate.bill.number}` : "its bill";
    if (refusal) {
      result.refused += 1;
      await refusedEntry(deps, row, refusal.reason, refusal.message);
      continue;
    }
    result.drafted += 1;
    await deps.store.record({
      actor: "system",
      domain: "ap",
      action: "accounting_payment_drafted",
      summary: `Drafted a booking in ${deps.label} of ${money(row.amount, row.currency)} against ${bill} from ${candidate.bill.contactName}, for a person to review`,
      detail: {
        ...base(deps, row),
        externalOrgId: deps.connection.externalOrgId,
        billId: row.billExternalId,
        amount: row.amount,
        currency: row.currency,
        paidOn: row.paidOn,
        reference: row.reference,
        network: row.network,
        shadow: row.shadow,
        paidAmount: row.paidAmount,
        paidToken: row.paidToken,
        networkFee: row.networkFee,
      },
    });
  }
  return result;
}

/**
 * Drafts whose bill the last sync saw closed in the tool (W3): paid there (its accountant booked it by hand) is refused
 * as already paid, voided or deleted as closed. So a draft never waits for a review that could only refuse it.
 */
export async function closeDrafts(deps: BookingDeps): Promise<number> {
  let closed = 0;
  for (const { posting, bill } of await deps.store.drafts(deps.connection.id)) {
    if (!bill) continue;
    const refusal =
      bill.status === "paid" || (bill.status === "open" && Number(bill.amountDue) <= 0)
        ? { reason: "already_paid", message: alreadyPaid(deps.label) }
        : bill.status === "voided" || bill.status === "deleted"
          ? { reason: "bill_closed", message: `The bill was ${bill.status} in ${deps.label}: nothing to book against.` }
          : null;
    if (!refusal) continue;
    await refuse(deps, posting, ["draft"], refusal.reason, refusal.message);
    closed += 1;
  }
  return closed;
}

/** What one approved line came to. */
export type LineOutcome = "booked" | "sent" | "stale" | "refused" | "failed" | "busy" | "unavailable";

export interface LineResult {
  postingId: string;
  outcome: LineOutcome;
  message: string;
  paymentId?: string;
}

const NO_ANSWER = (label: string) => `${label} did not answer. Nothing was booked. Try again in a moment.`;
const STALE = "This booking changed since you saw it. Look at it again, then approve.";

async function fail(deps: BookingDeps, posting: PostingRow, reason: string, message: string, from: readonly PostingState[] = ["sending"]): Promise<void> {
  const moved = await deps.store.move(posting, from, "failed", { reason, message, sendingUntil: null });
  if (!moved) return;
  await deps.store.record({
    actor: "system",
    domain: "ap",
    action: "accounting_payment_failed",
    summary: `Booking in ${deps.label} failed: ${message}`,
    detail: { ...base(deps, posting), reason, message, retryable: true },
  });
}

async function refuse(deps: BookingDeps, posting: PostingRow, from: readonly PostingState[], reason: string, message: string, demo?: boolean | null): Promise<void> {
  const moved = await deps.store.move(posting, from, "refused", { reason, message, sendingUntil: null, ...(demo !== undefined ? { organisationDemo: demo } : {}) });
  if (moved) await refusedEntry(deps, moved, reason, message);
}

/** A send that found nothing done goes back to where it was claimed from: a draft, or a failed booking to approve again. */
async function release(deps: BookingDeps, posting: PostingRow, claimedFrom: PostingState): Promise<void> {
  if (claimedFrom === "draft") await deps.store.move(posting, ["sending"], "draft", { sendingUntil: null });
  else await deps.store.move(posting, ["sending"], "failed", { sendingUntil: null });
}

async function markSent(deps: BookingDeps, posting: PostingRow, payment: ExternalPayment, adopted: boolean, nowIso: string): Promise<PostingRow | null> {
  const moved = await deps.store.move(posting, ["sending"], "sent", { externalPaymentId: payment.externalId, sentAt: nowIso, sendingUntil: null, reason: null, message: null });
  if (!moved) return null;
  await deps.store.record({
    actor: "system",
    domain: "ap",
    action: "accounting_payment_sent",
    summary: adopted
      ? `${deps.label} already held this payment (${payment.externalId}): Vestiarion took it as the booking, and wrote nothing new`
      : `Sent to ${deps.label}: payment ${payment.externalId}, to be read back`,
    detail: { ...base(deps, posting), paymentId: payment.externalId, adopted },
  });
  return moved;
}

/** Reads a sent booking back once (W7, step 7): confirmed when the provider holds what was sent. */
async function readBack(deps: BookingDeps, accessToken: string, posting: PostingRow, options: { goneMeansDeleted: boolean }): Promise<LineResult> {
  const now = deps.now ?? Date.now;
  const paymentId = posting.externalPaymentId as string;
  const account = posting.account as PaymentAccount;
  let held: ExternalPayment | null;
  try {
    held = await deps.booking.payment({ accessToken, externalOrgId: deps.connection.externalOrgId, paymentId });
  } catch {
    return { postingId: posting.id, outcome: "sent", paymentId, message: `Sent to ${deps.label}. Vestiarion reads it back at the next sync to confirm it.` };
  }
  if (!held) {
    if (!options.goneMeansDeleted) return { postingId: posting.id, outcome: "sent", paymentId, message: `Sent to ${deps.label}. Vestiarion reads it back at the next sync to confirm it.` };
    held = { externalId: paymentId, billExternalId: posting.billExternalId, accountExternalId: null, amount: posting.amount, currency: posting.currency, date: null, reference: posting.reference, status: "deleted" };
  }
  const expected = paymentToBook(posting, account);
  const check = paymentMatches(expected, held, deps.label);
  if (!check.ok && check.deleted) {
    await refuse(deps, posting, ["sent"], "deleted_in_provider", check.message);
    return { postingId: posting.id, outcome: "refused", message: check.message };
  }
  if (!check.ok) {
    await fail(deps, posting, "mismatch", check.message, ["sent"]);
    return { postingId: posting.id, outcome: "failed", message: check.message };
  }
  const moved = await deps.store.move(posting, ["sent"], "confirmed", { confirmedAt: iso(now()) });
  if (moved) {
    await deps.store.record({
      actor: "system",
      domain: "ap",
      action: "accounting_payment_confirmed",
      summary: `Booked in ${deps.label} and read back: payment ${paymentId} of ${money(held.amount, posting.currency)} from ${account.name}`,
      detail: { ...base(deps, posting), paymentId, amount: held.amount, currency: posting.currency, account, paidOn: posting.paidOn, reference: posting.reference },
    });
  }
  return { postingId: posting.id, outcome: "booked", paymentId, message: `Booked in ${deps.label}.` };
}

/** What a booking past review says to a person approving it again. */
function settled(posting: PostingRow, label: string): LineResult | null {
  if (posting.state === "confirmed") return { postingId: posting.id, outcome: "booked", paymentId: posting.externalPaymentId ?? undefined, message: `Already booked in ${label}.` };
  if (posting.state === "refused") return { postingId: posting.id, outcome: "refused", message: posting.message ?? "Not booked." };
  if (posting.state === "sent") return { postingId: posting.id, outcome: "sent", paymentId: posting.externalPaymentId ?? undefined, message: `Sent to ${label}; Vestiarion is confirming it.` };
  return null;
}

/**
 * A person's approval of one booking, sent (W6, W7). The fingerprint of what they saw must be the one worked out again
 * now; the organisation, read once for the whole approval, must pass the reality rule; the booking is claimed; then the
 * provider is asked first for a payment with its reference on its bill, the bill is checked as it is now, the payment
 * is booked with a key derived from what was approved, a timeout is read back before anything else, and what was
 * booked is read back once.
 */
export async function approvePosting(input: {
  deps: BookingDeps;
  accessToken: string;
  /** Read right before, once for the approval; null when the provider did not answer. */
  organisation: OrganisationFacts | null;
  posting: PostingRow;
  /** The bill as the review list showed it, from the last sync; null when it is no longer kept. */
  shownBill: ShownBill | null;
  account: PaymentAccount;
  shownFingerprint: string;
  by: string;
}): Promise<LineResult> {
  const { deps, posting, account, accessToken } = input;
  const now = deps.now ?? Date.now;
  const label = deps.label;
  const done = settled(posting, label);
  if (done) return done;
  const leaseOver = posting.state === "sending" && (posting.sendingUntil === null || Date.parse(posting.sendingUntil) <= now());
  if (posting.state === "sending" && !leaseOver) return { postingId: posting.id, outcome: "busy", message: "This booking is being sent now. Look again in a minute." };

  const fingerprint = input.shownBill
    ? postingFingerprint({ billExternalId: posting.billExternalId, bill: input.shownBill, amount: posting.amount, currency: posting.currency, accountId: account.id, paidOn: posting.paidOn, reference: posting.reference })
    : null;
  if (!fingerprint || fingerprint !== input.shownFingerprint) return { postingId: posting.id, outcome: "stale", message: STALE };

  const claimFrom: PostingState[] = ["draft", "failed", "sending"];
  if (!input.organisation) return { postingId: posting.id, outcome: "unavailable", message: NO_ANSWER(label) };
  const reality = bookingReality({ network: posting.network, shadow: posting.shadow }, input.organisation.demo);
  if (!reality.ok) {
    await refuse(deps, posting, ["draft", "failed"], "reality", REALITY_REFUSAL, input.organisation.demo);
    return { postingId: posting.id, outcome: "refused", message: REALITY_REFUSAL };
  }

  const claimed = await deps.store.move(
    posting,
    claimFrom,
    "sending",
    {
      account,
      fingerprint,
      approvedBy: input.by,
      approvedAt: iso(now()),
      sendingUntil: iso(now() + SENDING_LEASE_MS),
      attempts: posting.attempts + 1,
      organisationDemo: input.organisation.demo,
      reason: null,
      message: null,
    },
    { leaseOverAt: iso(now()) }
  );
  if (!claimed) return { postingId: posting.id, outcome: "busy", message: "Someone else approved this booking a moment ago." };
  const claimedFrom = posting.state;
  await deps.store.record({
    actor: "human",
    domain: "ap",
    action: "accounting_payment_approved",
    summary: `Approved booking ${money(posting.amount, posting.currency)} in ${label} from ${account.name}`,
    detail: { by: input.by, ...base(deps, posting), account, fingerprint, amount: posting.amount, currency: posting.currency, paidOn: posting.paidOn, reference: posting.reference },
  });

  const org = { accessToken, externalOrgId: deps.connection.externalOrgId };
  // 3. Look first: a payment with this reference on this bill is the one an earlier send made. A draft never reached
  // the provider (a send goes back to draft only before booking); a failed booking, or a send past its lease, may have,
  // and a payment it made may since have been deleted there, so that look must see deleted payments too.
  let existing: ExternalPayment | null;
  try {
    existing = await deps.booking.findPayment({ ...org, billId: posting.billExternalId, reference: posting.reference, deletedMatters: claimedFrom !== "draft" });
  } catch (error) {
    await release(deps, claimed, claimedFrom);
    return { postingId: posting.id, outcome: "unavailable", message: unavailableWords(error, label) };
  }
  if (existing?.status === "deleted") {
    const message = `A payment with this reference was deleted in ${label}. Vestiarion does not book it again; book it by hand if it belongs there.`;
    await refuse(deps, claimed, ["sending"], "deleted_in_provider", message);
    return { postingId: posting.id, outcome: "refused", message };
  }
  if (existing) {
    const sent = await markSent(deps, claimed, existing, true, iso(now()));
    return sent ? readBack(deps, accessToken, sent, { goneMeansDeleted: false }) : { postingId: posting.id, outcome: "busy", message: STALE };
  }

  // 4. The bill as it is now.
  let bill;
  try {
    bill = await deps.booking.bill({ ...org, billId: posting.billExternalId });
  } catch (error) {
    await release(deps, claimed, claimedFrom);
    return { postingId: posting.id, outcome: "unavailable", message: unavailableWords(error, label) };
  }
  const check = billCheck(bill, posting, input.shownBill as ShownBill, label);
  if (!check.ok && check.kind === "refused") {
    await refuse(deps, claimed, ["sending"], check.reason, check.message);
    return { postingId: posting.id, outcome: "refused", message: check.message };
  }
  if (!check.ok) {
    await release(deps, claimed, claimedFrom);
    return { postingId: posting.id, outcome: "stale", message: check.message };
  }

  // 5. Book it.
  const payment = paymentToBook(posting, account);
  let booked;
  try {
    booked = await deps.booking.bookPayment({ ...org, payment, idempotencyKey: idempotencyKey(posting.id, fingerprint) });
  } catch (error) {
    const failure = error instanceof ProviderError ? error.failure : "unavailable";
    if (failure === "rate_limited") {
      const message = `${label} asked Vestiarion to slow down. Nothing was booked. Approve it again in a minute.`;
      await fail(deps, claimed, "rate_limited", message);
      return { postingId: posting.id, outcome: "failed", message };
    }
    if (failure === "unauthorized" || failure === "forbidden") {
      const message = `${label} refused Vestiarion's access. Reconnect ${label} from Settings, then approve it again.`;
      await fail(deps, claimed, "reconnect", message);
      return { postingId: posting.id, outcome: "failed", message };
    }
    // 6. No answer, or one that does not read: the payment may be there. Read back before anything else.
    let found: ExternalPayment | null = null;
    try {
      found = await deps.booking.findPayment({ ...org, billId: posting.billExternalId, reference: posting.reference });
    } catch {
      found = null;
    }
    if (found && found.status === "active") {
      const sent = await markSent(deps, claimed, found, true, iso(now()));
      return sent ? readBack(deps, accessToken, sent, { goneMeansDeleted: false }) : { postingId: posting.id, outcome: "busy", message: STALE };
    }
    const message = `${label} did not answer, and no payment with this reference is there. Approve it again to try once more: Vestiarion looks for it first.`;
    await fail(deps, claimed, "no_answer", message);
    return { postingId: posting.id, outcome: "failed", message };
  }
  if (!booked.ok) {
    const message = `${label} refused the payment: ${booked.message.replace(/\.$/, "")}.`;
    await fail(deps, claimed, "refused_by_provider", message);
    return { postingId: posting.id, outcome: "failed", message };
  }
  const sent = await markSent(deps, claimed, booked.payment, false, iso(now()));
  return sent ? readBack(deps, accessToken, sent, { goneMeansDeleted: false }) : { postingId: posting.id, outcome: "sent", paymentId: booked.payment.externalId, message: `Sent to ${label}.` };
}

function unavailableWords(error: unknown, label: string): string {
  if (error instanceof ProviderError && error.failure === "rate_limited") return `${label} asked Vestiarion to slow down. Nothing was booked. Approve it again in a minute.`;
  if (error instanceof ProviderError && (error.failure === "unauthorized" || error.failure === "forbidden")) return `${label} refused Vestiarion's access. Reconnect ${label} from Settings.`;
  return NO_ANSWER(label);
}

/**
 * The read-back a sync's run makes (W3, W7): a booking sent is confirmed, or refused once the provider has deleted it;
 * a booking whose send stopped past its lease is looked for by its reference, taken when it is there, and failed when it
 * is not, so the next approval tries once more. Never books anything.
 */
export async function confirmInFlight(deps: BookingDeps & { accessToken: () => Promise<string | null> }): Promise<{ confirmed: number; checked: number }> {
  const now = deps.now ?? Date.now;
  const rows = await deps.store.inFlight(deps.connection.id, iso(now()));
  const result = { confirmed: 0, checked: 0 };
  if (rows.length === 0) return result;
  const token = await deps.accessToken();
  if (!token) return result;
  const org = { accessToken: token, externalOrgId: deps.connection.externalOrgId };
  for (const row of rows) {
    result.checked += 1;
    if (row.state === "sent" && row.externalPaymentId && row.account) {
      const outcome = await readBack(deps, token, row, { goneMeansDeleted: true });
      if (outcome.outcome === "booked") result.confirmed += 1;
      continue;
    }
    if (row.state !== "sending") continue;
    let found: ExternalPayment | null;
    try {
      found = await deps.booking.findPayment({ ...org, billId: row.billExternalId, reference: row.reference });
    } catch {
      continue;
    }
    if (found?.status === "deleted") {
      await refuse(deps, row, ["sending"], "deleted_in_provider", `A payment with this reference was deleted in ${deps.label}. Vestiarion does not book it again; book it by hand if it belongs there.`);
    } else if (found) {
      const sent = await markSent(deps, row, found, true, iso(now()));
      if (sent && (await readBack(deps, token, sent, { goneMeansDeleted: false })).outcome === "booked") result.confirmed += 1;
    } else {
      await fail(deps, row, "no_answer", `The send stopped before ${deps.label} answered, and no payment with this reference is there. Approve it again to try once more.`);
    }
  }
  return result;
}
