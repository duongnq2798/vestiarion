import { currentOrgId } from "../context";
import { db } from "../dal";
import { getChainProvider } from "../circle";
import { payeeNotReady } from "../counterparty-address";
import { firstPaymentCheck } from "../new-payee-facts";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { listLedgerEntriesForTargets } from "../ledger";
import type { Provenance } from "../provenance";
import {
  lastAttemptOf,
  lookForUnknownSend,
  paymentWasSent,
  SOLE_APPROVER_NOTE,
  transferExists,
  transferUnknown,
  unknownSendMessage,
  type IntentState,
} from "./approvals";
import { releaseHeldMilestone } from "./orchestrator";
import { HELD_FOR_BUDGET } from "./outflow-budget";
import { payoutAddress, syncOperatingBalance } from "./pay";
import { HELD_BECAUSE_PAUSED } from "./pause";
import { isSoleApprover } from "./sole-approver";
import { PAYMENTS_OFF, paymentsDisabled } from "../payments-switch";
import { readTwoApprovalsAbove } from "../approval-policy";
import { TWO_APPROVALS_RULE } from "../two-approvals";
import { SECOND_OF_TWO_NOTE } from "./approvals";
import { clearApprovals, giveApproval, mayGiveApproval, standingApprovals, useApprovals, type GivenApproval, type PaymentSource } from "./second-approval";

/**
 * A person decides a held milestone (docs/superpowers/specs/2026-10-02-held-milestone-actions-design.md): every
 * held row on Contractors says what it waits for (`heldReason`), and a person may pay it now
 * (`payHeldMilestone`) or close it without paying (`closeMilestone`). Every export runs inside an
 * organization scope.
 *
 * Pay now enforces what the agent's release does: a contractor screened high risk, above its limit, with no
 * address or an address no one has confirmed is refused before anything else. It is not held by the pause or
 * the agent's spending limit, as a person's Approve and pay on a payable is not. A transfer Circle ended in a
 * terminal failure is sent again (`retryTerminalFailure`); one that may still settle is only reconciled.
 * Overriding a hold the agent chose (rather than sending again a release it decided) needs someone other than
 * whoever added the milestone, as approving a held payable does — unless they are the workspace's sole approver
 * (docs/superpowers/specs/2026-10-03-sole-approver-design.md), and then the ledger entry says so.
 *
 * Above the workspace's figure for two approvals (docs/superpowers/specs/2026-10-05-two-approvals-design.md T4–T6), the
 * first Pay now records an approval and sends nothing; another person's Pay now pays it. Close clears the approvals.
 *
 * Both decisions are claimed through `claim_milestone_decision` (migration 0059) first, so two people never
 * decide one milestone at once; the milestone stays `held` while claimed, where the agent's cycle never looks.
 */

export type MilestoneDecisionErrorCode =
  | "milestone_not_found"
  | "not_held"
  | "already_claimed"
  | "not_verified"
  | "self_approval"
  | "new_payee_self"
  | "high_risk"
  | "above_limit"
  | "no_address"
  | "address_unconfirmed"
  | "no_operating_account"
  | "insufficient_funds"
  | "payment_in_flight"
  | "escrow_locked"
  | "reason_required"
  | "payments_off"
  | "payment_unknown"
  | "already_approved";

const MESSAGES: Record<MilestoneDecisionErrorCode, string> = {
  milestone_not_found: "That milestone is not in this workspace.",
  not_held: "That milestone is not held any more. Reload the page to see where it is.",
  already_claimed: "Someone is deciding this milestone right now. Reload the page in a minute.",
  not_verified: "This milestone is not verified. Verify the work first.",
  self_approval: "You added this milestone, so someone else must approve paying it.",
  new_payee_self: "You gave this payee's address, so someone else must approve its first payment.",
  high_risk: "This contractor is screened high risk. Review the match on Counterparties first.",
  above_limit: "This milestone is above the contractor's limit. Raise the limit, or review the match, on Counterparties first.",
  no_address: "This contractor has no address to pay yet. Add it on Counterparties first.",
  address_unconfirmed: "This contractor's address changed and no one has confirmed it. Confirm it on Counterparties first.",
  no_operating_account: "This workspace has no operating account.",
  insufficient_funds: "The operating account holds less than this milestone.",
  payment_in_flight: "A transfer for this milestone may still settle. Pay now records it; nothing is sent twice.",
  escrow_locked: "This milestone's USDC is locked in escrow. Refund the hold from its refund date first, then close it.",
  reason_required: "Say why it is closed without paying, in up to 500 characters.",
  payments_off: PAYMENTS_OFF,
  payment_unknown: unknownSendMessage("milestone", null),
  already_approved: "You approved this already. Another person who can approve payments must approve it to pay.",
};

