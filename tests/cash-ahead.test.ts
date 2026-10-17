import { describe, expect, it } from "vitest";
import { CASH_AHEAD_PER_CYCLE, latestSchedulingOf, shortAhead, type AheadCandidate, type LatestScheduling } from "@/lib/agent/cash-ahead";

/**
 * Scheduled payments checked against the cash ahead (docs/superpowers/specs/2026-10-17-cash-ahead-design.md A1, A3).
 * The book is the live test's on Oct 17: 150.03 USDC, a 140 USDC bill scheduled for Oct 22, two 45 USDC bills for
 * Oct 23 and Oct 24.
 */

const TODAY = "2026-10-17";

function bill(over: Partial<AheadCandidate> = {}): AheadCandidate {
  return { id: "b-45-a", amount: 45, currency: "USDC", scheduledFor: "2026-10-23T00:00:00.000Z", discount: null, paidToBank: false, ...over };
}

/** What falls due by a day in that book, the bill asked about aside. */
function dueByIn(book: Array<{ id: string; amount: number; day: string }>) {
  return (excludeId: string, by: string) => {
    const rows = book.filter((row) => row.id !== excludeId && row.day <= by);
    return { total: rows.reduce((sum, row) => sum + row.amount, 0), count: rows.length };
  };
}

const BOOK = [
  { id: "b-140", amount: 140, day: "2026-10-22" },
  { id: "b-45-a", amount: 45, day: "2026-10-23" },
  { id: "b-45-b", amount: 45, day: "2026-10-24" },
];

function check(over: Partial<Parameters<typeof shortAhead>[0]> = {}) {
  return shortAhead({
    candidates: [bill({ id: "b-140", amount: 140, scheduledFor: "2026-10-22T00:00:00.000Z" }), bill(), bill({ id: "b-45-b", scheduledFor: "2026-10-24T00:00:00.000Z" })],
    today: TODAY,
    operatingBalance: 150.03,
    reserveBalance: 0,
    dueBy: dueByIn(BOOK),
    latest: new Map(),
    ...over,
  });
}

describe("which scheduled bills the cash will not cover on their day (A1)", () => {
  it("finds the two bills after the 140 USDC one, with what was measured", () => {
    const ahead = check();
    expect([...ahead.keys()]).toEqual(["b-45-a", "b-45-b"]);
    expect(ahead.get("b-45-a")).toEqual({ scheduledFor: "2026-10-23", cashCounted: 150.03, dueBefore: { total: 140, count: 1 }, needed: 45 });
    expect(ahead.get("b-45-b")).toEqual({ scheduledFor: "2026-10-24", cashCounted: 150.03, dueBefore: { total: 185, count: 2 }, needed: 45 });
  });

  it("counts the reserve, as the written policy does for a later day", () => {
    expect(check({ reserveBalance: 79.97 }).size).toBe(0);
    expect([...check({ reserveBalance: 79.96 }).keys()]).toEqual(["b-45-b"]);
  });

  it("measures what a bill needs on its day, its discount taken when it still applies", () => {
    const discounted = bill({ id: "d", amount: 100, scheduledFor: "2026-10-20T00:00:00.000Z", discount: { pct: 2, deadline: "2026-10-20T12:00:00Z" } });
    const lapsed = bill({ id: "l", amount: 100, scheduledFor: "2026-10-21T00:00:00.000Z", discount: { pct: 2, deadline: "2026-10-20T12:00:00Z" } });
    const ahead = shortAhead({ candidates: [discounted, lapsed], today: TODAY, operatingBalance: 99, reserveBalance: 0, dueBy: () => ({ total: 0, count: 0 }), latest: new Map() });
    expect(ahead.has("d")).toBe(false);
    expect(ahead.get("l")?.needed).toBe(100);
  });

  it("leaves out EURC bills, bills paid to a bank account, and a day that is today or cannot be read", () => {
    const candidates = [
      bill({ id: "eurc", currency: "EURC" }),
      bill({ id: "bank", paidToBank: true }),
      bill({ id: "today", scheduledFor: "2026-10-17T00:00:00.000Z" }),
      bill({ id: "unread", scheduledFor: "not a day" }),
      bill({ id: "none", scheduledFor: null }),
    ];
    expect(shortAhead({ candidates, today: TODAY, operatingBalance: 0, reserveBalance: 0, dueBy: () => ({ total: 0, count: 0 }), latest: new Map() }).size).toBe(0);
  });

  it("takes the earliest scheduled first, and at most a few a cycle", () => {
    const many = Array.from({ length: CASH_AHEAD_PER_CYCLE + 2 }, (_, i) => bill({ id: `m${i}`, scheduledFor: `2026-10-${String(30 - i).padStart(2, "0")}T00:00:00.000Z` }));
    const ahead = shortAhead({ candidates: many, today: TODAY, operatingBalance: 0, reserveBalance: 0, dueBy: () => ({ total: 0, count: 0 }), latest: new Map() });
    expect(ahead.size).toBe(CASH_AHEAD_PER_CYCLE);
    expect([...ahead.values()].map((a) => a.scheduledFor)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]);
  });
});

