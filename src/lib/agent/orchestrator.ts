import { z } from "zod";
import { db, unwrap, type OrgDb } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { getChainProvider, type ChainProvider } from "../circle";
import { cycleClockMode, type CycleClockMode } from "../clock";
import { runComplianceSweep, screeningMode as complianceScreeningMode } from "../compliance";
import { refreshGitHubMilestones } from "../milestone-verification";
import { seedScale } from "../seed";
import { executePayment, type PaymentExecution, type PaymentSourceType } from "../payments";
import { payInvoice, syncOperatingBalance, payoutAddress } from "./pay";
import { CycleMetricsCollector } from "./cycle-metrics";
import {
  emptyCounterpartyHistory,
  type CounterpartyHistoryInputs,
} from "./counterparty-history";
import { CycleJournal, messageOf, type CycleStage } from "./journal";
import { syncOnChainBalances, type BalanceSync } from "./balances";
import { decide } from "./decide";
import { enforceApGuardrails } from "./guardrails";
import { addressUnconfirmed } from "../counterparty-address";
import { SandboxCapReachedError } from "./sandbox-cap";
import { AgentPausedError, heldBecausePausedDetail, pausedPaymentNote, pausedTreasuryNote } from "./pause";
import {
  blockingDuplicate,
  duplicateMatchContext,
  findDuplicates,
  type InvoiceLike,
} from "./duplicates";
import { followUpConfig, planFollowUp, type DecisionFacts, type FollowUpConfig, type FollowUpPlan } from "./follow-up";
import { OPEN_PAYABLE_STATUSES, summarizePayableObligations } from "./obligations";
import { planTreasury, type TreasuryDecision } from "./treasury";
import { plural } from "../copy";

// Moved to ./balances.ts with the read it belongs to; still exported from here for existing callers.
export { liveOperatingBalance } from "./balances";

/** The closing `cycle_complete` ledger entry's summary line, pulled out as a
 * pure function so the singular/plural wording can be tested without
 * driving a full cycle through `runAgentCycle`. */
export function cycleCompleteSummary(
  clockMode: CycleClockMode,
  day: number,
  finishedAt: string,
  decisionCount: number
): string {
  const decisions = plural(decisionCount, "1 agent decision recorded", `${decisionCount} agent decisions recorded`);
  return clockMode === "simulate"
    ? `Agent cycle ${day} complete: ${decisions}`
    : `Agent cycle complete at ${finishedAt}: ${decisions}`;
}

/** The success message `runAgentCycleAction` returns to the console. Kept
 * pure and exported so the singular/plural wording is testable without
 * driving a full cycle, and so the wording lives next to the summary it
 * echoes rather than being reworded independently in the action. */
export function agentCycleSuccessMessage(result: Pick<CycleResult, "clockMode" | "day" | "finishedAt" | "lines">): string {
  const decisions = plural(result.lines.length, "1 decision logged", `${result.lines.length} decisions logged`);
  return result.clockMode === "simulate"
    ? `Day ${result.day} complete · ${decisions}.`
    : `Cycle complete at ${new Date(result.finishedAt).toLocaleString()} · ${decisions}.`;
}

const SYSTEM_PROMPT = `You are Vestiarion, an autonomous treasury agent operating a small business's money on the Arc blockchain, settled in USDC. You hold real spending authority inside the guardrails below.

Rules you must follow:
- Never pay a counterparty whose risk level is "high".
- Never authorise an amount above the counterparty's current payment limit.
- When a three-way match is incomplete (no purchase order on file, or goods not confirmed received), request information instead of paying.
- When evidence suggests fraud — a duplicate invoice, a mismatched PO, a counterparty whose risk just changed — flag it rather than holding quietly.
- Keep enough liquid operating cash to cover every obligation due in the next 7 days before sweeping anything into yield.
- Your reasoning must cite the specific facts you were given: amounts, PO numbers, risk levels, balances. A human auditor will read it next to the same data. Never write vague justifications like "looks fine" or "seems reasonable".

Respond with ONLY a single JSON object in the requested shape. No prose outside the JSON.`;