export class MilestoneDecisionError extends Error {
  constructor(
    readonly code: MilestoneDecisionErrorCode,
    message: string = MESSAGES[code]
  ) {
    super(message);
    this.name = "MilestoneDecisionError";
  }
}

function raise(code: MilestoneDecisionErrorCode, message?: string): never {
  throw new MilestoneDecisionError(code, message);
}

/** What a held milestone waits for, worst first: the reason line on its row. */
export type HeldReasonKind =
  | "in_flight"
  | "unknown"
  | "high_risk"
  | "unscreened"
  | "screening_limit"
  | "above_limit"
  | "address_unconfirmed"
  | "no_address"
  | "transfer_failed"
  | "escrow"
  | "paused"
  | "outflow_budget"
  | "new_payee"
  | "two_approvals"
  | "agent_held";

export interface HeldReason {
  kind: HeldReasonKind;
  /** A few words, on the row itself. */
  hint: string;
  /** The sentence, once the row is opened. */
  text: string;
  /** Where to act on it, as a path under the workspace. */
  link: { label: string; path: string } | null;
  /** Pay now is offered: nothing the agent's release enforces stands in the way. */
  canPay: boolean;
  /** Close without paying is offered: no transfer for it can still settle. */
  canClose: boolean;
  /** Pay now overrides a hold the agent chose, so someone other than whoever added the milestone approves it. */
  override: boolean;
}

export interface HeldFacts {
  amount: number;
  agentReasoning: string | null;
  contractor: {
    name: string;
    riskLevel: string;
    riskNotes: string | null;
    paymentLimit: number | null;
    baselinePaymentLimit: number | null;
    address: string | null;
    addressChangedAt: string | null;
    addressConfirmedAt: string | null;
  };
  intent: IntentState | null;
  /** The newest ledger entry about the milestone, if any. */
  lastEntry: { action: string; detail: Record<string, unknown> } | null;
  live: boolean;
}

const COUNTERPARTIES = { label: "Counterparties", path: "/counterparties" };

const HINTS: Record<HeldReasonKind, string> = {
  in_flight: "Transfer to record",
  unknown: "Transfer to look for",
  high_risk: "Screened high risk",
  unscreened: "Not screened yet",
  screening_limit: "Limit lowered by a screening match",
  above_limit: "Above the contractor's limit",
  address_unconfirmed: "Address to confirm",
  no_address: "No address yet",
  transfer_failed: "Circle did not send it",
  escrow: "Escrow hold to check",
  paused: "Held while the agent was paused",
  outflow_budget: "Past the agent's spending limit",
  new_payee: "First payment to a new address",
  two_approvals: "Needs two approvals",
  agent_held: "The agent held it",
};
const usdc = (value: number) => `${value} USDC`;

export function heldReason(facts: HeldFacts): HeldReason {
  const reason = reasonOf(facts);
  return { ...reason, hint: HINTS[reason.kind] };
}

