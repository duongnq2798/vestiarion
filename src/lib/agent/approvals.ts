import { currentConfig, currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { chainModes, getChainProvider, type Stablecoin } from "../circle";
import { confirmCounterpartyAddress, sameAddress } from "../counterparty-address";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { listLedgerEntriesForTargets } from "../ledger";
import { explainPayable, presentReasoning } from "../reasoning-copy";
import { isTerminalFailure, settleUnknownSend, unknownSend, type UnknownSendAnswer } from "../payments";
import { MAY_HAVE_BEEN_ACCEPTED } from "../circle/settlement";
import { PAYMENTS_OFF, PaymentsDisabledError, paymentsHold } from "../payments-switch";
import { payInvoice, syncOperatingBalance } from "./pay";
import { amountToPay, invoiceDiscount, type InvoiceDiscount } from "./payment-timing";
import { ContractRefusal, personPaymentThroughContract } from "../treasury/person-payment";
import type { BankPayoutParams, SpendingLimitPayment } from "../circle/types";
import { chainById, homeChain, paidAcrossChains } from "../payee-chains";
import { counterpartyChainProblem } from "../intake-validation";
import { workspaceNetwork } from "../workspace-network";
import { bridgeFee, type BridgeFee } from "../circle/cctp";
import { gatewayQuoter, type GatewayQuote } from "../circle/gateway-quote";
import { choosePayoutRoute, payoutFundsShort, type GatewayFigures } from "../payout-route";
import { bankAccountsOf, readPayoutPartner, type CounterpartyBankAccount } from "../bank-payouts/store";
import type { BankPayoutShown } from "../bank-payouts/words";
import { createQuote, MIN_QUOTE } from "../blindpay/api";
import type { BlindpayQuote } from "../blindpay/map";
import { blindpaySettingsFromEnv } from "../blindpay/settings";
import type { CrossChainRoute } from "../circle/types";
import { commissionPartnersOf } from "../commissions/beneficiary";
import { isSoleApprover } from "./sole-approver";
import { addressGiver, askedVia, firstPaymentRefusal, membersLeftOut, newPayeeSelfMessage, type NewPayeeCheck } from "../new-payee";
import { firstPaymentCheck, loadNewPayeeFacts, newPayeeCheckFor } from "../new-payee-facts";
import { addedSince, latestDecision, recordedFacts, type AddedDetails } from "../added-details";
import { awaitsVerdict, heldForCash } from "../next-step";
import { verdictGate } from "../verdicts";
import { isReclaimable } from "./claim-age";
import type { Provenance } from "../provenance";
import { amountFromReserve, bringCashForApproval, CashBackError, cashShortMessage, cctpFeeCushion, reserveCover, type ReserveCover } from "./liquidity";
import { approversBesides, readTwoApprovalsAbove } from "../approval-policy";
import { needsSecondApprover, needsTwoApprovals, type TwoApprovalsFacts } from "../two-approvals";
import {
  clearApprovals,
  giveApproval,
  markApprovalsUsed,
  mayGiveApproval,
  standingApprovals,
  twoApprovalsFacts,
  usdcValueOfLatestDecision,
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
  | "beneficiary_approval"
  | "new_payee_self"
  | "high_risk"
  | "insufficient_funds"
  | "no_operating_account"
  | "payment_in_flight"
  | "payment_unknown"
  | "payments_off"
  | "address_changed"
  | "no_address"
  | "bridge_unsupported_token"
  | "nothing_to_add"
  | "invoice_changed"
  | "already_approved"
  | "needs_second_approver"
  | "chain_off_network"
  | "verdict_needed"
  | "verdict_disagreed"
  | "bank_not_set_up"
  | "bank_unsupported_token";

/**
 * Every message except `insufficient_funds` and `needs_second_approver`, whose texts name the balance and the figure,
 * and `chain_off_network`, whose text names the chain.
 */
const MESSAGES: Record<Exclude<ApprovalErrorCode, "insufficient_funds" | "needs_second_approver" | "chain_off_network">, string> = {
  already_decided: "Someone else decided this invoice a moment ago.",
  self_approval: "You created this invoice, so someone else must approve it.",
  beneficiary_approval: "This payable pays your own commission, so someone else must approve it.",
  new_payee_self: "You gave this payee's address, so someone else must approve its first payment.",
  high_risk: "This counterparty is screened high risk. Clear it in Compliance first.",
  no_operating_account: "This workspace has no operating account.",
  invoice_not_found: "That invoice is not waiting for a decision.",
  payment_in_flight: "A payment for this invoice was already sent. Approve and pay records it.",
  payments_off: PAYMENTS_OFF,
  payment_unknown:
    "Circle did not answer when this invoice's payment was sent, and Vestiarion cannot tell yet whether Circle took it. Approve and pay looks for it first and sends nothing twice; until it is known, it cannot be closed.",
  address_changed: "This counterparty's address changed after this page loaded. Check the new address and try again.",
  no_address: "This payee has no payment address yet. Add it on Counterparties, or ask them for it with a one-time link.",
  bridge_unsupported_token: "Only USDC crosses chains. This invoice is in EURC, and its payee is paid on another chain.",
  nothing_to_add: "Enter a PO reference or tick Goods or services received.",
  invoice_changed: "This invoice changed a moment ago. Reload the page to see it.",
  already_approved: "You approved this already. Another person who can approve payments must approve it to pay.",
  verdict_needed: "This decision waits for a verdict in shadow mode. Agree or disagree with it in Approvals first.",
  verdict_disagreed: "Someone disagreed with this decision in shadow mode, so it is not paid. Return it to the agent or reject it.",
  bank_not_set_up: "This vendor is paid to a bank account, and bank payouts are not set up on this workspace yet. Set them up under Settings, Bank payouts.",
  bank_unsupported_token: "Only USDC is paid to a bank account, and this invoice is in EURC.",
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

function raise(code: Exclude<ApprovalErrorCode, "insufficient_funds" | "needs_second_approver" | "chain_off_network">): never {
  throw new ApprovalError(code, MESSAGES[code]);
}

/**
 * A payable held in shadow mode for a person's verdict is settled through one (shadow mode S4): before any is given,
 * and for a payment after a disagreement, these refuse, before any claim. A verdict settling it passes `forVerdict`.
 */
async function refuseUntilVerdict(invoiceId: string, decision: "approve" | "reject" | "return", facts?: { status: string; transferSent: boolean }): Promise<void> {
  const gate = await verdictGate(invoiceId, decision, facts);
  if (gate) raise(gate);
}

/**
 * `claim_invoice_decision` raises `invalid_decision`, `invoice_not_found`,
 * `self_approval`, `beneficiary_approval` (0118) or `already_decided` as `"<code>: <detail>"` (the 0021
 * pattern `memberErrorFrom` also reads). Only the four this library can
 * actually meet are mapped; `invalid_decision` never fires here since the
 * decision is always one of this module's own literals, and anything else
 * (a connection error) is rethrown as-is rather than misreported as one of
 * these codes.
 */
function raiseFromClaim(error: { message: string }): never {
  const code = /^([a-z_]+):/.exec(error.message)?.[1];
  if (code === "already_decided" || code === "self_approval" || code === "beneficiary_approval" || code === "invoice_not_found") {
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

/** What waits on Approvals: held for a person, or being paid by one (`listWaitingPayables`). */
export const WAITING_STATUSES = ["held", "flagged", "awaiting_info", "processing"] as const;

export { RECLAIM_AFTER_MS } from "./claim-age";

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
  /** The route a payment across chains took on its first attempt (Gateway payouts G2); every later attempt keeps it. */
  payout_route?: string | null;
  /**
   * When the row last changed: a `submitting` row older than its claim is a send whose answer was lost (payment safety
   * R4, payment exceptions E2). A read without it keeps telling such a row as a send under way.
   */
  updated_at?: string | null;
  /**
   * The batch its first attempt was sent in (batch payouts R5), and its attempt: a first attempt in a batch with no Circle
   * id may have gone out with the batch, which Circle lists under the batch's own refId (payment exceptions review 1).
   */
  batch_key?: string | null;
  transfer_attempt?: number | null;
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
 * Whether the intent's current attempt was sent to Circle and Circle never said what became of it (payment safety R1,
 * R4): no provider id, and either `failed` with an error in the provider's words for that — the deadline ran out, the
 * connection dropped after the request left, Circle answered 5xx or with no id — or left `submitting` past its claim,
 * when the function that sent it stopped before Circle's answer was recorded (payment exceptions E2; `unknownSend` and
 * the settlement track read it the same way). A first attempt sent in a batch with no Circle id is unknown whatever its
 * status or error: Circle may have the batch (batch payouts R5). Circle may hold the transfer: it is looked for before
 * anything is sent again, and until it is known nothing closes over it.
 */
export function transferUnknown(intent: IntentState | null, now: number = Date.now()): boolean {
  if (intent === null || intent.provider_tx_id !== null) return false;
  if (intent.batch_key && (intent.transfer_attempt ?? 1) === 1 && intent.status !== "confirmed" && intent.status !== "created") return true;
  if (intent.status === "failed") return intent.last_error?.includes(MAY_HAVE_BEEN_ACCEPTED) ?? false;
  // A send left `submitting` is told only when its time was read with it: the cycle's own reads keep their answer.
  if (intent.status !== "submitting" || typeof intent.updated_at !== "string") return false;
  return unknownSend({ status: "submitting", providerTxId: null, lastError: intent.last_error, updatedAt: intent.updated_at }, now);
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
  /**
   * Circle never answered the send (`transferUnknown`): it may hold the transfer, and approving looks for it first.
   * `sending`: the send was left `submitting`, so it may still be under way (payment exceptions review 6).
   */
  | { state: "unanswered"; sending?: true }
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
  if (transferUnknown(intent)) return intent?.status === "submitting" ? { state: "unanswered", sending: true } : { state: "unanswered" };
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
    .select("status, provider_tx_id, last_error, provider_state, payout_route, updated_at, batch_key, transfer_attempt")
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
    if (looked.answer === "no_operating_account") throw new ApprovalError("payment_unknown", unknownSendMessage("invoice", null));
    if (looked.answer === "undecided") throw new ApprovalError("payment_unknown", unknownSendMessage("invoice", looked.retryAt, { unlookable: looked.unlookable }));
    intent = await paymentIntentOf(invoiceId);
  }
  if (paymentWasSent(intent)) raise("payment_in_flight");
}

/**
 * Looks for a source's unknown send on Circle from the operating wallet, sending nothing (R6). With no operating account
 * there is nothing to look from: a pay action refuses with `no_operating_account`, as it would for any payment.
 */
export async function lookForUnknownSend(type: "invoice" | "milestone", id: string): Promise<UnknownSendAnswer | { answer: "no_operating_account" }> {
  const operating = await operatingAccount();
  if (!operating) return { answer: "no_operating_account" };
  return settleUnknownSend({ type, id }, { provider: getChainProvider(), fromAccountId: operating.id });
}

/**
 * Why a bill whose send Circle never answered cannot be closed, or paid, yet (R6; payment exceptions review 3, 5), with
 * when to try again when that is known. `paying`: Approve and pay or Pay now looked first and sent nothing. `unlookable`:
 * a payout to another chain, which only sending it again under its own key settles.
 */
export function unknownSendMessage(what: "invoice" | "milestone", retryAt: string | null, options: { paying?: boolean; unlookable?: boolean } = {}): string {
  const pay = what === "invoice" ? "Approve and pay" : "Pay now";
  if (options.paying) {
    const looked = "Vestiarion looked for the earlier transfer on Circle first";
    return retryAt
      ? `${looked}: Circle has not listed it yet, so nothing was sent. Try again from ${retryAt.slice(11, 16)} UTC: by then Vestiarion can tell whether Circle took it.`
      : `${looked}, and could not tell whether Circle took it, so nothing was sent. Try again in a few minutes.`;
  }
  const sent = `Circle did not answer when this ${what}'s payment was sent`;
  if (options.unlookable) {
    return `${sent}, and a payout to another chain cannot be looked up on Circle. ${pay} asks Circle for it again under the same payment key, which Circle takes only once; once Circle has answered, it can be ${what === "invoice" ? "rejected or returned" : "closed"}.`;
  }
  return retryAt
    ? `${sent}, and has not listed it yet. Try again from ${retryAt.slice(11, 16)} UTC: by then Vestiarion can tell whether Circle took it.`
    : `${sent}, and Vestiarion cannot tell yet whether Circle took it. ${pay} looks for it first and sends nothing twice; until it is known, it cannot be closed.`;
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
  /**
   * For a payee on another chain, the fee of the route Approve and pay would take (`payoutRoute`), as read for this
   * listing; null when not read or not needed (review I2).
   */
  bridgeFeeUsdc: number | null;
  /**
   * For a payee on another chain, paid in USDC: the route Approve and pay would take, by the agent's rule, or the one an
   * earlier attempt took (approval payout route P1, P4). Absent otherwise.
   */
  payoutRoute?: CrossChainRoute;
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
  /** Held in shadow mode for a person to agree, no rule refusing it (shadow mode S2). */
  heldForVerdict?: boolean;
  /** The agent's decision a verdict on it is about, while it waits for one (shadow mode S3). */
  verdictEntry?: { seq: number; ts: string };
  /**
   * A new USDC payment from the operating wallet that the wallet's stored balance cannot cover, and the reserve's can:
   * what the wallet holds, and about what Approve and pay brings back from the reserve first (approval cash R5). Absent
   * otherwise.
   */
  fromReserve?: { operatingUsdc: number; amountUsdc: number };
  /**
   * Present when paying it would be the first payment to its address, where payments are real: who gave the address, a
   * member's id, "payee", or null when not known (new payee check N4); for an address the payee sent through a payee
   * link, the member who created the link. That member may not approve it unless they decide alone.
   */
  firstPaymentAddressBy?: string | null;
  /** How the payee sent that address, when a member asked for it: through a payee link, or on GitHub. Absent otherwise. */
  firstPaymentVia?: "payee_link" | "github";
  /**
   * For an address no member answers for alone (sent on GitHub, or with no giver named): the members who confirmed it,
   * who may not approve its first payment unless they decide alone. Absent otherwise.
   */
  firstPaymentConfirmers?: string[];
  /**
   * An address no member answers for alone: one member confirms it on Counterparties and a different one approves its
   * first payment, so while no one has confirmed it, no one approves it alone. Absent otherwise.
   */
  firstPaymentUnanswered?: true;
  /**
   * Every member left out of approving its first payment (`membersLeftOut`), for who can act, when one approval pays it.
   * Absent otherwise: above the figure for two approvals, `twoApprovals` says who may give one.
   */
  firstPaymentLeftOut?: string[];
  /**
   * Above the workspace's figure for two approvals (two approvals T8): the figure, the approvals given that still count,
   * and whether whoever entered it, or gave its address, may give one. Absent when one approval pays it, or its transfer
   * was already sent.
   */
  twoApprovals?: TwoApprovalsFacts;
  /**
   * A vendor paid to its bank account in Mexico through BlindPay (bank payouts B12): the account as the card names it,
   * and an indicative quote read for this listing, what the vendor would receive now; Approve and pay asks a fresh one.
   * The quote is null when it was not read: `quoteProblem` says why. Absent for a vendor paid to its address.
   */
  bank?: WaitingBankPayout;
}

/** A bank payout as the approval card shows it (bank payouts B12). */
export type WaitingBankPayout = BankPayoutShown;


/** Every payable currently waiting for a person's decision — held, flagged, awaiting more information, or claimed by someone else right now. */
export async function listWaitingPayables(
  options: {
    bridgeFee?: (chain: string, amount: number) => Promise<BridgeFee>;
    gatewayQuote?: (chain: string, amount: number) => Promise<GatewayQuote | null>;
    /** BlindPay's indicative quote for a bank payout (bank payouts B12); BlindPay itself when not given. */
    bankQuote?: (input: { bankAccountId: string; amount: number }) => Promise<BlindpayQuote>;
  } = {}
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

  // Both routes' figures for a payee on another chain, read now, so the person approving sees the route Approve and pay
  // takes and what leaves (CCTP payouts, review I2; approval payout route P4). A figure that cannot be read is null.
  // The payees' chains are on the workspace's network (network threading P3). The list itself needs no provider: a
  // workspace on Arc mainnet with no Circle account, or while Arc mainnet is switched off, has none, and its pages still
  // read (mainnet go-live, final review I2). Gateway's quote builds one only for a row paid across chains.
  const network = workspaceNetwork();
  let quoter: ReturnType<typeof gatewayQuoter> | undefined;
  const read = {
    bridgeFee: options.bridgeFee ?? ((chain: string, amount: number) => bridgeFee(network, chain, amount)),
    gatewayQuote: options.gatewayQuote ?? ((chain: string, amount: number) => (quoter ??= gatewayQuoter(getChainProvider(), db()))(chain, amount)),
  };
  // Vendors paid to their bank account in Mexico (bank payouts B4): no chain, no address, no CCTP or Gateway route.
  const bankAccounts = rows.length > 0 ? await bankAccountsOf(rows.map((row) => row.counterparty_id)) : new Map<string, CounterpartyBankAccount>();
  const quotes = new Map<string, PayoutQuotes>();
  await Promise.all(
    rows
      .filter((row) => !bankAccounts.has(row.counterparty_id) && paidAcrossChains(row.counterparties?.chain) && currencyOf(row.currency) === "USDC")
      .map(async (row) => quotes.set(row.id, await readPayoutQuotes(row.counterparties?.chain as string, num(row.amount), read)))
  );

  const intents = new Map<string, IntentState>();
  if (rows.length > 0) {
    const found = unwrap(
      await db()
        .from("payment_intents")
        .select("source_id, status, provider_tx_id, last_error, provider_state, failure_reason, payout_route, updated_at, batch_key, transfer_attempt")
        .eq("source_type", "invoice")
        .in("source_id", rows.map((row) => row.id))
    ) as Array<IntentState & { source_id: string }>;
    for (const intent of found) intents.set(intent.source_id, intent);
  }

  const bankPayouts = await waitingBankPayouts(rows, bankAccounts, intents, options.bankQuote);
  // On Arc testnet a bank payout takes BlindPay's test token, which the operating wallet's USDC does not cover (B7).
  const bankTakesUsdc = (blindpaySettingsFromEnv()?.route(network.id).token ?? "USDC") === "USDC";

  // Whose address a first payment would go to, where payments are real (new payee check N4): read once for the list.
  const newPayeeFacts =
    rows.length > 0 && chainModes().mode === "live" ? await loadNewPayeeFacts(db(), [...new Set(rows.map((row) => row.counterparty_id))]) : null;

  // A transfer already sent is only recorded, which asks no first-payment question (as Approve and pay reads it).
  // A bank payout goes to no address, so it asks no first-payment question either (B6).
  const newPayeeOf = (row: (typeof rows)[number]) =>
    newPayeeFacts && !bankAccounts.has(row.counterparty_id) && !transferExists(intents.get(row.id) ?? null)
      ? newPayeeCheckFor(newPayeeFacts, { id: row.counterparty_id, address: row.counterparties?.address ?? null })
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
        excluded: [row.created_by, ...(newPayee?.firstPayment ? membersLeftOut(newPayee) : [])],
        sent: transferExists(intents.get(row.id) ?? null),
      };
    })
  );

  // The stored balances, for what Approve and pay would bring back from the reserve first (approval cash R5).
  const balances = rows.length > 0 ? await storedBalances() : null;

  const now = Date.now();
  return rows.map((row) => {
    const intent = intents.get(row.id) ?? null;
    const newPayee = newPayeeOf(row);
    const askedFor = newPayee?.firstPayment ? askedVia(newPayee) : null;
    const decision = latestDecision(entries, row.id);
    // The route Approve and pay would take, as it would choose it (P1), and that route's fee (P4).
    const quote = quotes.get(row.id) ?? null;
    const pinned = intent?.payout_route === "gateway" || intent?.payout_route === "cctp" ? intent.payout_route : null;
    const payoutRoute = quote ? choosePayoutRoute({ amount: num(row.amount), pinned, cctpFeeUsdc: quote.cctpFeeUsdc, gateway: quote.gateway }) : null;
    // A new USDC payment from the operating wallet, with a CCTP payout's fee and its cushion on top, as Approve and pay
    // counts it (R5, review finding 2); a CCTP payout whose fee was not read has no figure, as it would not be covered.
    const cctpFee = payoutRoute === "cctp" ? (quote?.cctpFeeUsdc ?? null) : null;
    const fromOperating =
      currencyOf(row.currency) === "USDC" &&
      payoutRoute !== "gateway" &&
      !(payoutRoute === "cctp" && cctpFee === null) &&
      !(bankAccounts.has(row.counterparty_id) && !bankTakesUsdc) &&
      !transferExists(intent) &&
      !transferUnknown(intent);
    const needs = num(row.amount) + (cctpFee !== null ? cctpFee + cctpFeeCushion(cctpFee) : 0);
    const fromReserveUsdc = balances && fromOperating ? amountFromReserve(needs, balances.operating, balances.reserve) : null;
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
      // Its own chain, as stored: a list shows a payable whatever its chain, and Approve and pay refuses one off the network.
      payeeChain: row.counterparties?.chain ?? homeChain(network.id).id,
      bridgeFeeUsdc: quote ? (payoutRoute === "gateway" ? (quote.gateway?.feeUsdc ?? null) : quote.cctpFeeUsdc) : null,
      ...(payoutRoute ? { payoutRoute } : {}),
      poReference: onFile.poReference,
      goodsReceived: onFile.goodsReceived,
      addedSinceDecision: addedSince(recorded, onFile),
      guardrailRule: decision?.detail.guardrailBlocked === true && typeof decision.detail.guardrailRule === "string" ? decision.detail.guardrailRule : null,
      ...(row.status === "held" && heldForCash(decision?.detail) ? { heldForCash: true } : {}),
      // Held in shadow mode for a person to agree, and the decision a verdict is about (shadow mode S2, S3).
      // An Agree and pay that did not finish leaves it still waiting for a verdict, once its claim may be retaken (review minor 3).
      ...((row.status === "held" || isReclaimable(row.status, row.reviewed_at, now)) && decision && awaitsVerdict(decision.detail)
        ? { heldForVerdict: true, verdictEntry: { seq: Number(decision.seq), ts: decision.ts } }
        : {}),
      ...(balances && fromReserveUsdc !== null ? { fromReserve: { operatingUsdc: balances.operating, amountUsdc: fromReserveUsdc } } : {}),
      ...(newPayee?.firstPayment
        ? {
            firstPaymentAddressBy: addressGiver(newPayee),
            ...(askedFor ? { firstPaymentVia: askedFor } : {}),
            ...(newPayee.confirmersLeftOut ? { firstPaymentConfirmers: newPayee.confirmersLeftOut } : {}),
            ...(newPayee.unanswered ? { firstPaymentUnanswered: true as const } : {}),
            // One approval pays it: above the figure, two different people approve it, the two approvals saying who may.
            ...(twoApprovals.has(row.id) ? {} : { firstPaymentLeftOut: membersLeftOut(newPayee) }),
          }
        : {}),
      ...(twoApprovals.has(row.id) ? { twoApprovals: twoApprovals.get(row.id) } : {}),
      ...(bankPayouts.has(row.id) ? { bank: bankPayouts.get(row.id) } : {}),
    };
  });
}

