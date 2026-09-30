import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { getChainProvider } from "../circle";
import { confirmCounterpartyAddress, sameAddress } from "../counterparty-address";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { isTerminalFailure } from "../payments";
import { payInvoice, syncOperatingBalance } from "./pay";
import { invoiceDiscount, type InvoiceDiscount } from "./payment-timing";

/**
 * The approvals library (spec §6): lets a person pay, reject or return a
 * payable the agent held for review. Every export here runs inside an
 * organization scope.
 *
 * The decision itself is claimed through `claim_invoice_decision` (migration
 * 0025) before anything else changes — a compare-and-set in the database, so
 * two people racing the same invoice cannot both act on it, and a person
 * cannot approve an invoice they created themselves. Everything checked
 * before that claim (self-approval, high risk, funds) is a refusal that
 * never sends the claim at all, so a rejected attempt never even contends
 * for the row.
 *
 * A claim that never finished — the request died, or the update after it
 * failed — leaves the invoice `processing`. The claim lets anyone retake it
 * once `reviewed_at` is 10 minutes old (or missing), and
 * `listWaitingPayables` marks such a row `reclaimable` so the inbox offers
 * the decisions again rather than leaving it stuck. A failed update after a
 * claim is logged by invoice id, since on the approve path the transfer may
 * already have moved.
 *
 * An invoice whose payment was already sent — a crash after a confirmed
 * transfer, or a held row with a live transfer behind it — can only be
 * approved: Approve and pay records it (the payment's idempotency key
 * reconciles, it never pays twice), while Reject and Return are refused with
 * `payment_in_flight` before any claim, since either would record a real
 * transfer as something that did not happen.
 *
 * A payment Circle ended in a terminal failure (`CANCELLED`, `DENIED`,
 * `FAILED`) moved nothing: Reject and Return are allowed, and Approve and pay
 * sends it again — `retryTerminalFailure`, which reads Circle first and opens
 * a new attempt only on a terminal state — after every check a first payment
 * gets, the balance included. It does so only for a failure already recorded
 * when the approval began; an approval that finds a sent transfer has failed
 * records that, and leaves the new transfer to the next approval.
 *
 * The ledger entry written after a decision commits is best effort, through
 * `appendLedgerEntryBestEffort` as `src/lib/platform/members.ts` uses it: the
 * decision has already happened and must be reported as done even if the
 * entry fails to append.
 */

export type ApprovalErrorCode =
  | "invoice_not_found"
  | "already_decided"
  | "self_approval"
  | "high_risk"
  | "insufficient_funds"
  | "no_operating_account"
  | "payment_in_flight"
  | "address_changed";

/** Every message except `insufficient_funds`, whose text names the actual balance. */
const MESSAGES: Record<Exclude<ApprovalErrorCode, "insufficient_funds">, string> = {
  already_decided: "Someone else decided this invoice a moment ago.",
  self_approval: "You created this invoice, so someone else must approve it.",
  high_risk: "This counterparty is screened high risk. Clear it in Compliance first.",
  no_operating_account: "This workspace has no operating account.",
  invoice_not_found: "That invoice is not waiting for a decision.",
  payment_in_flight: "A payment for this invoice was already sent. Approve and pay records it.",
  address_changed: "This counterparty's address changed after this page loaded. Check the new address and try again.",
};

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

function raise(code: Exclude<ApprovalErrorCode, "insufficient_funds">): never {
  throw new ApprovalError(code, MESSAGES[code]);
}

/**
 * `claim_invoice_decision` raises `invalid_decision`, `invoice_not_found`,
 * `self_approval` or `already_decided` as `"<code>: <detail>"` (the 0021
 * pattern `memberErrorFrom` also reads). Only the three this library can
 * actually meet are mapped; `invalid_decision` never fires here since the
 * decision is always one of this module's own literals, and anything else
 * (a connection error) is rethrown as-is rather than misreported as one of
 * these codes.
 */