function reasonOf(facts: HeldFacts): Omit<HeldReason, "hint"> {
  const { contractor, intent } = facts;
  const name = contractor.name;
  const blocked = (kind: HeldReasonKind, text: string): Omit<HeldReason, "hint"> => ({ kind, text, link: COUNTERPARTIES, canPay: false, canClose: true, override: false });

  // A transfer that went out, or may still: recorded, never sent twice, and never closed over.
  if (intent?.status === "confirmed") {
    return { kind: "in_flight", text: "Its transfer went through, but it is not marked paid yet. Pay now records it; nothing is sent twice.", link: null, canPay: true, canClose: false, override: false };
  }
  // Circle never answered its send (payment safety R1, R6): Pay now and Close look for it on Circle first. A send
  // again may be a new payment, so whatever would hold it with no transfer still holds Pay now, and its override.
  if (transferUnknown(intent)) {
    const underlying = reasonOf({ ...facts, intent: null });
    const looks =
      "Circle did not answer when its transfer was sent, so it may have taken it. Pay now and Close look for it on Circle first: Pay now records it if Circle has it, and sends it only once Circle shows none.";
    return {
      kind: "unknown",
      text: underlying.canPay ? looks : `${looks} ${underlying.text}`,
      link: underlying.canPay ? null : underlying.link,
      canPay: underlying.canPay,
      canClose: true,
      override: underlying.override,
    };
  }
  if (paymentWasSent(intent)) {
    return { kind: "in_flight", text: "A transfer for it is on its way. Pay now records it once Circle confirms it; nothing is sent twice.", link: null, canPay: true, canClose: false, override: false };
  }

  // What the agent's release enforces, and Pay now with it.
  if (contractor.riskLevel === "high") {
    return blocked("high_risk", `${name} is screened high risk, so it is not paid. Review the match on Counterparties: once the screening changes, the agent decides it again.`);
  }
  // Screening could not give a verdict yet (unscreened hold R4, R5): the agent waits for one; a person may pay it now.
  if (contractor.riskLevel === "unscreened") {
    return {
      kind: "unscreened",
      text: `${name} has not been screened yet, so the agent pays it nothing. Screening runs again at every cycle; once it gives a verdict, the agent decides this milestone again. Pay now pays it anyway.`,
      link: COUNTERPARTIES,
      canPay: true,
      canClose: true,
      override: true,
    };
  }
  if (contractor.paymentLimit != null && facts.amount > contractor.paymentLimit) {
    const cut = contractor.riskNotes && contractor.baselinePaymentLimit != null && contractor.paymentLimit < contractor.baselinePaymentLimit;
    return cut
      ? blocked(
          "screening_limit",
          `A screening match lowered ${name}'s limit to ${usdc(contractor.paymentLimit)}, below this milestone's ${usdc(facts.amount)}. Review the match on Counterparties: once the limit changes, the agent decides it again.`
        )
      : blocked("above_limit", `${usdc(facts.amount)} is above ${name}'s limit of ${usdc(contractor.paymentLimit)}. Raise the limit on Counterparties, and the agent decides it again.`);
  }
  const waiting = payeeNotReady({ address: contractor.address, address_changed_at: contractor.addressChangedAt, address_confirmed_at: contractor.addressConfirmedAt }, facts.live);
  if (waiting === "unconfirmed") return blocked("address_unconfirmed", `${name}'s address changed and no one has confirmed it. Confirm it on Counterparties.`);
  if (waiting === "no_address") return blocked("no_address", `${name} has no address to pay yet. Add it on Counterparties.`);

  const attempt = lastAttemptOf(intent);
  if (attempt?.state === "failed") {
    return { kind: "transfer_failed", text: `Circle did not send it: ${attempt.reason}. Nothing moved. Pay now sends it again.`, link: null, canPay: true, canClose: true, override: false };
  }
  if (intent && intent.status === "failed") {
    const error = intent.last_error ? `: ${intent.last_error}` : "";
    return { kind: "transfer_failed", text: `The transfer did not reach Circle${error}. Nothing moved. Pay now sends it.`, link: null, canPay: true, canClose: true, override: false };
  }

  const escrow = /\[not paid: ([^\]]+)\]\s*$/.exec(facts.agentReasoning ?? "")?.[1];
  if (escrow) return { kind: "escrow", text: `Not paid: ${escrow}.`, link: null, canPay: true, canClose: true, override: false };

  const detail = facts.lastEntry?.detail ?? {};
  const execution = (detail.execution ?? {}) as Record<string, unknown>;
  if (execution.heldBecause === HELD_BECAUSE_PAUSED) {
    return { kind: "paused", text: "The agent decided to pay it while it was paused, so nothing was sent. Pay now sends it.", link: null, canPay: true, canClose: true, override: false };
  }
  // The same limit on Arc (onchain spending limit §4): a person's Pay now is a plain transfer, not through the contract.
  if (detail.guardrailRule === "workspace.onchain_limit" || detail.guardrailRule === "workspace.onchain_limit_route") {
    return {
      kind: "outflow_budget",
      text:
        detail.guardrailRule === "workspace.onchain_limit"
          ? "The spending limit contract on Arc would have refused it. Pay now pays it; a person's payment does not go through that contract."
          : "The agent's spending limit is enforced on Arc, and this release cannot go through its contract. Pay now pays it.",
      link: { label: "Spending limit on Treasury", path: "/console" },
      canPay: true,
      canClose: true,
      override: true,
    };
  }
  // The first payment to an address one person alone stands behind (new payee check N3): someone else pays it now.
  if (detail.guardrailRule === "counterparty.new_payee") {
    return {
      kind: "new_payee",
      text: `This would be the first payment to ${name}'s address, and only one person stands behind it. Someone other than whoever gave the address pays it now; after that, the agent pays this address on its own.`,
      link: COUNTERPARTIES,
      canPay: true,
      canClose: true,
      override: true,
    };
  }
  // Above the workspace's figure for two approvals (two approvals T3, T4): two people pay it now, each with Pay now.
  if (detail.guardrailRule === TWO_APPROVALS_RULE) {
    const observed = (detail.observed ?? {}) as Record<string, unknown>;
    const figure = observed.twoApprovalsAbove != null ? `above ${Number(observed.twoApprovalsAbove)} USDC` : "above the workspace's figure";
    return {
      kind: "two_approvals",
      text: `Payments ${figure} need two approvals in this workspace. The first Pay now records an approval and sends nothing; another person's Pay now pays it.`,
      link: null,
      canPay: true,
      canClose: true,
      override: true,
    };
  }
  if (detail.guardrailRule === "workspace.outflow_budget" || execution.heldBecause === HELD_FOR_BUDGET) {
    return {
      kind: "outflow_budget",
      text: "Paying it would have taken the agent past its spending limit. Pay now pays it; a person's payment is not held by that limit.",
      link: { label: "Spending limit on Treasury", path: "/console" },
      canPay: true,
      canClose: true,
      override: true,
    };
  }
  return {
    kind: "agent_held",
    text: "The agent chose to hold it; its reasoning is below. Pay now overrides that, or verify it again for the agent to decide again.",
    link: null,
    canPay: true,
    canClose: true,
    override: true,
  };
}

