import { describe, expect, it } from "vitest";
import {
  CycleJournal,
  CYCLE_STAGES,
  messageOf,
  STAGE_REQUIRES,
  type CycleStage,
} from "@/lib/agent/journal";

/** Runs a clean cycle up to but not including `stopBefore`. */
function upTo(stopBefore: CycleStage): CycleJournal {
  const j = new CycleJournal();
  for (const stage of CYCLE_STAGES) {
    if (stage === stopBefore) break;
    j.completed(stage, 10);
  }
  return j;
}

describe("CycleJournal — recording", () => {
  it("records each stage with its duration, in cycle order", () => {
    const j = new CycleJournal();
    j.completed("compliance", 400);
    j.completed("reconcile", 100);
    expect(j.stages().map((s) => s.stage)).toEqual(["reconcile", "compliance"]);
  });

  it("keeps the stages that completed before a failure", () => {
    const j = upTo("ap");
    j.failed("ap", new Error("TypeError: fetch failed"), 250);
    expect(j.failedStage()).toBe("ap");
    expect(j.stages().filter((s) => s.status === "completed").map((s) => s.stage)).toEqual([
      "reconcile",
      "compliance",
      "follow_up",
    ]);
  });

  it("names the first failure as the cause, not a later consequence", () => {
    const j = new CycleJournal();
    j.completed("reconcile", 1);
    j.failed("compliance", new Error("screening down"), 1);
    j.failed("forecast", new Error("later, unrelated"), 1);
    expect(j.failedStage()).toBe("compliance");
    expect(j.failures()).toHaveLength(2);
  });

  it("never reports a negative duration when a clock moves backwards", () => {
    const j = new CycleJournal();
    j.completed("ap", -50);
    expect(j.stages()[0].ms).toBe(0);
  });

  it("returns copies, so a caller cannot rewrite history", () => {
    const j = new CycleJournal();
    j.completed("ap", 1);
    const stolen = j.stages();
    stolen[0].status = "failed";
    expect(j.stages()[0].status).toBe("completed");
  });

  it("reports no failed stage on a clean run", () => {
    const j = upTo("forecast");
    j.completed("forecast", 5);
    expect(j.failedStage()).toBeNull();
    expect(j.summary()).toBeNull();
  });
});

describe("CycleJournal — the fail-closed boundary", () => {
  it("stops payments and releases when screening failed", () => {
    // The whole reason screening exists. Stale risk must not authorise money
    // leaving the business.
    const j = upTo("compliance");
    j.failed("compliance", new Error("screening provider down"), 10);

    expect(j.gate("ap").run).toBe(false);
    expect(j.gate("contractors").run).toBe(false);
    expect(j.gate("follow_up").run).toBe(false);
  });

  it("still sweeps and still forecasts when screening failed", () => {
    // A sweep moves the business's own money between its own accounts, and a
    // forecast authorises nothing. Neither needs a counterparty verdict.
    const j = upTo("compliance");
    j.failed("compliance", new Error("screening provider down"), 10);

    expect(j.gate("treasury").run).toBe(true);
    expect(j.gate("forecast").run).toBe(true);
  });

  it("stops every money movement when balances are unknown", () => {
    // If reconcile failed the agent does not know what it holds, so nothing
    // that moves money may run — including the sweep.
    const j = new CycleJournal();
    j.failed("reconcile", new Error("chain unreachable"), 10);
    j.completed("compliance", 10);

    expect(j.gate("ap").run).toBe(false);
    expect(j.gate("contractors").run).toBe(false);
    expect(j.gate("treasury").run).toBe(false);
    // Recording what happened is always allowed.
    expect(j.gate("forecast").run).toBe(true);
  });

  it("lets payments proceed when only the follow-up review failed", () => {
    // Nothing downstream rests on it; it just means frozen invoices went
    // unreviewed this cycle.
    const j = upTo("follow_up");
    j.failed("follow_up", new Error("boom"), 10);
    expect(j.gate("ap").run).toBe(true);
    expect(j.gate("treasury").run).toBe(true);
  });

  it("lets contractors and treasury proceed when AP failed", () => {
    const j = upTo("ap");
    j.failed("ap", new Error("boom"), 10);
    expect(j.gate("contractors").run).toBe(true);
    expect(j.gate("treasury").run).toBe(true);
    expect(j.gate("forecast").run).toBe(true);
  });

  it("blames the stage that actually broke, not the nearest dependency", () => {
    // An operator reading "skipped because contractors was skipped" would have
    // to walk a chain of consequences to find the cause.
    const j = new CycleJournal();
    j.completed("reconcile", 1);
    j.failed("compliance", new Error("screening down"), 1);
    const followUp = j.gate("follow_up");
    if (followUp.run) throw new Error("expected follow_up to be gated");
    j.skipped("follow_up", followUp.because);

    const ap = j.gate("ap");
    expect(ap.run).toBe(false);
    if (!ap.run) expect(ap.because).toContain("compliance");
  });

  it("treats a stage that never ran as unsatisfied, not as passed", () => {
    // Failing open on a missing prerequisite is the dangerous direction.
    const j = new CycleJournal();
    expect(j.gate("ap").run).toBe(false);
  });

  it("allows every independent stage on an empty journal", () => {
    const j = new CycleJournal();
    for (const stage of CYCLE_STAGES) {
      if (STAGE_REQUIRES[stage].length === 0) expect(j.gate(stage).run, stage).toBe(true);
    }
  });
});