/**
 * The bank payouts in a listing (bank payouts B12): each vendor's account, and BlindPay's indicative quote for what it
 * would receive now, read side by side. A quote BlindPay does not answer leaves the card without one, never the list.
 */
async function waitingBankPayouts(
  rows: ReadonlyArray<{ id: string; amount: string; currency?: string | null; counterparty_id: string }>,
  accounts: Map<string, CounterpartyBankAccount>,
  intents: Map<string, IntentState>,
  bankQuote: ((input: { bankAccountId: string; amount: number }) => Promise<BlindpayQuote>) | undefined
): Promise<Map<string, WaitingBankPayout>> {
  const out = new Map<string, WaitingBankPayout>();
  const banked = rows.filter((row) => accounts.has(row.counterparty_id));
  if (banked.length === 0) return out;
  const settings = blindpaySettingsFromEnv();
  const partner = settings ? await readPayoutPartner().catch(() => null) : null;
  const quote =
    bankQuote ??
    (settings && partner?.customerId
      ? (input: { bankAccountId: string; amount: number }) => createQuote(settings, { ...input, ...settings.route(workspaceNetwork().id) }, undefined)
      : null);
  await Promise.all(
    banked.map(async (row) => {
      const account = accounts.get(row.counterparty_id) as CounterpartyBankAccount;
      const amount = num(row.amount);
      const intent = intents.get(row.id) ?? null;
      const problem: WaitingBankPayout["quoteProblem"] =
        transferExists(intent) || transferUnknown(intent)
          ? "sent"
          : currencyOf(row.currency) !== "USDC"
            ? "eurc"
            : !quote
              ? "not_set_up"
              : amount < MIN_QUOTE
                ? "below_minimum"
                : null;
      let read: WaitingBankPayout["quote"] = null;
      if (problem === null && quote) {
        try {
          const answer = await quote({ bankAccountId: account.externalId, amount });
          read = { receiverAmount: answer.receiverAmount, currency: "MXN", rate: answer.rate, feesSender: answer.feesSender };
        } catch (error) {
          console.error("approvals: BlindPay quote not read", error instanceof Error ? error.message : "unknown error");
        }
      }
      out.set(row.id, {
        bankCode: account.bankCode,
        last4: account.last4,
        beneficiaryName: account.beneficiaryName,
        accountStatus: account.status,
        quote: read,
        quoteProblem: problem ?? (read ? null : "unread"),
      });
    })
  );
  return out;
}

