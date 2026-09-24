import { describe, expect, it } from "vitest";
import { CycleJournal, CYCLE_STAGES, messageOf } from "@/lib/agent/journal";

describe("CycleJournal", () => {
  it("records each stage in order with its duration", () => {
    const j = new CycleJournal();
    j.enter("reconcile", 1000);
    j.enter("compliance", 1400);
    j.finish(1900);

    expect(j.stages()).toEqual([
      { stage: "reconcile", status: "completed", ms: 400 },
      { stage: "compliance", status: "completed", ms: 500 },
    ]);
  });

  it("names the stage that was in flight when it failed", () => {
    const j = new CycleJournal();
    j.enter("reconcile", 1000);
    j.enter("compliance", 1200);
    j.fail(new Error("TypeError: fetch failed"), 1500);

    expect(j.failedStage()).toBe("compliance");
    expect(j.stages()).toEqual([
      { stage: "reconcile", status: "completed", ms: 200 },
      { stage: "compliance", status: "failed", ms: 300, error: "TypeError: fetch failed" },
    ]);
  });

  it("keeps the stages that completed before the failure", () => {
    // The whole point: an operator needs to know what had already been written
    // by the time it fell over.
    const j = new CycleJournal();
    j.enter("compliance", 0);
    j.enter("follow_up", 10);
    j.enter("ap", 20);
    j.fail(new Error("boom"), 30);

    const completed = j.stages().filter((s) => s.status === "completed").map((s) => s.stage);
    expect(completed).toEqual(["compliance", "follow_up"]);
  });

  it("reports no failed stage on a clean run", () => {
    const j = new CycleJournal();
    j.enter("treasury", 0);
    j.finish(5);
    expect(j.failedStage()).toBeNull();
    expect(j.stages().every((s) => s.status === "completed")).toBe(true);
  });

  it("survives a failure before any stage was entered", () => {
    const j = new CycleJournal();
    j.fail(new Error("died opening the run"));
    expect(j.stages()).toEqual([]);
    expect(j.failedStage()).toBeNull();
  });

  it("is idempotent about finishing, so a finally block cannot double-count", () => {
    const j = new CycleJournal();
    j.enter("forecast", 0);
    j.finish(10);
    j.finish(20);
    j.fail(new Error("late"), 30);
    expect(j.stages()).toHaveLength(1);
  });

  it("never reports a negative duration when a clock moves backwards", () => {
    const j = new CycleJournal();
    j.enter("ap", 1000);
    j.finish(900);
    expect(j.stages()[0].ms).toBe(0);
  });

  it("returns copies, so a caller cannot mutate the record after the fact", () => {
    const j = new CycleJournal();
    j.enter("ap", 0);
    j.finish(1);
    const stolen = j.stages();
    stolen[0].status = "failed";
    expect(j.stages()[0].status).toBe("completed");
  });

  it("covers the whole cycle, so no stage can fail unnamed", () => {
    const j = new CycleJournal();
    for (const [i, stage] of CYCLE_STAGES.entries()) j.enter(stage, i * 10);
    j.finish(CYCLE_STAGES.length * 10);
    expect(j.stages().map((s) => s.stage)).toEqual([...CYCLE_STAGES]);
  });
});

describe("messageOf", () => {
  it("uses the error message", () => {
    expect(messageOf(new Error("insufficient balance"))).toBe("insufficient balance");
  });

  it("falls back to the error name when the message is empty", () => {
    // `new Error()` with no message is exactly the case that would otherwise
    // write an empty string into the column an operator reads.
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
