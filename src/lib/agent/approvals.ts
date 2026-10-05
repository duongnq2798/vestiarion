import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { getChainProvider, type Stablecoin } from "../circle";
import { confirmCounterpartyAddress, sameAddress } from "../counterparty-address";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { listLedgerEntriesForTargets } from "../ledger";
import { explainPayable, presentReasoning } from "../reasoning-copy";
import { isTerminalFailure, settleUnknownSend, type UnknownSendAnswer } from "../payments";
import { MAY_HAVE_BEEN_ACCEPTED } from "../circle/settlement";
import { PAYMENTS_OFF, paymentsDisabled } from "../payments-switch";
import { payInvoice, syncOperatingBalance } from "./pay";
import { invoiceDiscount, type InvoiceDiscount } from "./payment-timing";
import { paidAcrossChains, payeeChain } from "../payee-chains";
import { bridgeFee, type BridgeFee } from "../circle/cctp";
import { gatewayQuoter, type GatewayQuote } from "../circle/gateway-quote";
import { isSoleApprover } from "./sole-approver";
import { newPayeeCheck } from "../new-payee";
import { firstPaymentCheck, loadNewPayeeFacts } from "../new-payee-facts";
import { addedSince, latestDecision, recordedFacts, type AddedDetails } from "../added-details";
import { heldForCash } from "../next-step";
import type { Provenance } from "../provenance";
import { readTwoApprovalsAbove } from "../approval-policy";
import { needsTwoApprovals, type TwoApprovalsFacts } from "../two-approvals";
import {
  clearApprovals,
  giveApproval,
  markApprovalsUsed,
  mayGiveApproval,
  standingApprovals,
  twoApprovalsFacts,
  type GivenApproval,
  type PaymentSource,
} from "./second-approval";

export type { AddedDetails };