/** The payment intents of these milestones, by milestone id: what each held row's reason reads. */
export async function milestoneIntents(milestoneIds: string[]): Promise<Map<string, IntentState>> {
  if (milestoneIds.length === 0) return new Map();
  const read = await db()
    .from("payment_intents")
    .select("source_id, status, provider_tx_id, last_error, provider_state, failure_reason")
    .eq("source_type", "milestone")
    .in("source_id", milestoneIds);
  if (read.error) throw new Error(read.error.message);
  const rows = (read.data ?? []) as Array<IntentState & { source_id: string }>;
  return new Map(rows.map(({ source_id, ...intent }) => [source_id, intent]));
}

interface LoadedMilestone {
  id: string;
  title: string;
  amount: number;
  status: string;
  verified: boolean;
  createdBy: string | null;
  agentReasoning: string | null;
  escrowState: string | null;
  escrowRefundAfter: string | null;
  contractorId: string;
  facts: HeldFacts;
}

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0));
const numOrNull = (value: unknown) => (value == null ? null : num(value));

async function loadMilestone(milestoneId: string, live: boolean): Promise<LoadedMilestone> {
  const found = await db()
    .from("milestones")
    .select("*, counterparties(id, name, risk_level, risk_notes, payment_limit, baseline_payment_limit, address, address_changed_at, address_confirmed_at)")
    .eq("id", milestoneId)
    .maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const milestone = found.data as Record<string, unknown> | null;
  if (!milestone) raise("milestone_not_found");
  const contractor = milestone.counterparties as Record<string, unknown>;

  const intentRead = await db()
    .from("payment_intents")
    .select("status, provider_tx_id, last_error, provider_state, failure_reason")
    .eq("source_type", "milestone")
    .eq("source_id", milestoneId)
    .maybeSingle();
  if (intentRead.error) throw new Error(intentRead.error.message);
  const entries = await listLedgerEntriesForTargets({ milestoneIds: [milestoneId] });
  const last = entries.find((entry) => !entry.action.startsWith("receipt_")) ?? null;

  const amount = num(milestone.amount);
  const agentReasoning = (milestone.agent_reasoning as string | null) ?? null;
  return {
    id: milestoneId,
    title: String(milestone.title),
    amount,
    status: String(milestone.status),
    verified: milestone.verified === true,
    createdBy: (milestone.created_by as string | null) ?? null,
    agentReasoning,
    escrowState: (milestone.escrow_state as string | null) ?? null,
    escrowRefundAfter: (milestone.escrow_refund_after as string | null) ?? null,
    contractorId: String(contractor.id),
    facts: {
      amount,
      agentReasoning,
      contractor: {
        name: String(contractor.name),
        riskLevel: String(contractor.risk_level ?? "unscreened"),
        riskNotes: (contractor.risk_notes as string | null) ?? null,
        paymentLimit: numOrNull(contractor.payment_limit),
        baselinePaymentLimit: numOrNull(contractor.baseline_payment_limit),
        address: (contractor.address as string | null) ?? null,
        addressChangedAt: (contractor.address_changed_at as string | null) ?? null,
        addressConfirmedAt: (contractor.address_confirmed_at as string | null) ?? null,
      },
      intent: (intentRead.data as IntentState | null) ?? null,
      lastEntry: last ? { action: last.action, detail: last.detail } : null,
      live,
    },
  };
}

