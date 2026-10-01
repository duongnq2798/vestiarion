import { describe, expect, it } from "vitest";
import { cashOutlook, type OutlookInput } from "@/lib/cash-outlook";

/**
 * Safe to spend today and the next 30 days (docs/superpowers/specs/2026-10-02-safe-to-spend-design.md):
 * the operating wallet's USDC less what the agent already counts as owed — open payables (a scheduled one
 * on its day, an overdue one today) and every open milestone — and the cushion it keeps over the next
 * 7 days (the treasury's 1.15 buffer). Receivables are expected, never counted as cash.
 */

const NOW = Date.parse("2026-10-02T09:00:00Z");
const day = (offset: number, hour = 12) => new Date(Date.UTC(2026, 9, 2 + offset, hour)).toISOString();

const base = (over: Partial<OutlookInput> = {}): OutlookInput => ({
  now: NOW,
  operatingUsdc: 100,
  payables: [],
  milestones: [],
  receivables: [],
  ...over,
});

const payable = (id: string, amount: number, due: string, over: Record<string, unknown> = {}) => ({
  id, counterparty: `Vendor ${id}`, amount, currency: "USDC", due_date: due, status: "pending", scheduled_for: null, ...over,
});

describe("cashOutlook: safe to spend today", () => {
  it("is the whole balance when nothing is owed", () => {
    const outlook = cashOutlook(base());
    expect(outlook).toMatchObject({ safeToSpend: 100, cash: 100, dueIn30d: 0, milestonesOpen: 0, cushion: 0, shortOn: null });
    expect(outlook.days).toEqual([]);
  });

  it("takes off what is due within 30 days, every open milestone, and a 15% cushion on the next 7 days", () => {
    const outlook = cashOutlook(
      base({
        payables: [payable("a", 20, day(3)), payable("b", 30, day(20)), payable("c", 40, day(40))],
        milestones: [{ id: "m1", title: "Thumbnails", contractor: "Linh", amount: 10, status: "verified", escrow_state: null }],
      })
    );
    // Due in 30 days: 20 + 30 (not the 40 on day 40). Milestones: 10. Cushion: 15% of (20 + 10) = 4.5.
    expect(outlook).toMatchObject({ dueIn30d: 50, dueCount: 2, milestonesOpen: 10, milestoneCount: 1, cushion: 4.5, safeToSpend: 35.5 });
  });

  it("counts a scheduled payable on its day, an overdue or held one today", () => {
    const outlook = cashOutlook(
      base({
        payables: [
          payable("late", 5, day(-3)),
          payable("held", 6, day(10), { status: "held" }),
          payable("sched", 7, day(25), { status: "scheduled", scheduled_for: day(4, 0) }),
        ],
      })
    );
    expect(outlook.days.map((d) => d.day)).toEqual(["2026-10-02", "2026-10-06", "2026-10-12"]);
    expect(outlook.days[0].items).toEqual([{ kind: "out", label: "Vendor late", amount: 5, note: "overdue" }]);
    expect(outlook.days[1].items).toEqual([{ kind: "out", label: "Vendor sched", amount: 7, note: "scheduled" }]);
    expect(outlook.days[2].items).toEqual([{ kind: "out", label: "Vendor held", amount: 6, note: "held" }]);
    // Cushion: 15% of the 5 overdue and the 7 scheduled on day 4, both inside 7 days.
    expect(outlook.cushion).toBe(1.8);
  });

  it("leaves out what no longer leaves the wallet: paid or rejected payables, released or escrowed milestones, EURC", () => {
    const outlook = cashOutlook(
      base({
        payables: [
          payable("paid", 5, day(1), { status: "paid" }),
          payable("rejected", 5, day(1), { status: "rejected" }),
          payable("eurc", 9, day(1), { currency: "EURC" }),
        ],
        milestones: [
          { id: "m1", title: "Paid", contractor: "Linh", amount: 5, status: "paid", escrow_state: null },
          { id: "m2", title: "Locked", contractor: "Linh", amount: 5, status: "verified", escrow_state: "funded" },
        ],
      })
    );
    expect(outlook).toMatchObject({ safeToSpend: 100, dueIn30d: 0, milestonesOpen: 0, eurcLeftOut: 9 });
  });

  it("goes negative, and names the first day the wallet runs short, before any expected receivable", () => {
    const outlook = cashOutlook(
      base({
        operatingUsdc: 30,
        payables: [payable("a", 20, day(2)), payable("b", 25, day(9))],
        receivables: [{ id: "r1", counterparty: "Acme", amount: 50, currency: "USDC", due_date: day(5), status: "pending" }],
      })
    );
    expect(outlook.safeToSpend).toBe(-18);
    expect(outlook.shortOn).toBe("2026-10-11");
    expect(outlook.expectedIn30d).toBe(50);
    const last = outlook.days.at(-1)!;
    expect(last).toMatchObject({ day: "2026-10-11", balance: -15, balanceWithExpected: 35 });
  });
});

describe("cashOutlook: the next 30 days", () => {
  it("lists only days with money moving, in order, with a running balance and expected receivables apart", () => {
    const outlook = cashOutlook(
      base({
        payables: [payable("a", 20, day(3))],
        milestones: [{ id: "m1", title: "Thumbnails", contractor: "Linh", amount: 10, status: "pending", escrow_state: null }],
        receivables: [
          { id: "r1", counterparty: "Acme", amount: 40, currency: "USDC", due_date: day(3), status: "pending" },
          { id: "r2", counterparty: "Beta", amount: 9, currency: "USDC", due_date: day(31), status: "pending" },
          { id: "r3", counterparty: "Gamma", amount: 9, currency: "USDC", due_date: day(2), status: "received" },
        ],
      })
    );
    expect(outlook.days).toEqual([
      { day: "2026-10-02", items: [{ kind: "milestone", label: "Linh: Thumbnails", amount: 10, note: "payable once verified" }], balance: 90, balanceWithExpected: 90 },
      {
        day: "2026-10-05",
        items: [
          { kind: "out", label: "Vendor a", amount: 20, note: "due" },
          { kind: "in", label: "Acme", amount: 40, note: "expected" },
        ],
        balance: 70,
        balanceWithExpected: 110,
      },
    ]);
  });
});
