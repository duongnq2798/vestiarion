import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { getChainProvider, type Stablecoin } from "../circle";
import { confirmCounterpartyAddress, sameAddress } from "../counterparty-address";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { listLedgerEntriesForTargets } from "../ledger";
import { explainPayable, presentReasoning } from "../reasoning-copy";
import { isTerminalFailure } from "../payments";
import { payInvoice, syncOperatingBalance } from "./pay";
import { invoiceDiscount, type InvoiceDiscount } from "./payment-timing";
import { paidAcrossChains, payeeChain } from "../payee-chains";
import { bridgeFee, type BridgeFee } from "../circle/cctp";
import { gatewayQuoter, type GatewayQuote } from "../circle/gateway-quote";
import { isSoleApprover } from "./sole-approver";

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
  | "address_changed"
  | "bridge_unsupported_token"
  | "nothing_to_add"
  | "invoice_changed";

/** Every message except `insufficient_funds`, whose text names the actual balance. */
const MESSAGES: Record<Exclude<ApprovalErrorCode, "insufficient_funds">, string> = {
  already_decided: "Someone else decided this invoice a moment ago.",
  self_approval: "You created this invoice, so someone else must approve it.",
  high_risk: "This counterparty is screened high risk. Clear it in Compliance first.",
  no_operating_account: "This workspace has no operating account.",
  invoice_not_found: "That invoice is not waiting for a decision.",
  payment_in_flight: "A payment for this invoice was already sent. Approve and pay records it.",
  address_changed: "This counterparty's address changed after this page loaded. Check the new address and try again.",
  bridge_unsupported_token: "Only USDC crosses chains. This invoice is in EURC, and its payee is paid on another chain.",
  nothing_to_add: "Enter a PO reference or tick Goods or services received.",
  invoice_changed: "This invoice changed a moment ago. Reload the page to see it.",
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
export function paymentWasSent(intent: IntentState | null): boolean {
  if (!intent) return false;
  if (intent.status === "confirmed" || intent.status === "pending" || intent.status === "submitting") return true;
  if (intent.provider_tx_id === null) return false;
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
 * checked for it.
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
}

/** What a person added to a payable the agent stopped on: only facts it lacked (complete held invoice R2). */
export interface AddedDetails {
  poReference?: string;
  goodsReceived?: true;
}

/** The purchase order and goods receipt a decision's entry recorded in `observed`, each only when it recorded one. */
function recordedFacts(entry: { detail: Record<string, unknown> } | null): { poReference?: string | null; goodsReceived?: boolean } {
  const observed = entry?.detail.observed;
  if (!observed || typeof observed !== "object") return {};
  const facts = observed as Record<string, unknown>;
  return {
    ...("poReference" in facts ? { poReference: typeof facts.poReference === "string" ? facts.poReference : null } : {}),
    ...("goodsReceived" in facts ? { goodsReceived: facts.goodsReceived === true } : {}),
  };
}

/** What is on the invoice now that its decision recorded as missing: the changes the follow-up reopens it on. */
function addedSince(
  recorded: { poReference?: string | null; goodsReceived?: boolean },
  onFile: { poReference: string | null; goodsReceived: boolean }
): AddedDetails | null {
  const added: AddedDetails = {};
  if (recorded.poReference === null && onFile.poReference !== null) added.poReference = onFile.poReference;
  if (recorded.goodsReceived === false && onFile.goodsReceived) added.goodsReceived = true;
  return Object.keys(added).length > 0 ? added : null;
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

  const now = Date.now();
  return rows.map((row) => {
    const intent = intents.get(row.id) ?? null;
    const decision = entries.find((entry) => entry.detail.invoiceId === row.id && entry.detail.observed !== undefined) ?? null;
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
  soleApprover = false
): string {
  const discounted = payment.discountTaken > 0;
  const sent = discounted ? payment.amountPaid : amount;
  const less = discounted ? ` (${amount} ${currency} less a ${payment.discountTaken} ${currency} early-payment discount)` : "";
  const own = soleApprover ? ` ${SOLE_APPROVER_NOTE}` : "";
  if (status === "paid") return `Approved and paid ${sent} ${currency} to ${name}${less}${own}`;
  if (status === "matched") return `Approved; payment of ${sent} ${currency} to ${name} submitted${less}${own}`;
  return `Approved; payment of ${sent} ${currency} to ${name} failed${less}${own}`;
}

/** How a ledger summary marks an approval by the person who entered the record, as the workspace's only approver (sole approver R4). */
export const SOLE_APPROVER_NOTE = "(entered and approved by the workspace's only approver)";

/**
 * `shownAddress` is the counterparty address the approval card showed the
 * person. When given, the approval is refused if it is no longer the
 * counterparty's, and a changed address no one had confirmed is confirmed by
 * this approval (spec 2026-09-30-counterparty-address-edit E4): the person
 * approved a payment to it, having seen it.
 */
export async function approveAndPay(
  input: { actorId: string; invoiceId: string; shownAddress?: string },
  options: {
    bridgeFee?: (chain: string, amount: number) => Promise<BridgeFee>;
    gatewayQuote?: (chain: string, amount: number) => Promise<GatewayQuote | null>;
  } = {}
): Promise<{ status: "paid" | "matched" | "held"; txRef: string | null; note: string }> {
  const orgId = currentOrgId();
  const invoice = await loadWaitingPayable(input.invoiceId);

  // Early refusals, before any claim — none of these contend for the row.
  // Whoever entered the invoice may approve it only as the workspace's sole
  // approver; the claim asks the database the same question again.
  const soleApprover = invoice.createdBy === input.actorId;
  if (soleApprover && !(await isSoleApprover(input.actorId))) raise("self_approval");
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
  const intent = await paymentIntentOf(invoice.id);
  const alreadySent = transferExists(intent);
  if (!alreadySent && invoice.currency === "USDC") {
    const balance = provider.mode === "live" ? await syncOperatingBalance(operating.id) : operating.balance;
    if (balance < invoice.amount) {
      throw new ApprovalError("insufficient_funds", `The operating account holds ${balance} USDC, less than this invoice.`);
    }
  }
  // A EURC payable is paid from the wallet's EURC, read from the chain. A
  // sandbox simulates its payments and has no EURC balance to check (E7).
  if (!alreadySent && invoice.currency === "EURC" && provider.mode === "live" && provider.getTokenBalance) {
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
    summary: approvalPaidSummary(result.status, invoice.amount, invoice.counterpartyName, result, invoice.currency, soleApprover),
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
 * another person's addition in between wins (R3). `reviewed_by` records a person's hand on it (R5).
 */
export async function addInvoiceDetails(input: {
  actorId: string;
  invoiceId: string;
  poReference: string | null;
  goodsReceived: boolean;
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
    detail: { by: input.actorId, invoiceId: invoice.id, counterpartyId: invoice.counterpartyId, added },
  });
  return added;
}

/** "purchase order PO-100", "goods received", or both joined. */
function addedWords(added: AddedDetails): string {
  return [added.poReference !== undefined ? `purchase order ${added.poReference}` : null, added.goodsReceived ? "goods received" : null]
    .filter((words): words is string => words !== null)
    .join(" and ");
}
