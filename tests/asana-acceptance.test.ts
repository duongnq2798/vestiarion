import { describe, expect, it } from "vitest";
import { acceptable, acceptanceKpis, durationWords, planRead, selfAcceptance, stateWords, type LinkFacts, type ReadFacts } from "@/lib/asana/acceptance";

/**
 * The rules of accepting contractor work from Asana (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A7 to
 * A10, A14): a completed task only makes the link ready for a person; an acceptance the task no longer bears out is
 * taken back; a held link stays held until a person accepts again; the payee never accepts their own work.
 */

const AT = "2026-10-14T09:00:00.000Z";
const FP = "a".repeat(64);
const link = (fields: Partial<LinkFacts> = {}): LinkFacts => ({
  state: "waiting",
  heldReason: null,
  acceptedAt: null,
  acceptedFingerprint: null,
  acceptedCompletedAt: null,
  afterPayment: false,
  ...fields,
});
const read = (fields: Partial<Extract<ReadFacts, { kind: "task" }>> = {}): ReadFacts => ({ kind: "task", completed: true, completedAt: AT, fingerprint: FP, ...fields });
const accepted = link({ state: "accepted", acceptedAt: "2026-10-14T10:00:00.000Z", acceptedFingerprint: FP, acceptedCompletedAt: AT });

describe("a read of a task not accepted", () => {
  it("waits while the task is not completed", () => {
    expect(planRead(link(), read({ completed: false, completedAt: null }), { criteria: true })).toEqual({ kind: "set", state: "waiting", heldReason: null, becameReady: false });
  });

  it("makes a completed task ready for acceptance, never accepted", () => {
    expect(planRead(link(), read(), { criteria: true })).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: true });
    // Ready already: no second "became ready".
    expect(planRead(link({ state: "ready" }), read(), { criteria: true })).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: false });
  });

  it("holds a completed task whose milestone has no acceptance criteria", () => {
    expect(planRead(link(), read(), { criteria: false })).toEqual({ kind: "set", state: "held", heldReason: "no_criteria", becameReady: false });
    // Once the criteria are written, the same task is ready.
    expect(planRead(link({ state: "held", heldReason: "no_criteria" }), read(), { criteria: true })).toMatchObject({ state: "ready", becameReady: true });
  });

  it("goes back to waiting when the task is reopened before anyone accepted it", () => {
    expect(planRead(link({ state: "ready" }), read({ completed: false, completedAt: null }), { criteria: true })).toMatchObject({ kind: "set", state: "waiting" });
  });

  it("holds a task Asana no longer shows the connection", () => {
    for (const reason of ["not_found", "forbidden"] as const) {
      expect(planRead(link({ state: "ready" }), { kind: "gone", reason }, { criteria: true })).toEqual({ kind: "set", state: "held", heldReason: "task_unreachable", becameReady: false });
    }
  });
});

describe("a read of an accepted task", () => {
  it("keeps the acceptance while the task is what was accepted", () => {
    expect(planRead(accepted, read(), { criteria: true })).toEqual({ kind: "keep" });
    // The same instant, written another way.
    expect(planRead(accepted, read({ completedAt: "2026-10-14T09:00:00Z" }), { criteria: true })).toEqual({ kind: "keep" });
  });

  it("takes it back when the task is reopened", () => {
    expect(planRead(accepted, read({ completed: false, completedAt: null }), { criteria: true })).toEqual({ kind: "withdraw", reason: "reopened" });
  });

  it("takes it back when the task was reopened and completed again between two reads", () => {
    expect(planRead(accepted, read({ completedAt: "2026-10-14T11:30:00.000Z" }), { criteria: true })).toEqual({ kind: "withdraw", reason: "reopened" });
  });

  it("takes it back when a deliverable changed: an attachment, a link or a new version", () => {
    expect(planRead(accepted, read({ fingerprint: "b".repeat(64) }), { criteria: true })).toEqual({ kind: "withdraw", reason: "deliverable_changed" });
  });

  it("takes it back when Asana no longer shows the task", () => {
    expect(planRead(accepted, { kind: "gone", reason: "not_found" }, { criteria: true })).toEqual({ kind: "withdraw", reason: "task_unreachable" });
  });
});

describe("a link held after an acceptance", () => {
  it("stays held whatever Asana says, until a person accepts again", () => {
    const held = link({ state: "held", heldReason: "reopened", acceptedAt: "2026-10-14T10:00:00.000Z", acceptedFingerprint: FP, acceptedCompletedAt: AT });
    for (const facts of [read(), read({ completed: false, completedAt: null }), read({ fingerprint: "c".repeat(64) })]) {
      expect(planRead(held, facts, { criteria: true })).toEqual({ kind: "set", state: "held", heldReason: "reopened", becameReady: false });
    }
  });

  it("stays held after a payment was sent, as a dispute", () => {
    const disputed = link({ state: "held", heldReason: "deliverable_changed", afterPayment: true });
    expect(planRead(disputed, read(), { criteria: true })).toMatchObject({ state: "held", heldReason: "deliverable_changed" });
  });
});