function raiseFromClaim(error: { message: string }): never {
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  if (code === "already_decided" || code === "self_approval" || code === "invoice_not_found") {
    throw new ApprovalError(code, MESSAGES[code]);
  }
  throw new Error(error.message);
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/** Trimmed, capped at 280 characters, and `undefined` once empty — never an empty string in the ledger. */
function trimReason(reason: string | undefined): string | undefined {
  const trimmed = (reason ?? "").trim().slice(0, 280);
  return trimmed.length > 0 ? trimmed : undefined;
}

const WAITING_STATUSES = ["held", "flagged", "awaiting_info", "processing"] as const;

/** How long a claim holds before anyone may retake it — `claim_invoice_decision`'s interval (migration 0025). */
export const RECLAIM_AFTER_MS = 10 * 60 * 1000;

/**
 * Whether `claim_invoice_decision` would let a new decision retake this row:
 * a `processing` claim whose `reviewed_at` is over 10 minutes old, or missing.
 */
function isReclaimable(status: string, reviewedAt: string | null, now: number): boolean {
  if (status !== "processing") return false;
  if (reviewedAt === null) return true;
  const claimedAt = Date.parse(reviewedAt);
  return Number.isNaN(claimedAt) || claimedAt < now - RECLAIM_AFTER_MS;
}

/** The columns of an invoice's payment intent (`payment_intents`, see `src/lib/payments.ts`) these rules read. */
interface IntentState {
  status: string;
  provider_tx_id: string | null;
  last_error: string | null;
  /** Circle's `state` for the current attempt's transfer, as last read; null before migration 0036 or any read since. */
  provider_state: string | null;
  /** Circle's `errorReason`; read only by the listing. */
  failure_reason?: string | null;
}

/**
 * Whether Circle ended the intent's current attempt without moving money: it
 * is `failed`, has a provider id, and Circle's recorded state is `CANCELLED`,
 * `DENIED` or `FAILED` — `begin_payment_retry`'s own condition (0036).
 */
function failedTerminally(intent: IntentState): boolean {
  return intent.status === "failed" && intent.provider_tx_id !== null && isTerminalFailure(intent.provider_state);
}

/**
 * Whether a payment for the invoice may already have moved, so that
 * rejecting or returning it would misrecord a real transfer. It has, unless:
 * - there is no intent;
 * - no transfer exists for its current attempt — no provider id, and the
 *   intent is `created` or `failed` (a submission that failed before Circle
 *   returned an id). One `submitting` may reach Circle any moment, and one
 *   `pending` or `confirmed` did;
 * - or Circle ended that transfer in a terminal failure state.
 * Anything else with a provider id counts as sent: Circle's `STUCK` (sent,
 * and it can still be mined), `SENT`, `QUEUED`, `INITIATED`, `CLEARED`,
 * `CONFIRMED`; a read of ours that failed; and a `failed` intent with no
 * recorded state, since before migration 0036 a `STUCK` transfer was
 * recorded `failed` (R1).
 */
function paymentWasSent(intent: IntentState | null): boolean {
  if (!intent) return false;
  if (intent.status === "confirmed" || intent.status === "pending" || intent.status === "submitting") return true;
  if (intent.provider_tx_id === null) return false;
  return !failedTerminally(intent);
}

/**
 * Whether `executePayment` would reconcile a transfer that may already have
 * moved rather than send one: a confirmed intent, or a provider id whose
 * attempt Circle did not end in a terminal failure. A terminally failed one
 * is sent again on approval, so it is a new payment and the balance is
 * checked for it.
 */
function transferExists(intent: IntentState | null): boolean {
  if (intent === null) return false;
  return intent.status === "confirmed" || (intent.provider_tx_id !== null && !failedTerminally(intent));
}

/** What the approval card says about the last payment attempt (see `WaitingPayable.lastAttempt`). */
export type LastPaymentAttempt = { state: "failed"; reason: string } | { state: "in_flight" } | null;

/**
 * Circle's own failure codes, in plain words, for the reasons a person is
 * most likely to hit and be able to act on. Any other code stays exactly as
 * Circle sent it — better an unfamiliar code than a made-up explanation.
 */
const REASON_IN_PLAIN_WORDS: Record<string, string> = {
  INSUFFICIENT_NATIVE_TOKEN: "the operating wallet does not hold enough USDC for the network fee (Circle: INSUFFICIENT_NATIVE_TOKEN)",
  INSUFFICIENT_TOKEN: "the operating wallet does not hold enough USDC (Circle: INSUFFICIENT_TOKEN)",
  FAILED_ON_CHAIN: "the transfer failed on chain (Circle: FAILED_ON_CHAIN)",
};

/**
 * The last attempt as the card reports it: failed terminally, with Circle's
 * reason in plain words when it is one of the common ones, Circle's own code
 * otherwise, or its state when it gave no reason at all; or in flight, when
 * the transfer is `pending` or Circle's last recorded state for it is one
 * that can still move money (`STUCK`, `SENT` and the rest) — a read of ours
 * that failed since does not change what Circle last said. Anything else is
 * null: no transfer, a confirmed one (Approve and pay records it), or a
 * `failed` intent from before Circle's state was kept, which Approve and pay
 * reads from Circle.
 */
function lastAttemptOf(intent: IntentState | null): LastPaymentAttempt {
  if (!intent || intent.provider_tx_id === null || intent.status === "confirmed") return null;
  if (failedTerminally(intent)) {
    const reason = intent.failure_reason;
    return {
      state: "failed",
      reason: reason ? (REASON_IN_PLAIN_WORDS[reason] ?? reason) : `Circle reported ${intent.provider_state}`,
    };
  }
  return intent.status === "pending" || intent.provider_state !== null ? { state: "in_flight" } : null;
}

/** The invoice's payment intent, keyed as `executePayment` keys it (source type and id), or null. */
async function paymentIntentOf(invoiceId: string): Promise<IntentState | null> {
  const result = await db()
    .from("payment_intents")
    .select("status, provider_tx_id, last_error, provider_state")
    .eq("source_type", "invoice")
    .eq("source_id", invoiceId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return (result.data as IntentState | null) ?? null;
}

/** Reject and Return refuse, before any claim, an invoice whose payment was already sent. */
async function refuseIfPaymentSent(invoiceId: string): Promise<void> {
  if (paymentWasSent(await paymentIntentOf(invoiceId))) raise("payment_in_flight");
}

/** Logs a failed write after a claim went through, by invoice id: the row is left `processing` until it is reclaimed. */
function logAfterClaim(invoiceId: string, what: string): void {
  console.error("approval: invoice update failed after the claim", invoiceId, what);
}

export interface WaitingPayable {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  riskLevel: string;
  amount: number;
  dueDate: string;
  status: "held" | "flagged" | "awaiting_info" | "processing";
  reasoning: string | null;
  decidedAt: string | null;
  createdBy: string | null;
  reviewedAt: string | null;
  /** A `processing` row whose claim did not finish and may be decided again; false for every other status. */
  reclaimable: boolean;
  /** A payment was already sent: only Approve and pay may record it, Reject and Return are refused. */
  paymentSent: boolean;
  /** Where Approve and pay sends the money: the counterparty's address now, or null when it has none. */
  address: string | null;
  /** The last payment attempt, when Circle ended it in a terminal failure (Approve and pay sends a new transfer) or it is still in flight; else null. */
  lastAttempt: LastPaymentAttempt;
}

/** Every payable currently waiting for a person's decision — held, flagged, awaiting more information, or claimed by someone else right now. */
export async function listWaitingPayables(): Promise<WaitingPayable[]> {
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, due_date, status, agent_reasoning, decided_at, created_by, reviewed_at, counterparty_id, counterparties(name, risk_level, address)")
      .eq("direction", "payable")
      .in("status", WAITING_STATUSES)
      .order("due_date", { ascending: true })
  ) as unknown as Array<{
    id: string;
    amount: string;
    due_date: string;
    status: WaitingPayable["status"];
    agent_reasoning: string | null;
    decided_at: string | null;
    created_by: string | null;
    reviewed_at: string | null;
    counterparty_id: string;
    counterparties: { name: string; risk_level: string; address: string | null } | null;
  }>;

  const intents = new Map<string, IntentState>();
  if (rows.length > 0) {
    const found = unwrap(
      await db()
        .from("payment_intents")
        .select("source_id, status, provider_tx_id, last_error, provider_state, failure_reason")
        .eq("source_type", "invoice")
        .in("source_id", rows.map((row) => row.id))
    ) as Array<IntentState & { source_id: string }>;
    for (const intent of found) intents.set(intent.source_id, intent);
  }

  const now = Date.now();
  return rows.map((row) => {
    const intent = intents.get(row.id) ?? null;
    return {
      id: row.id,
      counterpartyId: row.counterparty_id,
      counterpartyName: row.counterparties?.name ?? "unknown",
      riskLevel: row.counterparties?.risk_level ?? "unknown",
      amount: num(row.amount),
      dueDate: row.due_date,
      status: row.status,
      reasoning: row.agent_reasoning,
      decidedAt: row.decided_at,
      createdBy: row.created_by,
      reviewedAt: row.reviewed_at,
      reclaimable: isReclaimable(row.status, row.reviewed_at, now),
      paymentSent: paymentWasSent(intent),
      address: row.counterparties?.address ?? null,
      lastAttempt: lastAttemptOf(intent),
    };
  });
}

interface LoadedInvoice {
  id: string;
  amount: number;
  status: string;
  agentReasoning: string | null;
  createdBy: string | null;
  counterpartyId: string;
  counterpartyName: string;
  riskLevel: string | null;
  address: string | null;
  /** The invoice's early-payment discount, applied by `payInvoice` exactly as for the agent. */
  discount: InvoiceDiscount | null;
}

async function loadWaitingPayable(invoiceId: string): Promise<LoadedInvoice> {
  const result = await db()
    .from("invoices")
    .select(
      "id, amount, status, direction, agent_reasoning, created_by, counterparty_id, early_pay_discount_pct, discount_due_date, counterparties(name, risk_level, address)"
    )
    .eq("id", invoiceId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);

  const row = result.data as {
    id: string;
    amount: string;
    status: string;
    direction: string;
    agent_reasoning: string | null;
    created_by: string | null;
    counterparty_id: string;
    early_pay_discount_pct: string | number | null;
    discount_due_date: string | null;
    counterparties: { name: string; risk_level: string; address: string | null } | null;
  } | null;

  if (!row || row.direction !== "payable" || !(WAITING_STATUSES as readonly string[]).includes(row.status)) {
    raise("invoice_not_found");
  }

  return {
    id: row.id,
    amount: num(row.amount),
    status: row.status,
    agentReasoning: row.agent_reasoning,
    createdBy: row.created_by,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparties?.name ?? "unknown",
    riskLevel: row.counterparties?.risk_level ?? null,
    address: row.counterparties?.address ?? null,
    discount: invoiceDiscount(row),
  };
}

/** The operating account, or `null` when the workspace has none configured yet. */
async function operatingAccount(): Promise<{ id: string; balance: number } | null> {
  const result = await db().from("accounts").select("id, balance").eq("kind", "operating").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { id: string; balance: string } | null;
  return row ? { id: row.id, balance: num(row.balance) } : null;
}

/**
 * The `approval_paid` entry's summary, which says what actually happened to
 * the transfer — and, when an early-payment discount came off it, how much
 * left against the invoice's amount.
 */
function approvalPaidSummary(
  status: "paid" | "matched" | "held",
  amount: number,
  name: string,
  payment: { amountPaid: number; discountTaken: number }
): string {
  const discounted = payment.discountTaken > 0;
  const sent = discounted ? payment.amountPaid : amount;
  const less = discounted ? ` (${amount} USDC less a ${payment.discountTaken} USDC early-payment discount)` : "";
  if (status === "paid") return `Approved and paid ${sent} USDC to ${name}${less}`;
  if (status === "matched") return `Approved; payment of ${sent} USDC to ${name} submitted${less}`;
  return `Approved; payment of ${sent} USDC to ${name} failed${less}`;
}

/**
 * `shownAddress` is the counterparty address the approval card showed the
 * person. When given, the approval is refused if it is no longer the
 * counterparty's, and a changed address no one had confirmed is confirmed by
 * this approval (spec 2026-09-30-counterparty-address-edit E4): the person
 * approved a payment to it, having seen it.
 */
export async function approveAndPay(
  input: { actorId: string; invoiceId: string; shownAddress?: string }
): Promise<{ status: "paid" | "matched" | "held"; txRef: string | null; note: string }> {
  const orgId = currentOrgId();
  const invoice = await loadWaitingPayable(input.invoiceId);

  // Early refusals, before any claim — none of these contend for the row.
  if (invoice.createdBy === input.actorId) raise("self_approval");
  if (invoice.riskLevel === "high") raise("high_risk");
  const shownAddress = input.shownAddress?.trim();
  if (shownAddress !== undefined && !sameAddress(invoice.address, shownAddress === "" ? null : shownAddress)) {
    raise("address_changed");
  }

  const operating = await operatingAccount();
  if (!operating) raise("no_operating_account");

  // A transfer that already exists is reconciled, never sent again, so the
  // balance — already lower by this very payment — is not the question. One
  // Circle ended in a terminal failure moved nothing and is sent again, so it
  // is checked like any new payment.
  const provider = getChainProvider();
  const alreadySent = transferExists(await paymentIntentOf(invoice.id));
  if (!alreadySent) {
    const balance = provider.mode === "live" ? await syncOperatingBalance(operating.id) : operating.balance;
    if (balance < invoice.amount) {
      throw new ApprovalError("insufficient_funds", `The operating account holds ${balance} USDC, less than this invoice.`);
    }
  }

  const claim = await db()
    .rpc("claim_invoice_decision", { p_invoice_id: invoice.id, p_by: input.actorId, p_decision: "approve" })
    .single();
  if (claim.error) raiseFromClaim(claim.error);

  // A transfer already sent went wherever it went; recording it confirms nothing
  // about the address the counterparty has now. A new payment, a retry
  // included, is sent to that address.
  if (shownAddress !== undefined && !alreadySent) {
    // Best effort: the decision is claimed, and a confirmation that did not
    // land only means the agent holds the next payment to this address too.
    try {
      await confirmCounterpartyAddress({ actorId: input.actorId, counterpartyId: invoice.counterpartyId, shownAddress, via: "approval" });
    } catch (error) {
      console.error("approval: counterparty address not confirmed", invoice.id, (error as Error).message);
    }
  }

  const previous = invoice.status;

  let result;
  try {
    result = await payInvoice(
      {
        invoiceId: invoice.id,
        counterpartyId: invoice.counterpartyId,
        address: invoice.address,
        amount: invoice.amount,
        // The same discount rule as the agent's: off the transfer through the
        // deadline's UTC day. The funds check above stays on the full amount.
        discount: invoice.discount,
      },
      // A person's approval is the one caller that may send a payment Circle
      // ended in a terminal failure again, and only when the failure was
      // already recorded (`!alreadySent`): that is the approval that ran the
      // balance check and the address confirmation above, with the card
      // showing Circle's reason. An approval of a transfer that was still
      // sent or in flight skipped both, so it only reconciles — should Circle
      // now report a terminal failure, that is recorded, the invoice is held
      // again, and the next approval sends it. executePayment still reads
      // Circle before any retry.
      { provider, operating: { id: operating.id }, retryTerminalFailure: !alreadySent }
    );
  } catch (err) {
    // The claim went through, but nothing about the payment itself is known.
    // Give the invoice back to the waiting queue rather than leave it stuck
    // as `processing` — the payment's own idempotency key (keyed on the
    // invoice) protects a retry from paying twice.
    try {
      const rollback = await db()
        .from("invoices")
        .update({
          status: "held",
          agent_reasoning: `${invoice.agentReasoning ?? ""} [approval interrupted: ${(err as Error).message}]`,
        })
        .eq("id", invoice.id);
      if (rollback.error) console.error("approval: rollback to held failed after the claim", invoice.id, rollback.error.message);
    } catch (rollbackError) {
      console.error("approval: rollback to held failed after the claim", invoice.id, (rollbackError as Error).message);
    }
    throw err;
  }

  // A transfer that went out (confirmed, or submitted and awaiting Circle)
  // carried `amountPaid`; one that failed moved nothing.
  const sent = result.status === "paid" || result.status === "matched";
  const now = new Date().toISOString();
  const update = await db()
    .from("invoices")
    .update({
      status: result.status,
      agent_reasoning: `${invoice.agentReasoning ?? ""} [approved and paid by a person]${result.note}`,
      decided_at: now,
      settled_at: result.status === "paid" ? now : null,
      tx_ref: result.txRef,
      // Written with the transfer that carried it, so the cycle that later
      // reconciles a submitted payment records it as is.
      paid_amount: sent ? result.amountPaid : null,
    })
    .eq("id", invoice.id);
  if (update.error) {
    // The transfer may already have moved; this line is how to find the invoice.
    logAfterClaim(invoice.id, result.status);
    throw new Error(update.error.message);
  }

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "approval_paid",
    summary: approvalPaidSummary(result.status, invoice.amount, invoice.counterpartyName, result),
    detail: {
      by: input.actorId,
      invoiceId: invoice.id,
      counterpartyId: invoice.counterpartyId,
      amount: invoice.amount,
      // What the transfer carried and what the discount took off it; null
      // when nothing went out.
      amountPaid: sent ? result.amountPaid : null,
      discountTaken: sent ? result.discountTaken : null,
      overrode: previous,
      txRef: result.txRef,
      status: result.status,
      // Which transfer attempt this approval ended on, and on a retry the
      // attempt Circle failed before it: ids and states only.
      ...(result.execution ? { attempt: result.execution.attempt } : {}),
      ...(result.execution?.retriedAfter ? { retriedAfter: result.execution.retriedAfter } : {}),
    },
  });

  return { status: result.status, txRef: result.txRef, note: result.note };
}