/**
 * The approvals library (spec §6): lets a person pay, reject or return a
 * payable the agent held for review, or add the purchase order or goods
 * receipt it was missing so that the agent decides it again
 * (`addInvoiceDetails`). Every export here runs inside an organization scope.
 *
 * The decision itself is claimed through `claim_invoice_decision` (migration
 * 0025) before anything else changes — a compare-and-set in the database, so
 * two people racing the same invoice cannot both act on it, and a person
 * cannot approve an invoice they created themselves — unless they are the
 * workspace's sole approver (migration 0061, `sole_approver`), when there is
 * nobody else to, and the ledger entry says so. Everything checked
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
 * Above the workspace's figure for two approvals (docs/superpowers/specs/2026-10-05-two-approvals-design.md T4–T6),
 * Approve and pay records a first approval and sends nothing; a second approval, by another person, pays. Reject and
 * Return clear the approvals given.
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
  | "new_payee_self"
  | "high_risk"
  | "insufficient_funds"
  | "no_operating_account"
  | "payment_in_flight"
  | "payment_unknown"
  | "payments_off"
  | "address_changed"
  | "bridge_unsupported_token"
  | "nothing_to_add"
  | "invoice_changed"
  | "already_approved";

/** Every message except `insufficient_funds`, whose text names the actual balance. */
const MESSAGES: Record<Exclude<ApprovalErrorCode, "insufficient_funds">, string> = {
  already_decided: "Someone else decided this invoice a moment ago.",
  self_approval: "You created this invoice, so someone else must approve it.",
  new_payee_self: "You gave this payee's address, so someone else must approve its first payment.",
  high_risk: "This counterparty is screened high risk. Clear it in Compliance first.",
  no_operating_account: "This workspace has no operating account.",
  invoice_not_found: "That invoice is not waiting for a decision.",
  payment_in_flight: "A payment for this invoice was already sent. Approve and pay records it.",
  payments_off: PAYMENTS_OFF,
  payment_unknown:
    "Circle did not answer when this invoice's payment was sent, and Vestiarion cannot tell yet whether Circle took it. Approve and pay looks for it first and sends nothing twice; until it is known, it cannot be closed.",
  address_changed: "This counterparty's address changed after this page loaded. Check the new address and try again.",
  bridge_unsupported_token: "Only USDC crosses chains. This invoice is in EURC, and its payee is paid on another chain.",
  nothing_to_add: "Enter a PO reference or tick Goods or services received.",
  invoice_changed: "This invoice changed a moment ago. Reload the page to see it.",
  already_approved: "You approved this already. Another person who can approve payments must approve it to pay.",
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

/**
 * The columns of a payment intent (`payment_intents`, see `src/lib/payments.ts`) these rules read. A held
 * milestone's decision reads them by the same rules (src/lib/agent/milestone-decisions.ts).
 */
export interface IntentState {
  status: string;
  provider_tx_id: string | null;
  last_error: string | null;
  /** Circle's `state` for the current attempt's transfer, as last read; null before migration 0036 or any read since. */
  provider_state: string | null;
  /** Circle's `errorReason`; read only by the listing. */
  failure_reason?: string | null;
  /** The route a payment across chains took on its first attempt (Gateway payouts G2); read only by the approval. */
  payout_route?: string | null;
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
 * Whether the intent's current attempt was sent to Circle and Circle never said what became of it (payment safety R1):
 * `failed`, no provider id, and an error in the provider's words for that — the deadline ran out, the connection
 * dropped after the request left, Circle answered 5xx or with no id. Circle may hold the transfer under the attempt's
 * key. Sending it again under that key returns it rather than repeats it, so Approve and pay settles the question;
 * until then nothing closes over it.
 */
export function transferUnknown(intent: IntentState | null): boolean {
  return intent !== null && intent.status === "failed" && intent.provider_tx_id === null && (intent.last_error?.includes(MAY_HAVE_BEEN_ACCEPTED) ?? false);
}

/**
 * Whether a payment for the invoice may already have moved, so that
 * rejecting or returning it would misrecord a real transfer. It has, unless:
 * - there is no intent;
 * - no transfer exists for its current attempt — no provider id, and the
 *   intent is `created` or `failed` (a submission that failed before Circle
 *   returned an id), unless Circle never answered the send (`transferUnknown`).
 *   One `submitting` may reach Circle any moment, and one `pending` or
 *   `confirmed` did;
 * - or Circle ended that transfer in a terminal failure state.
 * Anything else with a provider id counts as sent: Circle's `STUCK` (sent,
 * and it can still be mined), `SENT`, `QUEUED`, `INITIATED`, `CLEARED`,
 * `CONFIRMED`; a read of ours that failed; and a `failed` intent with no
 * recorded state, since before migration 0036 a `STUCK` transfer was
 * recorded `failed` (R1).
 */
export function paymentWasSent(intent: IntentState | null): boolean {
  if (!intent) return false;
  if (intent.status === "confirmed" || intent.status === "pending" || intent.status === "submitting") return true;
  if (intent.provider_tx_id === null) return transferUnknown(intent);
  return !failedTerminally(intent) && !gatewayFailed(intent);
}

/**
 * Whether Gateway reported the intent's transfer `failed` (recorded `GATEWAY_FAILED`): its
 * attestation may still be minted, so approving reads it again and sends nothing, but a person
 * who has checked with Circle may reject or return the invoice (Gateway review I2).
 */
function gatewayFailed(intent: IntentState): boolean {
  return intent.status === "failed" && intent.provider_tx_id?.startsWith("gateway:") === true && intent.provider_state === "GATEWAY_FAILED";
}

/**
 * Whether `executePayment` would reconcile a transfer that may already have
 * moved rather than send one: a confirmed intent, or a provider id whose
 * attempt Circle did not end in a terminal failure. A terminally failed one
 * is sent again on approval, so it is a new payment and the balance is
 * checked for it. One Circle never answered (`transferUnknown`) is not a
 * transfer that exists: sent again under its key, it is a new payment when
 * Circle never had it, so it is checked as one, all but the balance, which
 * the transfer Circle may hold could already have lowered (payment safety R3).
 */
export function transferExists(intent: IntentState | null): boolean {
  if (intent === null) return false;
  return intent.status === "confirmed" || (intent.provider_tx_id !== null && !failedTerminally(intent));
}

/** What the approval card says about the last payment attempt (see `WaitingPayable.lastAttempt`). */
export type LastPaymentAttempt =
  /** `resend: false`: approving reads the failed transfer again and sends nothing new (a Gateway transfer that failed). */
  | { state: "failed"; reason: string; resend?: false }
  | { state: "in_flight" }
  /** Circle never answered the send (`transferUnknown`): it may hold the transfer, and approving asks it again under the same key. */
  | { state: "unanswered" }
  | null;

/**
 * Circle's own failure codes, in plain words, for the reasons a person is
 * most likely to hit and be able to act on. Any other code stays exactly as
 * Circle sent it — better an unfamiliar code than a made-up explanation.
 */
const REASON_IN_PLAIN_WORDS: Record<string, string> = {
  INSUFFICIENT_NATIVE_TOKEN: "the operating wallet does not hold enough USDC for the network fee (Circle: INSUFFICIENT_NATIVE_TOKEN)",
  // The invoice's own token: a EURC payment fails for want of EURC.
  INSUFFICIENT_TOKEN: "the operating wallet does not hold enough {token} (Circle: INSUFFICIENT_TOKEN)",
  FAILED_ON_CHAIN: "the transfer failed on chain (Circle: FAILED_ON_CHAIN)",
  ESTIMATION_ERROR: "Circle could not prepare the transaction (Circle: ESTIMATION_ERROR)",
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
export function lastAttemptOf(intent: IntentState | null, token: Stablecoin = "USDC"): LastPaymentAttempt {
  if (transferUnknown(intent)) return { state: "unanswered" };
  if (!intent || intent.provider_tx_id === null || intent.status === "confirmed") return null;
  if (gatewayFailed(intent)) {
    return { state: "failed", reason: intent.failure_reason ? `Gateway could not mint it (${intent.failure_reason})` : "Gateway could not mint it", resend: false };
  }
  if (failedTerminally(intent)) {
    const reason = intent.failure_reason;
    return {
      state: "failed",
      reason: reason ? (REASON_IN_PLAIN_WORDS[reason]?.replace("{token}", token) ?? reason) : `Circle reported ${intent.provider_state}`,
    };
  }
  return intent.status === "pending" || intent.provider_state !== null ? { state: "in_flight" } : null;
}

/** The invoice's payment intent, keyed as `executePayment` keys it (source type and id), or null. */
async function paymentIntentOf(invoiceId: string): Promise<IntentState | null> {
  const result = await db()
    .from("payment_intents")
    .select("status, provider_tx_id, last_error, provider_state, payout_route")
    .eq("source_type", "invoice")
    .eq("source_id", invoiceId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return (result.data as IntentState | null) ?? null;
}

/**
 * Reject and Return refuse, before any claim, an invoice whose payment was already sent (payment safety R1). One whose
 * send Circle never answered is looked for first, sending nothing (R6): found, it was sent; never taken, the bill may be
 * closed; still being listed, they refuse, saying when to try again.
 */
async function refuseIfPaymentSent(invoiceId: string): Promise<void> {
  let intent = await paymentIntentOf(invoiceId);
  if (transferUnknown(intent)) {
    const looked = await lookForUnknownSend("invoice", invoiceId);
    if (looked.answer === "undecided") throw new ApprovalError("payment_unknown", unknownSendMessage("invoice", looked.retryAt));
    intent = await paymentIntentOf(invoiceId);
  }
  if (paymentWasSent(intent)) raise("payment_in_flight");
}

/** Looks for a source's unknown send on Circle from the operating wallet, sending nothing (R6). */
export async function lookForUnknownSend(type: "invoice" | "milestone", id: string): Promise<UnknownSendAnswer> {
  const operating = await operatingAccount();
  if (!operating) return { answer: "undecided", retryAt: null };
  return settleUnknownSend({ type, id }, { provider: getChainProvider(), fromAccountId: operating.id });
}

/** Why a bill whose send Circle never answered cannot be closed yet (R6), with when to try again when that is known. */
export function unknownSendMessage(what: "invoice" | "milestone", retryAt: string | null): string {
  const sent = `Circle did not answer when this ${what}'s payment was sent`;
  return retryAt
    ? `${sent}, and has not listed it yet. Try again from ${retryAt.slice(11, 16)} UTC: by then Vestiarion can tell whether Circle took it.`
    : `${sent}, and Vestiarion cannot tell yet whether Circle took it. Approve and pay looks for it first and sends nothing twice; until it is known, it cannot be closed.`;
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
  /** The reasoning as a person reads it: plain sentences, never field names (src/lib/reasoning-copy.ts). */
  explanation: string;
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
  /** The invoice's early-payment discount, read as `payInvoice` applies it, so the approval dialog can say what will leave; null without one. */
  discount: InvoiceDiscount | null;
  /** What the invoice is in, and what Approve and pay sends: USDC or EURC (EURC invoices design E4). */
  currency: Stablecoin;
  /** The chain the payee is paid on (CCTP payouts X1): ARC-TESTNET, or one paid through CCTP. */
  payeeChain: string;
  /** For a payee on another chain, the CCTP fee to it as read for this listing; null when not read or not needed (review I2). */
  bridgeFeeUsdc: number | null;
  /** The purchase order on the invoice now; null without one. */
  poReference: string | null;
  /** Whether the goods or services are marked received now. */
  goodsReceived: boolean;
  /**
   * What a person added since the agent's decision recorded its facts, which the agent's follow-up reopens the
   * payable on at its next cycle (complete held invoice R4, R6); null when nothing was.
   */
  addedSinceDecision: AddedDetails | null;
  /** The guardrail rule that refused the agent's payment, when code stopped it; null for a stop the model chose. */
  guardrailRule: string | null;
  /** Held because the cash it needs was not there, which the agent decides again once cash comes in (reserve cash back R4). */
  heldForCash?: boolean;
  /**
   * Present when paying it would be the first payment to its address, where payments are real: who gave the address, a
   * member's id, "payee", or null when not known (new payee check N4). That member may not approve it unless they
   * decide alone.
   */
  firstPaymentAddressBy?: string | null;
  /**
   * Above the workspace's figure for two approvals (two approvals T8): the figure, the approvals given that still count,
   * and whether whoever entered it, or gave its address, may give one. Absent when one approval pays it, or its transfer
   * was already sent.
   */
  twoApprovals?: TwoApprovalsFacts;
}


/** Every payable currently waiting for a person's decision — held, flagged, awaiting more information, or claimed by someone else right now. */
export async function listWaitingPayables(
  options: { bridgeFee?: (chain: string, amount: number) => Promise<BridgeFee> } = {}
): Promise<WaitingPayable[]> {
  const rows = unwrap(
    await db()
      .from("invoices")
      .select(
        "id, amount, currency, due_date, status, agent_reasoning, decided_at, created_by, reviewed_at, counterparty_id, early_pay_discount_pct, discount_due_date, po_reference, goods_received, counterparties(name, risk_level, address, chain)"
      )
      .eq("direction", "payable")
      .in("status", WAITING_STATUSES)
      .order("due_date", { ascending: true })
  ) as unknown as Array<{
    id: string;
    amount: string;
    currency?: string | null;
    due_date: string;
    status: WaitingPayable["status"];
    agent_reasoning: string | null;
    decided_at: string | null;
    created_by: string | null;
    reviewed_at: string | null;
    counterparty_id: string;
    early_pay_discount_pct?: string | number | null;
    discount_due_date?: string | null;
    po_reference?: string | null;
    goods_received?: boolean | null;
    counterparties: { name: string; risk_level: string; address: string | null; chain?: string | null } | null;
  }>;

  // The decision each was held on, with its facts: what its reasoning is explained from (plain reasoning R3).
  const entries = rows.length > 0 ? await listLedgerEntriesForTargets({ invoiceIds: rows.map((row) => row.id) }) : [];

  // The fee to a payee on another chain, read now, so the person approving
  // sees what leaves (CCTP payouts, review I2). One that cannot be read is null.
  const readFee = options.bridgeFee ?? ((chain: string, amount: number) => bridgeFee(chain, amount));
  const fees = new Map<string, number | null>();
  await Promise.all(
    rows
      .filter((row) => paidAcrossChains(row.counterparties?.chain) && currencyOf(row.currency) === "USDC")
      .map(async (row) => {
        try {
          fees.set(row.id, (await readFee(payeeChain(row.counterparties?.chain).id, num(row.amount))).feeUsdc);
        } catch {
          fees.set(row.id, null);
        }
      })
  );

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

  // Whose address a first payment would go to, where payments are real (new payee check N4): read once for the list.
  const newPayeeFacts =
    rows.length > 0 && getChainProvider().mode === "live" ? await loadNewPayeeFacts(db(), [...new Set(rows.map((row) => row.counterparty_id))]) : null;

  const newPayeeOf = (row: (typeof rows)[number]) =>
    newPayeeFacts
      ? newPayeeCheck({ address: row.counterparties?.address ?? null, paidTo: newPayeeFacts.paidTo, entries: newPayeeFacts.entries.get(row.counterparty_id) ?? [] })
      : null;

  // Above the workspace's figure: the approvals given, and whether those left out may give one (two approvals T8).
  const twoApprovals = await twoApprovalsFacts(
    "invoice",
    rows.map((row) => {
      const currency = currencyOf(row.currency);
      const usdcValue = latestDecision(entries, row.id)?.detail.usdcValue;
      const newPayee = newPayeeOf(row);
      return {
        id: row.id,
        payment: { amount: num(row.amount), currency, address: row.counterparties?.address ?? null },
        weighed: currency === "USDC" ? num(row.amount) : typeof usdcValue === "number" ? usdcValue : null,
        excluded: [row.created_by, newPayee?.firstPayment ? newPayee.addressBy : null],
        sent: transferExists(intents.get(row.id) ?? null),
      };
    })
  );

  const now = Date.now();
  return rows.map((row) => {
    const intent = intents.get(row.id) ?? null;
    const newPayee = newPayeeOf(row);
    const decision = latestDecision(entries, row.id);
    const onFile = { poReference: row.po_reference ?? null, goodsReceived: row.goods_received === true };
    // The decision is explained from the facts it recorded, not from details a person added since (R6).
    const recorded = recordedFacts(decision);
    return {
      id: row.id,
      counterpartyId: row.counterparty_id,
      counterpartyName: row.counterparties?.name ?? "unknown",
      riskLevel: row.counterparties?.risk_level ?? "unknown",
      amount: num(row.amount),
      dueDate: row.due_date,
      status: row.status,
      reasoning: row.agent_reasoning,
      explanation: presentReasoning(
        row.agent_reasoning,
        explainPayable({
          name: row.counterparties?.name ?? "The counterparty",
          amount: num(row.amount),
          currency: currencyOf(row.currency),
          dueDate: row.due_date,
          poReference: recorded.poReference !== undefined ? recorded.poReference : onFile.poReference,
          goodsReceived: recorded.goodsReceived ?? onFile.goodsReceived,
          entry: decision,
        })
      ),
      decidedAt: row.decided_at,
      createdBy: row.created_by,
      reviewedAt: row.reviewed_at,
      reclaimable: isReclaimable(row.status, row.reviewed_at, now),
      paymentSent: paymentWasSent(intent),
      address: row.counterparties?.address ?? null,
      lastAttempt: lastAttemptOf(intent, currencyOf(row.currency)),
      discount: invoiceDiscount(row),
      currency: currencyOf(row.currency),
      payeeChain: payeeChain(row.counterparties?.chain).id,
      bridgeFeeUsdc: fees.get(row.id) ?? null,
      poReference: onFile.poReference,
      goodsReceived: onFile.goodsReceived,
      addedSinceDecision: addedSince(recorded, onFile),
      guardrailRule: decision?.detail.guardrailBlocked === true && typeof decision.detail.guardrailRule === "string" ? decision.detail.guardrailRule : null,
      ...(row.status === "held" && heldForCash(decision?.detail) ? { heldForCash: true } : {}),
      ...(newPayee?.firstPayment ? { firstPaymentAddressBy: newPayee.addressBy } : {}),
      ...(twoApprovals.has(row.id) ? { twoApprovals: twoApprovals.get(row.id) } : {}),
    };
  });
}

/** An invoice's currency as read: EURC, or USDC for anything else, a row from before 0040 included. */
function currencyOf(value: string | null | undefined): Stablecoin {
  return value === "EURC" ? "EURC" : "USDC";
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
  currency: Stablecoin;
  /** The payee's chain: another than Arc testnet is paid through CCTP (CCTP payouts X2). */
  destinationChain: string | null;
  poReference: string | null;
  goodsReceived: boolean;
}

async function loadWaitingPayable(invoiceId: string): Promise<LoadedInvoice> {
  const result = await db()
    .from("invoices")
    .select(
      "id, amount, currency, status, direction, agent_reasoning, created_by, counterparty_id, early_pay_discount_pct, discount_due_date, po_reference, goods_received, counterparties(name, risk_level, address, chain)"
    )
    .eq("id", invoiceId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);

  const row = result.data as {
    id: string;
    amount: string;
    currency?: string | null;
    status: string;
    direction: string;
    agent_reasoning: string | null;
    created_by: string | null;
    counterparty_id: string;
    early_pay_discount_pct: string | number | null;
    discount_due_date: string | null;
    po_reference?: string | null;
    goods_received?: boolean | null;
    counterparties: { name: string; risk_level: string; address: string | null; chain?: string | null } | null;
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
    currency: currencyOf(row.currency),
    destinationChain: row.counterparties?.chain ?? null,
    poReference: row.po_reference ?? null,
    goodsReceived: row.goods_received === true,
  };
}

/**
 * Whether paying this invoice would be the first payment to its counterparty's address, and who gave the address, where
 * payments are real (new payee check N1, N2, N5); null otherwise.
 */
async function firstPaymentTo(invoice: Pick<LoadedInvoice, "counterpartyId" | "address">): Promise<ReturnType<typeof newPayeeCheck>> {
  return getChainProvider().mode === "live" ? firstPaymentCheck(db(), { id: invoice.counterpartyId, address: invoice.address }) : null;
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
  payment: { amountPaid: number; discountTaken: number },
  currency: Stablecoin = "USDC",
  soleApprover = false,
  secondOfTwo = false
): string {
  const discounted = payment.discountTaken > 0;
  const sent = discounted ? payment.amountPaid : amount;
  const less = discounted ? ` (${amount} ${currency} less a ${payment.discountTaken} ${currency} early-payment discount)` : "";
  const own = soleApprover ? ` ${SOLE_APPROVER_NOTE}` : secondOfTwo ? ` ${SECOND_OF_TWO_NOTE}` : "";
  if (status === "paid") return `Approved and paid ${sent} ${currency} to ${name}${less}${own}`;
  if (status === "matched") return `Approved; payment of ${sent} ${currency} to ${name} submitted${less}${own}`;
  return `Approved; payment of ${sent} ${currency} to ${name} failed${less}${own}`;
}

/** How a ledger summary marks an approval by the person who entered the record, as the workspace's only approver (sole approver R4). */
export const SOLE_APPROVER_NOTE = "(entered and approved by the workspace's only approver)";

/** How a ledger summary marks the approval that paid a payment two people approved (two approvals T7). */
export const SECOND_OF_TWO_NOTE = "(the second of two approvals)";

/** A EURC payable's USDC value as the agent last weighed it (its latest decision's `usdcValue`), null when it has none (two approvals T2). */
async function usdcValueOfLatestDecision(invoiceId: string): Promise<number | null> {
  const decision = latestDecision(await listLedgerEntriesForTargets({ invoiceIds: [invoiceId] }), invoiceId);
  const value = decision?.detail.usdcValue;
  return typeof value === "number" ? value : null;
}

/**
 * `shownAddress` is the counterparty address the approval card showed the
 * person. When given, the approval is refused if it is no longer the
 * counterparty's, and a changed address no one had confirmed is confirmed by
 * this approval (spec 2026-09-30-counterparty-address-edit E4): the person
 * approved a payment to it, having seen it.
 *
 * `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none.
 */
export async function approveAndPay(
  input: { actorId: string; invoiceId: string; shownAddress?: string; provenance?: Provenance },
  options: {
    bridgeFee?: (chain: string, amount: number) => Promise<BridgeFee>;
    gatewayQuote?: (chain: string, amount: number) => Promise<GatewayQuote | null>;
  } = {}
): Promise<{ status: "paid" | "matched" | "held" | "approved"; txRef: string | null; note: string }> {
  const orgId = currentOrgId();
  const invoice = await loadWaitingPayable(input.invoiceId);
  const intent = await paymentIntentOf(invoice.id);
  // A transfer that already exists is reconciled, never sent again.
  const alreadySent = transferExists(intent);
  const firstPayment = await firstPaymentTo(invoice);
  // Above the workspace's figure a payment needs two people's approval (two approvals T4); a transfer already sent is
  // only recorded, on one approval (T6).
  const above = alreadySent ? null : await readTwoApprovalsAbove(db());
  const usdcValue = above !== null && invoice.currency === "EURC" ? await usdcValueOfLatestDecision(invoice.id) : null;
  const twoNeeded = above !== null && needsTwoApprovals({ amount: invoice.amount, currency: invoice.currency, usdcValue }, above);
  // Whoever entered it, and whoever gave a first payment's address (new payee check N4).
  const excluded = [invoice.createdBy, firstPayment?.addressBy ?? null];

  // Early refusals, before any claim — none of these contend for the row.
  let soleApprover = false;
  let fewApprovers = false;
  if (twoNeeded) {
    // Either of them gives one of the two approvals only when fewer than two others can (T5).
    if (excluded.includes(input.actorId)) {
      if (!(await mayGiveApproval({ actorId: input.actorId, excluded }))) raise(invoice.createdBy === input.actorId ? "self_approval" : "new_payee_self");
      fewApprovers = true;
    }
  } else {
    // Whoever entered the invoice may approve it only as the workspace's sole
    // approver; the claim asks the database the same question again.
    soleApprover = invoice.createdBy === input.actorId;
    if (soleApprover && !(await isSoleApprover(input.actorId))) raise("self_approval");
    // A first payment to an address needs someone other than whoever gave it, unless they decide alone (new payee check N4).
    if (firstPayment?.addressBy === input.actorId && !(await isSoleApprover(input.actorId))) raise("new_payee_self");
  }
  if (invoice.riskLevel === "high") raise("high_risk");
  const shownAddress = input.shownAddress?.trim();
  if (shownAddress !== undefined && !sameAddress(invoice.address, shownAddress === "" ? null : shownAddress)) {
    raise("address_changed");
  }

  // Only USDC crosses chains (CCTP payouts X6): refused before any claim.
  if (invoice.currency !== "USDC" && paidAcrossChains(invoice.destinationChain)) raise("bridge_unsupported_token");

  const operating = await operatingAccount();
  if (!operating) raise("no_operating_account");

  // A transfer that already exists is reconciled, never sent again, so the
  // balance — already lower by this very payment — is not the question. One
  // Circle ended in a terminal failure moved nothing and is sent again, so it
  // is checked like any new payment.
  const provider = getChainProvider();
  // A send Circle never answered may have lowered the balance already (payment safety R3): only the funds check is
  // skipped for it, since sending it again under its key may still be a new payment.
  const mayExist = alreadySent || transferUnknown(intent);
  // Nothing new is paid while the platform has payments switched off (payment safety S4), but a transfer already sent
  // is still recorded: that only reads Circle, and the provider refuses any send (S8).
  if (!alreadySent && (await paymentsDisabled())) raise("payments_off");

  // Two approvals (T4): the first is recorded and sends nothing; the second, by another person, pays.
  const source: PaymentSource = { type: "invoice", id: invoice.id };
  let approvals: GivenApproval[] = [];
  if (twoNeeded) {
    const payment = { amount: invoice.amount, currency: invoice.currency, address: invoice.address };
    const standing = await standingApprovals(source, payment);
    const other = standing.find((approval) => approval.by !== input.actorId);
    if (!other) {
      if (standing.some((approval) => approval.by === input.actorId)) raise("already_approved");
      await giveApproval(source, input.actorId, payment);
      await appendLedgerEntryBestEffort(orgId, {
        actor: "human",
        domain: "ap",
        action: "approval_given",
        summary: `Approved ${invoice.amount} ${invoice.currency} to ${invoice.counterpartyName}; one more approval pays it (payments above ${above} USDC need two)`,
        detail: {
          by: input.actorId,
          invoiceId: invoice.id,
          counterpartyId: invoice.counterpartyId,
          amount: invoice.amount,
          currency: invoice.currency,
          address: invoice.address,
          ...(invoice.currency === "EURC" ? { usdcValue } : {}),
          twoApprovalsAbove: above,
          // Given by whoever entered it, or gave its address, as fewer than two others can approve (T5).
          ...(fewApprovers ? { fewApprovers: true } : {}),
          ...input.provenance,
        },
      });
      return { status: "approved", txRef: null, note: "" };
    }
    // Another person's approval stands, so this one pays. It is recorded beside it, and both are used once the
    // payment is claimed (T6).
    const mine = standing.find((approval) => approval.by === input.actorId) ?? (await giveApproval(source, input.actorId, payment));
    approvals = [other, mine];
    if (excluded.includes(other.by)) fewApprovers = true;
  }
  if (!mayExist && invoice.currency === "USDC") {
    const balance = provider.mode === "live" ? await syncOperatingBalance(operating.id) : operating.balance;
    if (balance < invoice.amount) {
      throw new ApprovalError("insufficient_funds", `The operating account holds ${balance} USDC, less than this invoice.`);
    }
  }
  // A EURC payable is paid from the wallet's EURC, read from the chain. A
  // sandbox simulates its payments and has no EURC balance to check (E7).
  if (!mayExist && invoice.currency === "EURC" && provider.mode === "live" && provider.getTokenBalance) {
    const { balance } = await provider.getTokenBalance(operating.id, "EURC");
    if (balance < invoice.amount) {
      throw new ApprovalError("insufficient_funds", `The operating wallet holds ${balance} EURC, less than this invoice.`);
    }
  }

  // A new payment to another chain records both routes' fees, read now, with the route it takes, so the
  // card can set one against the other. A transfer already sent is only reconciled: its decision recorded them.
  const payout =
    !alreadySent && invoice.currency === "USDC" && paidAcrossChains(invoice.destinationChain)
      ? await payoutEvidence(invoice.destinationChain as string, invoice.amount, intent?.payout_route ?? null, {
          bridgeFee: options.bridgeFee ?? ((chain, amount) => bridgeFee(chain, amount)),
          gatewayQuote: options.gatewayQuote ?? gatewayQuoter(provider, db()),
        })
      : null;

  const claim = await db()
    .rpc("claim_invoice_decision", { p_invoice_id: invoice.id, p_by: input.actorId, p_decision: "approve" })
    .single();
  if (claim.error) raiseFromClaim(claim.error);

  // The approvals that let it through are used by this payment (T6). Best effort: the claim already holds the row.
  if (approvals.length > 0) {
    try {
      await markApprovalsUsed(source);
    } catch (error) {
      console.error("approval: approvals not marked used", invoice.id, (error as Error).message);
    }
  }

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
        currency: invoice.currency,
        // A person approving a payout to another chain lets its fee be at most the invoice itself (review I2, I4):
        // a fee read higher at the burn sends nothing.
        ...(paidAcrossChains(invoice.destinationChain) ? { destinationChain: invoice.destinationChain as string, maxBridgeFeeUsdc: invoice.amount } : {}),
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
      { provider, operating: { id: operating.id }, retryTerminalFailure: !mayExist }
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
    summary: approvalPaidSummary(result.status, invoice.amount, invoice.counterpartyName, result, invoice.currency, soleApprover, approvals.length > 0),
    detail: {
      by: input.actorId,
      invoiceId: invoice.id,
      counterpartyId: invoice.counterpartyId,
      amount: invoice.amount,
      currency: invoice.currency,
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
      // A new payment to another chain: the route it took and both routes' fees, as an ap_pay entry records them.
      ...(payout ? { payout } : {}),
      // The person who entered it approved it, as the workspace's only approver.
      ...(soleApprover ? { soleApprover: true } : {}),
      // The address's first payment, which this person stood behind beside whoever gave the address (new payee check N4).
      ...(firstPayment ? { firstPayment: true } : {}),
      // Above the figure: the two approvals, the earlier first (two approvals T7).
      ...(approvals.length > 0 ? { approvals: approvals.map((approval) => ({ by: approval.by, at: approval.at })), twoApprovalsAbove: above } : {}),
      ...(fewApprovers ? { fewApprovers: true } : {}),
      ...input.provenance,
    },
  });

  return { status: result.status, txRef: result.txRef, note: result.note };
}

/**
 * What an approved payment to another chain records of its route: the route it takes (the one an
 * earlier attempt took, which every later attempt keeps; CCTP for a first one, Gateway payouts R7),
 * that route's fee, and both routes' fees, read now. A fee that cannot be read is null: reading it
 * never stops an approval.
 */
async function payoutEvidence(
  chain: string,
  amount: number,
  pinned: string | null,
  read: {
    bridgeFee: (chain: string, amount: number) => Promise<BridgeFee>;
    gatewayQuote: (chain: string, amount: number) => Promise<GatewayQuote | null>;
  }
): Promise<Record<string, unknown>> {
  const [cctpFeeUsdc, gateway] = await Promise.all([
    read.bridgeFee(chain, amount).then(
      (fee) => fee.feeUsdc,
      () => null
    ),
    read.gatewayQuote(chain, amount).catch(() => null),
  ]);
  const route = pinned === "gateway" ? "gateway" : "cctp";
  return {
    chain,
    route,
    domain: payeeChain(chain).domain,
    feeUsdc: route === "gateway" ? (gateway?.feeUsdc ?? null) : cctpFeeUsdc,
    ...(route === "gateway" && gateway ? { gatewayBalanceUsdc: gateway.balanceUsdc } : {}),
    quotes: { cctpFeeUsdc, gatewayFeeUsdc: gateway?.feeUsdc ?? null },
  };
}

/**
 * A decision that ends the question clears the approvals given for it (two approvals T6). Best effort: the decision
 * stands, and an approval left behind agrees with nothing once the payable is decided again on other facts.
 */
async function clearApprovalsAfter(invoiceId: string): Promise<void> {
  try {
    await clearApprovals({ type: "invoice", id: invoiceId });
  } catch (error) {
    console.error("approval: approvals not cleared", invoiceId, (error as Error).message);
  }
}

/** `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none. */
export async function rejectInvoice(input: { actorId: string; invoiceId: string; reason?: string; provenance?: Provenance }): Promise<void> {
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
  await clearApprovalsAfter(input.invoiceId);

  const reason = trimReason(input.reason);
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "approval_rejected",
    summary: "An invoice was rejected",
    detail: { by: input.actorId, invoiceId: input.invoiceId, ...(reason === undefined ? {} : { reason }), ...input.provenance },
  });
}

