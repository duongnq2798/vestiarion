import { describe, expect, it } from "vitest";
import {
  allowedTones,
  boundTone,
  boundWaitDays,
  daysFromDue,
  referenceReminder,
  reminderAllowed,
  whenInWords,
  type ReminderFacts,
  type SentReminder,
} from "@/lib/collections";

/** The rules of the agent's reminders (docs/superpowers/specs/2026-10-03-collections-design.md R3–R5). */

const DUE = "2026-10-10T12:00:00+00:00";
const at = (iso: string) => Date.parse(iso);
const facts = (now: string, sent: SentReminder[] = [], deferredUntil: string | null = null): ReminderFacts => ({ now: at(now), dueDate: DUE, sent, deferredUntil });
const sentOn = (number: number, iso: string, tone: SentReminder["tone"] = "friendly"): SentReminder => ({ number, tone, sentAt: iso });

describe("days from the due date", () => {
  it("counts whole UTC days: before it negative, on it 0, after it positive", () => {
    expect(daysFromDue(DUE, at("2026-10-07T23:59:00Z"))).toBe(-3);
    expect(daysFromDue(DUE, at("2026-10-10T00:01:00Z"))).toBe(0);
    expect(daysFromDue(DUE, at("2026-10-13T08:00:00Z"))).toBe(3);
    expect(daysFromDue("2026-10-10", at("2026-10-11T08:00:00Z"))).toBe(1);
  });

  it("says when in words", () => {
    expect(whenInWords(-3)).toBe("3 days before the due date");
    expect(whenInWords(0)).toBe("on the due date");
    expect(whenInWords(1)).toBe("1 day after the due date");
  });
});

describe("when code allows a reminder (R3)", () => {
  it("allows the first from 3 days before the due date, and counts it as number 1", () => {
    expect(reminderAllowed(facts("2026-10-06T09:00:00Z"))).toEqual({ allowed: false, reason: "it is more than 3 days before the due date" });
    expect(reminderAllowed(facts("2026-10-07T09:00:00Z"))).toEqual({ allowed: true, number: 1, daysFromDue: -3 });
  });

  it("keeps 3 days between reminders", () => {
    const sent = [sentOn(1, "2026-10-07T09:00:00Z")];
    expect(reminderAllowed(facts("2026-10-10T08:59:00Z", sent))).toEqual({ allowed: false, reason: "a reminder went out less than 3 days ago" });
    expect(reminderAllowed(facts("2026-10-10T09:00:00Z", sent))).toEqual({ allowed: true, number: 2, daysFromDue: 0 });
  });

  it("stops after 4, after a final one, and 30 days after the due date", () => {
    const four = [1, 2, 3, 4].map((n) => sentOn(n, `2026-10-0${n}T09:00:00Z`));
    expect(reminderAllowed(facts("2026-10-20T09:00:00Z", four))).toMatchObject({ allowed: false, reason: "all 4 reminders were sent" });
    expect(reminderAllowed(facts("2026-10-25T09:00:00Z", [sentOn(1, "2026-10-12T09:00:00Z", "final")]))).toMatchObject({ allowed: false, reason: "the final reminder was sent" });
    expect(reminderAllowed(facts("2026-11-10T09:00:00Z"))).toMatchObject({ allowed: false, reason: "it is more than 30 days after the due date" });
  });

  it("waits while a wait the model chose is running", () => {
    expect(reminderAllowed(facts("2026-10-08T09:00:00Z", [], "2026-10-09T09:00:00Z"))).toEqual({ allowed: false, reason: "the agent chose to wait" });
    expect(reminderAllowed(facts("2026-10-09T09:00:00Z", [], "2026-10-09T09:00:00Z"))).toMatchObject({ allowed: true });
  });
});

describe("the tones code allows (R5)", () => {
  it("allows friendly always, firm after the due date, final 7 days after it with 2 sent", () => {
    expect(allowedTones(-2, 0)).toEqual(["friendly"]);
    expect(allowedTones(0, 1)).toEqual(["friendly"]);
    expect(allowedTones(1, 0)).toEqual(["friendly", "firm"]);
    expect(allowedTones(7, 1)).toEqual(["friendly", "firm"]);
    expect(allowedTones(7, 2)).toEqual(["friendly", "firm", "final"]);
  });

  it("brings a stronger tone down to the strongest allowed, and says so", () => {
    expect(boundTone("final", 2, 1)).toEqual({ tone: "firm", limited: true });
    expect(boundTone("firm", -1, 0)).toEqual({ tone: "friendly", limited: true });
    expect(boundTone("friendly", 12, 3)).toEqual({ tone: "friendly", limited: false });
  });

  it("keeps a wait between 1 and 3 days", () => {
    expect([boundWaitDays(undefined), boundWaitDays(0), boundWaitDays(2.4), boundWaitDays(9)]).toEqual([1, 1, 2, 3]);
  });
});

describe("the written policy (R4)", () => {
  const decide = (now: string, sent: SentReminder[] = []) => {
    const f = facts(now, sent);
    const allowance = reminderAllowed(f);
    if (!allowance.allowed) throw new Error(allowance.reason);
    return referenceReminder(f, allowance);
  };

  it("sends a friendly reminder 3 days before the due date, and on it", () => {
    expect(decide("2026-10-07T09:00:00Z")).toMatchObject({ action: "send", tone: "friendly" });
    expect(decide("2026-10-10T09:00:00Z", [sentOn(1, "2026-10-07T09:00:00Z")])).toMatchObject({ action: "send", tone: "friendly" });
  });

  it("sends a firm one 3 days after the due date, and the final one 10 days after it", () => {
    const two = [sentOn(1, "2026-10-07T09:00:00Z"), sentOn(2, "2026-10-10T09:00:00Z")];
    expect(decide("2026-10-13T09:00:00Z", two)).toMatchObject({ action: "send", tone: "firm" });
    const three = [...two, sentOn(3, "2026-10-13T09:00:00Z", "firm")];
    expect(decide("2026-10-20T09:00:00Z", three)).toMatchObject({ action: "send", tone: "final" });
  });

  it("waits for the next step's day, at most 3 days at a time, saying why", () => {
    const three = [sentOn(1, "2026-10-07T09:00:00Z"), sentOn(2, "2026-10-10T09:00:00Z"), sentOn(3, "2026-10-13T09:00:00Z", "firm")];
    const waiting = decide("2026-10-16T09:00:00Z", three);
    expect(waiting).toMatchObject({ action: "wait", waitDays: 3 });
    expect(waiting.reasoning).toBe("3 reminders went out before. The written policy sends reminder 4 10 days after the due date, which is 4 days away, so it waits 3 days.");
  });

  it("catches up when reminders were turned on late: the first goes now, firm", () => {
    expect(decide("2026-10-15T09:00:00Z")).toMatchObject({ action: "send", tone: "firm" });
  });
});