/** An invoice's currency as read: EURC, or USDC for anything else, a row from before 0040 included. */
function currencyOf(value: string | null | undefined): Stablecoin {
  return value === "EURC" ? "EURC" : "USDC";
}

interface LoadedInvoice {
  id: string;
  amount: number;
  status: string;
  /** When its decision was claimed: a `processing` row claimed under 10 minutes ago is being decided by someone else. */
  reviewedAt: string | null;
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
  /** The vendor's bank account in use, when it is paid to a bank through BlindPay (bank payouts B4, B7). */
  bankAccount: CounterpartyBankAccount | null;
}

/**
 * Where a bank payout goes (bank payouts B7): the vendor's account at BlindPay, on the network and token BlindPay is paid
 * with for the workspace's network. Refused before any claim when it is not USDC, when the deployment has no BlindPay
 * instance, or when the workspace has no BlindPay customer yet.
 */
async function bankRouteFor(invoice: Pick<LoadedInvoice, "currency" | "bankAccount">): Promise<BankPayoutParams> {
  if (invoice.currency !== "USDC") raise("bank_unsupported_token");
  const settings = blindpaySettingsFromEnv();
  const partner = settings ? await readPayoutPartner() : null;
  if (!settings || !partner?.customerId || !invoice.bankAccount) raise("bank_not_set_up");
  return { bankAccountId: invoice.bankAccount.externalId, ...settings.route(getChainProvider().network.id) };
}

