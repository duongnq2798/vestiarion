/**
 * One settlement lifecycle per payment (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md): where a
 * payment is, from the facts already recorded about it, each stage from its own source (L2), the ends kept apart (L3),
 * "available" as this rail means it (L4), whether the books agree (L5), and the same answer whatever order the facts
 * come in (L6). Pure, and a read model only: nothing that moves money reads it (L1). The facts come from the rows
 * through `./settlement-facts`.
 */

/** The canonical stages, in order (L2). */
export const SETTLEMENT_STAGES = ["proposed", "authorized", "submitted", "pending", "confirmed", "available", "reconciled"] as const;
export type SettlementStage = (typeof SETTLEMENT_STAGES)[number];

/** What the live provider records when Gateway reports a transfer failed: its attestation may still be minted (L3). */
export const GATEWAY_FAILED = "GATEWAY_FAILED";

/** How an attempt ended without paying the payee (L3): Circle failed or denied it, Circle cancelled it, or it never reached Circle. */
export type AttemptEnd = "failed" | "cancelled" | "not_sent";

/** One thing recorded about a payment, from its own source, with when it was so. */
export type SettlementFact =
  /** The agent decided to pay or schedule it, or a person chose to pay it: a signed entry. */
  | { kind: "proposed"; at: string; by: "agent" | "person"; seq: number | null }
  /** What let it be sent: code's checks, a person's approval, or two people's. */
  | { kind: "authorized"; at: string; by: "code" | "person" | "two_people"; seq: number | null }
  /** Vestiarion sent the attempt to Circle. */
  | { kind: "submitted"; at: string; attempt: number }
  /**
   * Circle has the transfer and has not confirmed it: its own state word, read by the payment or the transfer watch, at
   * `at`. Circle took it as it was sent, so the stage is reached by the send, whenever its word was read.
   */
  | { kind: "pending"; at: string; attempt: number; state: string | null; by: "circle" | "watch" }
  /** A read of Vestiarion's failed: it says nothing about the transfer. */
  | { kind: "read_failed"; at: string; attempt: number }
  /** Circle never answered the send: it may hold the transfer (payment safety R1, R10). */
  | { kind: "unanswered"; at: string; attempt: number }
  /** Circle confirmed the transfer; every reference it is known by: its hash, its mint, Circle's id. */
  | { kind: "confirmed"; at: string; attempt: number; refs: string[]; txHash: string | null }
  /** A payout to another chain was minted there. */
  | { kind: "minted"; at: string; attempt: number; chain: string; txHash: string }
  /** The attempt ended without paying the payee. */
  | { kind: "ended"; at: string; attempt: number; end: AttemptEnd; state: string | null; reason: string | null }
  /** A signed entry names the payment's transaction. */
  | { kind: "recorded"; at: string; seq: number; txRef: string };

/**
 * Who comes back to a bill next, by its status (L5, L10): the agent's cycle, which reads its payment again each time it
 * runs; a person in Approvals, whose Approve and pay looks for a send Circle never answered first and records a transfer
 * already confirmed; or a person on Contractors, whose Pay now on a held milestone does the same.
 */
export type FollowUp = "cycle" | "approvals" | "contractors";

/** The bill's own row: whether it is marked paid, with which transaction, and since when. */
export interface SettlementBooks {
  paid: boolean;
  txRef: string | null;
  at: string | null;
  /** Who comes back to the bill next; null, or absent, when no one does or it is not known: then nothing is promised. */
  followUp?: FollowUp | null;
}

/** A CCTP payout's step on the network, as the current attempt's Circle id names it, with its transaction and the payee's chain. */
export interface BridgeStep {
  /** Its approve, whose burn is not sent yet (`cctp-approve:`), or its burn (`cctp:`). */
  step: "approve" | "burn";
  txHash: string | null;
  chain: string | null;
}