describe("who may accept, and when", () => {
  it("is offered for a completed task with criteria, while the milestone waits for verification", () => {
    const facts = { completed: true, criteria: true, milestoneStatus: "pending" };
    expect(acceptable(link({ state: "ready" }), facts)).toBe(true);
    // Held after a reopen, completed again: a person accepts it again.
    expect(acceptable(link({ state: "held", heldReason: "reopened" }), facts)).toBe(true);
    expect(acceptable(link({ state: "accepted" }), facts)).toBe(false);
    expect(acceptable(link({ state: "waiting" }), facts)).toBe(false);
    expect(acceptable(link({ state: "held", heldReason: "task_unreachable" }), facts)).toBe(false);
    expect(acceptable(link({ state: "held", heldReason: "reopened", afterPayment: true }), facts)).toBe(false);
    expect(acceptable(link({ state: "ready" }), { ...facts, criteria: false })).toBe(false);
    expect(acceptable(link({ state: "ready" }), { ...facts, completed: false })).toBe(false);
    for (const status of ["verified", "held", "paid", "closed"]) expect(acceptable(link({ state: "ready" }), { ...facts, milestoneStatus: status })).toBe(false);
  });

  it("is never the payee: by their email in Vestiarion, or their Asana account", () => {
    expect(selfAcceptance({ memberEmail: "Mai@Fernhill.example ", payeeEmail: "mai@fernhill.example", memberAsanaGid: null, payeeAsanaGid: null })).toBe("payee_member");
    expect(selfAcceptance({ memberEmail: "owner@business.example", payeeEmail: "mai@fernhill.example", memberAsanaGid: "1001", payeeAsanaGid: "1001" })).toBe("payee_asana");
    expect(selfAcceptance({ memberEmail: "owner@business.example", payeeEmail: "mai@fernhill.example", memberAsanaGid: "1001", payeeAsanaGid: "2002" })).toBeNull();
    // Without a payee email, or an Asana account for either, nothing is matched by accident.
    expect(selfAcceptance({ memberEmail: "owner@business.example", payeeEmail: null, memberAsanaGid: null, payeeAsanaGid: null })).toBeNull();
    expect(selfAcceptance({ memberEmail: null, payeeEmail: null, memberAsanaGid: "1001", payeeAsanaGid: null })).toBeNull();
  });
});

describe("the words", () => {
  it("never call a completed task paid or approved", () => {
    const words = (["waiting", "ready", "accepted", "held"] as const).map((state) => stateWords(state, state === "held" ? "reopened" : null, false));
    expect(words.map((word) => word.label)).toEqual(["Waiting for the task", "Ready for acceptance", "Accepted", "Held for review"]);
    expect(words[1].line).toMatch(/accept the work/);
    expect(stateWords("held", "reopened", true).label).toBe("Changed after payment");
    for (const reason of ["reopened", "deliverable_changed", "task_unreachable", "no_criteria", "unlinked"] as const) expect(stateWords("held", reason, false).line).not.toMatch(/VND/);
  });
});

describe("the card's figures", () => {
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  it("counts acceptances, disputes, and the median time from an acceptance to the agent's decision", () => {
    const events = [
      { action: "milestone_accepted", ts: "2026-10-14T10:00:00Z", milestoneId: "m1" },
      { action: "milestone_release", ts: "2026-10-14T10:02:00Z", milestoneId: "m1" },
      { action: "milestone_accepted", ts: "2026-10-14T11:00:00Z", milestoneId: "m2" },
      { action: "milestone_hold", ts: "2026-10-14T11:06:00Z", milestoneId: "m2" },
      { action: "milestone_release", ts: "2026-10-14T11:30:00Z", milestoneId: "m2" },
      // A decision before the acceptance is not the one that followed it.
      { action: "milestone_release", ts: "2026-10-13T08:00:00Z", milestoneId: "m3" },
      { action: "milestone_accepted", ts: "2026-10-14T11:50:00Z", milestoneId: "m3" },
      { action: "milestone_acceptance_withdrawn", ts: "2026-10-14T11:55:00Z", milestoneId: "m3" },
      // Outside the window.
      { action: "milestone_accepted", ts: "2026-08-01T10:00:00Z", milestoneId: "m4" },
    ];
    expect(acceptanceKpis(events, NOW)).toEqual({ manualChecks: 3, disputes: 1, medianMinutesToProposal: 4, proposals: 2 });
    expect(acceptanceKpis([], NOW)).toEqual({ manualChecks: 0, disputes: 0, medianMinutesToProposal: null, proposals: 0 });
    expect(durationWords(0.4)).toBe("under a minute");
    expect(durationWords(4)).toBe("4 minutes");
    expect(durationWords(150)).toBe("2.5 hours");
  });
});