async function loadWaitingPayable(invoiceId: string): Promise<LoadedInvoice> {
  const result = await db()
    .from("invoices")
    .select(
      "id, amount, currency, status, direction, agent_reasoning, created_by, reviewed_at, counterparty_id, early_pay_discount_pct, discount_due_date, po_reference, goods_received, counterparties(name, risk_level, address, chain)"
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
    reviewed_at?: string | null;
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
  const bankAccount = (await bankAccountsOf([row.counterparty_id])).get(row.counterparty_id) ?? null;

  return {
    id: row.id,
    amount: num(row.amount),
    status: row.status,
    reviewedAt: row.reviewed_at ?? null,
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
    bankAccount,
  };
}

/**
 * Whether paying this invoice would be the first payment to its counterparty's address, and who gave the address, where
 * payments are real (new payee check N1, N2, N5); null otherwise.
 */
async function firstPaymentTo(invoice: Pick<LoadedInvoice, "counterpartyId" | "address">): Promise<NewPayeeCheck | null> {
  return chainModes().mode === "live" ? firstPaymentCheck(db(), { id: invoice.counterpartyId, address: invoice.address }) : null;
}

/** The stored operating and reserve balances (approval cash R5); null unless the workspace has both. */
async function storedBalances(): Promise<{ operating: number; reserve: number } | null> {
  const [operating, reserve] = await Promise.all([operatingAccount(), db().from("accounts").select("balance").eq("kind", "reserve").maybeSingle()]);
  if (reserve.error) throw new Error(reserve.error.message);
  const row = reserve.data as { balance: string | number } | null;
  return operating && row ? { operating: operating.balance, reserve: num(row.balance) } : null;
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
  secondOfTwo = false,
  addressGiverAlone = false
): string {
  const discounted = payment.discountTaken > 0;
  const sent = discounted ? payment.amountPaid : amount;
  const less = discounted ? ` (${amount} ${currency} less a ${payment.discountTaken} ${currency} early-payment discount)` : "";
  const own = secondOfTwo
    ? ` ${SECOND_OF_TWO_NOTE}`
    : [soleApprover ? SOLE_APPROVER_NOTE : "", addressGiverAlone ? ADDRESS_GIVER_NOTE : ""].map((note) => (note ? ` ${note}` : "")).join("");
  if (status === "paid") return `Approved and paid ${sent} ${currency} to ${name}${less}${own}`;
  if (status === "matched") return `Approved; payment of ${sent} ${currency} to ${name} submitted${less}${own}`;
  return `Approved; payment of ${sent} ${currency} to ${name} failed${less}${own}`;
}

/** How a ledger summary marks an approval by the person who entered the record, as the workspace's only approver (sole approver R4). */
export const SOLE_APPROVER_NOTE = "(entered and approved by the workspace's only approver)";

/**
 * How a ledger summary marks a first payment the workspace's only approver paid though no other member stands behind its
 * address: they gave it or asked the payee for it, or, for one no member answers for alone, they confirmed it or no one
 * else has (new payee check N4; independent review, 2026-10-15).
 */
export const ADDRESS_GIVER_NOTE = "(first payment to an address no other member stands behind, paid by the workspace's only approver)";

/** How a ledger summary marks the approval that paid a payment two people approved (two approvals T7). */
export const SECOND_OF_TWO_NOTE = "(the second of two approvals)";

/**
 * The note a person's payment adds to the bill's reasoning, by what its transfer did (settlement lifecycle I17): `paidNote`
 * only once Circle confirmed it; submitted while Circle has not (`matched`, a milestone's `verified`); not confirmed when
 * it was held again, which a failed transfer and a read of ours that threw both leave (L9). Notes stored before keep
 * their words, and read as before.
 */
export function personPaymentNote(status: string, paidNote: string): string {
  if (status === "paid") return ` [${paidNote}]`;
  return status === "matched" || status === "verified" ? " [approved by a person; payment submitted]" : " [approved by a person; payment not confirmed]";
}

/** A EURC payable's USDC value as the agent last weighed it (its latest decision's `usdcValue`), null when it has none (two approvals T2). */

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
  input: { actorId: string; invoiceId: string; shownAddress?: string; provenance?: Provenance; forVerdict?: boolean },
  options: {
    bridgeFee?: (chain: string, amount: number) => Promise<BridgeFee>;
    gatewayQuote?: (chain: string, amount: number) => Promise<GatewayQuote | null>;
  } = {}
): Promise<{
  status: "paid" | "matched" | "held" | "approved";
  txRef: string | null;
  note: string;
  fromReserveUsdc?: number;
  /** What went out, to whom and in what, once the transfer did: the person's confirmation says it; `simulated` in a sandbox. */
  paid?: { amount: number; currency: string; payee: string; simulated?: true };
  /**
   * The approval read an earlier transfer, or asked Circle for it again under its key, rather than deciding a new
   * payment (payment exceptions E3): no reason for paying a held bill is kept for it (capability and reasons R10).
   */
  checkedFirst?: true;
}> {
  const orgId = currentOrgId();
  const invoice = await loadWaitingPayable(input.invoiceId);
  let intent = await paymentIntentOf(invoice.id);
  // A send Circle never answered is looked for first, as Reject and Return look for it (payment safety R6; payment
  // exceptions review 3): found, it is only recorded; never taken, what follows is a new payment, and every check a new
  // payment gets applies to it, the shadow verdict's and the funds' included; not listed yet, nothing is claimed and
  // nothing is sent. A payout to another chain cannot be looked up this way: it is asked for again under its own key,
  // which Circle takes only once, as before. Not where the network holds payments, which refuses below.
  if (transferUnknown(intent) && !currentConfig().chain.networkHold) {
    const looked = await lookForUnknownSend("invoice", invoice.id);
    if (looked.answer === "no_operating_account") raise("no_operating_account");
    if (looked.answer === "undecided" && !looked.unlookable) throw new ApprovalError("payment_unknown", unknownSendMessage("invoice", looked.retryAt, { paying: true }));
    intent = await paymentIntentOf(invoice.id);
  }
  if (!input.forVerdict) await refuseUntilVerdict(invoice.id, "approve", { status: invoice.status, transferSent: transferExists(intent) || transferUnknown(intent) });
  // The partner a commission pays never approves it, sole approver or not, nor gives one of two approvals, and an
  // approval they gave before a plan named them does not stand (docs/superpowers/specs/2026-10-14-commissions-design.md
  // C11); the claim asks the database again. None for a payable that pays no commission. Whoever created it is treated
  // as whoever created any payable: naming someone a partner never lets anyone approve what they created.
  const partners = await commissionPartnersOf(invoice.id);
  if (partners.includes(input.actorId)) raise("beneficiary_approval");
  // A transfer that already exists is reconciled, never sent again.
  const alreadySent = transferExists(intent);
  // Recording a transfer already sent pays no address for the first time: it went wherever it went, as Pay now reads it.
  // A bank payout has no address to pay for the first time: a person approves every one (bank payouts B6).
  const firstPayment = alreadySent || invoice.bankAccount ? null : await firstPaymentTo(invoice);
  // Above the workspace's figure a payment needs two people's approval (two approvals T4); a transfer already sent is
  // only recorded, on one approval (T6).
  const above = alreadySent ? null : await readTwoApprovalsAbove(db());
  const usdcValue = above !== null && invoice.currency === "EURC" ? await usdcValueOfLatestDecision(invoice.id) : null;
  const twoNeeded = above !== null && needsTwoApprovals({ amount: invoice.amount, currency: invoice.currency, usdcValue }, above);
  // Whoever entered it, and whoever a first payment's address rests on: who gave it or asked for it, and, for one no
  // member answers for alone, who confirmed it (new payee check N4).
  const excluded = [invoice.createdBy, ...membersLeftOut(firstPayment)];
  const source: PaymentSource = { type: "invoice", id: invoice.id };
  const payment = { amount: invoice.amount, currency: invoice.currency, address: invoice.address };

  // Early refusals, before any claim — none of these contend for the row.
  // A workspace its network holds moves nothing, and has nothing sent to record (mainnet go-live M4): Arc mainnet
  // switched off withholds its Circle credentials, and a mainnet workspace not live yet has sent nothing. First, since
  // such a workspace may have no provider at all.
  const networkHeld = currentConfig().chain.networkHold;
  if (networkHeld) throw new ApprovalError("payments_off", networkHeld);
  let soleApprover = false;
  // The person who gave the first payment's address, or asked for it, approving it as the sole approver (N4).
  let addressGiverApproved = false;
  let fewApprovers = false;
  let standing: GivenApproval[] = [];
  if (twoNeeded) {
    // No approval is taken while another person's payment of it is being decided.
    if (invoice.status === "processing" && !isReclaimable(invoice.status, invoice.reviewedAt, Date.now())) raise("already_decided");
    // With fewer than two people who can approve payments, it could never be paid: no approval is taken (T5).
    if ((await approversBesides([])) < 2) throw new ApprovalError("needs_second_approver", needsSecondApprover(above as number));
    standing = (await standingApprovals(source, payment)).filter((approval) => !partners.includes(approval.by));
    // Whoever entered it, or gave its address, gives only the approvals no one independent of it can (T5).
    if (excluded.includes(input.actorId)) {
      if (!(await mayGiveApproval({ actorId: input.actorId, excluded, given: standing }))) {
        if (invoice.createdBy === input.actorId) raise("self_approval");
        throw new ApprovalError("new_payee_self", newPayeeSelfMessage(firstPayment, input.actorId));
      }
      fewApprovers = true;
    }
  } else {
    // Whoever entered the invoice may approve it only as the workspace's sole
    // approver; the claim asks the database the same question again.
    soleApprover = invoice.createdBy === input.actorId;
    if (soleApprover && !(await isSoleApprover(input.actorId))) raise("self_approval");
    // A first payment to an address needs someone other than whoever it rests on, unless they decide alone (new payee
    // check N4). One no member answers for alone needs another member's confirmation on record first: this approval
    // would confirm it itself, and that never counts.
    const refusal = firstPaymentRefusal(firstPayment, input.actorId);
    if (refusal) {
      if (!(await isSoleApprover(input.actorId))) throw new ApprovalError("new_payee_self", refusal);
      addressGiverApproved = true;
    }
  }
  if (invoice.riskLevel === "high") raise("high_risk");
  // Nothing to pay where payments are real: refused before any claim, as the agent holds it (counterparty.no_address).
  // A vendor paid to its bank needs no address (bank payouts B4): only USDC, through the workspace's BlindPay customer.
  if (!invoice.address && !invoice.bankAccount && chainModes().mode === "live") raise("no_address");
  const shownAddress = input.shownAddress?.trim();
  if (!invoice.bankAccount && shownAddress !== undefined && !sameAddress(invoice.address, shownAddress === "" ? null : shownAddress)) {
    raise("address_changed");
  }
  const bank = invoice.bankAccount && !alreadySent ? await bankRouteFor(invoice) : null;

  // A payee's chain must be one the workspace's network pays on (network threading P3): refused in plain words, before
  // any claim, and never paid on the workspace's own chain instead.
  const chainProblem = invoice.bankAccount ? null : counterpartyChainProblem(getChainProvider().network.id, invoice.destinationChain);
  if (chainProblem) throw new ApprovalError("chain_off_network", chainProblem);

  // Only USDC crosses chains (CCTP payouts X6): refused before any claim.
  if (invoice.currency !== "USDC" && paidAcrossChains(invoice.destinationChain)) raise("bridge_unsupported_token");

  // From the owner's own wallet, whose contract pays on its own chain only, a payout to another chain is refused by name
  // here, before any approval is recorded, fee asked for or funds counted (mainnet Base payouts B3). Such a workspace
  // never sent one: its provider refuses every one.
  if (!invoice.bankAccount && paidAcrossChains(invoice.destinationChain) && currentOrgConfig().chain.walletHost === "external") {
    throw new ApprovalError("payments_off", `Only USDC on ${workspaceNetwork().label} can be paid from your wallet's contract.`);
  }

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
  if (!alreadySent) {
    const hold = await paymentsHold();
    if (hold) throw new ApprovalError("payments_off", hold);
  }

  // Two approvals (T4): the first is recorded and sends nothing; the second, by another person, pays.
  let approvals: Array<{ by: string; at: string }> = [];
  if (twoNeeded) {
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
      return { status: "approved", txRef: null, note: "", ...(mayExist ? { checkedFirst: true as const } : {}) };
    }
    // Another person's approval stands, so this one pays. Nothing of it is stored before the claim: a refusal on the way
    // leaves no approval behind, and the ledger entry is its record (T6).
    approvals = [{ by: other.by, at: other.at }, { by: input.actorId, at: new Date().toISOString() }];
    if (excluded.includes(other.by)) fewApprovers = true;
  }
  // A new payment to another chain (approval payout route P1): both routes' fees and the Gateway balance, read now, and
  // the route by the agent's rule, keeping the one an earlier attempt took. A transfer already sent is only reconciled:
  // its decision recorded them.
  const crossChain = !alreadySent && !invoice.bankAccount && invoice.currency === "USDC" && paidAcrossChains(invoice.destinationChain);
  const quotes = crossChain
    ? await readPayoutQuotes(invoice.destinationChain as string, invoice.amount, {
        bridgeFee: options.bridgeFee ?? ((chain, amount) => bridgeFee(provider.network, chain, amount)),
        gatewayQuote: options.gatewayQuote ?? gatewayQuoter(provider, db()),
      })
    : null;
  const pinned: CrossChainRoute | null = intent?.payout_route === "gateway" || intent?.payout_route === "cctp" ? intent.payout_route : null;
  const route = quotes ? choosePayoutRoute({ amount: invoice.amount, pinned, cctpFeeUsdc: quotes.cctpFeeUsdc, gateway: quotes.gateway }) : null;

  // What leaves, counted where it leaves from (P2): a Gateway payout from the Gateway balance, which the operating wallet
  // does not touch; anything else from the operating wallet, a CCTP payout with its fee on top. What the operating wallet
  // lacks comes back from the reserve once the decision is claimed, when the reserve holds it (approval cash R1, R2).
  let fromReserve: ReserveCover | null = null;
  // A bank payout on Arc testnet takes BlindPay's test token, not USDC: its balance is read once BlindPay quotes (B7).
  const takesUsdc = !bank || bank.token === "USDC";
  if (!mayExist && invoice.currency === "USDC" && takesUsdc) {
    if (route === "gateway") {
      const short = payoutFundsShort({ route, amount: invoice.amount, operatingUsdc: 0, cctpFeeUsdc: null, gateway: quotes?.gateway ?? null });
      if (short) throw new ApprovalError("insufficient_funds", gatewayShortMessage(short.holds, quotes?.gateway?.feeUsdc ?? null));
    } else {
      const balance = provider.mode === "live" ? await syncOperatingBalance(operating.id) : operating.balance;
      const fee = route === "cctp" ? (quotes?.cctpFeeUsdc ?? null) : null;
      const short = payoutFundsShort({ route: "cctp", amount: invoice.amount, operatingUsdc: balance, cctpFeeUsdc: fee, gateway: null });
      if (short) {
        // A CCTP payout brings back a cushion on its fee, which is read again before the burn; one whose fee CCTP did not
        // give needs what no one knows, and is not covered (review finding 2).
        const read =
          route === "cctp" && fee === null
            ? { cover: null, reserveBalance: null }
            : await reserveCover(db(), { neededUsdc: short.needs ?? invoice.amount, operatingBalance: balance, cushionUsdc: fee !== null ? cctpFeeCushion(fee) : 0 });
        if (!read.cover) throw new ApprovalError("insufficient_funds", cashShortMessage({ operatingUsdc: balance, reserveUsdc: read.reserveBalance, feeUsdc: fee, what: "invoice" }));
        fromReserve = read.cover;
      }
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

  // A workspace paying from its owner's own wallet pays a person's approval through its contract too, within its figures
  // (wallet treasury W11): refused here, by name, before anything is claimed. A payment that may have been sent already
  // only goes through it again, so the contract is not asked first.
  let throughContract: SpendingLimitPayment | null = null;
  try {
    throughContract = await personPaymentThroughContract({
      sourceType: "invoice",
      sourceId: invoice.id,
      to: invoice.address,
      amount: amountToPay(invoice.amount, invoice.discount, new Date()).amountPaid,
      currency: invoice.currency,
      crossChain: paidAcrossChains(invoice.destinationChain),
      check: !mayExist,
    });
  } catch (error) {
    if (error instanceof ContractRefusal) throw new ApprovalError("payments_off", error.message);
    throw error;
  }

  // The route it takes and both routes' fees, so the card can set one against the other.
  const payout = quotes && route ? payoutRecord(invoice.destinationChain as string, route, quotes) : null;

  const claim = await db()
    .rpc("claim_invoice_decision", { p_invoice_id: invoice.id, p_by: input.actorId, p_decision: "approve" })
    .single();
  if (claim.error) raiseFromClaim(claim.error);

  // What the operating wallet lacks comes back from the reserve now that the decision is claimed, so a second click never
  // brings it back twice, and before any approval is used, so one that fails leaves them standing (approval cash R3).
  let fromReserveUsdc: number | null = null;
  if (fromReserve) {
    try {
      fromReserveUsdc = (await bringCashForApproval({ actorId: input.actorId, cover: fromReserve, operatingAccountId: operating.id, provider, source, payee: invoice.counterpartyName })).amount;
    } catch (error) {
      // Given back as it was before the claim: nothing was paid, so a flagged or awaiting payable stays so (review finding 3).
      await giveBackAfterClaim(invoice, `cash not brought back from the reserve: ${(error as Error).message}`, invoice.status === "processing" ? "held" : invoice.status);
      if (error instanceof PaymentsDisabledError) throw new ApprovalError("payments_off", error.message);
      if (!(error instanceof CashBackError)) throw error;
      if (error.code === "not_confirmed") throw new ApprovalError("insufficient_funds", error.message);
      const fee = route === "cctp" ? (quotes?.cctpFeeUsdc ?? null) : null;
      throw new ApprovalError(
        "insufficient_funds",
        `${error.message} ${cashShortMessage({ operatingUsdc: fromReserve.operatingBalance, reserveUsdc: null, feeUsdc: fee, what: "invoice" })}`
      );
    }
  }

  // The approvals that let it through are used by this payment, or nothing is sent (T6): approvals left open could send
  // it again on one approval after a failed transfer. This one, which pays it, is stored with them, as used (I4).
  if (approvals.length > 0) {
    try {
      await markApprovalsUsed(source, { by: input.actorId, payment });
    } catch (error) {
      await giveBackAfterClaim(invoice, `approvals not marked used: ${(error as Error).message}`);
      throw error;
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
        ...(paidAcrossChains(invoice.destinationChain) && !invoice.bankAccount
          ? { destinationChain: invoice.destinationChain as string, maxBridgeFeeUsdc: invoice.amount, ...(route ? { route } : {}) }
          : {}),
        // A vendor paid to its bank (bank payouts B7); a payout already sent is reconciled under its intent's route.
        ...(invoice.bankAccount ? { bank: bank ?? (await bankRouteFor(invoice)) } : {}),
        // From the owner's own wallet, only through its contract, from the agent's wallet (wallet treasury W11).
        ...(throughContract ? { spendingLimit: throughContract } : {}),
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
    await giveBackAfterClaim(invoice, (err as Error).message);
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
      agent_reasoning: `${invoice.agentReasoning ?? ""}${personPaymentNote(result.status, "approved and paid by a person")}${result.note}`,
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
    summary: approvalPaidSummary(result.status, invoice.amount, invoice.counterpartyName, result, invoice.currency, soleApprover, approvals.length > 0, addressGiverApproved),
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
      // A new payment to another chain: the route it took and both routes' fees, as an ap_pay entry records them. A bank
      // payout: BlindPay's quote and payout, and the account's bank and last four (bank payouts B10).
      ...(result.execution?.bankPayout && invoice.bankAccount
        ? { payout: { route: "bank", ...result.execution.bankPayout, rail: "spei", bankAccount: { bankCode: invoice.bankAccount.bankCode, last4: invoice.bankAccount.last4 } } }
        : payout
          ? { payout }
          : {}),
      // The person who entered it approved it, as the workspace's only approver.
      ...(soleApprover ? { soleApprover: true } : {}),
      // The person who gave the address, or asked for it, made its first payment as the workspace's only approver.
      ...(addressGiverApproved ? { addressGiverApproved: true } : {}),
      // The address's first payment, which this person stood behind beside whoever gave the address (new payee check N4).
      ...(firstPayment ? { firstPayment: true } : {}),
      // Above the figure: the two approvals, the earlier first (two approvals T7).
      ...(approvals.length > 0 ? { approvals: approvals.map((approval) => ({ by: approval.by, at: approval.at })), twoApprovalsAbove: above } : {}),
      ...(fewApprovers ? { fewApprovers: true } : {}),
      // What came back from the reserve first, recorded in its own `cash_brought_back` entry (approval cash R4).
      ...(fromReserveUsdc !== null ? { fromReserveUsdc } : {}),
      ...input.provenance,
    },
  });

  return {
    status: result.status,
    txRef: result.txRef,
    note: result.note,
    ...(fromReserveUsdc !== null ? { fromReserveUsdc } : {}),
    ...(mayExist ? { checkedFirst: true as const } : {}),
    ...(sent
      ? {
          paid: {
            amount: result.amountPaid ?? invoice.amount,
            currency: invoice.currency,
            payee: invoice.counterpartyName,
            ...(provider.mode === "live" ? {} : { simulated: true as const }),
          },
        }
      : {}),
  };
}