/** `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none. */
export async function returnInvoice(input: { actorId: string; invoiceId: string; provenance?: Provenance }): Promise<void> {
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
  await clearApprovalsAfter(input.invoiceId);

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "approval_returned",
    summary: "An invoice was returned, undecided",
    detail: { by: input.actorId, invoiceId: input.invoiceId, ...input.provenance },
  });
}

/** The statuses a person may add details in: waiting, and not being decided by anyone (complete held invoice R3). */
const COMPLETABLE_STATUSES = ["held", "flagged", "awaiting_info"] as const;

/**
 * Adds what a payable the agent stopped on was missing (spec 2026-10-03-complete-held-invoice-design): its purchase
 * order, when it has none, and its goods or services received, when they are not marked so. Nothing already on file
 * changes (R2), and only owners and admins call it (R1, in the action).
 *
 * The status stays as it is. At the next cycle the follow-up stage compares the payable's facts with those its
 * decision recorded, reopens it on what changed with a signed `invoice_reopened`, and the AP stage decides it again,
 * every check included (R4). A payment already sent is refused before any write, as Reject and Return refuse it; the
 * write is a compare-and-set on a waiting status, and on the purchase order still being empty, so a decision or
 * another person's addition in between wins (R3). `reviewed_by` records a person's hand on it (R5). `provenance`, when
 * given, names the surface the person acted from (integrations design R3); the console gives none.
 */