export interface SettlementInput {
  facts: readonly SettlementFact[];
  /** The bill the payment pays, or null when there is none to compare. */
  books: SettlementBooks | null;
  /** Paid to another chain (CCTP, Gateway): in the payee's wallet only once minted there (L4). */
  crossChain: boolean;
  /** For a CCTP payout, the step on the network its current attempt is at; null or absent otherwise. */
  bridge?: BridgeStep | null;
  /** A sandbox's payment: nothing reached a wallet. */
  simulated: boolean;
  /**
   * Whether the entries the facts come from were read in full. A read cut at its row limit leaves the oldest out, so an
   * entry naming the transaction may exist unread: then a missing one is unknown, never a mismatch (L5). True by default.
   */
  recordingsComplete?: boolean;
  /** Circle's id for the current attempt's transfer, carried for the trail (payment exceptions E7); null or absent with none. */
  circleId?: string | null;
}

/** Who or what says a stage was reached. */
export type StageSource = "agent" | "person" | "two_people" | "code" | "vestiarion" | "circle" | "watch" | "chain" | "books";

export interface StageMark {
  at: string | null;
  by: StageSource;
  /** The signed entry the stage comes from, when one does. */
  seq?: number | null;
  /** Circle's own word, while pending: its latest. */
  state?: string | null;
  /** When that word was read, by the payment's own read or the transfer watch's; `at` is when Circle took the transfer. */
  stateAt?: string | null;
  /** The transaction: confirmed, minted, the one the books name, or a payout's step on the network Circle confirmed. */
  txHash?: string | null;
  /** The chain a payout to another chain was minted on. */
  chain?: string | null;
}

/**
 * Where the payment is now, in one word. `gateway_failed`: Gateway reported the payout failed, though its attestation may
 * still be minted (L3). Nothing watches it any more and nothing sends it again, so it is not in flight; nor is it an end.
 */
export type SettlementStatus = "waiting" | "in_flight" | "unknown" | "gateway_failed" | "confirmed" | "reconciled" | "failed" | "cancelled" | "not_sent";

/** How the books disagree with the transfer (L5). */
export type SettlementMismatch = "confirmed_not_marked_paid" | "marked_paid_not_confirmed" | "marked_paid_other_transaction" | "no_signed_entry";

/** A fact that contradicted a verified state; the state stands, or, for money that moved, the confirmation does (L6). */
export interface SettlementConflict {
  attempt: number;
  at: string;
  kind: "failure_after_confirmed" | "confirmed_after_failure" | "circle_answered_not_sent";
}

export interface EarlierAttempt {
  attempt: number;
  end: AttemptEnd | null;
  at: string | null;
  state: string | null;
  reason: string | null;
}

export interface Settlement {
  status: SettlementStatus;
  /** The furthest stage reached; null with nothing recorded. */
  stage: SettlementStage | null;
  /** The current attempt: the highest one recorded. */
  attempt: number;
  stages: Partial<Record<SettlementStage, StageMark>>;
  /** How the current attempt ended, when it did without paying. */
  end: { end: AttemptEnd; at: string; state: string | null; reason: string | null } | null;
  /** Since when Circle has not answered the current attempt's send. */
  unknownSince: string | null;
  /** When a read of Vestiarion's last failed, after Circle's last word. */
  readFailedAt: string | null;
  /** When the current attempt was sent, while it is in flight: what its age counts from. */
  inFlightSince: string | null;
  earlier: EarlierAttempt[];
  mismatch: SettlementMismatch | null;
  /** Confirmed and marked paid with its transaction, but the entries were not read in full and none read names it (L5). */
  recordingUnread: boolean;
  conflicts: SettlementConflict[];
  simulated: boolean;
  /** Paid to another chain: an unknown send is asked again under its key there, rather than looked up (I18). */
  crossChain: boolean;
  /**
   * A CCTP payout still pending whose step on the network Circle reports confirmed (`CONFIRMED`, `COMPLETE`): its burn,
   * whose mint is not recorded yet, or its approve, whose burn is not sent yet. Circle's word is the step's, not the
   * payout's (L3).
   */
  stepConfirmed: BridgeStep | null;
  /** Who comes back to the bill next, from its books; null promises no one (L5, L10). */
  followUp: FollowUp | null;
  /** Circle's id for the current attempt's transfer, when the payment intent has one: the trail a person gives Circle. */
  circleId?: string;
}