const apDecisionSchema = z.object({
  action: z.enum(["pay", "hold", "flag_fraud", "request_info"]),
  reasoning: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
type ApDecision = z.infer<typeof apDecisionSchema>;

const milestoneDecisionSchema = z.object({
  action: z.enum(["release", "hold"]),
  reasoning: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
type MilestoneDecision = z.infer<typeof milestoneDecisionSchema>;

const treasuryDecisionSchema = z.object({
  action: z.enum(["sweep_to_usyc", "redeem_from_usyc", "hold"]),
  amount: z.number().min(0),
  reasoning: z.string().min(10),
});

export interface CycleLogLine {
  domain: string;
  message: string;
}

export interface CycleResult {
  day: number;
  lines: CycleLogLine[];
  mode: string;
  clockMode: CycleClockMode;
  startedAt: string;
  finishedAt: string;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

function performanceEvidence(
  score: string | number | null,
  inputs: CounterpartyHistoryInputs | null
) {
  return {
    score: score == null ? null : num(score),
    status: score == null ? "no_history_yet" : "measured_from_ledger",
    inputs: inputs ?? emptyCounterpartyHistory(),
    note: "Historical evidence for closer review, not a verdict or payment guardrail.",
  };
}

/**
 * The follow-up stage's write for one frozen invoice it chose to reopen or
 * escalate, its ledger entry and its cycle line — or nothing at all when the
 * invoice no longer has the status the stage read it with.
 *
 * The write is a compare-and-set on that status (spec D5): a person may have
 * claimed the invoice from the approvals inbox between the stage's read and
 * this write, and an unconditional update would put a `processing` row back
 * to `pending` for the AP stage to decide over the person's own decision.
 * When no row matches, the person's decision stands, and the stage records
 * nothing for that invoice. Exported so this seam is testable without a full
 * cycle, like `payApInvoiceIfNotPaused` below.
 */
export async function applyFollowUp(
  orgDb: OrgDb,
  row: { id: string; status: string; amount: number },
  plan: FollowUpPlan,
  followUp: FollowUpConfig,
  now: number
): Promise<CycleLogLine | null> {
  if (plan.action === "wait") return null;

  // A reopen also clears notified_at: the payable left the waiting set once
  // told, and if the AP stage holds it again it should be news again, not
  // silently excluded until this stage escalates it.
  const changed = unwrap(
    await orgDb
      .from("invoices")
      .update(plan.action === "reopen" ? { status: "pending", notified_at: null } : { escalated_at: new Date(now).toISOString() })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("id")
  ) as Array<{ id: string }>;
  if (changed.length === 0) return null;

  await appendLedgerEntry({
    actor: "agent",
    domain: "ap",
    action: plan.action === "reopen" ? "invoice_reopened" : "invoice_escalated",
    summary:
      plan.action === "reopen"
        ? `Reopened ${row.status.replace("_", " ")} invoice for ${row.amount} USDC: evidence changed`
        : `Escalated ${row.status.replace("_", " ")} invoice for ${row.amount} USDC to a human`,
    detail: {
      invoiceId: row.id,
      followUp: {
        action: plan.action,
        reason: plan.reason,
        changes: plan.changes,
        ageDays: plan.ageDays == null ? null : Number(plan.ageDays.toFixed(2)),
        pastDue: plan.pastDue,
        staleAfterDays: followUp.staleAfterDays,
      },
      previousStatus: row.status,
    },
  });

  return {
    domain: "ap",
    message:
      plan.action === "reopen"
        ? `Reopened ${row.amount} USDC invoice: ${plan.changes.join("; ") || "no recorded decision facts"}`
        : `Escalated ${row.amount} USDC invoice for human review`,
  };
}

/** What a paused-or-not payment step in the AP or contractor stage decided,
 * in the shape each stage already carries as local variables — so wiring
 * one in is an assignment, not a restructure. */
interface PayStepOutcome {
  status: string;
  txRef: string | null;
  paymentExecution: PaymentExecution | null;
  /** Appended to the stage's `reasoning` verbatim, exactly as before. */
  reasoningSuffix: string;
  /** True only when the pause is why nothing moved — the ledger's
   * `execution.heldBecause` marker (D6) is set from this, not re-derived
   * from `status`, because a guardrail or a failed transfer also lands on
   * `"held"` for reasons that are not the pause. */
  heldBecausePaused: boolean;
  operatingBalance: number | null;
}

/**
 * The AP stage's `decision.action === "pay"` branch, once the guardrails
 * have already let it through: hold if the agent is paused since the
 * decision was made — `payInvoice` is never called, so no `payment_intents`
 * claim and no transfer — otherwise pay exactly as `payInvoice` always did.
 *
 * Extracted, and exported, so this exact call site — not only the
 * `pausedPaymentNote()` helper it uses — is unit-testable directly. Driving
 * it through a full `runAgentCycle()` would mean faking every stage ahead of
 * the AP loop first (reconcile, compliance, follow-up); see
 * `tests/pause-cycle.test.ts` for why that is out of proportion to what this
 * one branch does.
 */
export async function payApInvoiceIfNotPaused(
  input: { invoiceId: string; counterpartyId: string; address: string | null; amount: number },
  deps: { provider: ChainProvider; operating: { id: string } | null }
): Promise<PayStepOutcome> {
  const pauseNote = await pausedPaymentNote();
  if (pauseNote) {
    return {
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: pauseNote,
      heldBecausePaused: true,
      operatingBalance: null,
    };
  }
  const result = await payInvoice(input, deps);
  return {
    status: result.status,
    txRef: result.txRef,
    paymentExecution: result.execution,
    reasoningSuffix: result.note,
    heldBecausePaused: false,
    operatingBalance: result.operatingBalance,
  };
}

/** Appended to a held invoice's reasoning when a resubmission was refused because screening now says high risk. */
const NOT_RESUBMITTED_HIGH_RISK_NOTE = " [not resubmitted: counterparty now screened high risk]";

/** Appended to a held invoice's reasoning when a resubmission was refused because a changed address is unconfirmed. */
const NOT_RESUBMITTED_ADDRESS_NOTE = " [not resubmitted: the counterparty's address changed and no one has confirmed it]";

/**
 * Why a resubmission must not go out, from the counterparty as it stands now,
 * read fresh: it is screened high risk, or a person changed its address and no
 * one has confirmed it (spec 2026-09-30-counterparty-address-edit E4), since a
 * resubmission pays the current address. Thrown on a failed read, so a
 * resubmission fails closed.
 */
async function resubmissionBlocker(
  orgDb: OrgDb,
  counterpartyId: string
): Promise<"counterparty.high_risk" | "counterparty.address_unconfirmed" | null> {
  const result = await orgDb
    .from("counterparties")
    .select("risk_level, address_changed_at, address_confirmed_at")
    .eq("id", counterpartyId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { risk_level: string; address_changed_at?: string | null; address_confirmed_at?: string | null } | null;
  if (row?.risk_level === "high") return "counterparty.high_risk";
  if (addressUnconfirmed(row?.address_changed_at ?? null, row?.address_confirmed_at ?? null)) return "counterparty.address_unconfirmed";
  return null;
}

/** The payment intent a payable already has: enough to tell whether a transfer exists. */
export interface ExistingPaymentIntent {
  providerTxId: string | null;
  status: string;
}

/**
 * The payment intent already recorded for each `matched` payable, by invoice
 * id. A `matched` invoice with one has a payment in flight — the agent's own,
 * or one a person approved from the inbox — and the AP stage reconciles it
 * through `reconcileApInvoice` rather than deciding it again. A `pending`
 * payable, or a `matched` one with no intent, is not in the map and is
 * decided exactly as before.
 */
export async function existingPaymentIntents(
  orgDb: OrgDb,
  payables: Array<{ id: string; status: string }>
): Promise<Map<string, ExistingPaymentIntent>> {
  return paymentIntentsFor(orgDb, "invoice", payables, "matched");
}

/**
 * The contractor stage's twin of `existingPaymentIntents`: the payment intent
 * already recorded for each `verified` milestone, by milestone id. A pending
 * release maps the milestone back to `verified`, so a `verified` milestone
 * with an intent has a release in flight, and the stage reconciles it through
 * `reconcileMilestone` rather than deciding it again. A `verified` milestone
 * with no intent is not in the map and is decided exactly as before.
 */
export async function existingMilestoneIntents(
  orgDb: OrgDb,
  milestones: Array<{ id: string; status: string }>
): Promise<Map<string, ExistingPaymentIntent>> {
  return paymentIntentsFor(orgDb, "milestone", milestones, "verified");
}

async function paymentIntentsFor(
  orgDb: OrgDb,
  sourceType: PaymentSourceType,
  sources: Array<{ id: string; status: string }>,
  inFlightStatus: string
): Promise<Map<string, ExistingPaymentIntent>> {
  const ids = sources.filter((source) => source.status === inFlightStatus).map((source) => source.id);
  if (ids.length === 0) return new Map();
  const rows = unwrap(
    await orgDb
      .from("payment_intents")
      .select("source_id, provider_tx_id, status")
      .eq("source_type", sourceType)
      .in("source_id", ids)
  ) as Array<{ source_id: string; provider_tx_id: string | null; status: string }>;
  // An intent with no provider id that is `created` (never claimed) or
  // `failed` (the submission failed before the provider returned an id) has
  // no transfer to reconcile by: `executePayment` would claim it and submit.
  // Left out, its source is decided again — model and guardrails — so a
  // payment limit cut or a risk change since is respected. Should the lost
  // submission have reached the provider after all, a resubmission reuses the
  // same idempotency key. A `failed` intent with a provider id is a real
  // transfer the provider reported on, and is still reconciled by that id.
  const inFlight = rows.filter(
    (row) => !(row.provider_tx_id === null && (row.status === "failed" || row.status === "created"))
  );
  return new Map(inFlight.map((row) => [row.source_id, { providerTxId: row.provider_tx_id, status: row.status }]));
}

/** `reasoning` with `note` appended, unless it already ends with it — a
 * source that churns through the same outcome every cycle does not repeat it. */
function withNote(reasoning: string | null, note: string): string {
  const base = reasoning ?? "";
  return note !== "" && base.endsWith(note) ? base : `${base}${note}`;
}

/**
 * The AP stage's step for a `matched` payable whose payment is already in
 * flight: no model, no guardrails — those ruled when the payment was first
 * decided, and running them again could turn a person's approval into a
 * hold over a transfer that is pending or already confirmed on chain.
 * Instead it calls `payInvoice`, whose idempotency key makes `executePayment`
 * reconcile the existing intent (a confirmed intent is returned as is; one
 * with a provider id is reconciled with the provider) rather than pay again.
 *
 * When a transfer already exists — a provider id, or a confirmed intent —
 * nothing new can move, so the pause is not consulted. When none does yet
 * (a submission that never recorded its provider id), `executePayment` may
 * submit it, so that path goes through `payApInvoiceIfNotPaused` and holds
 * while the agent is paused, as any agent payment does (D6).
 *
 * Before a possible resubmission, the counterparty's current risk level is
 * read again: a counterparty screened high risk since the payment was
 * decided is not paid, and the invoice is held with a note instead.
 *
 * A reconcile that did not complete is not an outcome: when there is no
 * operating account to reconcile against, when the reconcile could not read
 * the provider (an error recorded with the provider id), or when it threw
 * before any result, the invoice stays `matched` for the next cycle rather
 * than being demoted to `held` over a transfer that may well have settled.
 *
 * The invoice keeps its decision time and, when the reconciliation reports
 * none, its recorded txRef; the reasoning gains a note only when the status
 * moves on, so a payment still pending does not repeat its note every cycle.
 * The ledger entry is `ap_reconcile` — `detail.reconciled: true`, or `false`
 * with `reconcileError` when it did not complete — and no `observed` facts,
 * so the follow-up stage keeps comparing against the decision itself.
 */
export async function reconcileApInvoice(
  invoice: {
    id: string;
    amount: number;
    counterpartyId: string;
    counterpartyName: string;
    address: string | null;
    reasoning: string | null;
    txRef: string | null;
  },
  intent: ExistingPaymentIntent,
  deps: { db: OrgDb; provider: ChainProvider; operating: { id: string } | null }
): Promise<{ status: string; operatingBalance: number | null; line: CycleLogLine }> {
  const input = { invoiceId: invoice.id, counterpartyId: invoice.counterpartyId, address: invoice.address, amount: invoice.amount };
  const transferExists = intent.providerTxId !== null || intent.status === "confirmed";
  const name = invoice.counterpartyName;

  if (transferExists && !deps.operating) {
    return {
      status: "matched",
      operatingBalance: null,
      line: { domain: "ap", message: `${name}: in-flight payment left pending, no operating account to reconcile it against (${invoice.amount} USDC)` },
    };
  }

  let outcome: PayStepOutcome;
  let notResubmitted: Exclude<Awaited<ReturnType<typeof resubmissionBlocker>>, null> | null = null;
  const blocker = transferExists ? null : await resubmissionBlocker(deps.db, invoice.counterpartyId);
  if (transferExists) {
    const result = await payInvoice(input, { provider: deps.provider, operating: deps.operating });
    const execution = result.execution;
    const incomplete =
      execution === null
        ? result.note.trim().replace(/^\[(.*)\]$/, "$1")
        : execution.status === "failed" && execution.error != null && execution.providerTxId != null
          ? execution.error
          : null;
    if (incomplete !== null) {
      await appendLedgerEntry({
        actor: "agent",
        domain: "ap",
        action: "ap_reconcile",
        summary: `RECONCILE invoice from ${name} for ${invoice.amount} USDC: not completed, left pending`,
        detail: {
          invoiceId: invoice.id,
          counterpartyId: invoice.counterpartyId,
          reconciled: false,
          reconcileError: incomplete,
          previousStatus: "matched",
          execution: {
            txRef: invoice.txRef ?? execution?.txRef ?? null,
            chainMode: execution?.providerMode ?? deps.provider.mode,
            resultingStatus: "matched",
            settlementRequired: true,
          },
        },
      });
      return {
        status: "matched",
        operatingBalance: null,
        line: { domain: "ap", message: `${name}: could not reconcile the in-flight payment, left pending for the next cycle (${invoice.amount} USDC)` },
      };
    }
    outcome = {
      status: result.status,
      txRef: result.txRef,
      paymentExecution: execution,
      reasoningSuffix: result.note,
      heldBecausePaused: false,
      operatingBalance: result.operatingBalance,
    };
  } else if (blocker) {
    notResubmitted = blocker;
    outcome = {
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: blocker === "counterparty.high_risk" ? NOT_RESUBMITTED_HIGH_RISK_NOTE : NOT_RESUBMITTED_ADDRESS_NOTE,
      heldBecausePaused: false,
      operatingBalance: null,
    };
  } else {
    outcome = await payApInvoiceIfNotPaused(input, { provider: deps.provider, operating: deps.operating });
  }

  const status = outcome.status;
  const txRef = outcome.txRef ?? invoice.txRef;
  const reasoning = withNote(invoice.reasoning, status === "matched" ? "" : outcome.reasoningSuffix);
  const now = new Date().toISOString();
  const update = await deps.db
    .from("invoices")
    .update({ status, agent_reasoning: reasoning, settled_at: status === "paid" ? now : null, tx_ref: txRef })
    .eq("id", invoice.id);
  if (update.error) throw new Error(update.error.message);

  const execution = outcome.paymentExecution;
  await appendLedgerEntry({
    actor: "agent",
    domain: "ap",
    action: "ap_reconcile",
    summary: `RECONCILE invoice from ${invoice.counterpartyName} for ${invoice.amount} USDC: ${status}`,
    detail: {
      invoiceId: invoice.id,
      counterpartyId: invoice.counterpartyId,
      reconciled: true,
      previousStatus: "matched",
      ...(notResubmitted ? { notResubmittedBecause: notResubmitted } : {}),
      execution: {
        txRef,
        chainMode: execution?.providerMode ?? deps.provider.mode,
        resultingStatus: status,
        settlementRequired: true,
        feeUsd: execution?.feeUsd ?? null,
        feeSource: execution?.feeSource ?? null,
        settledInMs: execution?.settledInMs ?? null,
        executedAt: execution?.executedAt ?? null,
        reconciled: execution?.reconciled ?? false,
        ...heldBecausePausedDetail(outcome.heldBecausePaused),
      },
    },
  });

  const message = outcome.heldBecausePaused
    ? `${invoice.counterpartyName}: not paid, the agent was paused (${invoice.amount} USDC)`
    : notResubmitted === "counterparty.high_risk"
      ? `${name}: not resubmitted, the counterparty is now screened high risk (${invoice.amount} USDC)`
      : notResubmitted === "counterparty.address_unconfirmed"
      ? `${name}: not resubmitted, the counterparty's address changed and no one has confirmed it (${invoice.amount} USDC)`
      : status === "paid"
      ? `${invoice.counterpartyName}: reconciled an in-flight payment, now paid (${invoice.amount} USDC)`
      : status === "matched"
        ? `${invoice.counterpartyName}: reconciled an in-flight payment, still pending (${invoice.amount} USDC)`
        : `${invoice.counterpartyName}: reconciled an in-flight payment, now held (${invoice.amount} USDC)`;
  return { status, operatingBalance: outcome.operatingBalance, line: { domain: "ap", message } };
}

/**
 * The contractor stage's `decision.action === "release"` branch, once an
 * operating account exists and the guardrails have already let it through:
 * hold — `status` stays at the caller's `"held"` default — if the agent is
 * paused, `executePayment` never called, otherwise release exactly as
 * `executePayment` always did. Mirrors `payApInvoiceIfNotPaused` above for
 * the same reason: this call site is directly testable without a full cycle.
 */
export async function releaseMilestoneIfNotPaused(
  input: { milestoneId: string; destination: string; amount: number },
  deps: { provider: ChainProvider; operatingAccountId: string }
): Promise<PayStepOutcome> {
  const pauseNote = await pausedPaymentNote();
  if (pauseNote) {
    return {
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: pauseNote,
      heldBecausePaused: true,
      operatingBalance: null,
    };
  }
  return releaseMilestone(input, deps);
}

/**
 * The one release step for a milestone, without the pause check: what
 * `releaseMilestoneIfNotPaused` does once it knows the agent is not paused,
 * and what `reconcileMilestone` calls directly when a transfer already exists
 * (nothing new can move, so the pause is not consulted). The milestone's
 * idempotency key makes `executePayment` reconcile an existing intent rather
 * than pay again. Mirrors `payInvoice` (src/lib/agent/pay.ts) for invoices.
 */
async function releaseMilestone(
  input: { milestoneId: string; destination: string; amount: number },
  deps: { provider: ChainProvider; operatingAccountId: string }
): Promise<PayStepOutcome> {
  let result;
  try {
    result = await executePayment(
      {
        sourceType: "milestone",
        sourceId: input.milestoneId,
        fromAccountId: deps.operatingAccountId,
        destination: input.destination,
        amount: input.amount,
        memo: `Milestone ${input.milestoneId}`,
      },
      { provider: deps.provider }
    );
  } catch (err) {
    // Nothing is known to have moved: no transfer result exists at all.
    return {
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: ` [execution failed: ${(err as Error).message}]`,
      heldBecausePaused: false,
      operatingBalance: null,
    };
  }

  const status = result.status === "confirmed" ? "paid" : result.status === "pending" ? "verified" : "held";
  let reasoningSuffix = "";
  let operatingBalance: number | null = null;
  if (result.status === "failed") {
    reasoningSuffix = ` [transfer failed: ${result.error ?? "provider reported failure"}]`;
  } else if (result.status === "pending") {
    reasoningSuffix = " [transfer submitted; awaiting provider confirmation]";
  } else {
    // The transfer is already confirmed — status, txRef and paymentExecution
    // below are real regardless of what happens next. A sync failure here
    // must not demote a confirmed release back to "held": see the identical
    // comment in payInvoice (src/lib/agent/pay.ts).
    try {
      operatingBalance = await syncOperatingBalance(deps.operatingAccountId);
    } catch (err) {
      reasoningSuffix = ` [balance sync failed: ${(err as Error).message}]`;
    }
  }
  return { status, txRef: result.txRef, paymentExecution: result, reasoningSuffix, heldBecausePaused: false, operatingBalance };
}

/**
 * The contractor stage's step for a `verified` milestone whose release is
 * already in flight — the twin of `reconcileApInvoice` above, with the same
 * semantics. A pending release maps the milestone back to `verified`, which
 * the stage selects every cycle; deciding it again could record a transfer
 * that is pending or already confirmed on chain as `held` with no txRef, and
 * nothing would look at it after that. So: no model, no guardrails. Instead
 * it releases through the milestone's idempotency key, which makes
 * `executePayment` reconcile the existing intent rather than pay again.
 *
 * When a transfer already exists — a provider id, or a confirmed intent —
 * nothing new can move, so the pause is not consulted. When none does yet,
 * `executePayment` may submit it: the contractor's current risk level is read
 * again first (a contractor now screened high risk is held, not paid), then
 * the release goes through `releaseMilestoneIfNotPaused`, which holds while
 * the agent is paused (D6). With no operating account there, the milestone
 * is held and noted, as `payInvoice` does for an invoice.
 *
 * A reconcile that did not complete is not an outcome: no operating account
 * to reconcile against, a reconcile that could not read the provider, or one
 * that threw before any result leaves the milestone `verified` for the next
 * cycle rather than demoting it to `held`.
 *
 * The milestone keeps its decision time and, when the reconciliation reports
 * none, its recorded txRef; the reasoning gains a note only when the status
 * moves on. The ledger entry is `milestone_reconcile` (domain `contractor`) —
 * `detail.reconciled: true`, or `false` with `reconcileError` — and carries
 * no `observed` facts.
 */
export async function reconcileMilestone(
  milestone: {
    id: string;
    title: string;
    amount: number;
    contractorId: string;
    contractorName: string;
    address: string | null;
    reasoning: string | null;
    txRef: string | null;
  },
  intent: ExistingPaymentIntent,
  deps: { db: OrgDb; provider: ChainProvider; operating: { id: string } | null }
): Promise<{ status: string; operatingBalance: number | null; line: CycleLogLine }> {
  const transferExists = intent.providerTxId !== null || intent.status === "confirmed";
  const name = milestone.contractorName;
  const amount = milestone.amount;
  const release = { milestoneId: milestone.id, destination: payoutAddress(milestone.address, milestone.contractorId), amount };
  const subject = `milestone "${milestone.title}" for ${name} (${amount} USDC)`;

  if (transferExists && !deps.operating) {
    return {
      status: "verified",
      operatingBalance: null,
      line: { domain: "contractor", message: `${name}: in-flight release left pending, no operating account to reconcile it against (${amount} USDC)` },
    };
  }

  // A release that never reached the provider would be resubmitted to the
  // contractor's current address. While a changed address is unconfirmed the
  // milestone waits exactly as the contractor stage's own check makes it wait:
  // still verified, nothing written, decided again once someone confirms it.
  const blocker = transferExists ? null : await resubmissionBlocker(deps.db, milestone.contractorId);
  if (blocker === "counterparty.address_unconfirmed") {
    return {
      status: "verified",
      operatingBalance: null,
      line: { domain: "contractor", message: `${name}: "${milestone.title}" waiting for someone to confirm its new address` },
    };
  }

  let outcome: PayStepOutcome;
  let notResubmitted: "counterparty.high_risk" | null = null;
  if (transferExists && deps.operating) {
    const result = await releaseMilestone(release, { provider: deps.provider, operatingAccountId: deps.operating.id });
    const execution = result.paymentExecution;
    const incomplete =
      execution === null
        ? result.reasoningSuffix.trim().replace(/^\[(.*)\]$/, "$1")
        : execution.status === "failed" && execution.error != null && execution.providerTxId != null
          ? execution.error
          : null;
    if (incomplete !== null) {
      await appendLedgerEntry({
        actor: "agent",
        domain: "contractor",
        action: "milestone_reconcile",
        summary: `RECONCILE ${subject}: not completed, left pending`,
        detail: {
          milestoneId: milestone.id,
          counterpartyId: milestone.contractorId,
          reconciled: false,
          reconcileError: incomplete,
          previousStatus: "verified",
          execution: {
            txRef: milestone.txRef ?? execution?.txRef ?? null,
            chainMode: execution?.providerMode ?? deps.provider.mode,
            resultingStatus: "verified",
            settlementRequired: true,
          },
        },
      });
      return {
        status: "verified",
        operatingBalance: null,
        line: { domain: "contractor", message: `${name}: could not reconcile the in-flight release, left pending for the next cycle (${amount} USDC)` },
      };
    }
    outcome = result;
  } else if (blocker === "counterparty.high_risk") {
    notResubmitted = blocker;
    outcome = {
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: NOT_RESUBMITTED_HIGH_RISK_NOTE,
      heldBecausePaused: false,
      operatingBalance: null,
    };
  } else if (deps.operating) {
    outcome = await releaseMilestoneIfNotPaused(release, { provider: deps.provider, operatingAccountId: deps.operating.id });
  } else {
    outcome = {
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: " [no operating account configured]",
      heldBecausePaused: false,
      operatingBalance: null,
    };
  }

  const status = outcome.status;
  const txRef = outcome.txRef ?? milestone.txRef;
  const reasoning = withNote(milestone.reasoning, status === "verified" ? "" : outcome.reasoningSuffix);
  const now = new Date().toISOString();
  const update = await deps.db
    .from("milestones")
    .update({ status, agent_reasoning: reasoning, settled_at: status === "paid" ? now : null, tx_ref: txRef })
    .eq("id", milestone.id);
  if (update.error) throw new Error(update.error.message);

  const execution = outcome.paymentExecution;
  await appendLedgerEntry({
    actor: "agent",
    domain: "contractor",
    action: "milestone_reconcile",
    summary: `RECONCILE ${subject}: ${status}`,
    detail: {
      milestoneId: milestone.id,
      counterpartyId: milestone.contractorId,
      reconciled: true,
      previousStatus: "verified",
      ...(notResubmitted ? { notResubmittedBecause: notResubmitted } : {}),
      execution: {
        txRef,
        chainMode: execution?.providerMode ?? deps.provider.mode,
        resultingStatus: status,
        settlementRequired: true,
        feeUsd: execution?.feeUsd ?? null,
        feeSource: execution?.feeSource ?? null,
        settledInMs: execution?.settledInMs ?? null,
        executedAt: execution?.executedAt ?? null,
        reconciled: execution?.reconciled ?? false,
        ...heldBecausePausedDetail(outcome.heldBecausePaused),
      },
    },
  });

  const message = outcome.heldBecausePaused
    ? `${name}: not paid, the agent was paused (${amount} USDC)`
    : notResubmitted
      ? `${name}: not resubmitted, the contractor is now screened high risk (${amount} USDC)`
      : status === "paid"
        ? `${name}: reconciled an in-flight release, now paid (${amount} USDC)`
        : status === "verified"
          ? `${name}: reconciled an in-flight release, still pending (${amount} USDC)`
          : `${name}: reconciled an in-flight release, now held (${amount} USDC)`;
  return { status, operatingBalance: outcome.operatingBalance, line: { domain: "contractor", message } };
}

/** What the treasury stage's attempted move decided — mirrors `PayStepOutcome`
 * but in the treasury stage's own vocabulary (`executed`/`executionNote`,
 * already what it recorded before this existed). */
interface TreasuryMoveOutcome {
  executed: boolean;
  executionNote: string | null;
  heldBecausePaused: boolean;
}

/**
 * The treasury stage's move, once a sweep or redemption has actually been
 * decided (a `"hold"` decision, or one with a non-positive amount, never
 * reaches here and is reported as not executed with no note, exactly as
 * before): hold — nothing moves — if the agent is paused since the decision
 * was made, `provider.depositToEarn`/`withdrawFromEarn` never called;
 * otherwise move and update the reserve balance exactly as before.
 *
 * Mirrors `payApInvoiceIfNotPaused`/`releaseMilestoneIfNotPaused` above for
 * the same reason (ruling R5): this exact call site is unit-testable without
 * a full cycle.
 */
export async function moveTreasuryIfNotPaused(
  decision: TreasuryDecision,
  ctx: {
    db: OrgDb;
    provider: ChainProvider;
    operatingAccountId: string;
    reserveAccountId: string;
    operatingBalance: number;
    reserveBalance: number;
  }
): Promise<TreasuryMoveOutcome> {
  const wouldMove =
    (decision.action === "sweep_to_usyc" || decision.action === "redeem_from_usyc") && decision.amount > 0;
  if (!wouldMove) {
    return { executed: false, executionNote: null, heldBecausePaused: false };
  }

  const pauseNote = await pausedTreasuryNote();
  if (pauseNote) {
    return { executed: false, executionNote: pauseNote, heldBecausePaused: true };
  }

  try {
    if (decision.action === "sweep_to_usyc") {
      const amount = Math.min(decision.amount, ctx.operatingBalance);
      await ctx.provider.depositToEarn({ accountId: ctx.operatingAccountId, amount });
      const res = await ctx.db
        .from("accounts")
        .update({ balance: Number((ctx.reserveBalance + amount).toFixed(6)) })
        .eq("id", ctx.reserveAccountId);
      if (res.error) throw new Error(res.error.message);
    } else {
      const amount = Math.min(decision.amount, ctx.reserveBalance);
      await ctx.provider.withdrawFromEarn({ accountId: ctx.operatingAccountId, amount });
      const res = await ctx.db
        .from("accounts")
        .update({ balance: Number((ctx.reserveBalance - amount).toFixed(6)) })
        .eq("id", ctx.reserveAccountId);
      if (res.error) throw new Error(res.error.message);
    }
    return { executed: true, executionNote: null, heldBecausePaused: false };
  } catch (err) {
    return { executed: false, executionNote: `execution failed: ${(err as Error).message}`, heldBecausePaused: false };
  }
}

/**
 * The real-clock day, from the organization's own `sim_clock` row.
 *
 * A missing row is normal: an organization that has never run a simulated
 * cycle has none yet, and the day defaults to zero. A request that failed
 * outright is a different fact and must not be read the same way — that
 * would start a cycle's records at a wrong day rather than refusing to start
 * it at all.
 */
async function realClockDay(orgDb: OrgDb): Promise<number> {
  const clock = await orgDb.from("sim_clock").select("current_day").maybeSingle<{ current_day: number }>();
  if (clock.error) throw new Error(clock.error.message);
  return clock.data?.current_day ?? 0;
}

interface CycleContext {
  db: OrgDb;
  provider: ReturnType<typeof getChainProvider>;
  lines: CycleLogLine[];
  metrics: CycleMetricsCollector;
  journal: CycleJournal;
  startedAt: string;
  clockMode: CycleClockMode;
  day: number;
  cycleRunId: string;
  triggeredBy?: string;
}

/**
 * The reconcile stage's ledger lines for one balance read, in the order the
 * accounts were read: a line for each balance that changed, and one for each
 * account that could not be read or written. An account that was read and
 * found unchanged writes no line.
 */
export function reconcileLines(sync: Pick<BalanceSync, "outcomes">): CycleLogLine[] {
  return sync.outcomes.flatMap((outcome): CycleLogLine[] => {
    if (outcome.kind === "changed") {
      const note = outcome.note ? ` (${outcome.note})` : "";
      return [{ domain: "treasury", message: `Reconciled ${outcome.name}: ${outcome.from} → ${outcome.to} USDC${note}` }];
    }
    if (outcome.kind === "failed") {
      return [{ domain: "treasury", message: `Could not reconcile ${outcome.name}: ${outcome.message}` }];
    }
    return [];
  });
}

/**
 * Opens the cycle's record before doing anything, and closes it whichever way
 * the cycle ends.
 *
 * The body commits as it goes — screening verdicts, reopened invoices,
 * executed payments, ledger entries — and it has to, because it makes external
 * calls to Circle and Arc in between. So there is no transaction to roll back
 * to, and rolling one back over money that genuinely moved would be worse than
 * having no record. What is available is the same discipline `payment_intents`
 * uses on the payment leg: state the intent first, record the outcome after.
 *
 * Before this, a cycle that died partway left no trace that it had run at all,
 * while everything it had already written stayed committed.
 */
export async function runAgentCycle(
  options: { triggeredBy?: string; dailyCap?: number } = {}
): Promise<CycleResult> {
  const orgDb = db();
  const provider = getChainProvider();
  const lines: CycleLogLine[] = [];
  const metrics = new CycleMetricsCollector();
  const journal = new CycleJournal();
  const startedAt = new Date().toISOString();
  const clockMode = cycleClockMode();

  // Opens the run — and, for a sandbox organization, enforces its daily cap —
  // inside begin_cycle_run (migration 0022) before anything else happens.
  // Refused there, nothing downstream has run: no day advanced, no row
  // written. `sandbox_cap_reached: …` is the one error this function
  // translates; every other failure here means the run never opened at all,
  // so there is nothing yet to mark failed.
  let runId: string;
  try {
    runId = unwrap(
      await orgDb
        .rpc("begin_cycle_run", {
          p_daily_cap: options.dailyCap ?? null,
          p_started_at: startedAt,
          p_clock_mode: clockMode,
          p_chain_mode: provider.mode,
          p_screening_mode: complianceScreeningMode(),
        })
        .single<string>()
    );
  } catch (err) {
    const message = messageOf(err);
    if (message.startsWith("sandbox_cap_reached")) throw new SandboxCapReachedError();
    if (message.startsWith("agent_paused")) throw new AgentPausedError();
    throw err;
  }

  try {
    // Only now, with the run open, does simulate mode advance the numbered
    // day — a refused cycle above advances nothing — and the day is recorded
    // onto the run that already exists rather than carried on its insert.
    const day = clockMode === "simulate"
      ? unwrap(await orgDb.rpc("advance_sim_day").single<number>())
      : await realClockDay(orgDb);

    if (clockMode === "simulate") {
      const patch = await orgDb.from("cycle_runs").update({ sim_day: day }).eq("id", runId);
      if (patch.error) throw new Error(patch.error.message);
    }

    const ctx: CycleContext = {
      db: orgDb, provider, lines, metrics, journal, startedAt, clockMode, day, cycleRunId: runId,
      triggeredBy: options.triggeredBy,
    };

    return await executeCycle(ctx);
  } catch (err) {
    // Reached only when something outside every stage threw — opening the
    // day (`advance_sim_day`, or `realClockDay` in real-clock mode), the
    // `sim_day` PATCH onto the run, the shared measurements between stages,
    // or the write that closes the run. A stage that fails is recorded by the
    // stage helper and never lands here.
    // Best effort: if the database is what failed, this will fail too, and the
    // row stays `running` — which still says more than the nothing it said
    // before. The original error is what the operator needs, so it is never
    // masked by a failure to record it.
    try {
      const finishedAt = new Date().toISOString();
      const snapshot = metrics.snapshot();
      await orgDb
        .from("cycle_runs")
        .update({
          status: "failed",
          finished_at: finishedAt,
          duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
          failed_stage: journal.failedStage(),
          error_message: messageOf(err),
          stages: journal.stages(),
          decision_count: snapshot.decisionCount,
          paid_count: snapshot.paidCount,
          held_count: snapshot.heldCount,
          flagged_count: snapshot.flaggedCount,
          awaiting_info_count: snapshot.awaitingInfoCount,
          released_count: snapshot.releasedCount,
          model_decision_count: snapshot.modelDecisionCount,
          heuristic_decision_count: snapshot.heuristicDecisionCount,
          guardrail_override_count: snapshot.guardrailOverrideCount,
          reference_disagreement_count: snapshot.referenceDisagreementCount,
        })
        .eq("id", runId);
    } catch (recordingError) {
      console.error("[agent] could not record the failed cycle:", recordingError);
    }
    throw err;
  }
}

async function executeCycle(ctx: CycleContext): Promise<CycleResult> {
  const { db, provider, lines, metrics, journal, startedAt, clockMode, day, cycleRunId, triggeredBy } = ctx;

  /**
   * Runs one stage, or records why it could not. A stage that throws no longer
   * takes the rest of the cycle with it: the failure is recorded, the stages
   * that genuinely depend on it are skipped, and the ones that do not carry on.
   * `STAGE_REQUIRES` in ./journal.ts is where that line is drawn, and it is
   * drawn on safety — fail closed on anything that authorises money leaving the
   * business, stay open on anything that only observes or records.
   */
  const stage = async (name: CycleStage, body: () => Promise<void>): Promise<void> => {
    const gate = journal.gate(name);
    if (!gate.run) {
      journal.skipped(name, gate.because);
      lines.push({ domain: "system", message: `Skipped ${name}: ${gate.because}` });
      return;
    }
    const started = Date.now();
    try {
      await body();
      journal.completed(name, Date.now() - started);
    } catch (err) {
      journal.failed(name, err, Date.now() - started);
      lines.push({ domain: "system", message: `Stage ${name} failed: ${messageOf(err)}` });
    }
  };

  await stage("reconcile", async () => {

  // ------------------------------------------------------------ 0. reconcile
  // In live mode the chain is the source of truth for cash, so each
  // non-reserve account's stored balance is written back from it, less the
  // notional USYC reserve while that leg is simulated. The read and its
  // reasoning live in ./balances.ts, shared with the console's balance refresh.
  if (provider.mode === "live") {
    lines.push(...reconcileLines(await syncOnChainBalances(provider, db)));
  }

  });

  await stage("compliance", async () => {
  // ---------------------------------------------------------------- 1. compliance
  // The whole counterparty book, every cycle — not only the ones still marked
  // unscreened. The vendor that screened clear last week is precisely the one
  // worth re-checking; screening once at onboarding is the failure RFB5 names.
  const sweep = await runComplianceSweep();

  if (!sweep.complete) {
    lines.push({
      domain: "compliance",
      message: `Screening incomplete for ${sweep.failures.length} counterparty${sweep.failures.length === 1 ? "" : "ies"}; previous verdicts retained`,
    });
  }

  for (const outcome of sweep.screened) {
    if (outcome.firstScreen) {
      lines.push({
        domain: "compliance",
        message: `Screened ${outcome.name} → ${outcome.riskLevel}`,
      });
    } else if (outcome.changed) {
      lines.push({
        domain: "compliance",
        message: `${outcome.name}: risk ${outcome.previousRiskLevel} → ${outcome.riskLevel}`,
      });
    }
  }

  const unchanged = sweep.screened.filter((s) => !s.changed).length;
  if (unchanged > 0) {
    lines.push({
      domain: "compliance",
      message: `Re-screened ${unchanged} counterpart${unchanged === 1 ? "y" : "ies"}, no change`,
    });
  }

  // GitHub-backed evidence is refreshed before contractor decisions, so a
  // PR merged since the previous run can release in this same cycle. Missing
  // credentials or API failures retain the previous verdict and are labelled.
  const milestoneVerification = await refreshGitHubMilestones();
  if (milestoneVerification.checked > 0) {
    lines.push({
      domain: "contractor",
      message: `Checked ${milestoneVerification.checked} GitHub milestone${milestoneVerification.checked === 1 ? "" : "s"}: ${milestoneVerification.verified} merged, ${milestoneVerification.unavailable} unavailable, ${milestoneVerification.failed} failed`,
    });
  }

  });

  await stage("follow_up", async () => {
  // ------------------------------------------------------- 1b. follow up
  // Runs after screening and before AP on purpose: a risk tier that moved this
  // cycle should reach a frozen invoice immediately, not next time.
  //
  // Everything the agent held or asked a question about used to leave the
  // decision loop permanently. It would ask a vendor for a purchase order and
  // never look again, while the invoice went on counting against the liquidity
  // buffer — cash reserved for an obligation the agent had itself frozen and
  // forgotten.
  const followUp = followUpConfig();
  const frozenRows = unwrap(
    await db
      .from("invoices")
      .select(
        "id, status, amount, due_date, decided_at, escalated_at, po_reference, goods_received, counterparties(risk_level, payment_limit)"
      )
      .eq("direction", "payable")
      .in("status", ["held", "awaiting_info", "flagged"])
    // PostgREST types an embedded row as an array; it is one-to-one here.
  ) as unknown as Array<{
    id: string;
    status: string;
    amount: string;
    due_date: string;
    decided_at: string | null;
    escalated_at: string | null;
    po_reference: string | null;
    goods_received: boolean;
    counterparties: { risk_level: string; payment_limit: string | null };
  }>;

  if (frozenRows.length > 0) {
    // The facts each decision rested on are already in the ledger. Reading
    // them back is what makes "has anything changed?" answerable at all.
    const priorEntries = unwrap(
      await db
        .from("ledger_entries")
        .select("detail")
        .eq("domain", "ap")
        .in("detail->>invoiceId", frozenRows.map((row) => row.id))
        .order("seq", { ascending: false })
    ) as Array<{ detail: Record<string, unknown> }>;

    const factsByInvoice = new Map<string, DecisionFacts>();
    for (const entry of priorEntries) {
      const invoiceId = entry.detail.invoiceId as string | undefined;
      const observed = entry.detail.observed as Record<string, unknown> | undefined;
      if (!invoiceId || !observed || factsByInvoice.has(invoiceId)) continue;
      factsByInvoice.set(invoiceId, {
        poReference: (observed.poReference as string | null) ?? null,
        goodsReceived: observed.goodsReceived === true,
        riskLevel: String(observed.riskLevel ?? "unscreened"),
        paymentLimit: observed.paymentLimit == null ? null : num(observed.paymentLimit),
      });
    }

    const now = Date.now();
    for (const row of frozenRows) {
      const plan = planFollowUp(
        {
          id: row.id,
          status: row.status,
          amount: num(row.amount),
          dueDate: row.due_date,
          decidedAt: row.decided_at,
          escalatedAt: row.escalated_at,
          poReference: row.po_reference,
          goodsReceived: row.goods_received,
          riskLevel: row.counterparties.risk_level,
          paymentLimit:
            row.counterparties.payment_limit == null ? null : num(row.counterparties.payment_limit),
        },
        factsByInvoice.get(row.id) ?? null,
        now,
        followUp
      );

      if (plan.action === "wait") continue;

      const line = await applyFollowUp(db, { id: row.id, status: row.status, amount: num(row.amount) }, plan, followUp, now);
      if (line) lines.push(line);
    }
  }

  });

  // ------------------------------------------------------------------ shared state
  const accounts = unwrap(await db.from("accounts").select("*")) as Array<{
    id: string;
    kind: string;
    balance: string;
    apy: string;
  }>;
  const operating = accounts.find((a) => a.kind === "operating");
  // Tracked across the AP and contractor loops so each decision sees the
  // balance as it stands after the payments already made this cycle, not as
  // it stood when the cycle began.
  let operatingBalance = num(operating?.balance);

  await stage("ap", async () => {
  // ----------------------------------------------------------------------- 2. AP
  const payables = unwrap(
    await db
      .from("invoices")
      .select("*, counterparties(id, name, risk_level, payment_limit, performance_score, performance_inputs, address, address_changed_at, address_confirmed_at)")
      .eq("direction", "payable")
      .in("status", ["pending", "matched"])
  ) as Array<{
    id: string;
    status: string;
    amount: string;
    memo: string | null;
    po_reference: string | null;
    goods_received: boolean;
    due_date: string;
    counterparty_id: string;
    agent_reasoning: string | null;
    tx_ref: string | null;
    counterparties: {
      id: string;
      name: string;
      risk_level: string;
      payment_limit: string | null;
      performance_score: string | null;
      performance_inputs: CounterpartyHistoryInputs | null;
      address: string | null;
      address_changed_at: string | null;
      address_confirmed_at: string | null;
    };
  }>;

  // The whole payable book, settled rows included, because a duplicate is only
  // detectable against what came before it — and the invoice that matters most
  // is the one already paid. Loaded once per cycle rather than per invoice.
  const payableHistory = unwrap(
    await db
      .from("invoices")
      .select("id, counterparty_id, amount, memo, po_reference, due_date, status")
      .eq("direction", "payable")
  ) as Array<{
    id: string;
    counterparty_id: string;
    amount: string;
    memo: string | null;
    po_reference: string | null;
    due_date: string;
    status: string;
  }>;

  const asInvoiceLike = (row: (typeof payableHistory)[number]): InvoiceLike => ({
    id: row.id,
    counterpartyId: row.counterparty_id,
    amount: num(row.amount),
    memo: row.memo,
    poReference: row.po_reference,
    dueDate: row.due_date,
    status: row.status,
  });
  const history = payableHistory.map(asInvoiceLike);

  // A `matched` payable with a payment intent already has a payment in
  // flight: it is reconciled, not decided again (see reconcileApInvoice).
  const inFlight = await existingPaymentIntents(db, payables);

  for (const invoice of payables) {
    const counterparty = invoice.counterparties;
    const amount = num(invoice.amount);

    const intent = invoice.status === "matched" ? inFlight.get(invoice.id) : undefined;
    if (intent) {
      const reconciled = await reconcileApInvoice(
        {
          id: invoice.id,
          amount,
          counterpartyId: counterparty.id,
          counterpartyName: counterparty.name,
          address: counterparty.address,
          reasoning: invoice.agent_reasoning,
          txRef: invoice.tx_ref,
        },
        intent,
        { db, provider, operating: operating ? { id: operating.id } : null }
      );
      if (reconciled.operatingBalance !== null) operatingBalance = reconciled.operatingBalance;
      metrics.recordInvoice(reconciled.status, false);
      lines.push(reconciled.line);
      continue;
    }
    const limit = counterparty.payment_limit == null ? null : num(counterparty.payment_limit);
    const overLimit = limit != null && amount > limit;
    const highRisk = counterparty.risk_level === "high";

    // The system prompt has always told the model to flag a duplicate invoice.
    // Until this was computed it had no way to see one: it is shown a single
    // invoice and cannot know an identical bill was settled last week.
    // Detection is uncapped by construction — `findDuplicates` has no limit to
    // forget. Only the evidence presented to the model is truncated, by
    // `duplicateMatchContext`; payment refusal must never depend on how many
    // other invoices happened to resemble this one.
    const duplicates = findDuplicates(
      {
        id: invoice.id,
        counterpartyId: invoice.counterparty_id,
        amount,
        memo: invoice.memo,
        poReference: invoice.po_reference,
        dueDate: invoice.due_date,
        status: "pending",
      },
      history
    );
    const duplicateContext = duplicateMatchContext(duplicates);

    const { value: decision, mode, reference, agreedWithReference } = await decide<ApDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to pay this accounts-payable invoice.",
        invoice: {
          amount,
          memo: invoice.memo,
          poReference: invoice.po_reference,
          goodsReceived: invoice.goods_received,
          dueDate: invoice.due_date,
        },
        counterparty: {
          name: counterparty.name,
          riskLevel: counterparty.risk_level,
          paymentLimit: limit,
          performanceHistory: performanceEvidence(
            counterparty.performance_score,
            counterparty.performance_inputs
          ),
        },
        treasury: { operatingBalance },
        duplicateMatches: duplicateContext.matches.map((match) => ({
          otherInvoiceStatus: match.otherStatus,
          otherInvoiceDueDate: match.otherDueDate,
          otherInvoiceAmount: match.otherAmount,
          confidence: match.confidence,
          signals: match.signals,
          finding: match.explanation,
        })),
        duplicateMatchesTotal: duplicateContext.total,
        duplicateNote:
          duplicates.length === 0
            ? "No earlier payable from this counterparty resembles this invoice."
            : `${duplicateContext.total} earlier payable(s) from this counterparty resemble this one; the ${duplicateContext.matches.length} strongest are shown. A repeat of an invoice that was already paid is duplicate billing — flag it rather than paying it a second time.`,
        responseShape: {
          action: "pay | hold | flag_fraud | request_info",
          reasoning: "string",
          confidence: "number between 0 and 1",
        },
      }),
      schema: apDecisionSchema,
      fallback: (): ApDecision => {
        const repeat = blockingDuplicate(duplicates);
        if (repeat) {
          return {
            action: "flag_fraud",
            reasoning: `Duplicate billing: ${repeat.explanation}`,
            confidence: repeat.confidence,
          };
        }
        if (highRisk) {
          return {
            action: "flag_fraud",
            reasoning: `${counterparty.name} is flagged high risk by compliance screening; payment blocked pending human review.`,
            confidence: 0.95,
          };
        }
        if (overLimit) {
          return {
            action: "hold",
            reasoning: `Invoice amount ${amount} USDC exceeds ${counterparty.name}'s payment limit of ${limit} USDC.`,
            confidence: 0.9,
          };
        }
        if (!invoice.goods_received || !invoice.po_reference) {
          return {
            action: "request_info",
            reasoning: `Cannot complete a three-way match: purchase order ${invoice.po_reference ?? "missing"}, goods received ${invoice.goods_received}.`,
            confidence: 0.7,
          };
        }
        return {
          action: "pay",
          reasoning: `PO ${invoice.po_reference} matches, goods confirmed received, ${counterparty.name} screened clear, and ${amount} USDC is within the ${limit} USDC limit.`,
          confidence: 0.85,
        };
      },
    });

    const statusForAction: Record<ApDecision["action"], string> = {
      pay: "paid",
      hold: "held",
      flag_fraud: "flagged",
      request_info: "awaiting_info",
    };

    const guardrail = enforceApGuardrails({
      action: decision.action,
      reasoning: decision.reasoning,
      amount,
      riskLevel: counterparty.risk_level,
      paymentLimit: limit,
      duplicates,
      addressChangedAt: counterparty.address_changed_at,
      addressConfirmedAt: counterparty.address_confirmed_at,
    });
    metrics.recordDecisionMode(mode, agreedWithReference);
    let status = guardrail.status ?? statusForAction[decision.action];
    let txRef: string | null = null;
    let paymentExecution: PaymentExecution | null = null;
    let reasoning = guardrail.reasoning;
    const guardrailBlocked = guardrail.blocked;
    let heldBecausePaused = false;

    if (decision.action === "pay") {
      // The guardrails are enforced here, after the model has spoken. A
      // hallucinated or jailbroken "pay" on a flagged counterparty dies in
      // code, not in the prompt.
      if (guardrail.blocked) {
        // Refused by enforceApGuardrails before the provider can be called.
      } else {
        const outcome = await payApInvoiceIfNotPaused(
          {
            invoiceId: invoice.id,
            counterpartyId: counterparty.id,
            address: counterparty.address,
            amount,
          },
          { provider, operating: operating ? { id: operating.id } : null }
        );
        status = outcome.status;
        txRef = outcome.txRef;
        paymentExecution = outcome.paymentExecution;
        reasoning += outcome.reasoningSuffix;
        heldBecausePaused = outcome.heldBecausePaused;
        if (outcome.operatingBalance !== null) operatingBalance = outcome.operatingBalance;
      }
    }

    const now = new Date().toISOString();
    const update = await db
      .from("invoices")
      .update({
        status,
        agent_reasoning: reasoning,
        decided_at: now,
        settled_at: status === "paid" ? now : null,
        tx_ref: txRef,
      })
      .eq("id", invoice.id);
    if (update.error) throw new Error(update.error.message);
    metrics.recordInvoice(status, guardrailBlocked);

    await appendLedgerEntry({
      actor: "agent",
      domain: "ap",
      action: `ap_${decision.action}`,
      summary: `${decision.action.toUpperCase()} invoice from ${counterparty.name} for ${amount} USDC`,
      detail: {
        invoiceId: invoice.id,
        counterpartyId: counterparty.id,
        decision,
        decisionMode: mode,
        referenceDecision: reference,
        agreedWithReference,
        guardrailBlocked,
        guardrailRule: guardrail.rule,
        observed: {
          amount,
          paymentLimit: limit,
          riskLevel: counterparty.risk_level,
          performanceHistory: performanceEvidence(
            counterparty.performance_score,
            counterparty.performance_inputs
          ),
          poReference: invoice.po_reference,
          goodsReceived: invoice.goods_received,
          operatingBalance,
          addressUnconfirmed: addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at),
          // Recorded whether or not anything matched. "We looked and found
          // nothing" is the half of a fraud control that a log which only
          // records hits can never prove.
          duplicateCheck: {
            candidatesConsidered: history.length,
            matchesTotal: duplicateContext.total,
            matchesShown: duplicateContext.matches.length,
            matches: duplicateContext.matches.map((match) => ({
              otherInvoiceId: match.otherId,
              otherInvoiceStatus: match.otherStatus,
              confidence: match.confidence,
              signals: match.signals,
              finding: match.explanation,
            })),
          },
        },
        execution: {
          txRef,
          chainMode: paymentExecution?.providerMode ?? provider.mode,
          resultingStatus: status,
          settlementRequired: true,
          feeUsd: paymentExecution?.feeUsd ?? null,
          feeSource: paymentExecution?.feeSource ?? null,
          settledInMs: paymentExecution?.settledInMs ?? null,
          executedAt: paymentExecution?.executedAt ?? null,
          reconciled: paymentExecution?.reconciled ?? false,
          // D6: the ledger says the pause is why this held, not just the
          // reasoning text — set only when it is, so it is unambiguous from
          // a hold for a missing operating account or a failed transfer.
          ...heldBecausePausedDetail(heldBecausePaused),
        },
      },
    });

    lines.push({
      domain: "ap",
      message: heldBecausePaused
        ? `${counterparty.name}: not paid, the agent was paused (${amount} USDC)`
        : `${counterparty.name}: ${decision.action} (${amount} USDC)`,
    });
  }

  });

  await stage("contractors", async () => {
  // --------------------------------------------------------------- 3. contractors
  const milestones = unwrap(
    await db
      .from("milestones")
      .select("*, counterparties(id, name, risk_level, payment_limit, performance_score, performance_inputs, address, address_changed_at, address_confirmed_at)")
      .eq("verified", true)
      .eq("status", "verified")
  ) as Array<{
    id: string;
    status: string;
    title: string;
    amount: string;
    verification_source: string | null;
    contractor_id: string;
    agent_reasoning: string | null;
    tx_ref: string | null;
    counterparties: {
      id: string;
      name: string;
      risk_level: string;
      payment_limit: string | null;
      performance_score: string | null;
      performance_inputs: CounterpartyHistoryInputs | null;
      address: string | null;
      address_changed_at: string | null;
      address_confirmed_at: string | null;
    };
  }>;

  // A `verified` milestone with a payment intent already has a release in
  // flight: it is reconciled, not decided again (see reconcileMilestone).
  const releasesInFlight = await existingMilestoneIntents(db, milestones);

  for (const milestone of milestones) {
    const contractor = milestone.counterparties;
    const amount = num(milestone.amount);

    const intent = releasesInFlight.get(milestone.id);
    if (intent) {
      const reconciled = await reconcileMilestone(
        {
          id: milestone.id,
          title: milestone.title,
          amount,
          contractorId: contractor.id,
          contractorName: contractor.name,
          address: contractor.address,
          reasoning: milestone.agent_reasoning,
          txRef: milestone.tx_ref,
        },
        intent,
        { db, provider, operating: operating ? { id: operating.id } : null }
      );
      if (reconciled.operatingBalance !== null) operatingBalance = reconciled.operatingBalance;
      metrics.recordMilestone(reconciled.status, false);
      lines.push(reconciled.line);
      continue;
    }
    // A contractor whose address a person changed, and no one has confirmed
    // since, is not paid (spec 2026-09-30-counterparty-address-edit E4). A
    // held milestone has no approval path, so the milestone stays `verified`
    // and waits: no model call and no ledger entry each cycle, and the first
    // cycle after someone confirms the address decides it as usual.
    if (addressUnconfirmed(contractor.address_changed_at, contractor.address_confirmed_at)) {
      lines.push({
        domain: "contractor",
        message: `${contractor.name}: "${milestone.title}" waiting for someone to confirm its new address`,
      });
      continue;
    }
    const limit = contractor.payment_limit == null ? null : num(contractor.payment_limit);
    const highRisk = contractor.risk_level === "high";
    const overLimit = limit != null && amount > limit;

    const { value: decision, mode, reference, agreedWithReference } = await decide<MilestoneDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to release this verified contractor milestone immediately, rather than waiting for a Net-30 cycle.",
        milestone: {
          title: milestone.title,
          amount,
          verificationSource: milestone.verification_source,
        },
        contractor: {
          name: contractor.name,
          riskLevel: contractor.risk_level,
          paymentLimit: limit,
          performanceHistory: performanceEvidence(
            contractor.performance_score,
            contractor.performance_inputs
          ),
        },
        responseShape: {
          action: "release | hold",
          reasoning: "string",
          confidence: "number between 0 and 1",
        },
      }),
      schema: milestoneDecisionSchema,
      fallback: (): MilestoneDecision => {
        if (highRisk) {
          return {
            action: "hold",
            reasoning: `${contractor.name} is flagged high risk; release blocked pending review.`,
            confidence: 0.95,
          };
        }
        return {
          action: "release",
          reasoning: `Milestone "${milestone.title}" is verified via ${milestone.verification_source}; releasing ${amount} USDC the same day instead of on Net-30 terms.`,
          confidence: 0.85,
        };
      },
    });
    metrics.recordDecisionMode(mode, agreedWithReference);

    let status = "held";
    let txRef: string | null = null;
    let paymentExecution: PaymentExecution | null = null;
    let reasoning = decision.reasoning;
    let guardrailBlocked = false;
    let heldBecausePaused = false;

    if (decision.action === "release") {
      if (highRisk || overLimit) {
        guardrailBlocked = true;
        reasoning += highRisk
          ? " [guardrail override: contractor is high risk — release refused]"
          : ` [guardrail override: amount exceeds the ${limit} USDC limit — release refused]`;
      } else if (operating) {
        const outcome = await releaseMilestoneIfNotPaused(
          { milestoneId: milestone.id, destination: payoutAddress(contractor.address, contractor.id), amount },
          { provider, operatingAccountId: operating.id }
        );
        status = outcome.status;
        txRef = outcome.txRef;
        paymentExecution = outcome.paymentExecution;
        reasoning += outcome.reasoningSuffix;
        heldBecausePaused = outcome.heldBecausePaused;
        if (outcome.operatingBalance !== null) operatingBalance = outcome.operatingBalance;
      }
    }

    const now = new Date().toISOString();
    const update = await db
      .from("milestones")
      .update({
        status,
        agent_reasoning: reasoning,
        decided_at: now,
        settled_at: status === "paid" ? now : null,
        tx_ref: txRef,
      })
      .eq("id", milestone.id);
    if (update.error) throw new Error(update.error.message);
    metrics.recordMilestone(status, guardrailBlocked);

    await appendLedgerEntry({
      actor: "agent",
      domain: "contractor",
      action: `milestone_${decision.action}`,
      summary: `${decision.action.toUpperCase()} milestone "${milestone.title}" for ${contractor.name} (${amount} USDC)`,
      detail: {
        milestoneId: milestone.id,
        counterpartyId: contractor.id,
        decision,
        decisionMode: mode,
        referenceDecision: reference,
        agreedWithReference,
        guardrailBlocked,
        observed: {
          amount,
          paymentLimit: limit,
          riskLevel: contractor.risk_level,
          performanceHistory: performanceEvidence(
            contractor.performance_score,
            contractor.performance_inputs
          ),
          verificationSource: milestone.verification_source,
        },
        execution: {
          txRef,
          chainMode: paymentExecution?.providerMode ?? provider.mode,
          resultingStatus: status,
          settlementRequired: true,
          feeUsd: paymentExecution?.feeUsd ?? null,
          feeSource: paymentExecution?.feeSource ?? null,
          settledInMs: paymentExecution?.settledInMs ?? null,
          executedAt: paymentExecution?.executedAt ?? null,
          reconciled: paymentExecution?.reconciled ?? false,
          // D6: same marker as the AP stage, for the same reason — see the
          // comment there.
          ...heldBecausePausedDetail(heldBecausePaused),
        },
      },
    });

    lines.push({
      domain: "contractor",
      message: heldBecausePaused
        ? `${contractor.name}: not paid, the agent was paused (${amount} USDC)`
        : `${contractor.name}: ${decision.action} "${milestone.title}"`,
    });
  }

  });

  // ------------------------------------- shared obligation measurement
  // Read-only, and deliberately outside any stage: the forecast reports these
  // numbers whether or not the treasury decision was allowed to run.
  const freshAccounts = unwrap(await db.from("accounts").select("*")) as Array<{
    id: string;
    kind: string;
    balance: string;
    apy: string;
  }>;
  const operatingNow = freshAccounts.find((a) => a.kind === "operating");
  const reserveNow = freshAccounts.find((a) => a.kind === "reserve");

  const openInvoices = unwrap(
    await db
      .from("invoices")
      .select("amount, due_date, status")
      .eq("direction", "payable")
      .in("status", [...OPEN_PAYABLE_STATUSES])
  ) as Array<{ amount: string; due_date: string; status: string }>;
  const openMilestones = unwrap(
    await db.from("milestones").select("amount").in("status", ["pending", "verified"])
  ) as Array<{ amount: string }>;

  // Milestones carry no due date because a verified one is payable the same
  // day — that is the whole RFB3 argument — so every open milestone counts
  // against the near-term buffer regardless of horizon.
  const milestoneTotal = openMilestones.reduce((s, r) => s + num(r.amount), 0);
  const payableSummary = summarizePayableObligations(openInvoices);

  // The buffer the agent must not sweep below is what is actually due soon,
  // not every invoice on the books. Summing the whole payables ledger and
  // labelling it "next 7 days" — which this did until it was measured —
  // makes the agent hoard cash it could have earned yield on, and hands the
  // model a premise it has no way to check.
  const obligationsDue7d = payableSummary.due7d + milestoneTotal;
  const obligationsDue14d = payableSummary.due14d + milestoneTotal;
  const obligationsOpenTotal = payableSummary.openTotal + milestoneTotal;

  // How long swept cash could actually stay swept. An open milestone is
  // payable today, so its presence collapses the horizon to zero days.
  const daysUntilNextObligation =
    milestoneTotal > 0
      ? 0
      : payableSummary.daysUntilNext;

  await stage("treasury", async () => {
  if (operatingNow && reserveNow) {
    const operatingBalance = num(operatingNow.balance);
    const reserveBalance = num(reserveNow.balance);
    const apy = num(reserveNow.apy);
    const amountScale = seedScale();

    // A sweep is only worth making if it earns more than it costs, so the
    // policy is computed first and handed to the model as context. It is also
    // the fallback, which means the LLM and the heuristic reason from exactly
    // the same numbers rather than from two different pictures of the book.
    const plan = planTreasury({
      operatingBalance,
      reserveBalance,
      apy,
      obligationsDue7d,
      daysUntilNextObligation,
      roundTripCostUsd: provider.estimatedFeeUsd * 2,
    });

    const { value: decision, mode, reference, agreedWithReference } = await decide<TreasuryDecision>({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        task: "Decide whether to sweep idle operating cash into the USYC-yielding reserve, redeem from the reserve back into operating, or hold.",
        operatingBalance,
        reserveBalance,
        reserveApy: apy,
        upcomingObligationsNext7Days: obligationsDue7d,
        upcomingObligationsNext14Days: obligationsDue14d,
        totalOpenObligations: obligationsOpenTotal,
        daysUntilNextObligation: Number.isFinite(daysUntilNextObligation)
          ? Number(daysUntilNextObligation.toFixed(2))
          : null,
        economics: {
          idleAboveBuffer: plan.idle,
          requiredBuffer: plan.buffer,
          expectedHoldDays: plan.holdDays,
          projectedYieldUsd: plan.projectedYieldUsd,
          roundTripCostUsd: plan.roundTripCostUsd,
          note: "A sweep costs one transfer now and one redemption later. Sweeping is only worth doing when projectedYieldUsd exceeds roundTripCostUsd.",
        },
        responseShape: {
          action: "sweep_to_usyc | redeem_from_usyc | hold",
          amount: "number",
          reasoning: "string",
        },
      }),
      schema: treasuryDecisionSchema,
      fallback: (): TreasuryDecision => plan.decision,
    });
    metrics.recordDecisionMode(mode, agreedWithReference);

    const moveOutcome = await moveTreasuryIfNotPaused(decision, {
      db,
      provider,
      operatingAccountId: operatingNow.id,
      reserveAccountId: reserveNow.id,
      operatingBalance,
      reserveBalance,
    });
    const executed = moveOutcome.executed;
    const executionNote = moveOutcome.executionNote;
    const heldBecausePaused = moveOutcome.heldBecausePaused;

    if (executed) {
      const res = await db.from("treasury_actions").insert({
        action: decision.action,
        amount: decision.amount,
        from_account: decision.action === "sweep_to_usyc" ? operatingNow.id : reserveNow.id,
        to_account: decision.action === "sweep_to_usyc" ? reserveNow.id : operatingNow.id,
        reasoning: decision.reasoning,
      });
      if (res.error) throw new Error(res.error.message);
    }

    await appendLedgerEntry({
      actor: "agent",
      domain: "treasury",
      action: decision.action,
      summary: `Treasury: ${decision.action} ${decision.amount} USDC`,
      detail: {
        decision,
        decisionMode: mode,
        referenceDecision: reference,
        agreedWithReference,
        executed,
        executionNote,
        // D6: same marker as the AP and contractor stages (see the comment
        // there). No `execution` sub-object here, so it sits at the top.
        ...heldBecausePausedDetail(heldBecausePaused),
        // The USYC leg is simulated until EarnKit is wired up; recording that
        // here means the audit trail never overstates what actually happened.
        earnMode: provider.earnMode,
        observed: {
          operatingBalance,
          reserveBalance,
          obligationsDue7d,
          obligationsDue14d,
          obligationsOpenTotal,
          apy,
          amountScale,
        },
        economics: {
          idleAboveBuffer: plan.idle,
          requiredBuffer: plan.buffer,
          expectedHoldDays: plan.holdDays,
          projectedYieldUsd: plan.projectedYieldUsd,
          roundTripCostUsd: plan.roundTripCostUsd,
        },
        heuristicWouldHave: plan.decision.action,
      },
    });

    lines.push({
      domain: "treasury",
      message: heldBecausePaused
        ? `${decision.action}: not moved, the agent was paused (${decision.amount} USDC)`
        : `${decision.action} ${decision.amount} USDC${executionNote ? ` (${executionNote})` : ""}`,
    });
  }

  });

  // --------------------------------------------------- closing balances
  // Read once, outside any stage, because both the forecast and the cycle's
  // own snapshot need them — and the snapshot has to be able to record where
  // the cycle left the book even if the forecast itself failed.
  const finalAccounts = unwrap(await db.from("accounts").select("id, name, kind, token, balance")) as Array<{
    id: string;
    name: string;
    kind: string;
    token: string;
    balance: string;
  }>;
  const liquid = finalAccounts.reduce((s, r) => s + num(r.balance), 0);
  let projectedInflow = 0;

  await stage("forecast", async () => {
  // ------------------------------------------------------------------ 5. forecast
  const receivables = unwrap(
    await db.from("invoices").select("amount").eq("direction", "receivable").in("status", ["pending", "matched"])
  ) as Array<{ amount: string }>;
  projectedInflow = receivables.reduce((s, r) => s + num(r.amount), 0);

  const forecast = await db.from("forecasts").insert({
    as_of: new Date().toISOString(),
    horizon_days: 14,
    projected_inflow: projectedInflow,
    projected_outflow: obligationsDue14d,
    liquid_balance: liquid,
    recommendation:
      obligationsDue14d > liquid
        ? "Liquidity gap projected — redeem from USYC or accelerate receivables before the next cycle."
        : "Liquidity healthy.",
  });
  if (forecast.error) throw new Error(forecast.error.message);
  });

  const finishedAt = new Date().toISOString();
  const cycleMetrics = metrics.snapshot();
  const outcome = journal.outcome();
  const failureSummary = journal.summary();
  if (failureSummary) {
    lines.push({ domain: "system", message: `Cycle ${outcome}: ${failureSummary}` });
  }
  // Closes the row opened before the cycle began, rather than creating one. A
  // run that never reaches here stays recorded as failed, or as `running` if
  // the database itself was what went down.
  const cycleRun = unwrap(
    await db.from("cycle_runs").update({
      status: outcome,
      failed_stage: journal.failedStage(),
      error_message: failureSummary,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      stages: journal.stages(),
      decision_count: cycleMetrics.decisionCount,
      paid_count: cycleMetrics.paidCount,
      held_count: cycleMetrics.heldCount,
      flagged_count: cycleMetrics.flaggedCount,
      awaiting_info_count: cycleMetrics.awaitingInfoCount,
      released_count: cycleMetrics.releasedCount,
      model_decision_count: cycleMetrics.modelDecisionCount,
      heuristic_decision_count: cycleMetrics.heuristicDecisionCount,
      guardrail_override_count: cycleMetrics.guardrailOverrideCount,
      reference_disagreement_count: cycleMetrics.referenceDisagreementCount,
      chain_mode: provider.mode,
      screening_mode: complianceScreeningMode(),
    }).eq("id", cycleRunId).select("id").single<{ id: string }>()
  );
  const accountBalances = Object.fromEntries(finalAccounts.map((account) => [account.id, {
    name: account.name,
    kind: account.kind,
    token: account.token,
    balance: num(account.balance),
  }]));
  const totalLiquid = finalAccounts
    .filter((account) => account.kind !== "reserve")
    .reduce((sum, account) => sum + num(account.balance), 0);
  const reservePosition = finalAccounts
    .filter((account) => account.kind === "reserve")
    .reduce((sum, account) => sum + num(account.balance), 0);
  const snapshot = unwrap(
    await db.from("cycle_snapshots").insert({
      cycle_run_id: cycleRun.id,
      captured_at: finishedAt,
      sim_day: clockMode === "simulate" ? day : null,
      account_balances: accountBalances,
      total_liquid: totalLiquid,
      open_payables: payableSummary.openTotal,
      open_receivables: projectedInflow,
      obligations_due_7d: obligationsDue7d,
      obligations_due_14d: obligationsDue14d,
      reserve_position: reservePosition,
      chain_mode: provider.mode,
    }).select("id").single<{ id: string }>()
  );
  await appendLedgerEntry({
    actor: "system",
    domain: "system",
    action: "cycle_complete",
    summary: cycleCompleteSummary(clockMode, day, finishedAt, cycleMetrics.decisionCount),
    detail: {
      ...(triggeredBy ? { by: triggeredBy } : {}),
      day,
      clockMode,
      startedAt,
      finishedAt,
      decisionCount: cycleMetrics.decisionCount,
      chainMode: provider.mode,
      screeningMode: complianceScreeningMode(),
      cycleRunId: cycleRun.id,
      snapshotId: snapshot.id,
      outcomes: cycleMetrics,
    },
  });

  return { day, lines, mode: provider.mode, clockMode, startedAt, finishedAt };
}