/** Both routes' figures for a payout to another chain, read now: CCTP's fee, and Gateway's fee with its balance. */
interface PayoutQuotes {
  cctpFeeUsdc: number | null;
  gateway: GatewayFigures | null;
}

/** Reads both routes' figures. A figure that cannot be read is null: reading it never stops an approval by itself. */
async function readPayoutQuotes(
  chain: string,
  amount: number,
  read: {
    bridgeFee: (chain: string, amount: number) => Promise<BridgeFee>;
    gatewayQuote: (chain: string, amount: number) => Promise<GatewayQuote | null>;
  }
): Promise<PayoutQuotes> {
  const [cctpFeeUsdc, gateway] = await Promise.all([
    read.bridgeFee(chain, amount).then(
      (fee) => fee.feeUsdc,
      () => null
    ),
    read.gatewayQuote(chain, amount).catch(() => null),
  ]);
  return { cctpFeeUsdc, gateway: gateway ? { feeUsdc: gateway.feeUsdc, balanceUsdc: gateway.balanceUsdc } : null };
}

/**
 * What an approved payment to another chain records of its route (approval payout route P1, P5): the route it takes,
 * by the agent's rule or the one an earlier attempt took, that route's fee, the Gateway balance for a Gateway payout,
 * and both routes' fees.
 */