describe("a bill left to its day (A3)", () => {
  const latest = (entry: LatestScheduling) => new Map([["b-45-a", entry]]);

  it("when a person moved it there from the payment plan", () => {
    expect(check({ latest: latest({ by: "person" }) }).has("b-45-a")).toBe(false);
  });

  it("when its decision scheduled it knowing the cash fell short", () => {
    expect(check({ latest: latest({ by: "agent", shortfall: true, cashAhead: null }) }).has("b-45-a")).toBe(false);
    expect(check({ latest: latest({ by: "agent", shortfall: false, cashAhead: null }) }).has("b-45-a")).toBe(true);
  });

  it("when a check already decided it early and the cash ahead is no worse, but not once it is", () => {
    const seen = { cashCounted: 150.03, dueBefore: { total: 140, count: 1 } };
    expect(check({ latest: latest({ by: "agent", shortfall: false, cashAhead: seen }) }).has("b-45-a")).toBe(false);
    expect(check({ latest: latest({ by: "agent", shortfall: false, cashAhead: seen }), operatingBalance: 150 }).has("b-45-a")).toBe(true);
    const moreDue = [...BOOK, { id: "new", amount: 5, day: "2026-10-21" }];
    expect(check({ latest: latest({ by: "agent", shortfall: false, cashAhead: seen }), dueBy: dueByIn(moreDue) }).has("b-45-a")).toBe(true);
  });
});

describe("a bill's latest scheduling, from the ledger", () => {
  it("is the newest entry about it: a person's move, or the agent's decision with what it saw", () => {
    const latest = latestSchedulingOf([
      { action: "payment_rescheduled", detail: { invoiceId: "a" } },
      { action: "ap_schedule", detail: { invoiceId: "a", timing: { shortfall: false } } },
      { action: "ap_schedule", detail: { invoiceId: "b", timing: { shortfall: true } } },
      { action: "ap_schedule", detail: { invoiceId: "c", timing: { shortfall: false }, cashAhead: { cashCounted: 10, dueBefore: { total: 5, count: 1 }, needed: 9 } } },
      { action: "ap_schedule", detail: { invoiceId: "d" } },
      { action: "ap_schedule", detail: {} },
    ]);
    expect(latest.get("a")).toEqual({ by: "person" });
    expect(latest.get("b")).toEqual({ by: "agent", shortfall: true, cashAhead: null });
    expect(latest.get("c")).toEqual({ by: "agent", shortfall: false, cashAhead: { cashCounted: 10, dueBefore: { total: 5, count: 1 } } });
    expect(latest.get("d")).toEqual({ by: "agent", shortfall: null, cashAhead: null });
    expect(latest.size).toBe(4);
  });
});
