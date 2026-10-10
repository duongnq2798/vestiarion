import { FAILED_STATES, MAY_HAVE_BEEN_ACCEPTED } from "./circle/settlement";
import { networkOf, type Network } from "./network";
import { paidAcrossChains } from "./payee-chains";
import { reduceSettlement, type Settlement, type SettlementBooks, type SettlementFact } from "./settlement";

/**
 * The facts a payment's lifecycle is read from (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md L2,
 * L3), from the rows already recorded: its payment intent (`payment_intents`), the signed entries about its bill, and
 * the bill itself. Pure: the page reads the rows inside its organization scope and hands them here.
 */

/** The payment intent's columns the lifecycle reads (`src/lib/settlement-read.ts` selects exactly these). */
export interface IntentRecord {
  status: string;
  provider: string | null;
  provider_mode: string | null;
  provider_tx_id: string | null;
  provider_state: string | null;
  failure_reason: string | null;
  last_error: string | null;
  tx_hash: string | null;
  mint_tx_hash: string | null;
  destination_chain: string | null;
  transfer_attempt: number | null;
  /** Each attempt Circle ended before this one, as `begin_payment_retry` keeps it (0036). */
  previous_attempts: unknown;
  /** When the current attempt was sent: 0080 stamps it whenever the row becomes `submitting`. */
  submitted_at: string | null;
  executed_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  batch_key: string | null;
  network: string | null;
}

/** How long a claimed send may run before it is claimed again (claim_payment_intent, 0004): past it, Circle never answered. */
const CLAIM_RUNS_MS = 2 * 60_000;

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const record = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const terminal = (state: string | null) => state !== null && FAILED_STATES.includes(state);

/** Circle's terminal state as an end: `CANCELLED` is a cancellation, `FAILED` and `DENIED` a failure (L3). */
function circleEnd(state: string): "failed" | "cancelled" {
  return state === "CANCELLED" ? "cancelled" : "failed";
}

/** The attempts Circle ended before the current one, as the row keeps them. */
function earlierEnds(value: unknown): SettlementFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<SettlementFact>((item) => {
    const attempt = record(item);
    const number = typeof attempt?.attempt === "number" ? attempt.attempt : null;
    const state = text(attempt?.providerState);
    const at = text(attempt?.failedAt);
    if (number === null || !at || !state) return [];
    return [{ kind: "ended", at, attempt: number, end: terminal(state) ? circleEnd(state) : "failed", state, reason: text(attempt?.failureReason) }];
  });
}

/** What the payment intent says, attempt by attempt (L2, L3). `now` tells a send left running past its claim. */
export function intentFacts(intent: IntentRecord, now: number): SettlementFact[] {
  const attempt = intent.transfer_attempt ?? 1;
  const facts = earlierEnds(intent.previous_attempts);
  // A new attempt not yet sent keeps the last one's `submitted_at`: nothing of it is sent.
  if (intent.status === "created") return facts;
  const sentAt = intent.submitted_at ?? intent.executed_at ?? intent.created_at;
  facts.push({ kind: "submitted", at: sentAt, attempt });
  const lastRead = intent.executed_at ?? intent.updated_at;
  switch (intent.status) {
    case "submitting":
      // Running longer than a claim may: the send may have reached Circle with its answer lost (payment safety R1).
      if (now - Date.parse(intent.updated_at) > CLAIM_RUNS_MS) facts.push({ kind: "unanswered", at: intent.updated_at, attempt });
      return facts;
    case "pending":
      if (intent.provider_tx_id) facts.push({ kind: "pending", at: lastRead, attempt, state: intent.provider_state, by: "circle" });
      return facts;
    case "confirmed": {
      const at = intent.confirmed_at ?? lastRead;
      const refs = [intent.tx_hash, intent.mint_tx_hash, intent.provider_tx_id].filter((ref): ref is string => Boolean(ref));
      facts.push({ kind: "confirmed", at, attempt, refs: [...new Set(refs)], txHash: intent.tx_hash });
      if (intent.mint_tx_hash && intent.destination_chain) facts.push({ kind: "minted", at, attempt, chain: intent.destination_chain, txHash: intent.mint_tx_hash });
      return facts;
    }
    case "failed":
      if (intent.provider_tx_id) {
        if (terminal(intent.provider_state)) {
          facts.push({ kind: "ended", at: intent.updated_at, attempt, end: circleEnd(intent.provider_state as string), state: intent.provider_state, reason: intent.failure_reason });
        } else {
          // Circle took it and has not ended it: a read of ours failed, or Gateway's failure, which may still be minted (L3).
          facts.push({ kind: "pending", at: lastRead, attempt, state: intent.provider_state, by: "circle" }, { kind: "read_failed", at: intent.updated_at, attempt });
        }
        return facts;
      }
      // Circle never answered the send, or a batch whose answer was lost: looked for, never not sent (R4, R5).
      if (intent.last_error?.includes(MAY_HAVE_BEEN_ACCEPTED) || (intent.batch_key && attempt === 1)) {
        facts.push({ kind: "unanswered", at: intent.updated_at, attempt });
        return facts;
      }
      facts.push({ kind: "ended", at: intent.updated_at, attempt, end: "not_sent", state: null, reason: intent.last_error });
      return facts;
    default:
      return facts;
  }
}