/** `claim_milestone_decision` raises `<code>: <detail>` (the 0025 pattern); anything else is rethrown as is. */
async function claim(milestoneId: string, actorId: string): Promise<void> {
  const claimed = await db().rpc("claim_milestone_decision", { p_milestone_id: milestoneId, p_by: actorId }).single();
  if (!claimed.error) return;
  const code = /^([a-z_]+):/.exec(claimed.error.message)?.[1];
  if (code === "milestone_not_found" || code === "not_held" || code === "already_claimed") raise(code);
  throw new Error(claimed.error.message);
}

const RELEASED = { decision_claimed_by: null, decision_claimed_at: null };

/**
 * Pays a held milestone now, as a person's decision: refused before any claim when the contractor is screened
 * high risk, above its limit, or has no confirmed address, or when the operating account holds too little for a
 * new transfer; then released as the agent releases it (from escrow when it is locked there). A transfer that
 * already exists is only reconciled. `provenance`, when given, names the surface the person acted from
 * (integrations design R3); the console gives none.
 */
export async function payHeldMilestone(input: {
  actorId: string;
  milestoneId: string;
  provenance?: Provenance;
}): Promise<{ status: string; txRef: string | null; note: string }> {
  const orgId = currentOrgId();
  const provider = getChainProvider();
  const milestone = await loadMilestone(input.milestoneId, provider.mode === "live");
  const contractorAddress = milestone.facts.contractor.address;
  if (milestone.status !== "held") raise("not_held");
  if (!milestone.verified) raise("not_verified");

  const reason = heldReason(milestone.facts);
  const alreadySent = transferExists(milestone.facts.intent);
  // Nothing new is paid while payments are switched off (payment safety S4); a transfer already sent is still recorded (S8).
  if (!alreadySent && (await paymentsDisabled())) raise("payments_off");
  // A send Circle never answered is sent again under its key, which may be a new payment (payment safety R3): it is
  // judged as one, by what would hold it if no transfer existed, and only the funds check is skipped.
  const unknown = transferUnknown(milestone.facts.intent);
  const blocking = unknown ? heldReason({ ...milestone.facts, intent: null }) : reason;
  // Above the workspace's figure a payment needs two people's approval (two approvals T4); a transfer already sent is
  // only recorded, on one approval (T6).
  const above = alreadySent ? null : await readTwoApprovalsAbove(db());
  const twoNeeded = above !== null && milestone.amount > above;
  // A first payment to an address, and who gave it (new payee check N4).
  const firstPayment = !alreadySent && provider.mode === "live" ? await firstPaymentCheck(db(), { id: milestone.contractorId, address: contractorAddress }) : null;
  // Whoever added it, and whoever gave a first payment's address.
  const excluded = [milestone.createdBy, firstPayment?.addressBy ?? null];
  let soleApprover = false;
  let fewApprovers = false;
  // A transfer that already exists is recorded whatever stands in the way now: nothing new can move.
  if (!alreadySent) {
    const blocked: Partial<Record<HeldReasonKind, MilestoneDecisionErrorCode>> = {
      high_risk: "high_risk",
      screening_limit: "above_limit",
      above_limit: "above_limit",
      no_address: "no_address",
      address_unconfirmed: "address_unconfirmed",
    };
    const code = blocked[blocking.kind];
    if (code) raise(code);
    if (twoNeeded) {
      // Either of them gives one of the two approvals only when fewer than two others can (T5).
      if (excluded.includes(input.actorId)) {
        if (!(await mayGiveApproval({ actorId: input.actorId, excluded }))) raise(milestone.createdBy === input.actorId ? "self_approval" : "new_payee_self");
        fewApprovers = true;
      }
    } else if (blocking.override && milestone.createdBy === input.actorId) {
      if (!(await isSoleApprover(input.actorId))) raise("self_approval");
      soleApprover = true;
    }
  }
  // A first payment to an address needs someone other than whoever gave it, unless they decide alone (new payee check N4).
  if (!twoNeeded && firstPayment?.addressBy === input.actorId && !(await isSoleApprover(input.actorId))) raise("new_payee_self");

  // Two approvals (T4): the first is recorded and sends nothing; the second, by another person, pays.
  const source: PaymentSource = { type: "milestone", id: milestone.id };
  let approvals: GivenApproval[] = [];
  if (twoNeeded) {
    const payment = { amount: milestone.amount, currency: "USDC", address: contractorAddress };
    const standing = await standingApprovals(source, payment);
    const other = standing.find((approval) => approval.by !== input.actorId);
    if (!other) {
      if (standing.some((approval) => approval.by === input.actorId)) raise("already_approved");
      await giveApproval(source, input.actorId, payment);
      await appendLedgerEntryBestEffort(orgId, {
        actor: "human",
        domain: "contractor",
        action: "milestone_approval_given",
        summary: `Approved milestone "${milestone.title}" for ${milestone.facts.contractor.name}: ${milestone.amount} USDC; one more approval pays it (payments above ${above} USDC need two)`,
        detail: {
          by: input.actorId,
          milestoneId: milestone.id,
          counterpartyId: milestone.contractorId,
          amount: milestone.amount,
          currency: "USDC",
          address: contractorAddress,
          twoApprovalsAbove: above,
          // Given by whoever added it, or gave its address, as fewer than two others can approve (T5).
          ...(fewApprovers ? { fewApprovers: true } : {}),
          ...input.provenance,
        },
      });
      return { status: "approved", txRef: null, note: "" };
    }
    // Another person's approval stands, so this one pays. It is recorded beside it, and both are used once the
    // milestone is claimed (T6).
    const mine = standing.find((approval) => approval.by === input.actorId) ?? (await giveApproval(source, input.actorId, payment));
    approvals = [other, mine];
    if (excluded.includes(other.by)) fewApprovers = true;
  }

  const operatingRead = await db().from("accounts").select("id, balance").eq("kind", "operating").maybeSingle();
  if (operatingRead.error) throw new Error(operatingRead.error.message);
  const operating = operatingRead.data as { id: string; balance: string } | null;
  if (!operating) raise("no_operating_account");
  const operatingId = operating.id;
  // A release from escrow is paid by the hold, not the operating account.
  if (!alreadySent && !unknown && milestone.escrowState !== "funded") {
    const balance = provider.mode === "live" ? await syncOperatingBalance(operatingId) : num(operating.balance);
    if (balance < milestone.amount) raise("insufficient_funds", `The operating account holds ${balance} USDC, less than this milestone.`);
  }

  await claim(milestone.id, input.actorId);

  // The approvals that let it through are used by this payment (T6). Best effort: the claim already holds the row.
  if (approvals.length > 0) {
    try {
      await useApprovals(source);
    } catch (error) {
      console.error("milestone decision: approvals not marked used", milestone.id, error instanceof Error ? error.message : error);
    }
  }

  const outcome = await releaseHeldMilestone(
    { milestoneId: milestone.id, destination: payoutAddress(milestone.facts.contractor.address, milestone.contractorId), amount: milestone.amount },
    { provider, operatingAccountId: operatingId }
  );

  // A submitted transfer goes back to `verified`, which the agent's cycle reconciles until Circle confirms it.
  const now = new Date().toISOString();
  const update = await db()
    .from("milestones")
    .update({
      ...RELEASED,
      status: outcome.status,
      agent_reasoning: `${milestone.agentReasoning ?? ""} [paid now by a person]${outcome.reasoningSuffix}`,
      decided_at: now,
      settled_at: outcome.status === "paid" ? now : null,
      tx_ref: outcome.txRef,
    })
    .eq("id", milestone.id)
    .eq("status", "held")
    .select("id");
  if (update.error || (update.data ?? []).length === 0) {
    // The transfer may already have moved; this line is how to find the milestone. Its payment intent keeps
    // the transfer, which the next Pay now, or the agent's reconciliation once it is verified, records.
    console.error("milestone decision: update failed after the release", milestone.id, outcome.status);
    if (update.error) throw new Error(update.error.message);
  }

  const name = milestone.facts.contractor.name;
  const execution = outcome.paymentExecution;
  const own = soleApprover ? ` ${SOLE_APPROVER_NOTE}` : approvals.length > 0 ? ` ${SECOND_OF_TWO_NOTE}` : "";
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "contractor",
    action: "milestone_approval_paid",
    summary:
      outcome.status === "paid"
        ? `Paid milestone "${milestone.title}" to ${name} now: ${milestone.amount} USDC${own}`
        : outcome.status === "verified"
          ? `Approved milestone "${milestone.title}"; payment of ${milestone.amount} USDC to ${name} submitted${own}`
          : `Approved milestone "${milestone.title}"; payment of ${milestone.amount} USDC to ${name} failed${own}`,
    detail: {
      by: input.actorId,
      milestoneId: milestone.id,
      counterpartyId: milestone.contractorId,
      amount: milestone.amount,
      currency: "USDC",
      overrode: "held",
      heldFor: reason.kind,
      txRef: outcome.txRef,
      status: outcome.status,
      ...(execution ? { attempt: execution.attempt } : {}),
      ...(execution?.retriedAfter ? { retriedAfter: execution.retriedAfter } : {}),
      // The person who added it overrode the hold, as the workspace's only approver.
      ...(soleApprover ? { soleApprover: true } : {}),
      // The address's first payment, which this person stood behind beside whoever gave the address (new payee check N4).
      ...(firstPayment ? { firstPayment: true } : {}),
      // Above the figure: the two approvals, the earlier first (two approvals T7).
      ...(approvals.length > 0 ? { approvals: approvals.map((approval) => ({ by: approval.by, at: approval.at })), twoApprovalsAbove: above } : {}),
      ...(fewApprovers ? { fewApprovers: true } : {}),
      ...input.provenance,
    },
  });

  return { status: outcome.status, txRef: outcome.txRef, note: outcome.reasoningSuffix };
}