export async function addInvoiceDetails(input: {
  actorId: string;
  invoiceId: string;
  poReference: string | null;
  goodsReceived: boolean;
  provenance?: Provenance;
}): Promise<AddedDetails> {
  const orgId = currentOrgId();
  const invoice = await loadWaitingPayable(input.invoiceId);
  if (!(COMPLETABLE_STATUSES as readonly string[]).includes(invoice.status)) raise("invoice_changed");

  const poReference = input.poReference?.trim() || null;
  const added: AddedDetails = {};
  if (poReference !== null && invoice.poReference === null) added.poReference = poReference;
  if (input.goodsReceived && !invoice.goodsReceived) added.goodsReceived = true;
  if (added.poReference === undefined && added.goodsReceived === undefined) raise("nothing_to_add");

  await refuseIfPaymentSent(invoice.id);

  let write = db()
    .from("invoices")
    .update({
      ...(added.poReference !== undefined ? { po_reference: added.poReference } : {}),
      ...(added.goodsReceived ? { goods_received: true } : {}),
      reviewed_by: input.actorId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", invoice.id)
    .in("status", COMPLETABLE_STATUSES);
  if (added.poReference !== undefined) write = write.is("po_reference", null);
  if (added.goodsReceived) write = write.eq("goods_received", false);
  const changed = unwrap(await write.select("id")) as Array<{ id: string }>;
  if (changed.length === 0) raise("invoice_changed");

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "invoice_details_added",
    summary: `Added ${addedWords(added)} to an invoice from ${invoice.counterpartyName} for ${invoice.amount} ${invoice.currency}`,
    // No `observed`: the follow-up and the card read the decision's facts from the decision's own entry.
    detail: { by: input.actorId, invoiceId: invoice.id, counterpartyId: invoice.counterpartyId, added, ...input.provenance },
  });
  return added;
}

/** "purchase order PO-100", "goods received", or both joined. */
function addedWords(added: AddedDetails): string {
  return [added.poReference !== undefined ? `purchase order ${added.poReference}` : null, added.goodsReceived ? "goods received" : null]
    .filter((words): words is string => words !== null)
    .join(" and ");
}
