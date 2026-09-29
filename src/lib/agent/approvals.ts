import { currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { getChainProvider } from "../circle";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { payInvoice, syncOperatingBalance } from "./pay";

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
  | "payment_in_flight";

/** Every message except `insufficient_funds`, whose text names the actual balance. */
const MESSAGES: Record<Exclude<ApprovalErrorCode, "insufficient_funds">, string> = {
  already_decided: "Someone else decided this invoice a moment ago.",
  self_approval: "You created this invoice, so someone else must approve it.",
  high_risk: "This counterparty is screened high risk. Clear it in Compliance first.",
  no_operating_account: "This workspace has no operating account.",
  invoice_not_found: "That invoice is not waiting for a decision.",
  payment_in_flight: "A payment for this invoice was already sent. Approve and pay records it.",
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
}

/**
 * Whether a payment for the invoice was already sent, so that rejecting or
 * returning it would misrecord a real transfer: the intent is confirmed,
 * pending or being submitted, or it has a provider id and a recorded error —
 * a reconcile that could not read the provider, not a failure the provider
 * reported. A provider-reported failure (`failed`, no error of our own) or no
 * intent at all means nothing moved.
 */
function paymentWasSent(intent: IntentState | null): boolean {
  if (!intent) return false;
  if (intent.status === "confirmed" || intent.status === "pending" || intent.status === "submitting") return true;
  return intent.provider_tx_id !== null && intent.last_error !== null;
}

/** Whether `executePayment` would reconcile rather than transfer: a confirmed intent, or one with a provider id. */
function transferExists(intent: IntentState | null): boolean {
  return intent !== null && (intent.status === "confirmed" || intent.provider_tx_id !== null);
}

/** The invoice's payment intent, keyed as `executePayment` keys it (source type and id), or null. */
async function paymentIntentOf(invoiceId: string): Promise<IntentState | null> {
  const result = await db()
    .from("payment_intents")
    .select("status, provider_tx_id, last_error")
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
}

/** Every payable currently waiting for a person's decision — held, flagged, awaiting more information, or claimed by someone else right now. */
export async function listWaitingPayables(): Promise<WaitingPayable[]> {
  const rows = unwrap(
    await db()
      .from("invoices")
      .select("id, amount, due_date, status, agent_reasoning, decided_at, created_by, reviewed_at, counterparty_id, counterparties(name, risk_level)")
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
    counterparties: { name: string; risk_level: string } | null;
  }>;

  const intents = new Map<string, IntentState>();
  if (rows.length > 0) {
    const found = unwrap(
      await db()
        .from("payment_intents")
        .select("source_id, status, provider_tx_id, last_error")
        .eq("source_type", "invoice")
        .in("source_id", rows.map((row) => row.id))
    ) as Array<IntentState & { source_id: string }>;
    for (const intent of found) intents.set(intent.source_id, intent);
  }

  const now = Date.now();
  return rows.map((row) => ({
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
    paymentSent: paymentWasSent(intents.get(row.id) ?? null),
  }));
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
}

async function loadWaitingPayable(invoiceId: string): Promise<LoadedInvoice> {
  const result = await db()
    .from("invoices")
    .select("id, amount, status, direction, agent_reasoning, created_by, counterparty_id, counterparties(name, risk_level, address)")
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
  };
}

/** The operating account, or `null` when the workspace has none configured yet. */
async function operatingAccount(): Promise<{ id: string; balance: number } | null> {
  const result = await db().from("accounts").select("id, balance").eq("kind", "operating").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { id: string; balance: string } | null;
  return row ? { id: row.id, balance: num(row.balance) } : null;
}

/** The `approval_paid` entry's summary, which says what actually happened to the transfer. */
function approvalPaidSummary(status: "paid" | "matched" | "held", amount: number, name: string): string {
  if (status === "paid") return `Approved and paid ${amount} USDC to ${name}`;
  if (status === "matched") return `Approved; payment of ${amount} USDC to ${name} submitted`;
  return `Approved; payment of ${amount} USDC to ${name} failed`;
}

export async function approveAndPay(
  input: { actorId: string; invoiceId: string }
): Promise<{ status: "paid" | "matched" | "held"; txRef: string | null; note: string }> {
  const orgId = currentOrgId();
  const invoice = await loadWaitingPayable(input.invoiceId);

  // Early refusals, before any claim — none of these contend for the row.
  if (invoice.createdBy === input.actorId) raise("self_approval");
  if (invoice.riskLevel === "high") raise("high_risk");

  const operating = await operatingAccount();
  if (!operating) raise("no_operating_account");

  // A transfer that already exists is reconciled, never sent again, so the
  // balance — already lower by this very payment — is not the question.
  const provider = getChainProvider();
  if (!transferExists(await paymentIntentOf(invoice.id))) {
    const balance = provider.mode === "live" ? await syncOperatingBalance(operating.id) : operating.balance;
    if (balance < invoice.amount) {
      throw new ApprovalError("insufficient_funds", `The operating account holds ${balance} USDC, less than this invoice.`);
    }
  }

  const claim = await db()
    .rpc("claim_invoice_decision", { p_invoice_id: invoice.id, p_by: input.actorId, p_decision: "approve" })
    .single();
  if (claim.error) raiseFromClaim(claim.error);

  const previous = invoice.status;

  let result;
  try {
    result = await payInvoice(
      { invoiceId: invoice.id, counterpartyId: invoice.counterpartyId, address: invoice.address, amount: invoice.amount },
      { provider, operating: { id: operating.id } }
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

  const now = new Date().toISOString();
  const update = await db()
    .from("invoices")
    .update({
      status: result.status,
      agent_reasoning: `${invoice.agentReasoning ?? ""} [approved and paid by a person]${result.note}`,
      decided_at: now,
      settled_at: result.status === "paid" ? now : null,
      tx_ref: result.txRef,
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
    summary: approvalPaidSummary(result.status, invoice.amount, invoice.counterpartyName),
    detail: {
      by: input.actorId,
      invoiceId: invoice.id,
      counterpartyId: invoice.counterpartyId,
      amount: invoice.amount,
      overrode: previous,
      txRef: result.txRef,
      status: result.status,
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