/** A ledger entry as the lifecycle reads it. */
export interface SettlementEntry {
  seq: number;
  ts: string;
  action: string;
  detail: Record<string, unknown>;
}

/** The entries that name a payment's transaction (the receipts' recording entries, and a milestone's own). */
const RECORDING = new Set(["ap_pay", "approval_paid", "ap_reconcile", "milestone_release", "milestone_approval_paid"]);
/** The agent's decisions to pay or schedule. */
const AGENT_PAYS = new Set(["ap_pay", "ap_schedule", "milestone_release"]);
/** A person's approval that pays. */
const PERSON_PAYS = new Set(["approval_paid", "milestone_approval_paid"]);
/** What a decision's transfer ended as when it went out: paid, in flight (`verified` for a milestone). */
const WENT_OUT = new Set(["paid", "matched", "verified"]);

/** What the signed entries about a bill say (L2): who proposed and authorized it, the transfer watch's reads, the recordings. */
export function entryFacts(entries: readonly SettlementEntry[], source: { type: "invoice" | "milestone"; id: string }): SettlementFact[] {
  const key = source.type === "invoice" ? "invoiceId" : "milestoneId";
  return [...entries]
    .filter((entry) => entry.detail[key] === source.id)
    .sort((a, b) => a.seq - b.seq)
    .flatMap<SettlementFact>((entry) => {
      const facts: SettlementFact[] = [];
      const detail = entry.detail;
      const execution = record(detail.execution);
      if (AGENT_PAYS.has(entry.action) && detail.guardrailBlocked !== true) {
        facts.push({ kind: "proposed", at: entry.ts, by: "agent", seq: entry.seq });
        const resulting = text(execution?.resultingStatus);
        // Sent: it went out, or it was held only because its transfer failed (no other reason recorded).
        const sent = entry.action !== "ap_schedule" && (WENT_OUT.has(resulting ?? "") || (resulting === "held" && !text(execution?.heldBecause)));
        if (sent) facts.push({ kind: "authorized", at: entry.ts, by: "code", seq: entry.seq });
      }
      if (PERSON_PAYS.has(entry.action)) {
        const two = Array.isArray(detail.approvals) && detail.approvals.length > 1;
        facts.push({ kind: "proposed", at: entry.ts, by: "person", seq: entry.seq }, { kind: "authorized", at: entry.ts, by: two ? "two_people" : "person", seq: entry.seq });
      }
      if (entry.action === "payment_stuck") {
        const attempt = typeof detail.attempt === "number" ? detail.attempt : 1;
        // The watch's read: Circle never answered the send, or what it showed when asked (stuck-transfer alert D5).
        facts.push(
          detail.sendAnswered === false
            ? { kind: "unanswered", at: entry.ts, attempt }
            : { kind: "pending", at: entry.ts, attempt, state: text(detail.providerState), by: "watch" }
        );
      }
      if (RECORDING.has(entry.action)) {
        const refs = [text(execution?.txRef), text(detail.txRef), text(execution?.mintTxHash)].filter((ref): ref is string => ref !== null);
        for (const txRef of new Set(refs)) facts.push({ kind: "recorded", at: entry.ts, seq: entry.seq, txRef });
      }
      return facts;
    });
}

/** Whether a payment's destination is another chain than its network's own: an unknown one is treated as another. */
function crossChain(destination: string | null): boolean {
  try {
    return paidAcrossChains(destination);
  } catch {
    return true;
  }
}

/** A payment's lifecycle, from its intent, the entries about its bill and the bill itself (L1-L6). */
export function settlementOf(input: {
  intent: IntentRecord;
  entries: readonly SettlementEntry[];
  source: { type: "invoice" | "milestone"; id: string };
  books: SettlementBooks | null;
  now: number;
}): Settlement {
  const { intent } = input;
  return reduceSettlement({
    facts: [...intentFacts(intent, input.now), ...entryFacts(input.entries, input.source)],
    books: input.books,
    crossChain: crossChain(intent.destination_chain),
    simulated: intent.provider === "simulate" || intent.provider_mode === "simulate",
  });
}

/** The network a payment was made on: its own record's, else the workspace's (0075). */
export function intentNetwork(intent: Pick<IntentRecord, "network">, workspace: Network): Network {
  try {
    return intent.network ? networkOf(intent.network) : workspace;
  } catch {
    return workspace;
  }
}