function payoutRecord(chain: string, route: CrossChainRoute, quotes: PayoutQuotes): Record<string, unknown> {
  return {
    chain,
    route,
    domain: chainById(chain).domain,
    feeUsdc: route === "gateway" ? (quotes.gateway?.feeUsdc ?? null) : quotes.cctpFeeUsdc,
    ...(route === "gateway" && quotes.gateway ? { gatewayBalanceUsdc: quotes.gateway.balanceUsdc } : {}),
    quotes: { cctpFeeUsdc: quotes.cctpFeeUsdc, gatewayFeeUsdc: quotes.gateway?.feeUsdc ?? null },
  };
}

/** Why a Gateway payout is refused before it is sent (P2): what the balance holds against what it needs. */
function gatewayShortMessage(holds: number | null, feeUsdc: number | null): string {
  return holds === null || feeUsdc === null
    ? "Circle gave no Gateway figures for this payout, so its balance cannot be checked. Try again in a moment."
    : `The Gateway balance, ${holds} USDC, does not cover this payout and its ${feeUsdc} USDC fee. Fund Gateway on Treasury first.`;
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

/**
 * Gives a claimed payable back to the waiting queue when what follows the claim did not happen: as held, or as it was
 * when nothing was paid (approval cash review finding 3). Best effort.
 */
async function giveBackAfterClaim(invoice: Pick<LoadedInvoice, "id" | "agentReasoning">, why: string, status: string = "held"): Promise<void> {
  try {
    const rollback = await db()
      .from("invoices")
      .update({ status, agent_reasoning: `${invoice.agentReasoning ?? ""} [approval interrupted: ${why}]` })
      .eq("id", invoice.id);
    if (rollback.error) console.error(`approval: rollback to ${status} failed after the claim`, invoice.id, rollback.error.message);
  } catch (rollbackError) {
    console.error(`approval: rollback to ${status} failed after the claim`, invoice.id, (rollbackError as Error).message);
  }
}

/** `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none. */
export async function rejectInvoice(input: { actorId: string; invoiceId: string; reason?: string; provenance?: Provenance; forVerdict?: boolean }): Promise<void> {
  const orgId = currentOrgId();
  if (!input.forVerdict) await refuseUntilVerdict(input.invoiceId, "reject");
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

/**
 * `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none.
 * `reason`, when the person gave one, is kept in the ledger as a rejection's is (capability and reasons R10).
 */
export async function returnInvoice(input: { actorId: string; invoiceId: string; reason?: string; provenance?: Provenance; forVerdict?: boolean }): Promise<void> {
  const orgId = currentOrgId();
  if (!input.forVerdict) await refuseUntilVerdict(input.invoiceId, "return");
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

  const reason = trimReason(input.reason);
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "ap",
    action: "approval_returned",
    summary: "An invoice was returned, undecided",
    detail: { by: input.actorId, invoiceId: input.invoiceId, ...(reason === undefined ? {} : { reason }), ...input.provenance },
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
