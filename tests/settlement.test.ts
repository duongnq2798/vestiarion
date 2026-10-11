import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ageText, paymentsInFlight, reduceSettlement, SETTLEMENT_STAGES, type SettlementBooks, type SettlementFact, type SettlementInput } from "@/lib/settlement";
import { booksOf, entryFacts, flightRows, intentFacts, settlementOf, settlementsByBill, type IntentRecord } from "@/lib/settlement-facts";

/**
 * One settlement lifecycle per payment (docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md): the stages
 * from the facts already recorded, each from its own source (L2), the ends kept apart (L3), what "available" means on
 * this rail (L4), the books' agreement (L5), and the replay rules (L6). Pure: no read, no write.
 */

const T = (minute: number, second = 0) => `2026-10-11T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const TX = `0x${"ab".repeat(32)}`;
const OTHER_TX = `0x${"cd".repeat(32)}`;
const MINT = `0x${"ef".repeat(32)}`;

const proposed: SettlementFact = { kind: "proposed", at: T(0), by: "agent", seq: 41 };
const authorized: SettlementFact = { kind: "authorized", at: T(0), by: "code", seq: 41 };
const submitted: SettlementFact = { kind: "submitted", at: T(0, 2), attempt: 1 };
const pending: SettlementFact = { kind: "pending", at: T(0, 3), attempt: 1, state: "SENT", by: "circle" };
const confirmed: SettlementFact = { kind: "confirmed", at: T(0, 5), attempt: 1, refs: [TX, "circle-tx-1"], txHash: TX };
const recorded: SettlementFact = { kind: "recorded", at: T(0, 6), seq: 42, txRef: TX };
const paidBooks: SettlementBooks = { paid: true, txRef: TX, at: T(0, 6) };
const openBooks: SettlementBooks = { paid: false, txRef: null, at: null };

const input = (facts: SettlementFact[], over: Partial<SettlementInput> = {}): SettlementInput => ({ facts, books: paidBooks, crossChain: false, simulated: false, ...over });

function permutations<V>(items: V[]): V[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

describe("the stages (L2)", () => {
  it("are the seven, in order", () => {
    expect(SETTLEMENT_STAGES).toEqual(["proposed", "authorized", "submitted", "pending", "confirmed", "available", "reconciled"]);
  });

  it("reach reconciled when the transfer is confirmed and the books mark it paid with the same transaction, in a signed entry", () => {
    const settlement = reduceSettlement(input([proposed, authorized, submitted, pending, confirmed, recorded]));
    expect(settlement.status).toBe("reconciled");
    expect(settlement.stage).toBe("reconciled");
    expect(settlement.mismatch).toBeNull();
    expect(settlement.stages.proposed).toMatchObject({ at: T(0), by: "agent", seq: 41 });
    expect(settlement.stages.authorized).toMatchObject({ by: "code", seq: 41 });
    expect(settlement.stages.submitted).toMatchObject({ at: T(0, 2), by: "vestiarion" });
    // Circle took it when it was sent; its word was read a second later.
    expect(settlement.stages.pending).toMatchObject({ at: T(0, 2), stateAt: T(0, 3), by: "circle", state: "SENT" });
    expect(settlement.stages.confirmed).toMatchObject({ at: T(0, 5), by: "circle", txHash: TX });
    // A direct payment on the network's own chain is in the payee's wallet once confirmed: the chain says so (L4).
    expect(settlement.stages.available).toMatchObject({ at: T(0, 5), by: "chain" });
    expect(settlement.stages.reconciled).toMatchObject({ seq: 42, by: "books", txHash: TX });
    expect(settlement.inFlightSince).toBeNull();
  });

  it("matches the books' reference to any of the transfer's, whatever its case", () => {
    const settlement = reduceSettlement(input([submitted, confirmed, { ...recorded, txRef: "CIRCLE-TX-1" }], { books: { paid: true, txRef: "Circle-Tx-1", at: T(1) } }));
    expect(settlement.status).toBe("reconciled");
  });

  it("is in flight from the send until Circle confirms it, aged from the send", () => {
    expect(reduceSettlement(input([proposed, authorized, submitted], { books: openBooks }))).toMatchObject({ status: "in_flight", stage: "submitted", inFlightSince: T(0, 2) });
    expect(reduceSettlement(input([proposed, authorized, submitted, pending], { books: openBooks }))).toMatchObject({ status: "in_flight", stage: "pending", inFlightSince: T(0, 2) });
  });

  it("keeps Circle's latest word while pending, with when it was read, and says when its last read failed", () => {
    const stuck: SettlementFact = { kind: "pending", at: T(20), attempt: 1, state: "STUCK", by: "watch" };
    const settlement = reduceSettlement(input([submitted, pending, stuck, { kind: "read_failed", at: T(25), attempt: 1 }], { books: openBooks }));
    // Reached when Circle took it, at the send, however late its latest word: a later read never moves the stage.
    expect(settlement.stages.pending).toMatchObject({ at: T(0, 2), stateAt: T(20), state: "STUCK", by: "watch" });
    expect(settlement.readFailedAt).toBe(T(25));
    // A later answer from Circle clears it.
    const answered = reduceSettlement(input([submitted, pending, { kind: "read_failed", at: T(25), attempt: 1 }, { ...pending, at: T(26) }], { books: openBooks }));
    expect(answered.readFailedAt).toBeNull();
  });

  it("waits, with nothing sent, while only a decision exists", () => {
    expect(reduceSettlement(input([proposed], { books: openBooks }))).toMatchObject({ status: "waiting", stage: "proposed", attempt: 1 });
    expect(reduceSettlement(input([], { books: null }))).toMatchObject({ status: "waiting", stage: null });
  });

  it("takes the earliest proposal and the latest authorization", () => {
    const person: SettlementFact = { kind: "authorized", at: T(30), by: "person", seq: 90 };
    const settlement = reduceSettlement(input([{ ...proposed, at: T(31), by: "person", seq: 90 }, person, proposed, authorized]));
    expect(settlement.stages.proposed).toMatchObject({ by: "agent", seq: 41 });
    expect(settlement.stages.authorized).toMatchObject({ by: "person", seq: 90 });
  });

  it("never shows a payment proposed or authorized after it was sent: their entry is signed once the transfer answered", () => {
    // The agent's real order: the claim stamps the send at 10:00:40, Circle confirms at 10:01:10, then the invoice and
    // its ap_pay entry are written at 10:01:12.
    const settlement = reduceSettlement(
      input(
        [
          { kind: "proposed", at: T(1, 12), by: "agent", seq: 41 },
          { kind: "authorized", at: T(1, 12), by: "code", seq: 41 },
          { kind: "submitted", at: T(0, 40), attempt: 1 },
          { ...confirmed, at: T(1, 10) },
          { ...recorded, at: T(1, 12) },
        ],
        { books: { paid: true, txRef: TX, at: T(1, 12) } }
      )
    );
    expect(settlement.stages.proposed).toMatchObject({ at: T(0, 40), by: "agent", seq: 41 });
    expect(settlement.stages.authorized).toMatchObject({ at: T(0, 40), by: "code", seq: 41 });
    const times = SETTLEMENT_STAGES.map((stage) => settlement.stages[stage]?.at).filter((at): at is string => typeof at === "string");
    expect(times).toEqual([...times].sort());
  });

  it("takes the authorization that let the current attempt go, not a later approval that only recorded it", () => {
    // The agent sent it; a person approved it later while it was in flight, which sends nothing new.
    const later: SettlementFact = { kind: "authorized", at: T(20), by: "person", seq: 90 };
    const recordedOnly = reduceSettlement(input([{ ...proposed, at: T(0, 4) }, { ...authorized, at: T(0, 4) }, submitted, pending, later], { books: openBooks }));
    expect(recordedOnly.stages.authorized).toMatchObject({ by: "code", seq: 41, at: T(0, 2) });
    // A person's approval that sent a second attempt is the one shown, from when that attempt was sent.
    const retried = reduceSettlement(
      input(
        [
          { ...proposed, at: T(0, 4) },
          { ...authorized, at: T(0, 4) },
          submitted,
          { kind: "ended", at: T(1), attempt: 1, end: "failed", state: "FAILED", reason: null },
          { kind: "submitted", at: T(30), attempt: 2 },
          { kind: "authorized", at: T(30, 20), by: "person", seq: 95 },
        ],
        { books: openBooks }
      )
    );
    expect(retried.stages.authorized).toMatchObject({ by: "person", seq: 95, at: T(30) });
    // Sent again later without a new approval (a send never taken, sent again by the cycle): the approval before it counts.
    const resent = reduceSettlement(input([{ ...authorized, at: T(0, 4), by: "person", seq: 60 }, { kind: "submitted", at: T(25), attempt: 1 }], { books: openBooks }));
    expect(resent.stages.authorized).toMatchObject({ by: "person", seq: 60, at: T(0, 4) });
  });
});

describe("Gateway's reported failure (L3)", () => {
  const gatewayFailed: SettlementFact = { kind: "pending", at: T(3), attempt: 1, state: "GATEWAY_FAILED", by: "circle" };

  it("is neither in flight nor an end: Gateway reported it failed, and its attestation may still be minted", () => {
    const settlement = reduceSettlement(input([proposed, authorized, submitted, gatewayFailed], { books: openBooks, crossChain: true }));
    expect(settlement).toMatchObject({ status: "gateway_failed", stage: "pending", end: null, inFlightSince: null, mismatch: null });
    expect(settlement.stages.pending).toMatchObject({ state: "GATEWAY_FAILED" });
    // Minted after all: confirmed, as any transfer.
    expect(reduceSettlement(input([submitted, gatewayFailed, { ...confirmed, at: T(9) }], { books: openBooks, crossChain: true })).status).toBe("confirmed");
  });

  it("is never counted in flight, nor aged, however long ago it was sent", () => {
    const settlement = reduceSettlement(input([submitted, gatewayFailed], { books: openBooks, crossChain: true }));
    const summary = paymentsInFlight([{ settlement, amount: 30, currency: "USDC" }], Date.parse(T(0)) + 30 * 86_400_000, 15);
    expect(summary).toEqual({ inFlight: [], mismatched: [], totals: [], oldestMs: null, late: 0 });
  });
});

describe("a CCTP payout's step Circle confirmed on Arc (L3)", () => {
  const burn = { step: "burn", txHash: OTHER_TX, chain: "BASE-SEPOLIA" } as const;
  const onArc = (state: string, by: "circle" | "watch" = "circle"): SettlementFact => ({ kind: "pending", at: T(3), attempt: 1, state, by });

  it("is told apart while the payout waits for its mint, with the step's transaction at the pending stage", () => {
    for (const state of ["CONFIRMED", "COMPLETE"]) {
      for (const by of ["circle", "watch"] as const) {
        const settlement = reduceSettlement(input([submitted, onArc(state, by)], { books: openBooks, crossChain: true, bridge: burn }));
        expect(settlement, `${state} by ${by}`).toMatchObject({ status: "in_flight", stage: "pending", stepConfirmed: burn, stages: { pending: { state, txHash: OTHER_TX } } });
      }
    }
    expect(reduceSettlement(input([submitted, onArc("CONFIRMED")], { books: openBooks, crossChain: true, bridge: { ...burn, step: "approve" } })).stepConfirmed).toEqual({ ...burn, step: "approve" });
  });

  it("is nothing to tell while Circle has not confirmed the step, once the payout is confirmed, or for a payment on Arc", () => {
    expect(reduceSettlement(input([submitted, onArc("SENT")], { books: openBooks, crossChain: true, bridge: burn })).stepConfirmed).toBeNull();
    expect(reduceSettlement(input([submitted, onArc("SENT")], { books: openBooks, crossChain: true, bridge: burn })).stages.pending?.txHash).toBeUndefined();
    expect(reduceSettlement(input([submitted, onArc("CONFIRMED"), confirmed], { books: openBooks, crossChain: true, bridge: burn })).stepConfirmed).toBeNull();
    expect(reduceSettlement(input([submitted, onArc("CONFIRMED")], { books: openBooks, crossChain: false, bridge: burn })).stepConfirmed).toBeNull();
    expect(reduceSettlement(input([submitted, onArc("CONFIRMED")], { books: openBooks, crossChain: true })).stepConfirmed).toBeNull();
  });
});

describe("who comes back to the bill (L5, L10)", () => {
  it("is carried from the books, and is no one without them or when they do not say", () => {
    const unknown: SettlementFact[] = [submitted, { kind: "unanswered", at: T(1), attempt: 1 }];
    expect(reduceSettlement(input(unknown, { books: { ...openBooks, followUp: "approvals" } }))).toMatchObject({ status: "unknown", followUp: "approvals" });
    expect(reduceSettlement(input([submitted, confirmed], { books: { ...openBooks, followUp: "cycle" } }))).toMatchObject({ mismatch: "confirmed_not_marked_paid", followUp: "cycle" });
    expect(reduceSettlement(input(unknown, { books: openBooks })).followUp).toBeNull();
    expect(reduceSettlement(input(unknown, { books: null })).followUp).toBeNull();
  });
});

describe("what available means (L4)", () => {
  it("is reached for a payout to another chain only once its mint is recorded, named by that chain", () => {
    const bridged = (facts: SettlementFact[]) => reduceSettlement(input(facts, { crossChain: true }));
    expect(bridged([submitted, confirmed]).stages.available).toBeUndefined();
    const minted: SettlementFact = { kind: "minted", at: T(1), attempt: 1, chain: "BASE-SEPOLIA", txHash: MINT };
    expect(bridged([submitted, confirmed, minted]).stages.available).toMatchObject({ at: T(1), by: "circle", chain: "BASE-SEPOLIA", txHash: MINT });
  });

  it("links a Gateway payout's reconciled transaction on the payee's chain, where its mint is", () => {
    const minted: SettlementFact = { kind: "minted", at: T(1), attempt: 1, chain: "BASE-SEPOLIA", txHash: MINT };
    const gateway = reduceSettlement(
      input([submitted, { ...confirmed, refs: [MINT, "gateway:x"], txHash: MINT }, minted, { ...recorded, txRef: MINT }], { books: { paid: true, txRef: MINT, at: T(2) }, crossChain: true })
    );
    expect(gateway.stages.reconciled).toMatchObject({ txHash: MINT, chain: "BASE-SEPOLIA" });
    // A CCTP payout whose books name its burn on Arc stays on Arc.
    const burn = reduceSettlement(input([submitted, { ...confirmed, refs: [TX, MINT], txHash: TX }, minted, recorded], { crossChain: true }));
    expect(burn.stages.reconciled).toMatchObject({ txHash: TX });
    expect(burn.stages.reconciled?.chain).toBeUndefined();
  });

  it("is never reached by a simulated payment, which reaches no wallet", () => {
    const settlement = reduceSettlement(input([submitted, confirmed, recorded], { simulated: true }));
    expect(settlement.stages.available).toBeUndefined();
    expect(settlement.status).toBe("reconciled");
    expect(settlement.simulated).toBe(true);
  });
});

describe("the ends, kept apart (L3)", () => {
  it("tells Circle's failure from its cancellation, and both from a send that never reached Circle", () => {
    const failed: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "failed", state: "FAILED", reason: "INSUFFICIENT_TOKEN" };
    const cancelled: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "cancelled", state: "CANCELLED", reason: null };
    const notSent: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "not_sent", state: null, reason: "Circle refused it" };
    expect(reduceSettlement(input([submitted, pending, failed], { books: openBooks }))).toMatchObject({ status: "failed", stage: "pending", end: { end: "failed", state: "FAILED", reason: "INSUFFICIENT_TOKEN" }, inFlightSince: null });
    expect(reduceSettlement(input([submitted, pending, cancelled], { books: openBooks }))).toMatchObject({ status: "cancelled", end: { state: "CANCELLED" } });
    expect(reduceSettlement(input([submitted, notSent], { books: openBooks }))).toMatchObject({ status: "not_sent", stage: "submitted", end: { reason: "Circle refused it" } });
  });

  it("holds a send Circle never answered in flight, as unknown, until Circle answers or the lookup finds nothing", () => {
    const unanswered: SettlementFact = { kind: "unanswered", at: T(0, 30), attempt: 1 };
    expect(reduceSettlement(input([submitted, unanswered], { books: openBooks }))).toMatchObject({ status: "unknown", unknownSince: T(0, 30), inFlightSince: T(0, 2) });
    // Found on Circle: in flight with Circle's word.
    expect(reduceSettlement(input([submitted, unanswered, { ...pending, at: T(5) }], { books: openBooks }))).toMatchObject({ status: "in_flight", unknownSince: null });
    // Circle listed nothing 15 minutes after: never taken.
    const never: SettlementFact = { kind: "ended", at: T(16), attempt: 1, end: "not_sent", state: null, reason: "Circle has no transfer" };
    expect(reduceSettlement(input([submitted, unanswered, never], { books: openBooks }))).toMatchObject({ status: "not_sent", unknownSince: null });
  });
});

describe("the replay rules (L6)", () => {
  it("gives the same result whatever order the facts arrive in", () => {
    const facts = [proposed, submitted, pending, confirmed, recorded];
    const expected = reduceSettlement(input(facts));
    for (const order of permutations(facts)) expect(reduceSettlement(input(order))).toEqual(expected);
  });

  it("changes nothing for a fact seen twice", () => {
    const once = reduceSettlement(input([proposed, submitted, pending, confirmed, recorded]));
    expect(reduceSettlement(input([proposed, submitted, submitted, pending, pending, confirmed, confirmed, recorded, recorded]))).toEqual(once);
  });

  it("never undoes a confirmation: a late pending read is ignored, a late failure is a conflict", () => {
    const latePending: SettlementFact = { kind: "pending", at: T(30), attempt: 1, state: "STUCK", by: "watch" };
    const lateFailure: SettlementFact = { kind: "ended", at: T(31), attempt: 1, end: "failed", state: "FAILED", reason: null };
    const lateNotSent: SettlementFact = { kind: "ended", at: T(32), attempt: 1, end: "not_sent", state: null, reason: "lost" };
    const settlement = reduceSettlement(input([submitted, pending, confirmed, recorded, latePending, lateFailure, lateNotSent]));
    expect(settlement.status).toBe("reconciled");
    expect(settlement.stages.pending?.state).toBe("SENT");
    expect(settlement.end).toBeNull();
    expect(settlement.conflicts).toEqual([{ attempt: 1, at: T(31), kind: "failure_after_confirmed" }]);
  });

  it("never undoes Circle's end with a pending read, and takes a confirmation after it as a conflict", () => {
    const failed: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "failed", state: "FAILED", reason: null };
    expect(reduceSettlement(input([submitted, failed, { ...pending, at: T(2) }], { books: openBooks }))).toMatchObject({ status: "failed" });
    const settlement = reduceSettlement(input([submitted, failed, { ...confirmed, at: T(3) }, recorded]));
    expect(settlement.status).toBe("reconciled");
    expect(settlement.conflicts).toEqual([{ attempt: 1, at: T(3), kind: "confirmed_after_failure" }]);
  });

  it("reopens a send that never reached Circle when it is sent again under the same key, or when Circle shows it", () => {
    const notSent: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "not_sent", state: null, reason: "connection refused" };
    expect(reduceSettlement(input([submitted, notSent, { kind: "submitted", at: T(5), attempt: 1 }], { books: openBooks }))).toMatchObject({ status: "in_flight", end: null, inFlightSince: T(5) });
    // A send before the conclusion does not reopen it.
    expect(reduceSettlement(input([submitted, notSent], { books: openBooks })).status).toBe("not_sent");
    const shown = reduceSettlement(input([submitted, notSent, { ...pending, at: T(6) }], { books: openBooks }));
    expect(shown).toMatchObject({ status: "in_flight", end: null });
    expect(shown.conflicts).toEqual([{ attempt: 1, at: T(6), kind: "circle_answered_not_sent" }]);
  });

  it("follows the newest attempt after Circle ended one, and lists the earlier with how it ended", () => {
    const failedFirst: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "failed", state: "FAILED", reason: "INSUFFICIENT_TOKEN" };
    const second: SettlementFact[] = [
      { kind: "submitted", at: T(10), attempt: 2 },
      { kind: "pending", at: T(10, 2), attempt: 2, state: "SENT", by: "circle" },
    ];
    const settlement = reduceSettlement(input([submitted, pending, failedFirst, ...second], { books: openBooks }));
    expect(settlement).toMatchObject({ status: "in_flight", attempt: 2, inFlightSince: T(10), end: null });
    expect(settlement.earlier).toEqual([{ attempt: 1, end: "failed", at: T(1), state: "FAILED", reason: "INSUFFICIENT_TOKEN" }]);
    // A late fact about the first attempt changes only the first.
    const late = reduceSettlement(input([submitted, pending, failedFirst, ...second, { kind: "pending", at: T(40), attempt: 1, state: "STUCK", by: "watch" }], { books: openBooks }));
    expect(late).toEqual(settlement);
  });

  it("shuffled, repeated and late, gives the same answer and the same amounts in flight", () => {
    const facts: SettlementFact[] = [
      proposed,
      submitted,
      { kind: "unanswered", at: T(3), attempt: 1 },
      { kind: "pending", at: T(8), attempt: 1, state: "QUEUED", by: "circle" },
      { kind: "pending", at: T(20), attempt: 1, state: "STUCK", by: "watch" },
    ];
    const expected = reduceSettlement(input(facts, { books: openBooks }));
    expect(expected).toMatchObject({ status: "in_flight", stages: { pending: { state: "STUCK" } } });
    for (const order of permutations(facts)) {
      const settlement = reduceSettlement(input([...order, order[0]], { books: openBooks }));
      expect(settlement).toEqual(expected);
      expect(paymentsInFlight([{ settlement, amount: 12.5, currency: "USDC" }], Date.parse(T(30)), 15).totals).toEqual([{ currency: "USDC", amount: 12.5 }]);
    }
  });
});

describe("the books (L5)", () => {
  it("says what does not match: not yet marked paid, marked paid unconfirmed, another transaction, no signed entry", () => {
    expect(reduceSettlement(input([submitted, confirmed], { books: openBooks }))).toMatchObject({ status: "confirmed", mismatch: "confirmed_not_marked_paid" });
    expect(reduceSettlement(input([submitted, pending]))).toMatchObject({ status: "in_flight", mismatch: "marked_paid_not_confirmed" });
    expect(reduceSettlement(input([submitted, confirmed, recorded], { books: { paid: true, txRef: OTHER_TX, at: T(1) } }))).toMatchObject({ status: "confirmed", mismatch: "marked_paid_other_transaction" });
    expect(reduceSettlement(input([submitted, confirmed, { ...recorded, txRef: OTHER_TX }]))).toMatchObject({ status: "confirmed", mismatch: "no_signed_entry" });
    // A failed payment whose bill is open is no mismatch; nor is one without books to compare.
    const failed: SettlementFact = { kind: "ended", at: T(1), attempt: 1, end: "failed", state: "FAILED", reason: null };
    expect(reduceSettlement(input([submitted, failed], { books: openBooks })).mismatch).toBeNull();
    expect(reduceSettlement(input([submitted, confirmed], { books: null })).mismatch).toBeNull();
  });

  it("never calls a missing entry a mismatch when the entries read may have been cut short", () => {
    // Read in full, a bill marked paid with the transaction and no entry naming it does not match.
    expect(reduceSettlement(input([submitted, confirmed]))).toMatchObject({ mismatch: "no_signed_entry", recordingUnread: false });
    // Cut at the read's limit, the entry may be among the older ones not read: unknown, never a mismatch.
    expect(reduceSettlement(input([submitted, confirmed], { recordingsComplete: false }))).toMatchObject({ status: "confirmed", mismatch: null, recordingUnread: true });
    // Found anyway, it is reconciled.
    expect(reduceSettlement(input([submitted, confirmed, recorded], { recordingsComplete: false }))).toMatchObject({ status: "reconciled", recordingUnread: false });
    // The other mismatches do not depend on an entry: they stand.
    expect(reduceSettlement(input([submitted, confirmed], { books: openBooks, recordingsComplete: false }))).toMatchObject({ mismatch: "confirmed_not_marked_paid", recordingUnread: false });
    expect(reduceSettlement(input([submitted, confirmed], { books: { paid: true, txRef: OTHER_TX, at: T(1) }, recordingsComplete: false })).mismatch).toBe("marked_paid_other_transaction");
  });
});

describe("payments in flight and their age (Treasury, L7)", () => {
  const now = Date.parse(T(40));
  const at = (facts: SettlementFact[], books = openBooks) => reduceSettlement(input(facts, { books }));

  it("lists what was sent and not confirmed, oldest first, with each one's age and whether it is past the network's wait", () => {
    const old = { id: "a", settlement: at([submitted, pending]), amount: 10, currency: "USDC" };
    const fresh = { id: "b", settlement: at([{ kind: "submitted", at: T(35), attempt: 1 }]), amount: 2.5, currency: "USDC" };
    const unknown = { id: "c", settlement: at([{ kind: "submitted", at: T(30), attempt: 1 }, { kind: "unanswered", at: T(31), attempt: 1 }]), amount: 4, currency: "EURC" };
    const done = { id: "d", settlement: at([submitted, confirmed, recorded], paidBooks), amount: 99, currency: "USDC" };
    const lagging = { id: "e", settlement: at([submitted, { ...confirmed, at: T(38) }]), amount: 7, currency: "USDC" };
    const summary = paymentsInFlight([fresh, done, unknown, old, lagging], now, 15);
    expect(summary.inFlight.map((row) => [row.id, row.ageMs, row.late])).toEqual([
      ["a", (39 * 60 + 58) * 1000, true],
      ["c", 10 * 60 * 1000, false],
      ["b", 5 * 60 * 1000, false],
    ]);
    expect(summary.totals).toEqual([
      { currency: "USDC", amount: 12.5 },
      { currency: "EURC", amount: 4 },
    ]);
    expect(summary.oldestMs).toBe((39 * 60 + 58) * 1000);
    expect(summary.late).toBe(1);
    expect(summary.mismatched.map((row) => [row.id, row.settlement.mismatch])).toEqual([["e", "confirmed_not_marked_paid"]]);
  });

  it("is empty with nothing in flight", () => {
    expect(paymentsInFlight([], now, 15)).toEqual({ inFlight: [], mismatched: [], totals: [], oldestMs: null, late: 0 });
  });

  it("says an age in words a person reads", () => {
    expect(ageText(20_000)).toBe("less than a minute");
    expect(ageText(12 * 60_000 + 59_000)).toBe("12 min");
    expect(ageText(60 * 60_000)).toBe("1 h");
    expect(ageText(2 * 3_600_000 + 5 * 60_000)).toBe("2 h 5 min");
    expect(ageText(3 * 86_400_000 + 1)).toBe("3 days");
    expect(ageText(-5)).toBe("less than a minute");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The facts, from the rows already recorded.

const NOW = Date.parse(T(30));
const intent = (over: Partial<IntentRecord> = {}): IntentRecord => ({
  status: "confirmed",
  provider: "circle",
  provider_mode: "live",
  provider_tx_id: "circle-tx-1",
  provider_state: "COMPLETE",
  failure_reason: null,
  last_error: null,
  tx_hash: TX,
  mint_tx_hash: null,
  destination_chain: null,
  transfer_attempt: 1,
  previous_attempts: [],
  submitted_at: T(0, 2),
  executed_at: T(0, 5),
  confirmed_at: T(0, 5),
  created_at: T(0, 1),
  updated_at: T(0, 5),
  batch_key: null,
  network: "arc-testnet",
  ...over,
});

describe("intentFacts", () => {
  it("reads a confirmed transfer as sent then confirmed, with every reference it has", () => {
    expect(intentFacts(intent(), NOW)).toEqual([
      { kind: "submitted", at: T(0, 2), attempt: 1 },
      { kind: "confirmed", at: T(0, 5), attempt: 1, refs: [TX, "circle-tx-1"], txHash: TX },
    ]);
  });

  it("reads a bridged payout's mint as its own fact", () => {
    const facts = intentFacts(intent({ destination_chain: "BASE-SEPOLIA", mint_tx_hash: MINT, tx_hash: MINT, provider_tx_id: "gateway:abc" }), NOW);
    expect(facts).toContainEqual({ kind: "minted", at: T(0, 5), attempt: 1, chain: "BASE-SEPOLIA", txHash: MINT });
  });

  it("reads a pending transfer with Circle's state, from when it was last read", () => {
    expect(intentFacts(intent({ status: "pending", provider_state: "SENT", confirmed_at: null, executed_at: T(1) }), NOW)).toEqual([
      { kind: "submitted", at: T(0, 2), attempt: 1 },
      { kind: "pending", at: T(1), attempt: 1, state: "SENT", by: "circle" },
    ]);
  });

  it("reads Circle's terminal failure as failed or cancelled, with its reason", () => {
    const failed = intentFacts(intent({ status: "failed", provider_state: "DENIED", failure_reason: "RISK", confirmed_at: null, updated_at: T(2) }), NOW);
    expect(failed).toContainEqual({ kind: "ended", at: T(2), attempt: 1, end: "failed", state: "DENIED", reason: "RISK" });
    const cancelled = intentFacts(intent({ status: "failed", provider_state: "CANCELLED", confirmed_at: null, updated_at: T(2) }), NOW);
    expect(cancelled).toContainEqual({ kind: "ended", at: T(2), attempt: 1, end: "cancelled", state: "CANCELLED", reason: null });
  });

  it("reads a failed read of a transfer Circle took as still pending, never as a failure (L3)", () => {
    const facts = intentFacts(intent({ status: "failed", provider_state: "SENT", last_error: "timeout", confirmed_at: null, executed_at: T(1), updated_at: T(3) }), NOW);
    expect(facts).toEqual([
      { kind: "submitted", at: T(0, 2), attempt: 1 },
      { kind: "pending", at: T(1), attempt: 1, state: "SENT", by: "circle" },
      { kind: "read_failed", at: T(3), attempt: 1 },
    ]);
    // Gateway's own failure may still be minted: pending too, with Gateway's word, and no failed read of ours.
    expect(intentFacts(intent({ status: "failed", provider_tx_id: "gateway:x", provider_state: "GATEWAY_FAILED", confirmed_at: null, updated_at: T(3) }), NOW)).toEqual([
      { kind: "submitted", at: T(0, 2), attempt: 1 },
      { kind: "pending", at: T(3), attempt: 1, state: "GATEWAY_FAILED", by: "circle" },
    ]);
  });

  it("reads a send Circle never answered as unknown, and one that never reached Circle as not sent", () => {
    const unanswered = intent({ status: "failed", provider_tx_id: null, provider_state: null, tx_hash: null, confirmed_at: null, last_error: "Circle createTransaction may or may not have been accepted", updated_at: T(1) });
    expect(intentFacts(unanswered, NOW)).toEqual([
      { kind: "submitted", at: T(0, 2), attempt: 1 },
      { kind: "unanswered", at: T(1), attempt: 1 },
    ]);
    const refused = intent({ status: "failed", provider_tx_id: null, provider_state: null, tx_hash: null, confirmed_at: null, last_error: "Circle refused the request (400)", updated_at: T(1) });
    expect(intentFacts(refused, NOW)).toEqual([
      { kind: "submitted", at: T(0, 2), attempt: 1 },
      { kind: "ended", at: T(1), attempt: 1, end: "not_sent", state: null, reason: "Circle refused the request (400)" },
    ]);
    // A batch member whose batch's answer was lost is looked for: unknown, never not sent.
    expect(intentFacts({ ...refused, batch_key: "batch-1" }, NOW).map((fact) => fact.kind)).toEqual(["submitted", "unanswered"]);
  });

  it("reads a send left submitting past its claim as unknown, and a fresh one as sent", () => {
    const sending = intent({ status: "submitting", provider_tx_id: null, provider_state: null, tx_hash: null, confirmed_at: null, executed_at: null, submitted_at: T(29), updated_at: T(29) });
    expect(intentFacts(sending, NOW)).toEqual([{ kind: "submitted", at: T(29), attempt: 1 }]);
    expect(intentFacts({ ...sending, submitted_at: T(20), updated_at: T(20) }, NOW)).toEqual([
      { kind: "submitted", at: T(20), attempt: 1 },
      { kind: "unanswered", at: T(20), attempt: 1 },
    ]);
  });

  it("reads nothing sent for an attempt not yet sent, and every earlier attempt's end", () => {
    const retrying = intent({
      status: "created",
      transfer_attempt: 2,
      provider_tx_id: null,
      provider_state: null,
      tx_hash: null,
      confirmed_at: null,
      executed_at: null,
      // The first attempt's send, kept by the row until the second is sent.
      submitted_at: T(0, 2),
      previous_attempts: [{ attempt: 1, idempotencyKey: "k1", providerTxId: "circle-tx-1", providerState: "CANCELLED", failureReason: null, failedAt: T(4) }],
    });
    expect(intentFacts(retrying, NOW)).toEqual([{ kind: "ended", at: T(4), attempt: 1, end: "cancelled", state: "CANCELLED", reason: null }]);
  });

  it("falls back to when it was executed, then created, for a row from before submitted_at (0080)", () => {
    expect(intentFacts(intent({ status: "pending", submitted_at: null, confirmed_at: null }), NOW)[0]).toEqual({ kind: "submitted", at: T(0, 5), attempt: 1 });
    expect(intentFacts(intent({ status: "submitting", submitted_at: null, executed_at: null, provider_tx_id: null, updated_at: T(29, 30) }), NOW)[0]).toEqual({ kind: "submitted", at: T(0, 1), attempt: 1 });
  });
});

describe("entryFacts", () => {
  const INVOICE = "inv-1";
  const entry = (seq: number, action: string, detail: Record<string, unknown>, ts = T(0)) => ({ seq, ts, action, detail: { invoiceId: INVOICE, ...detail } });

  it("reads the agent's decision to pay as proposed and, when it went out, authorized by code and a recording of its transaction", () => {
    expect(entryFacts([entry(41, "ap_pay", { execution: { resultingStatus: "matched", txRef: "circle-tx-1" } })], { type: "invoice", id: INVOICE })).toEqual([
      { kind: "proposed", at: T(0), by: "agent", seq: 41 },
      { kind: "authorized", at: T(0), by: "code", seq: 41 },
      { kind: "recorded", at: T(0), seq: 41, txRef: "circle-tx-1" },
    ]);
  });

  it("reads a schedule as proposed only, and a refusal by code or a hold for a verdict as no authorization", () => {
    const facts = entryFacts(
      [
        entry(1, "ap_schedule", { decision: { payOn: "2026-10-20" } }),
        entry(2, "ap_pay", { guardrailBlocked: true }),
        entry(3, "ap_pay", { execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } }),
      ],
      { type: "invoice", id: INVOICE }
    );
    expect(facts.map((fact) => [fact.kind, "seq" in fact ? fact.seq : null])).toEqual([
      ["proposed", 1],
      ["proposed", 3],
    ]);
  });

  it("reads an agent's payment whose transfer failed as authorized: it was sent", () => {
    const facts = entryFacts([entry(5, "ap_pay", { execution: { resultingStatus: "held" } })], { type: "invoice", id: INVOICE });
    expect(facts.map((fact) => fact.kind)).toEqual(["proposed", "authorized"]);
  });

  it("reads a person's approval as proposed and authorized by them, or by two people", () => {
    expect(entryFacts([entry(9, "approval_paid", { status: "paid", txRef: TX })], { type: "invoice", id: INVOICE })).toEqual([
      { kind: "proposed", at: T(0), by: "person", seq: 9 },
      { kind: "authorized", at: T(0), by: "person", seq: 9 },
      { kind: "recorded", at: T(0), seq: 9, txRef: TX },
    ]);
    const two = entryFacts([entry(9, "approval_paid", { status: "matched", approvals: [{ by: "a" }, { by: "b" }] })], { type: "invoice", id: INVOICE });
    expect(two).toContainEqual({ kind: "authorized", at: T(0), by: "two_people", seq: 9 });
  });

  it("reads the transfer watch's alert as a pending read of its attempt, or as an unanswered send", () => {
    expect(entryFacts([entry(12, "payment_stuck", { attempt: 2, sendAnswered: true, circleAsked: true, providerState: "STUCK" }, T(20))], { type: "invoice", id: INVOICE })).toEqual([
      { kind: "pending", at: T(20), attempt: 2, state: "STUCK", by: "watch" },
    ]);
    expect(entryFacts([entry(13, "payment_stuck", { sendAnswered: false, circleAsked: false }, T(20))], { type: "invoice", id: INVOICE })).toEqual([{ kind: "unanswered", at: T(20), attempt: 1 }]);
  });

  it("reads a reconcile's and a mint's transaction as recordings, and leaves out another bill's entries and others", () => {
    const facts = entryFacts(
      [
        entry(20, "ap_reconcile", { execution: { resultingStatus: "paid", txRef: TX, mintTxHash: MINT } }),
        { seq: 21, ts: T(0), action: "ap_pay", detail: { invoiceId: "another", execution: { resultingStatus: "paid", txRef: OTHER_TX } } },
        entry(22, "invoice_escalated", {}),
      ],
      { type: "invoice", id: INVOICE }
    );
    expect(facts).toEqual([
      { kind: "recorded", at: T(0), seq: 20, txRef: TX },
      { kind: "recorded", at: T(0), seq: 20, txRef: MINT },
    ]);
  });

  it("reads a milestone's release and a person's Pay now by the milestone's id", () => {
    const milestone = (seq: number, action: string, detail: Record<string, unknown>) => ({ seq, ts: T(0), action, detail: { milestoneId: "ms-1", ...detail } });
    const facts = entryFacts(
      [milestone(30, "milestone_release", { execution: { resultingStatus: "verified", txRef: "circle-tx-9" } }), milestone(31, "milestone_approval_paid", { status: "paid", txRef: TX })],
      { type: "milestone", id: "ms-1" }
    );
    expect(facts.map((fact) => fact.kind)).toEqual(["proposed", "authorized", "recorded", "proposed", "authorized", "recorded"]);
  });
});

describe("settlementOf", () => {
  it("puts the intent, the entries and the bill together, on the payment's own network", () => {
    const settlement = settlementOf({
      intent: intent(),
      entries: [{ seq: 41, ts: T(0), action: "ap_pay", detail: { invoiceId: "inv-1", execution: { resultingStatus: "paid", txRef: TX } } }],
      source: { type: "invoice", id: "inv-1" },
      books: paidBooks,
      now: NOW,
    });
    expect(settlement).toMatchObject({ status: "reconciled", stage: "reconciled", simulated: false, mismatch: null });
    expect(settlement.stages.available).toMatchObject({ by: "chain" });
  });

  it("orders the stages as they happened when the decision's entry is written after the transfer confirmed", () => {
    // executePayment claims (submitted_at), awaits Circle (confirmed_at), and only then is the ap_pay entry appended.
    const settlement = settlementOf({
      intent: intent({ submitted_at: T(0, 40), executed_at: T(1, 10), confirmed_at: T(1, 10), updated_at: T(1, 10) }),
      entries: [{ seq: 41, ts: T(1, 12), action: "ap_pay", detail: { invoiceId: "inv-1", execution: { resultingStatus: "paid", txRef: TX } } }],
      source: { type: "invoice", id: "inv-1" },
      books: { paid: true, txRef: TX, at: T(1, 12) },
      now: NOW,
    });
    expect(settlement.status).toBe("reconciled");
    expect(settlement.stages.proposed?.at).toBe(T(0, 40));
    expect(settlement.stages.authorized?.at).toBe(T(0, 40));
    const times = SETTLEMENT_STAGES.map((stage) => settlement.stages[stage]?.at).filter((at): at is string => typeof at === "string");
    expect(times).toEqual([...times].sort());
  });

  it("knows a payout to another chain from its own chain, and a simulated payment from its provider", () => {
    const bridged = settlementOf({ intent: intent({ destination_chain: "BASE-SEPOLIA", mint_tx_hash: null, status: "pending", confirmed_at: null }), entries: [], source: { type: "invoice", id: "inv-1" }, books: null, now: NOW });
    expect(bridged.stages.available).toBeUndefined();
    // Arc testnet's own chain named as the destination is a direct payment.
    const direct = settlementOf({ intent: intent({ destination_chain: "ARC-TESTNET" }), entries: [], source: { type: "invoice", id: "inv-1" }, books: null, now: NOW });
    expect(direct.stages.available).toMatchObject({ by: "chain" });
    const simulated = settlementOf({ intent: intent({ provider: "simulate", provider_mode: "simulate", tx_hash: "sim_1" }), entries: [], source: { type: "invoice", id: "inv-1" }, books: null, now: NOW });
    expect(simulated.simulated).toBe(true);
  });

  it("knows a simulated payment by its last result's mode, as the receipt does, not by the provider it was created with", () => {
    const simulated = (over: Partial<IntentRecord>) => settlementOf({ intent: intent(over), entries: [], source: { type: "invoice", id: "inv-1" }, books: null, now: NOW }).simulated;
    // Created in a sandbox, whose simulator refused it, then paid live once the workspace connected Circle: the row keeps
    // provider 'simulate' (ensure ignores a duplicate), and the live result wrote provider_mode 'live'.
    expect(simulated({ provider: "simulate", provider_mode: "live" })).toBe(false);
    expect(simulated({ provider: "circle", provider_mode: "simulate" })).toBe(true);
    // A row from before provider_mode (0008) is told by its provider.
    expect(simulated({ provider: "simulate", provider_mode: null })).toBe(true);
    expect(simulated({ provider: "circle", provider_mode: null })).toBe(false);
  });

  it("shows Pending from when Circle took the transfer, at its send, however often the cycle reads it again", () => {
    // Sent at 10:00 and answered at once; each cycle's read rewrites executed_at, the latest at 10:25.
    const settlement = settlementOf({
      intent: intent({ status: "pending", provider_state: "SENT", tx_hash: null, confirmed_at: null, submitted_at: T(0), executed_at: T(25), updated_at: T(25) }),
      entries: [],
      source: { type: "invoice", id: "inv-1" },
      books: null,
      now: NOW,
    });
    expect(settlement.stages.submitted?.at).toBe(T(0));
    expect(settlement.stages.pending).toMatchObject({ at: T(0), state: "SENT", stateAt: T(25), by: "circle" });
    expect(settlement.inFlightSince).toBe(T(0));
  });

  it("tells a CCTP payout's burn, or its approve, Circle confirmed on Arc from its Circle id, with that step's transaction and the payee's chain", () => {
    const bridging = (over: Partial<IntentRecord>) =>
      settlementOf({
        intent: intent({ status: "pending", provider_state: "CONFIRMED", tx_hash: OTHER_TX, destination_chain: "BASE-SEPOLIA", confirmed_at: null, executed_at: T(1), ...over }),
        entries: [],
        source: { type: "invoice", id: "inv-1" },
        books: null,
        now: NOW,
      });
    expect(bridging({ provider_tx_id: "cctp:burn-1" })).toMatchObject({ status: "in_flight", stepConfirmed: { step: "burn", txHash: OTHER_TX, chain: "BASE-SEPOLIA" } });
    expect(bridging({ provider_tx_id: "cctp-approve:approve-1" }).stepConfirmed).toEqual({ step: "approve", txHash: OTHER_TX, chain: "BASE-SEPOLIA" });
    expect(bridging({ provider_tx_id: "cctp:burn-1", provider_state: "SENT" }).stepConfirmed).toBeNull();
  });

  it("carries who comes back to the bill: a held bill's unknown send waits for a person, never for the cycle", () => {
    const unknown = intent({ status: "failed", provider_tx_id: null, provider_state: null, tx_hash: null, confirmed_at: null, last_error: "Circle createTransaction may or may not have been accepted", updated_at: T(1) });
    const of = (books: Parameters<typeof settlementOf>[0]["books"]) => settlementOf({ intent: unknown, entries: [], source: { type: "invoice", id: "inv-1" }, books, now: NOW });
    expect(of(booksOf({ id: "inv-1", status: "held", tx_ref: null }, "invoice"))).toMatchObject({ status: "unknown", followUp: "approvals" });
    expect(of(booksOf({ id: "inv-1", status: "matched", tx_ref: null }, "invoice"))).toMatchObject({ status: "unknown", followUp: "cycle" });
    expect(of(null).followUp).toBeNull();
  });
});

describe("booksOf", () => {
  it("reads a bill as paid only from its own status, with its transaction and since when", () => {
    expect(booksOf({ id: "inv-1", status: "paid", tx_ref: TX, settled_at: T(6) }, "invoice")).toEqual({ paid: true, txRef: TX, at: T(6), followUp: null });
    // A transfer in flight leaves the bill matched: not paid yet, whatever its tx_ref says.
    expect(booksOf({ id: "inv-1", status: "matched", tx_ref: "circle-tx-1" }, "invoice")).toEqual({ paid: false, txRef: "circle-tx-1", at: null, followUp: "cycle" });
  });

  it("says who comes back to the bill next, by its status: the agent's cycle, a person where it waits, or no one", () => {
    const next = (type: "invoice" | "milestone", status: string) => booksOf({ id: "bill-1", status, tx_ref: null }, type).followUp;
    // The cycle reads a matched payable's and a verified milestone's payment again each time it runs.
    expect(next("invoice", "matched")).toBe("cycle");
    expect(next("milestone", "verified")).toBe("cycle");
    // Approvals lists these payables; a held milestone is paid with Pay now on Contractors.
    for (const status of ["held", "flagged", "awaiting_info", "processing"]) expect(next("invoice", status), status).toBe("approvals");
    expect(next("milestone", "held")).toBe("contractors");
    // No one comes back to a payment here: nothing is promised.
    for (const status of ["paid", "rejected", "pending", "scheduled"]) expect(next("invoice", status), status).toBeNull();
    for (const status of ["paid", "pending", "closed"]) expect(next("milestone", status), status).toBeNull();
    // A milestone is never matched, nor a payable verified.
    expect(next("milestone", "matched")).toBeNull();
    expect(next("invoice", "verified")).toBeNull();
  });
});

describe("settlementsByBill", () => {
  const payment = (sourceType: "invoice" | "milestone", sourceId: string, over: Partial<IntentRecord> = {}) => ({ ...intent(over), source_type: sourceType, source_id: sourceId });

  it("gives each shown bill's payment its lifecycle, from that bill's entries and books only", () => {
    const settlements = settlementsByBill({
      payments: [
        payment("invoice", "inv-1"),
        payment("invoice", "inv-2", { status: "pending", provider_state: "QUEUED", confirmed_at: null, tx_hash: null }),
        payment("milestone", "ms-1"),
        // A bill the page does not show: left out.
        payment("invoice", "inv-hidden"),
      ],
      invoices: [
        { id: "inv-1", status: "paid", tx_ref: TX, settled_at: T(6) },
        { id: "inv-2", status: "matched", tx_ref: "circle-tx-1" },
      ],
      milestones: [{ id: "ms-1", status: "verified", tx_ref: "circle-tx-1" }],
      entries: [
        { seq: 41, ts: T(0), action: "ap_pay", detail: { invoiceId: "inv-1", execution: { resultingStatus: "paid", txRef: TX } } },
        { seq: 50, ts: T(0), action: "ap_pay", detail: { invoiceId: "inv-2", execution: { resultingStatus: "matched", txRef: "circle-tx-1" } } },
        { seq: 60, ts: T(0), action: "milestone_release", detail: { milestoneId: "ms-1", execution: { resultingStatus: "verified", txRef: "circle-tx-1" } } },
      ],
      now: NOW,
    });
    expect([...settlements.keys()].sort()).toEqual(["inv-1", "inv-2", "ms-1"]);
    expect(settlements.get("inv-1")).toMatchObject({ status: "reconciled", stages: { proposed: { seq: 41 } } });
    expect(settlements.get("inv-2")).toMatchObject({ status: "in_flight", stage: "pending", mismatch: null, stages: { proposed: { seq: 50 }, pending: { state: "QUEUED" } } });
    // Confirmed, but the milestone is not marked paid yet: the next cycle marks it.
    expect(settlements.get("ms-1")).toMatchObject({ status: "confirmed", mismatch: "confirmed_not_marked_paid", stages: { proposed: { seq: 60 } } });
  });

  it("never lends one bill's entries to another with the same id of another kind", () => {
    const settlements = settlementsByBill({
      payments: [payment("milestone", "same-id", { status: "pending", confirmed_at: null })],
      invoices: [{ id: "same-id", status: "open", tx_ref: null }],
      milestones: [{ id: "same-id", status: "approved", tx_ref: null }],
      entries: [{ seq: 1, ts: T(0), action: "ap_pay", detail: { invoiceId: "same-id", execution: { resultingStatus: "paid", txRef: TX } } }],
      now: NOW,
    });
    expect(settlements.get("same-id")?.stages.proposed).toBeUndefined();
  });

  it("tells each lifecycle whether the entries were read in full", () => {
    const read = (entriesComplete?: boolean) =>
      settlementsByBill({
        payments: [payment("invoice", "inv-1")],
        invoices: [{ id: "inv-1", status: "paid", tx_ref: TX, settled_at: T(6) }],
        entries: [],
        now: NOW,
        ...(entriesComplete === undefined ? {} : { entriesComplete }),
      }).get("inv-1");
    expect(read()).toMatchObject({ mismatch: "no_signed_entry", recordingUnread: false });
    expect(read(true)).toMatchObject({ mismatch: "no_signed_entry" });
    expect(read(false)).toMatchObject({ mismatch: null, recordingUnread: true });
  });
});

describe("flightRows", () => {
  const payment = (sourceType: "invoice" | "milestone", sourceId: string, over: Partial<IntentRecord> = {}, amount = 10, token = "USDC") => ({
    ...intent(over),
    source_type: sourceType,
    source_id: sourceId,
    amount,
    token,
  });

  it("names each payment's payee, carries what was sent, and its lifecycle", () => {
    const rows = flightRows({
      payments: [
        payment("invoice", "inv-1", { status: "pending", provider_state: "SENT", confirmed_at: null, tx_hash: null }, 100),
        payment("milestone", "ms-1", { status: "submitting", provider_tx_id: null, provider_state: null, confirmed_at: null, tx_hash: null, updated_at: T(29) }, 40, "EURC"),
        payment("invoice", "gone", { status: "pending", confirmed_at: null }),
      ],
      // A resend after the discount's deadline carries the full amount: the invoice's paid_amount says so, not the intent.
      invoices: [{ id: "inv-1", status: "matched", tx_ref: "circle-tx-1", counterparty_name: "Harbor VPS", paid_amount: 98 }],
      milestones: [{ id: "ms-1", status: "verified", tx_ref: null, contractor_name: "Ana Lima", title: "Design review" }],
      entries: [],
      now: NOW,
    });
    expect(rows.map((row) => [row.source, row.name, row.amount, row.currency, row.settlement.status])).toEqual([
      [{ type: "invoice", id: "inv-1" }, "Harbor VPS", 98, "USDC", "in_flight"],
      [{ type: "milestone", id: "ms-1" }, "Design review for Ana Lima", 40, "EURC", "in_flight"],
    ]);
  });

  it("falls back to the intent's amount when the invoice recorded none", () => {
    const rows = flightRows({
      payments: [payment("invoice", "inv-1", { status: "pending", confirmed_at: null }, 12.5)],
      invoices: [{ id: "inv-1", status: "matched", tx_ref: null, counterparty_name: "Harbor VPS", paid_amount: null }],
      milestones: [],
      entries: [],
      now: NOW,
    });
    expect(rows[0].amount).toBe(12.5);
  });

  it("leaves a Gateway payout Gateway reported failed out of the payments in flight, whether its bill waits or was rejected", () => {
    const reported = { status: "failed", provider_tx_id: "gateway:x", provider_state: "GATEWAY_FAILED", destination_chain: "BASE-SEPOLIA", tx_hash: null, confirmed_at: null, updated_at: T(3) };
    const rows = flightRows({
      payments: [payment("invoice", "rejected", reported, 30), payment("invoice", "held", reported, 20)],
      invoices: [
        { id: "rejected", status: "rejected", tx_ref: null, counterparty_name: "Harbor VPS", paid_amount: null },
        { id: "held", status: "held", tx_ref: null, counterparty_name: "Lumen Design", paid_amount: null },
      ],
      milestones: [],
      entries: [],
      now: NOW,
    });
    expect(rows.map((row) => [row.source.id, row.settlement.status])).toEqual([
      ["rejected", "gateway_failed"],
      ["held", "gateway_failed"],
    ]);
    // Thirty days on, it is neither in flight, nor aged, nor added to what is outstanding.
    expect(paymentsInFlight(rows, NOW + 30 * 86_400_000, 15)).toEqual({ inFlight: [], mismatched: [], totals: [], oldestMs: null, late: 0 });
  });

  it("lists a held bill's confirmed transfer as not matching the books, and its unknown send in flight, each for a person", () => {
    const rows = flightRows({
      payments: [
        payment("invoice", "held-paid", { confirmed_at: T(9), updated_at: T(9) }, 50),
        payment("invoice", "held-unknown", { status: "failed", provider_tx_id: null, provider_state: null, tx_hash: null, confirmed_at: null, last_error: "it may or may not have been accepted", updated_at: T(1) }, 5000),
        payment("milestone", "ms-held", { confirmed_at: T(9), updated_at: T(9) }, 40),
      ],
      invoices: [
        { id: "held-paid", status: "held", tx_ref: null, counterparty_name: "Northwind", paid_amount: null },
        { id: "held-unknown", status: "held", tx_ref: null, counterparty_name: "Harbor VPS", paid_amount: null },
      ],
      milestones: [{ id: "ms-held", status: "held", tx_ref: null, contractor_name: "Ana Lima", title: "Design review" }],
      entries: [],
      now: NOW,
    });
    const summary = paymentsInFlight(rows, NOW, 15);
    expect(summary.mismatched.map((row) => [row.source.id, row.settlement.mismatch, row.settlement.followUp])).toEqual([
      ["held-paid", "confirmed_not_marked_paid", "approvals"],
      ["ms-held", "confirmed_not_marked_paid", "contractors"],
    ]);
    expect(summary.inFlight.map((row) => [row.source.id, row.settlement.status, row.settlement.followUp])).toEqual([["held-unknown", "unknown", "approvals"]]);
  });

  it("passes on whether the entries were read in full", () => {
    const rows = flightRows({
      payments: [payment("invoice", "inv-1")],
      invoices: [{ id: "inv-1", status: "paid", tx_ref: TX, counterparty_name: "Harbor VPS", settled_at: T(6) }],
      milestones: [],
      entries: [],
      entriesComplete: false,
      now: NOW,
    });
    expect(rows[0].settlement).toMatchObject({ mismatch: null, recordingUnread: true });
  });
});

describe("a read model only (L1)", () => {
  const ROOT = process.cwd();
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const moneyMovers = [...walk(path.join(ROOT, "src", "lib", "agent")), ...walk(path.join(ROOT, "src", "lib", "commands")), ...walk(path.join(ROOT, "src", "app", "actions")), path.join(ROOT, "src", "lib", "payments.ts")];

  it("is read by nothing that moves money", () => {
    // `@/lib/settlement…` or a relative `settlement…` beside them; Circle's own `circle/settlement` is another module.
    const imports = /from\s+["'](?:@\/lib\/|(?:\.\.?\/)+)settlement(?:-facts|-read)?["']/;
    expect(imports.test('import { x } from "../settlement";')).toBe(true);
    expect(imports.test('import { x } from "@/lib/settlement-facts";')).toBe(true);
    expect(imports.test('import { FAILED_STATES } from "../circle/settlement";')).toBe(false);
    const readers = moneyMovers.filter((file) => imports.test(readFileSync(file, "utf8")));
    expect(readers.map((file) => path.relative(ROOT, file))).toEqual([]);
    expect(moneyMovers.length).toBeGreaterThan(20);
  });
});