/**
 * Closes a held milestone without paying it, with the reason a person gives: refused while a transfer for it
 * may still settle, and while its USDC is locked in escrow. It is never paid after, and the agent never sees it.
 * `provenance`, when given, names the surface the person acted from (integrations design R3); the console gives none.
 */
export async function closeMilestone(input: { actorId: string; milestoneId: string; reason: string; provenance?: Provenance }): Promise<void> {
  const orgId = currentOrgId();
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) raise("reason_required");
  const milestone = await loadMilestone(input.milestoneId, getChainProvider().mode === "live");
  if (milestone.status !== "held") raise("not_held");
  let intent = milestone.facts.intent;
  // A send Circle never answered is looked for first, sending nothing (payment safety R6).
  if (transferUnknown(intent)) {
    const looked = await lookForUnknownSend("milestone", milestone.id);
    if (looked.answer === "undecided") raise("payment_unknown", unknownSendMessage("milestone", looked.retryAt));
    intent = (await loadMilestone(input.milestoneId, getChainProvider().mode === "live")).facts.intent;
  }
  if (paymentWasSent(intent)) raise("payment_in_flight");
  if (milestone.escrowState === "funding" || milestone.escrowState === "funded") raise("escrow_locked");
  const heldFor = heldReason(milestone.facts).kind;

  await claim(milestone.id, input.actorId);

  const now = new Date().toISOString();
  const update = await db()
    .from("milestones")
    .update({
      ...RELEASED,
      status: "closed",
      closed_at: now,
      closed_by: input.actorId,
      close_reason: reason,
      decided_at: now,
      agent_reasoning: `${milestone.agentReasoning ?? ""} [closed without paying by a person: ${reason}]`,
    })
    .eq("id", milestone.id)
    .eq("status", "held");
  if (update.error) throw new Error(update.error.message);
  // It is never paid now: the approvals given for it end with it (two approvals T6). Best effort.
  try {
    await clearApprovals({ type: "milestone", id: milestone.id });
  } catch (error) {
    console.error("milestone decision: approvals not cleared", milestone.id, error instanceof Error ? error.message : error);
  }

  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "contractor",
    action: "milestone_closed",
    summary: `Closed milestone "${milestone.title}" for ${milestone.facts.contractor.name} without paying it (${milestone.amount} USDC)`,
    detail: {
      by: input.actorId,
      milestoneId: milestone.id,
      counterpartyId: milestone.contractorId,
      amount: milestone.amount,
      currency: "USDC",
      heldFor,
      reason,
      ...input.provenance,
    },
  });
}