/** Circle's words for a transaction it confirmed. */
const CONFIRMED_STATES = new Set(["CONFIRMED", "COMPLETE"]);

interface AttemptState {
  attempt: number;
  submittedAt: string | null;
  /** Circle's latest word, read at `at`, and when the first word about this attempt was read. */
  pending: { at: string; state: string | null; by: "circle" | "watch"; first: string } | null;
  readFailedAt: string | null;
  unknownSince: string | null;
  confirmed: { at: string; refs: string[]; txHash: string | null } | null;
  minted: { at: string; chain: string; txHash: string } | null;
  ended: { end: AttemptEnd; at: string; state: string | null; reason: string | null } | null;
}

/** Same-time facts in the order they happen: a decision, then the send, then Circle's answers, then the books. */
const ORDER: Record<SettlementFact["kind"], number> = {
  proposed: 0,
  authorized: 1,
  submitted: 2,
  unanswered: 3,
  pending: 4,
  read_failed: 5,
  ended: 6,
  confirmed: 7,
  minted: 8,
  recorded: 9,
};

const time = (at: string) => {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? 0 : parsed;
};
const later = (a: string, b: string) => time(a) > time(b);
const seqOf = (fact: SettlementFact) => ("seq" in fact && typeof fact.seq === "number" ? fact.seq : 0);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every fact once, by time, then by stage, then by ledger sequence: the order they arrived in does not matter (L6). */
function ordered(facts: readonly SettlementFact[]): SettlementFact[] {
  const seen = new Map<string, SettlementFact>();
  for (const fact of facts) {
    const key = JSON.stringify(fact, Object.keys(fact).sort());
    if (!seen.has(key)) seen.set(key, fact);
  }
  return [...seen.values()].sort((a, b) => time(a.at) - time(b.at) || ORDER[a.kind] - ORDER[b.kind] || seqOf(a) - seqOf(b) || compareText(JSON.stringify(a), JSON.stringify(b)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fresh(attempt: number): AttemptState {
  return { attempt, submittedAt: null, pending: null, readFailedAt: null, unknownSince: null, confirmed: null, minted: null, ended: null };
}

/** One rail fact applied to its attempt, by the replay rules (L6). */
function apply(state: AttemptState, fact: Exclude<SettlementFact, { kind: "proposed" | "authorized" | "recorded" }>, conflicts: SettlementConflict[]): void {
  const circleEnded = state.ended !== null && state.ended.end !== "not_sent";
  switch (fact.kind) {
    case "submitted":
      if (state.confirmed || circleEnded) return;
      // A send under the same key after Vestiarion concluded it never reached Circle: sent again (a claim taken again).
      if (state.ended?.end === "not_sent") {
        if (later(fact.at, state.ended.at)) {
          state.ended = null;
          state.unknownSince = null;
          state.submittedAt = fact.at;
        }
        return;
      }
      state.submittedAt ??= fact.at;
      return;
    case "unanswered":
      // Circle answered something about this attempt, or ended it: the send is not unknown.
      if (state.confirmed || state.pending || circleEnded) return;
      if (state.ended?.end === "not_sent") {
        if (!later(fact.at, state.ended.at)) return;
        state.ended = null;
      }
      state.unknownSince ??= fact.at;
      return;
    case "pending":
      // A stale read: Circle confirmed or ended this attempt, which a pending read never undoes.
      if (state.confirmed || circleEnded) return;
      if (state.ended?.end === "not_sent") {
        // Circle has the transfer: Vestiarion's conclusion that it never reached Circle is corrected.
        conflicts.push({ attempt: state.attempt, at: fact.at, kind: "circle_answered_not_sent" });
        state.ended = null;
      }
      state.unknownSince = null;
      if (!state.pending || !later(state.pending.at, fact.at)) state.pending = { at: fact.at, state: fact.state, by: fact.by, first: state.pending?.first ?? fact.at };
      return;
    case "read_failed":
      if (state.confirmed || state.ended) return;
      if (!state.readFailedAt || later(fact.at, state.readFailedAt)) state.readFailedAt = fact.at;
      return;
    case "confirmed":
      if (state.confirmed) {
        state.confirmed.refs = [...new Set([...state.confirmed.refs, ...fact.refs])];
        state.confirmed.txHash ??= fact.txHash;
        return;
      }
      // Money moved: a confirmation stands even over an end Circle reported before it, and the contradiction is listed.
      if (circleEnded) conflicts.push({ attempt: state.attempt, at: fact.at, kind: "confirmed_after_failure" });
      state.confirmed = { at: fact.at, refs: [...fact.refs], txHash: fact.txHash };
      state.ended = null;
      state.unknownSince = null;
      return;
    case "minted":
      state.minted ??= { at: fact.at, chain: fact.chain, txHash: fact.txHash };
      return;
    case "ended":
      if (state.confirmed) {
        // Confirmed is never undone (L6); a failure after it is a contradiction worth a look.
        if (fact.end !== "not_sent") conflicts.push({ attempt: state.attempt, at: fact.at, kind: "failure_after_confirmed" });
        return;
      }
      if (fact.end === "not_sent") {
        // Circle has it, or already ended it: Vestiarion's conclusion cannot be right.
        if (state.pending || state.ended) return;
        state.ended = { end: fact.end, at: fact.at, state: fact.state, reason: fact.reason };
        state.unknownSince = null;
        return;
      }
      if (circleEnded) return;
      state.ended = { end: fact.end, at: fact.at, state: fact.state, reason: fact.reason };
      state.unknownSince = null;
      return;
  }
}

/** Whether one of the transfer's references is `ref`, whatever its case. */
const isRef = (refs: readonly string[], ref: string | null | undefined) => typeof ref === "string" && refs.some((known) => same(known, ref));

/** A payment's lifecycle from its facts (L2-L6). */
export function reduceSettlement(input: SettlementInput): Settlement {
  let proposed: Extract<SettlementFact, { kind: "proposed" }> | null = null;
  const authorizations: Array<Extract<SettlementFact, { kind: "authorized" }>> = [];
  const recordings: Array<Extract<SettlementFact, { kind: "recorded" }>> = [];
  const attempts = new Map<number, AttemptState>();
  const conflicts: SettlementConflict[] = [];
  for (const fact of ordered(input.facts)) {
    if (fact.kind === "proposed") proposed ??= fact;
    else if (fact.kind === "authorized") authorizations.push(fact);
    else if (fact.kind === "recorded") recordings.push(fact);
    else {
      const state = attempts.get(fact.attempt) ?? fresh(fact.attempt);
      attempts.set(fact.attempt, state);
      apply(state, fact, conflicts);
    }
  }

  const number = attempts.size > 0 ? Math.max(...attempts.keys()) : 1;
  const current = attempts.get(number) ?? fresh(number);
  const sentAt = current.submittedAt;
  // The entry that proposes or authorizes a payment is signed once the transfer's first answer is back, so after the send:
  // what it says was so by the time the payment was sent, and the stage is shown then at the latest (L2).
  const byTheSend = (at: string) => (sentAt && later(at, sentAt) ? sentAt : at);
  // What let the current attempt go: the first authorization recorded once it was sent (the entry that sent it), else the
  // latest before (one sent again later under the same approval). A later approval of a transfer already in flight
  // records it; it did not let it go.
  const authorized = sentAt
    ? (authorizations.find((fact) => !later(sentAt, fact.at)) ?? authorizations.filter((fact) => later(sentAt, fact.at)).at(-1) ?? null)
    : (authorizations.at(-1) ?? null);
  const stages: Settlement["stages"] = {};
  if (proposed) stages.proposed = { at: byTheSend(proposed.at), by: proposed.by, seq: proposed.seq };
  if (authorized) stages.authorized = { at: byTheSend(authorized.at), by: authorized.by, seq: authorized.seq };
  if (sentAt) stages.submitted = { at: sentAt, by: "vestiarion" };
  const confirmed = current.confirmed;
  // A CCTP payout's burn (or approve) Circle confirmed on the network, while the payout waits for its mint (or burn): the
  // pending stage links that step's transaction, and the track says which step Circle's word is about (L3).
  const stepConfirmed =
    !confirmed && !current.ended && input.crossChain && input.bridge && current.pending?.state && CONFIRMED_STATES.has(current.pending.state) ? input.bridge : null;
  if (current.pending) {
    // Reached when Circle took the transfer, as the send reached it: at the send, or at Circle's first word when that is
    // earlier or no send is recorded. A later read, each cycle's or the transfer watch's, changes Circle's word and when
    // it was read (`stateAt`), never when the stage was reached (L2).
    const pending = current.pending;
    const reached = sentAt && !later(sentAt, pending.first) ? sentAt : pending.first;
    stages.pending = { at: reached, by: pending.by, state: pending.state, stateAt: pending.at, ...(stepConfirmed?.txHash ? { txHash: stepConfirmed.txHash } : {}) };
  }
  if (confirmed) {
    // Gateway's payout is known by its mint, on the payee's chain: its transaction is linked there, never on Arc.
    const onPayeeChain = current.minted && confirmed.txHash && same(confirmed.txHash, current.minted.txHash) ? current.minted.chain : null;
    stages.confirmed = { at: confirmed.at, by: "circle", txHash: confirmed.txHash, ...(onPayeeChain ? { chain: onPayeeChain } : {}) };
    // In the payee's wallet: on the network's own chain once confirmed; on another chain once minted there; never for a
    // simulated payment (L4).
    if (!input.simulated && !input.crossChain) stages.available = { at: confirmed.at, by: "chain" };
    if (!input.simulated && input.crossChain && current.minted) {
      stages.available = { at: current.minted.at, by: "circle", chain: current.minted.chain, txHash: current.minted.txHash };
    }
  }

  // Reconciled: the bill marked paid with one of the transfer's references, and a signed entry naming it (L5).
  const books = input.books;
  const recording = confirmed ? recordings.find((fact) => isRef(confirmed.refs, fact.txRef)) : undefined;
  const booksAgree = Boolean(confirmed && books?.paid && isRef(confirmed.refs, books.txRef));
  if (confirmed && booksAgree && recording) {
    const ref = books?.txRef ?? recording.txRef;
    // The mint on the payee's chain (a Gateway payout's own transaction) is linked there, as the confirmed stage links it.
    const onPayeeChain = current.minted && same(ref, current.minted.txHash) ? current.minted.chain : null;
    stages.reconciled = { at: books?.at ?? recording.at, by: "books", seq: recording.seq, txHash: ref, ...(onPayeeChain ? { chain: onPayeeChain } : {}) };
  }
  // The books agree and no entry read names the transaction, but the entries were not all read: it may be among the rest.
  const recordingUnread = Boolean(confirmed && booksAgree && !recording && input.recordingsComplete === false);

  const status: SettlementStatus = confirmed
    ? stages.reconciled
      ? "reconciled"
      : "confirmed"
    : current.ended
      ? current.ended.end
      : current.unknownSince
        ? "unknown"
        : current.pending?.state === GATEWAY_FAILED
          ? "gateway_failed"
          : current.pending || current.submittedAt
            ? "in_flight"
            : "waiting";

  const mismatch: SettlementMismatch | null = !books
    ? null
    : confirmed
      ? stages.reconciled
        ? null
        : !books.paid
          ? "confirmed_not_marked_paid"
          : !booksAgree
            ? "marked_paid_other_transaction"
            : recordingUnread
              ? null
              : "no_signed_entry"
      : books.paid
        ? "marked_paid_not_confirmed"
        : null;

  const stage = [...SETTLEMENT_STAGES].reverse().find((name) => stages[name] !== undefined) ?? null;
  const inFlight = status === "in_flight" || status === "unknown";
  return {
    status,
    stage,
    attempt: number,
    stages,
    end: current.ended,
    unknownSince: current.unknownSince,
    readFailedAt: current.readFailedAt && (!current.pending || later(current.readFailedAt, current.pending.at)) ? current.readFailedAt : null,
    inFlightSince: inFlight ? (current.submittedAt ?? current.pending?.at ?? current.unknownSince) : null,
    earlier: [...attempts.values()]
      .filter((state) => state.attempt < number)
      .sort((a, b) => a.attempt - b.attempt)
      .map((state) => ({ attempt: state.attempt, end: state.ended?.end ?? null, at: state.ended?.at ?? null, state: state.ended?.state ?? null, reason: state.ended?.reason ?? null })),
    mismatch,
    recordingUnread,
    conflicts,
    simulated: input.simulated,
    crossChain: input.crossChain,
    stepConfirmed: stepConfirmed ? { ...stepConfirmed } : null,
    followUp: input.books?.followUp ?? null,
    ...(input.circleId ? { circleId: input.circleId } : {}),
  };
}

/** A payment as Treasury lists it: its lifecycle, and what it carries. */
export interface FlightPayment {
  settlement: Settlement;
  amount: number;
  currency: string;
}

export interface PaymentsInFlight<T extends FlightPayment> {
  /** Sent and not confirmed, the oldest first: its age, and whether it is past the network's wait. */
  inFlight: Array<T & { ageMs: number; late: boolean }>;
  /** Whose books do not match the transfer (L5). */
  mismatched: T[];
  /** What is in flight, per currency, in the order each first appears. Two currencies are never added. */
  totals: Array<{ currency: string; amount: number }>;
  oldestMs: number | null;
  /** How many are past the network's wait (the transfer watch's `stuckAfterMinutes`). */
  late: number;
}

/** What Treasury says of the payments in flight (L7): the pending-aging and outstanding-mismatch figures. */
export function paymentsInFlight<T extends FlightPayment>(payments: readonly T[], now: number, stuckAfterMinutes: number): PaymentsInFlight<T> {
  const inFlight = payments
    .filter((payment) => payment.settlement.inFlightSince !== null)
    .map((payment) => {
      const ageMs = Math.max(0, now - time(payment.settlement.inFlightSince as string));
      return { ...payment, ageMs, late: ageMs >= stuckAfterMinutes * 60_000 };
    })
    .sort((a, b) => b.ageMs - a.ageMs);
  const totals: Array<{ currency: string; amount: number }> = [];
  for (const payment of inFlight) {
    const total = totals.find((entry) => entry.currency === payment.currency);
    if (total) total.amount = Math.round((total.amount + payment.amount) * 1_000_000) / 1_000_000;
    else totals.push({ currency: payment.currency, amount: payment.amount });
  }
  return {
    inFlight,
    mismatched: payments.filter((payment) => payment.settlement.mismatch !== null),
    totals,
    oldestMs: inFlight[0]?.ageMs ?? null,
    late: inFlight.filter((payment) => payment.late).length,
  };
}

/** How long, in words: "less than a minute", "12 min", "2 h 5 min", "3 days". */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}
