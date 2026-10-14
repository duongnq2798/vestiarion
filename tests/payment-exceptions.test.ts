import { describe, expect, it } from "vitest";
import { readSource } from "@/lib/docs/content";
import { slugifyHeadings } from "@/lib/docs/headings";
import {
  ACROSS_CHAINS,
  EXCEPTION_ANCHOR,
  checkFirstTitle,
  chatConfirmText,
  checksFirst,
  CHECK_FIRST_LABEL,
  inFlightNext,
  milestonePayAction,
  NEXT_BY_FOLLOW_UP,
  OWNER_BY_FOLLOW_UP,
  paymentException,
  payActionOf,
  READS_AGAIN,
  RUNBOOK,
  runbookHref,
  runningLine,
  STUCK_AT_CIRCLE,
  whatToDo,
  type PaymentException,
} from "@/lib/payment-exceptions";
import { reduceSettlement, type SettlementBooks, type SettlementFact } from "@/lib/settlement";

/**
 * Payments whose outcome is not clean (docs/superpowers/specs/2026-10-14-payment-exceptions-design.md): what a person's
 * pay action does with an earlier transfer, said before it runs and while it runs (E3), and the runbook each exceptional
 * state is told with on the screens and in the guide (E5).
 */

const T = (minute: number) => `2026-10-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
const NOW = Date.parse(T(40));
const open: SettlementBooks = { paid: false, txRef: null, at: null };
const sent = (minute: number): SettlementFact => ({ kind: "submitted", at: T(minute), attempt: 1 });
const settle = (facts: SettlementFact[], books: SettlementBooks = open) => reduceSettlement({ facts, books, crossChain: false, simulated: false });

describe("what a person's pay action does with the earlier attempt (E3)", () => {
  it("sends when there was none, and sends again only once Circle ended the last one", () => {
    expect(payActionOf({ paymentSent: false, lastAttempt: null })).toBe("send");
    expect(payActionOf({ paymentSent: false, lastAttempt: { state: "failed" } })).toBe("send_again");
  });

  it("checks a transfer already sent, in flight, or that Gateway reported failed, and sends nothing new", () => {
    expect(payActionOf({ paymentSent: true, lastAttempt: null })).toBe("check");
    expect(payActionOf({ paymentSent: true, lastAttempt: { state: "in_flight" } })).toBe("check");
    expect(payActionOf({ paymentSent: true, lastAttempt: { state: "failed", resend: false } })).toBe("check");
  });

  it("looks for a send Circle never answered first, whatever else is said of it", () => {
    expect(payActionOf({ paymentSent: true, lastAttempt: { state: "unanswered" } })).toBe("look_first");
    expect(payActionOf({ paymentSent: false, lastAttempt: { state: "unanswered" } })).toBe("look_first");
  });

  it("reads a held milestone's Pay now by why it is held", () => {
    expect(milestonePayAction("unknown")).toBe("look_first");
    expect(milestonePayAction("in_flight")).toBe("check");
    expect(milestonePayAction("transfer_failed")).toBe("send_again");
    expect(milestonePayAction("agent_held")).toBe("send");
    expect(milestonePayAction("cash_shortfall")).toBe("send");
  });

  it("checks first only when it reads or looks for an earlier transfer", () => {
    expect((["send", "send_again", "check", "look_first"] as const).filter(checksFirst)).toEqual(["check", "look_first"]);
  });
});

describe("the words before and while it runs: never 'pay now' or 'sending' for a check (E3)", () => {
  it("asks to check, or to look first, rather than to pay now", () => {
    expect(checkFirstTitle("check", "12.50 USDC to Jiren")).toBe("Check the payment of 12.50 USDC to Jiren already sent?");
    expect(checkFirstTitle("look_first", "12.50 USDC to Jiren")).toBe("Look for the earlier payment of 12.50 USDC to Jiren first?");
    expect(checkFirstTitle("send", "12.50 USDC to Jiren")).toBeNull();
    expect(checkFirstTitle("send_again", "12.50 USDC to Jiren")).toBeNull();
  });

  it("names the confirm button for what it does", () => {
    expect(CHECK_FIRST_LABEL).toEqual({ check: "Check it", look_first: "Look first" });
  });

  it("says, while it runs, that it is checking the earlier transfer, not sending", () => {
    expect(runningLine("send", "Jiren")).toBe("Sending to Jiren");
    expect(runningLine("send_again", "Jiren")).toBe("Sending to Jiren");
    expect(runningLine("check", "Jiren")).toBe("Checking the transfer already sent to Jiren");
    expect(runningLine("look_first", "Jiren")).toBe("Looking for the earlier transfer to Jiren on Circle first");
  });

  it("gives a chat's confirmation the same words, and none for a payment it sends", () => {
    expect(chatConfirmText("check")).toBe("Checks the transfer already sent with Circle and records it: nothing new is sent.");
    expect(chatConfirmText("look_first")).toBe(
      "Looks for the earlier transfer on Circle first: records it if Circle has it, and sends the payment only once Circle shows none."
    );
    expect(chatConfirmText("send")).toBeNull();
    expect(chatConfirmText("send_again")).toBeNull();
  });
});

describe("which exceptional state a payment is in", () => {
  it("is slow to confirm once in flight past the network's wait, and nothing before", () => {
    const pending: SettlementFact = { kind: "pending", at: T(2), attempt: 1, state: "SENT", by: "circle" };
    expect(paymentException(settle([sent(1), pending]), NOW, 15)).toBe("stuck");
    expect(paymentException(settle([sent(30), { ...pending, at: T(30) }]), NOW, 15)).toBeNull();
    // Exactly at the wait, as Treasury counts it.
    expect(paymentException(settle([sent(25)]), NOW, 15)).toBe("stuck");
  });

  it("is of unknown outcome while Circle has not answered the send, however young", () => {
    expect(paymentException(settle([sent(38), { kind: "unanswered", at: T(39), attempt: 1 }]), NOW, 15)).toBe("unknown");
  });

  it("keeps failed and cancelled together, not sent and Gateway's failure apart", () => {
    const ended = (end: "failed" | "cancelled" | "not_sent"): SettlementFact => ({ kind: "ended", at: T(3), attempt: 1, end, state: end === "not_sent" ? null : "FAILED", reason: null });
    expect(paymentException(settle([sent(1), ended("failed")]), NOW, 15)).toBe("failed");
    expect(paymentException(settle([sent(1), ended("cancelled")]), NOW, 15)).toBe("failed");
    expect(paymentException(settle([sent(1), ended("not_sent")]), NOW, 15)).toBe("not_sent");
    expect(paymentException(settle([sent(1), { kind: "pending", at: T(2), attempt: 1, state: "GATEWAY_FAILED", by: "circle" }]), NOW, 15)).toBe("gateway_failed");
  });

  it("is none for a payment confirmed, reconciled, or not sent yet", () => {
    const TX = `0x${"ab".repeat(32)}`;
    expect(paymentException(settle([sent(1), { kind: "confirmed", at: T(2), attempt: 1, refs: [TX], txHash: TX }]), NOW, 15)).toBeNull();
    expect(paymentException(settle([]), NOW, 15)).toBeNull();
  });
});

describe("what to do, by who comes back to the bill (E5)", () => {
  it("names Circle's stuck state as Circle's, and who reads a slow transfer again", () => {
    const stuck = whatToDo("stuck", { followUp: "cycle", circleState: "STUCK" });
    expect(stuck.title).toBe("Slow to confirm");
    expect(stuck.owner).toBe(RUNBOOK.stuck.owner);
    expect(stuck.done).toBe(`${RUNBOOK.stuck.done} ${READS_AGAIN.cycle}`);
    expect(stuck.next).toBe(STUCK_AT_CIRCLE);
    expect(whatToDo("stuck", { followUp: "approvals", circleState: "SENT" }).next).toBe(RUNBOOK.stuck.next);
    expect(whatToDo("stuck", { followUp: "approvals", circleState: null }).done).toBe(`${RUNBOOK.stuck.done} ${READS_AGAIN.approvals}`);
    expect(whatToDo("stuck", { followUp: null, circleState: null }).done).toBe(RUNBOOK.stuck.done);
  });

  it("gives an unknown outcome to the agent while its cycle comes back, and to a person where the bill waits", () => {
    expect(whatToDo("unknown", { followUp: "cycle" })).toMatchObject({ owner: OWNER_BY_FOLLOW_UP.unknown.cycle, next: NEXT_BY_FOLLOW_UP.unknown.cycle });
    expect(whatToDo("unknown", { followUp: "approvals" })).toMatchObject({ owner: OWNER_BY_FOLLOW_UP.unknown.approvals, next: NEXT_BY_FOLLOW_UP.unknown.approvals });
    expect(whatToDo("unknown", { followUp: "contractors" })).toMatchObject({ owner: OWNER_BY_FOLLOW_UP.unknown.contractors, next: NEXT_BY_FOLLOW_UP.unknown.contractors });
    expect(whatToDo("unknown", { followUp: null })).toMatchObject({ owner: RUNBOOK.unknown.owner, next: RUNBOOK.unknown.next });
    expect(NEXT_BY_FOLLOW_UP.unknown.approvals).toContain("Approve and pay in Approvals");
    expect(NEXT_BY_FOLLOW_UP.unknown.contractors).toContain("Pay now on Contractors");
  });

  it("sends a failed or unsent payment again only through a person, in Approvals or on Contractors", () => {
    expect(whatToDo("failed", { followUp: "approvals" }).next).toBe(NEXT_BY_FOLLOW_UP.failed.approvals);
    expect(whatToDo("failed", { followUp: "contractors" }).next).toBe(NEXT_BY_FOLLOW_UP.failed.contractors);
    expect(whatToDo("not_sent", { followUp: "approvals" }).next).toBe(NEXT_BY_FOLLOW_UP.not_sent.approvals);
    expect(whatToDo("not_sent", { followUp: "contractors" }).next).toBe(NEXT_BY_FOLLOW_UP.not_sent.contractors);
    expect(RUNBOOK.failed.owner).toContain("never sends a failed payment again on its own");
  });

  it("never tells anyone to pay a payment that may still settle another way", () => {
    for (const state of ["stuck", "unknown", "gateway_failed"] as const) {
      expect(`${RUNBOOK[state].next} ${STUCK_AT_CIRCLE}`, state).not.toMatch(/pay it again|send it again yourself/i);
    }
    expect(RUNBOOK.stuck.next).toContain("do not pay it another way");
    expect(STUCK_AT_CIRCLE).toContain("Do not pay it another way");
  });

  it("says what really happens to a payout to another chain, which cannot be looked up by its reference (payment exceptions review 5)", () => {
    expect(whatToDo("unknown", { followUp: "cycle", crossChain: true })).toMatchObject({ done: ACROSS_CHAINS.done, next: ACROSS_CHAINS.next.cycle });
    expect(whatToDo("unknown", { followUp: "approvals", crossChain: true })).toMatchObject({ done: ACROSS_CHAINS.done, next: ACROSS_CHAINS.next.approvals });
    expect(whatToDo("unknown", { followUp: null, crossChain: true })).toMatchObject({ done: ACROSS_CHAINS.done, next: RUNBOOK.unknown.next });
    expect(ACROSS_CHAINS.done).toContain("asked for again under the same payment key, which Circle takes only once");
    expect(ACROSS_CHAINS.next.approvals).toContain("Reject and Return wait until Circle has answered");
    expect(inFlightNext("unknown", { followUp: "approvals", crossChain: true })).toBe("Approve and pay in Approvals: it asks Circle again under the same payment key, which Circle takes only once.");
    expect(inFlightNext("unknown", { followUp: "cycle", crossChain: true })).toBe("Wait, and do not pay it another way: the agent's next cycle asks Circle again under the same payment key.");
  });

  it("gives a payment in flight on Treasury a short next step", () => {
    expect(inFlightNext("stuck", { followUp: "cycle", circleState: "STUCK" })).toBe("Circle shows it stuck: check it with Circle support. Do not pay it another way.");
    expect(inFlightNext("stuck", { followUp: "cycle", circleState: "SENT" })).toBe("Wait for Circle, and do not pay it another way.");
    expect(inFlightNext("unknown", { followUp: "cycle" })).toBe("Wait, and do not pay it another way: the agent's next cycle looks for it.");
    expect(inFlightNext("unknown", { followUp: "approvals" })).toBe("Approve and pay in Approvals: it looks for it first and sends nothing twice.");
    expect(inFlightNext("unknown", { followUp: "contractors" })).toBe("Pay now on Contractors: it looks for it first and sends nothing twice.");
    expect(inFlightNext("unknown", { followUp: null })).toBe("Do not pay it another way.");
  });
});

describe("the runbook guide (E5, I27)", () => {
  const guide = readSource("guides/payment-exceptions");
  const ids = slugifyHeadings(guide).map((heading) => heading.id);
  const states = Object.keys(RUNBOOK) as Array<PaymentException | "returned">;

  it("has a section for every state, at the anchor the screens link", () => {
    expect(states).toEqual(["stuck", "unknown", "failed", "not_sent", "gateway_failed", "returned"]);
    for (const state of states) {
      expect(guide, state).toContain(`## ${RUNBOOK[state].title}`);
      expect(ids, state).toContain(EXCEPTION_ANCHOR[state]);
    }
    expect(runbookHref("unknown")).toBe(`/docs/guides/payment-exceptions#${EXCEPTION_ANCHOR.unknown}`);
  });

  it.each(states)("says, for %s, when it applies, who acts, what was done, what to do next and where the trail is", (state) => {
    const entry = RUNBOOK[state];
    for (const words of [entry.when, entry.owner, entry.done, entry.next, entry.trail]) expect(guide).toContain(words);
  });

  it("quotes every variant the screens give by who comes back to the bill", () => {
    const variants = [
      ...Object.values(READS_AGAIN),
      STUCK_AT_CIRCLE,
      ACROSS_CHAINS.done,
      ...Object.values(ACROSS_CHAINS.next),
      ...Object.values(OWNER_BY_FOLLOW_UP).flatMap((byFollowUp) => Object.values(byFollowUp)),
      ...Object.values(NEXT_BY_FOLLOW_UP).flatMap((byFollowUp) => Object.values(byFollowUp)),
    ];
    for (const words of variants) expect(guide).toContain(words);
  });
});