describe("CycleJournal — outcome", () => {
  it("is completed only when every stage ran and succeeded", () => {
    const j = new CycleJournal();
    for (const stage of CYCLE_STAGES) j.completed(stage, 1);
    expect(j.outcome()).toBe("completed");
  });

  it("is partial when anything failed, however much else worked", () => {
    // A cycle that skipped work is never "completed": its counts are real but
    // stop where the failure stopped them.
    const j = new CycleJournal();
    for (const stage of CYCLE_STAGES) j.completed(stage, 1);
    j.failed("compliance", new Error("x"), 1);
    expect(j.outcome()).toBe("partial");
  });

  it("is partial when a stage was skipped", () => {
    const j = new CycleJournal();
    for (const stage of CYCLE_STAGES) j.completed(stage, 1);
    j.skipped("ap", "compliance failed");
    expect(j.outcome()).toBe("partial");
  });

  it("is failed when nothing ran at all", () => {
    expect(new CycleJournal().outcome()).toBe("failed");
  });

  it("summarises the failures and what they cost", () => {
    const j = upTo("compliance");
    j.failed("compliance", new Error("screening down"), 1);
    j.skipped("ap", "compliance failed");
    j.skipped("contractors", "compliance failed");

    const summary = j.summary()!;
    expect(summary).toContain("compliance: screening down");
    expect(summary).toContain("skipped ap, contractors");
  });
});

describe("messageOf", () => {
  it("uses the error message", () => {
    expect(messageOf(new Error("insufficient balance"))).toBe("insufficient balance");
  });

  it("falls back to the error name when the message is empty", () => {
    // `new Error()` is exactly the case that would otherwise write an empty
    // string into the column an operator reads.
    expect(messageOf(new Error())).toBe("Error");
  });

  it("accepts a thrown string", () => {
    expect(messageOf("something went wrong")).toBe("something went wrong");
  });

  it("never returns an empty string", () => {
    for (const value of [undefined, null, "", "   "]) {
      expect(messageOf(value).length).toBeGreaterThan(0);
    }
  });

  it("truncates rather than writing an unbounded blob", () => {
    const result = messageOf(new Error("x".repeat(2000)));
    expect(result.length).toBe(500);
    expect(result.endsWith("...")).toBe(true);
  });
});
