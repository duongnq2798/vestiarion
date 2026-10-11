import { FAILED_STATES, MAY_HAVE_BEEN_ACCEPTED } from "./circle/settlement";
import { paidAcrossChains } from "./payee-chains";
import { GATEWAY_FAILED, reduceSettlement, type Settlement, type SettlementBooks, type SettlementFact } from "./settlement";

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
        } else if (intent.provider_state === GATEWAY_FAILED) {
          // Gateway's failure: its attestation may still be minted, so it keeps Gateway's own word as its last; the
          // lifecycle tells it apart from a transfer in flight, since nothing watches it any more (L3).
          facts.push({ kind: "pending", at: intent.updated_at, attempt, state: intent.provider_state, by: "circle" });
        } else {
          // Circle took it and has not ended it: a read of ours failed (L3).
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

/**
 * A payment's lifecycle, from its intent, the entries about its bill and the bill itself (L1-L6). `entriesComplete`
 * false: the entries were read up to a limit that may have left older ones out (L5, L8).
 */
export function settlementOf(input: {
  intent: IntentRecord;
  entries: readonly SettlementEntry[];
  source: { type: "invoice" | "milestone"; id: string };
  books: SettlementBooks | null;
  entriesComplete?: boolean;
  now: number;
}): Settlement {
  const { intent } = input;
  return reduceSettlement({
    facts: [...intentFacts(intent, input.now), ...entryFacts(input.entries, input.source)],
    books: input.books,
    crossChain: crossChain(intent.destination_chain),
    simulated: intent.provider === "simulate" || intent.provider_mode === "simulate",
    recordingsComplete: input.entriesComplete ?? true,
  });
}

/** A bill as its payment's books read it: whether it is marked paid, with which transaction, since when (L5). */
export interface BillBooks {
  id: string;
  status: string;
  tx_ref: string | null;
  settled_at?: string | null;
}

/** The books of a bill, as the lifecycle compares them with its transfer: `paid` is the bill's own status (L5). */
export function booksOf(bill: BillBooks): SettlementBooks {
  return { paid: bill.status === "paid", txRef: bill.tx_ref, at: bill.settled_at ?? null };
}

/** A payment intent with the bill it pays. */
type BillPayment = IntentRecord & { source_type: "invoice" | "milestone"; source_id: string };

/**
 * Each payment with its bill and its lifecycle, for the bills a page shows (L7): a payment whose bill is not among them is
 * left out. The entries are grouped by bill once, so a page with many bills reads each entry once.
 */
export function billSettlements<P extends BillPayment, B extends BillBooks>(input: {
  payments: Iterable<P>;
  invoices?: readonly B[];
  milestones?: readonly B[];
  entries: readonly SettlementEntry[];
  /** False when the entries were read up to a limit that may have left older ones out. */
  entriesComplete?: boolean;
  now: number;
}): Array<{ payment: P; bill: B; settlement: Settlement }> {
  const bills = new Map<string, B>();
  for (const bill of input.invoices ?? []) bills.set(`invoice:${bill.id}`, bill);
  for (const bill of input.milestones ?? []) bills.set(`milestone:${bill.id}`, bill);
  const entriesOf = new Map<string, SettlementEntry[]>();
  for (const entry of input.entries) {
    for (const [type, key] of [
      ["invoice", "invoiceId"],
      ["milestone", "milestoneId"],
    ] as const) {
      const id = entry.detail[key];
      if (typeof id !== "string") continue;
      const list = entriesOf.get(`${type}:${id}`) ?? [];
      list.push(entry);
      entriesOf.set(`${type}:${id}`, list);
    }
  }
  const found: Array<{ payment: P; bill: B; settlement: Settlement }> = [];
  for (const payment of input.payments) {
    const key = `${payment.source_type}:${payment.source_id}`;
    const bill = bills.get(key);
    if (!bill) continue;
    const settlement = settlementOf({
      intent: payment,
      entries: entriesOf.get(key) ?? [],
      source: { type: payment.source_type, id: payment.source_id },
      books: booksOf(bill),
      entriesComplete: input.entriesComplete ?? true,
      now: input.now,
    });
    found.push({ payment, bill, settlement });
  }
  return found;
}

/** Each payment's lifecycle by its bill's id, for the cards of the bills a page shows (L7). */
export function settlementsByBill(input: {
  payments: Iterable<BillPayment>;
  invoices?: readonly BillBooks[];
  milestones?: readonly BillBooks[];
  entries: readonly SettlementEntry[];
  entriesComplete?: boolean;
  now: number;
}): Map<string, Settlement> {
  return new Map(billSettlements(input).map(({ payment, settlement }) => [payment.source_id, settlement]));
}

/** A payment as Treasury lists it (L7): whom it pays, the bill it pays, what it carries, and where it is. */
export interface FlightRow {
  source: { type: "invoice" | "milestone"; id: string };
  /** The payee, or the milestone and its contractor. */
  name: string;
  /** What was sent: the invoice's `paid_amount`, written with the transfer that carried it, else the intent's amount. */
  amount: number;
  currency: string;
  settlement: Settlement;
}

type Named = BillBooks & { name: string; sent: number | null };

/**
 * Treasury's payments (L7, L8): each payment read for it, with its bill's books and the entries about it. The intent keeps
 * its first attempt's amount, which a resend after a discount's deadline does not change; the invoice's `paid_amount`
 * is what the transfer in flight carries (0038).
 */
export function flightRows(input: {
  payments: Iterable<BillPayment & { amount: number; token: string }>;
  invoices: readonly (BillBooks & { counterparty_name: string; paid_amount?: number | null })[];
  milestones: readonly (BillBooks & { contractor_name: string; title: string })[];
  entries: readonly SettlementEntry[];
  entriesComplete?: boolean;
  now: number;
}): FlightRow[] {
  const invoices: Named[] = input.invoices.map((invoice) => ({ id: invoice.id, status: invoice.status, tx_ref: invoice.tx_ref, settled_at: invoice.settled_at, name: invoice.counterparty_name, sent: invoice.paid_amount ?? null }));
  const milestones: Named[] = input.milestones.map((milestone) => ({
    id: milestone.id,
    status: milestone.status,
    tx_ref: milestone.tx_ref,
    settled_at: milestone.settled_at,
    name: `${milestone.title} for ${milestone.contractor_name}`,
    sent: null,
  }));
  return billSettlements({ payments: input.payments, invoices, milestones, entries: input.entries, entriesComplete: input.entriesComplete ?? true, now: input.now }).map(({ payment, bill, settlement }) => ({
    source: { type: payment.source_type, id: payment.source_id },
    name: bill.name,
    amount: bill.sent ?? payment.amount,
    currency: payment.token,
    settlement,
  }));
}