export async function rejectInvoice(input: { actorId: string; invoiceId: string; reason?: string }): Promise<void> {
  const orgId = currentOrgId();
  await refuseIfPaymentSent(input.invoiceId);
  const claim = await db()
    .rpc("claim_invoice_decision", { p_invoice_id: input.invoiceId, p_by: input.actorId, p_decision: "reject" })
    .single();
  if (claim.error) raiseFromClaim(claim.error);

  const update = await db()
    .from("invoices")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", input.invoiceId);
  if (update.error) {
    logAfterClaim(input.invoiceId, "reject");
    throw new Error(update.error.message);
  }

  const reason = trimReason(input.reason);
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "approval_rejected",
    summary: "An invoice was rejected",
    detail: reason === undefined ? { by: input.actorId, invoiceId: input.invoiceId } : { by: input.actorId, invoiceId: input.invoiceId, reason },
  });
}

export async function returnInvoice(input: { actorId: string; invoiceId: string }): Promise<void> {
  const orgId = currentOrgId();
  await refuseIfPaymentSent(input.invoiceId);
  const claim = await db()
    .rpc("claim_invoice_decision", { p_invoice_id: input.invoiceId, p_by: input.actorId, p_decision: "return" })
    .single();
  if (claim.error) raiseFromClaim(claim.error);

  const update = await db()
    .from("invoices")
    // notified_at is cleared too: a payable the agent re-holds after this is
    // news again, not silently excluded until the follow-up stage escalates it.
    .update({ status: "pending", decided_at: null, escalated_at: null, notified_at: null })
    .eq("id", input.invoiceId);
  if (update.error) {
    logAfterClaim(input.invoiceId, "return");
    throw new Error(update.error.message);
  }

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "approval_returned",
    summary: "An invoice was returned, undecided",
    detail: { by: input.actorId, invoiceId: input.invoiceId },
  });
}
