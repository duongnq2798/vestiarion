import { describe, expect, it } from "vitest";
import { cashOutlook } from "@/lib/cash-outlook";
import { scenarioBasis } from "@/lib/cash-scenario-basis";
import { cashScenario, DEFAULT_LEVERS, receivablesIn, type BasisOutflow, type ScenarioBasis, type ScenarioLevers } from "@/lib/cash-scenarios";

/**
 * Cash scenarios (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md C5-C8): from what Treasury already
 * counts, the balance day by day over 30, 60 or 90 days, as it stands and with clients paying late, a receivable never
 * arriving or bills costing more; the first short day, the bills it touches, advice in words, what moves it most and
 * what it is built from. A receivable adds to the balance only on the day it arrives.
 */

const NOW = Date.parse("2026-10-02T09:00:00Z");
const at = (offset: number, hour = 12) => new Date(Date.UTC(2026, 9, 2 + offset, hour)).toISOString();
const ymd = (offset: number) => at(offset).slice(0, 10);

const basis = (over: Partial<ScenarioBasis> = {}): ScenarioBasis => ({
  today: "2026-10-02",
  cash: 100,
  reserve: 0,
  outflows: [],
  receivables: [],
  clients: {},
  eurc: [],
  recurringRead: true,
  ...over,
});
const bill = (label: string, amount: number, day: number, over: Partial<BasisOutflow> = {}): BasisOutflow => ({
  id: `bill-${label}-${day}`, kind: "bill", label, amount, day, note: "due", foreign: false, ...over,
});
const owed = (label: string, amount: number, day: number, over: Partial<ScenarioBasis["receivables"][number]> = {}) => ({
  id: `in-${label}`, label, amount, day, overdue: false, client: `client-${label}`, ...over,
});
const levers = (over: Partial<ScenarioLevers> = {}): ScenarioLevers => ({ horizon: 30, lateDays: 14, choices: {}, costPct: 0, costScope: "all", ...over });

describe("cashScenario: the base case is what Treasury already counts", () => {
  it("matches Next 30 days on the same rows: with receivables on their due days, and with none at all", () => {
    const input = {
      now: NOW,
      operatingUsdc: 30,
      reserveUsdc: 0,
      payables: [
        { id: "a", counterparty: "Vendor a", amount: 20, currency: "USDC", due_date: at(2), status: "pending", scheduled_for: null },
        { id: "b", counterparty: "Vendor b", amount: 25, currency: "USDC", due_date: at(9), status: "pending", scheduled_for: null },
      ],
      milestones: [{ id: "m1", title: "Logo", contractor: "Linh", amount: 10, status: "pending", escrow_state: null }],
      receivables: [{ id: "r1", counterparty: "Acme", amount: 50, currency: "USDC", due_date: at(5), status: "pending" }],
    };
    const outlook = cashOutlook(input);
    const start = scenarioBasis({ ...input, recurring: [] });
    const asIs = cashScenario(start, levers({ lateDays: 0 }));
    const noneArrive = cashScenario(start, levers({ choices: { r1: "never" } }));
    const offset = (day: string) => (Date.parse(`${day}T00:00:00Z`) - Date.parse("2026-10-02T00:00:00Z")) / 86_400_000;
    for (const day of outlook.days) {
      expect(asIs.days[offset(day.day)].base).toBe(day.balanceWithExpected);
      expect(asIs.days[offset(day.day)].scenario).toBe(day.balanceWithExpected);
      expect(noneArrive.days[offset(day.day)].scenario).toBe(day.balance);
    }
    // Next 30 days says the wallet runs short on Oct 11 before any receivable arrives; that is the scenario with none.
    expect(noneArrive.scenario.shortOn).toBe(outlook.shortOn);
    // On today, the cushion is Safe to spend today's.
    expect(asIs.days[0].cushion).toBe(outlook.cushion);
  });

  it("covers every day of the horizon, from today, with the wallet and the reserve together as cash", () => {
    for (const horizon of [30, 60, 90] as const) {
      const result = cashScenario(basis({ cash: 70, reserve: 30 }), levers({ horizon }));
      expect(result.days).toHaveLength(horizon);
      expect(result.days[0]).toEqual({ day: "2026-10-02", base: 100, scenario: 100, cushion: 0 });
      expect(result.lastDay).toBe(ymd(horizon - 1));
      expect(result).toMatchObject({ horizon, today: "2026-10-02", cash: 70, reserve: 30 });
    }
  });
});

describe("cashScenario: receivables late, on time or never", () => {
  const start = basis({ outflows: [bill("Harbor", 120, 10)], receivables: [owed("Acme", 50, 5), owed("Beta", 30, 8)] });

  it("moves every receivable by the days late, so the balance runs short the day the bill leaves", () => {
    const result = cashScenario(start, levers());
    expect(result.base).toMatchObject({ shortOn: null, lowest: { day: ymd(10), balance: 60 }, end: 60 });
    expect(result.scenario).toMatchObject({ shortOn: ymd(10), lowest: { day: ymd(10), balance: -20 }, end: 60 });
    // Acme is due day 5 and arrives day 19: until then it is not in the balance.
    expect(result.days[18].scenario).toBe(-20);
    expect(result.days[19].scenario).toBe(30);
    expect(result.moved).toEqual([
      { id: "in-Acme", label: "Acme", amount: 50, expected: ymd(5), arrives: ymd(19), outside: false },
      { id: "in-Beta", label: "Beta", amount: 30, expected: ymd(8), arrives: ymd(22), outside: false },
    ]);
    expect(result.affected).toEqual([{ id: "bill-Harbor-10", label: "Harbor", amount: 120, day: ymd(10), kind: "bill", note: "due" }]);
    expect(result.shortfall).toBe(20);
    expect(result.receivables).toEqual({ base: 80, scenario: 80 });
    expect(result.outflows).toEqual({ base: 120, scenario: 120 });
  });

  it("keeps a receivable on time, or drops it, as chosen one by one", () => {
    const result = cashScenario(start, levers({ choices: { "in-Acme": "on_time", "in-Beta": "never" } }));
    expect(result.days[5].scenario).toBe(150);
    expect(result.days[29].scenario).toBe(30);
    expect(result.moved).toEqual([{ id: "in-Beta", label: "Beta", amount: 30, expected: ymd(8), arrives: null, outside: false }]);
    expect(result.receivables).toEqual({ base: 80, scenario: 50 });
  });

  it("counts lateness from today for a receivable already overdue", () => {
    const result = cashScenario(basis({ receivables: [owed("Old", 40, 0, { overdue: true })] }), levers({ lateDays: 14 }));
    expect(result.days[13].scenario).toBe(100);
    expect(result.days[14].scenario).toBe(140);
  });

  it("leaves a receivable that lands after the horizon out of it", () => {
    const result = cashScenario(basis({ receivables: [owed("Acme", 50, 20)] }), levers({ lateDays: 14 }));
    expect(result.moved).toEqual([{ id: "in-Acme", label: "Acme", amount: 50, expected: ymd(20), arrives: ymd(34), outside: true }]);
    expect(result.receivables).toEqual({ base: 50, scenario: 0 });
    expect(result.days[29].scenario).toBe(100);
    // Over 60 days it arrives.
    expect(cashScenario(basis({ receivables: [owed("Acme", 50, 20)] }), levers({ horizon: 60, lateDays: 14 })).days[34].scenario).toBe(150);
  });

  it("changes nothing at 0 days late", () => {
    const result = cashScenario(start, levers({ lateDays: 0 }));
    expect(result.days.map((day) => day.scenario)).toEqual(result.days.map((day) => day.base));
    expect(result.moved).toEqual([]);
  });

  it("lists the receivables a horizon holds, for the choices", () => {
    const start90 = basis({ receivables: [owed("Near", 1, 3), owed("Far", 2, 70)] });
    expect(receivablesIn(start90, 30).map((receivable) => receivable.label)).toEqual(["Near"]);
    expect(receivablesIn(start90, 90).map((receivable) => receivable.label)).toEqual(["Near", "Far"]);
  });
});

describe("cashScenario: bills cost more or less", () => {
  const start = basis({
    cash: 1000,
    outflows: [
      bill("Harbor", 100, 2),
      bill("Euro Supplies", 50, 3, { foreign: true }),
      bill("Linh", 20, 4, { kind: "recurring", note: "recurring, not billed yet", id: "rec-1:2026-10-06" }),
      bill("Linh: Logo", 10, 0, { kind: "milestone", note: "verified", id: "m1" }),
    ],
  });

  it("changes every bill and recurring payment, never a milestone, agreed in USDC", () => {
    const result = cashScenario(start, levers({ costPct: 10 }));
    expect(result.outflows).toEqual({ base: 180, scenario: 197 });
    expect(result.costDelta).toBe(17);
    expect(result.days[4].scenario).toBe(803);
  });

  it("changes only the bills written in another currency when asked", () => {
    const result = cashScenario(start, levers({ costPct: 10, costScope: "foreign" }));
    expect(result.costDelta).toBe(5);
    expect(result.days[4].scenario).toBe(815);
  });

  it("takes a fall in costs too", () => {
    expect(cashScenario(start, levers({ costPct: -50 })).costDelta).toBe(-85);
  });

  it("holds each lever within its range", () => {
    const wild = cashScenario(start, levers({ costPct: 900, lateDays: 500 }));
    expect(wild.costDelta).toBe(170);
    const odd = cashScenario(basis({ receivables: [owed("Acme", 5, 0)] }), levers({ lateDays: -3, costPct: Number.NaN }));
    expect(odd.costDelta).toBe(0);
    expect(odd.days[0].scenario).toBe(105);
    const fractional = cashScenario(basis({ receivables: [owed("Acme", 5, 0)] }), levers({ lateDays: 2.7 }));
    expect(fractional.days[1].scenario).toBe(100);
    expect(fractional.days[2].scenario).toBe(105);
  });
});

describe("cashScenario: the cushion", () => {
  it("is 15% of what leaves in the 7 days from each day, and names the first day the balance falls below it", () => {
    const result = cashScenario(basis({ outflows: [bill("Harbor", 95, 10)] }), levers());
    expect(result.days[3].cushion).toBe(0);
    expect(result.days[4].cushion).toBe(14.25);
    expect(result.days[10].cushion).toBe(14.25);
    expect(result.days[11].cushion).toBe(0);
    expect(result.scenario).toMatchObject({ shortOn: null, belowCushionOn: ymd(10), lowest: { day: ymd(10), balance: 5 } });
    expect(result.affected).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it("counts a bill just past the horizon in the last days' cushion", () => {
    const result = cashScenario(basis({ outflows: [bill("Later", 40, 32)] }), levers());
    expect(result.days[29].cushion).toBe(6);
  });
});

describe("cashScenario: recomputed from the rows", () => {
  it("moves the short day when one due day moves", () => {
    const start = basis({ outflows: [bill("Harbor", 80, 6), bill("Atlas", 60, 10)], receivables: [owed("Acme", 70, 15)] });
    expect(cashScenario(start, levers()).scenario.shortOn).toBe(ymd(10));
    const moved = { ...start, outflows: [bill("Harbor", 80, 6), bill("Atlas", 60, 25)] };
    expect(cashScenario(moved, levers()).scenario.shortOn).toBe(ymd(25));
    expect(cashScenario(moved, levers({ lateDays: 0 })).scenario.shortOn).toBeNull();
  });
});

describe("cashScenario: advice, never an action", () => {
  const start = basis({
    outflows: [bill("Northwind", 60, 6, { note: "scheduled", dueDay: 25 }), bill("Harbor", 80, 12)],
    receivables: [owed("Acme", 70, 10)],
  });

  it("says how much the wallet would need by the short day, which scheduled bill could wait for its due day, and which receivable matters most", () => {
    const result = cashScenario(start, levers());
    expect(result.scenario.shortOn).toBe(ymd(12));
    expect(result.suggestions).toEqual([
      { kind: "need", amount: 40, by: ymd(12) },
      { kind: "pay_on_due", label: "Northwind", amount: 60, scheduledFor: ymd(6), dueOn: ymd(25) },
      { kind: "follow_up", label: "Acme", amount: 70, expected: ymd(10), arrives: ymd(24) },
    ]);
  });

  it("suggests nothing when the scenario never runs short, and no scheduled bill already past the short day", () => {
    expect(cashScenario(start, levers({ lateDays: 0 })).suggestions).toEqual([]);
    const after = cashScenario({ ...start, outflows: [bill("Northwind", 60, 14, { note: "scheduled", dueDay: 25 }), bill("Harbor", 120, 12)] }, levers());
    expect(after.scenario.shortOn).toBe(ymd(12));
    expect(after.suggestions.map((suggestion) => suggestion.kind)).toEqual(["need", "follow_up"]);
  });

  it("names a receivable that never arrives", () => {
    const result = cashScenario(start, levers({ choices: { "in-Acme": "never" } }));
    expect(result.suggestions.at(-1)).toEqual({ kind: "follow_up", label: "Acme", amount: 70, expected: ymd(10), arrives: null });
  });
});

describe("cashScenario: what moves it most", () => {
  it("names the three sources that pull the balance down most by the short day, grouped by counterparty", () => {
    const result = cashScenario(
      basis({
        cash: 800,
        outflows: [
          bill("Harbor", 200, 3),
          bill("Linh", 150, 5, { kind: "recurring", note: "recurring, not billed yet", id: "rec-1:2026-10-07" }),
          bill("Linh", 100, 8),
          bill("Small", 20, 9),
          bill("Atlas", 400, 25),
          bill("After", 500, 28),
        ],
        receivables: [owed("Acme", 300, 7)],
      }),
      levers({ lateDays: 30, costPct: 10 })
    );
    expect(result.scenario.shortOn).toBe(ymd(25));
    expect(result.driversOn).toBe(ymd(25));
    expect(result.drivers).toEqual([
      { kind: "payee", label: "Atlas", amount: 400, bills: 1, recurring: 0, milestones: 0 },
      { kind: "receivable", label: "Acme", amount: 300, count: 1, arrives: ymd(37), never: false },
      { kind: "payee", label: "Linh", amount: 250, bills: 1, recurring: 1, milestones: 0 },
    ]);
  });

  it("counts a rise in bill costs as one source", () => {
    const result = cashScenario(basis({ cash: 1100, outflows: [bill("Euro Supplies", 1000, 5, { foreign: true })] }), levers({ costPct: 50, costScope: "foreign" }));
    expect(result.drivers).toEqual([
      { kind: "payee", label: "Euro Supplies", amount: 1000, bills: 1, recurring: 0, milestones: 0 },
      { kind: "costs", amount: 500, pct: 50, scope: "foreign" },
    ]);
  });

  it("measures on the lowest day when the scenario never runs short", () => {
    const result = cashScenario(basis({ cash: 500, outflows: [bill("Harbor", 100, 3), bill("Atlas", 50, 6)], receivables: [owed("Acme", 300, 20)] }), levers({ lateDays: 0 }));
    expect(result.driversOn).toBe(ymd(6));
    expect(result.drivers.map((driver) => driver.kind === "costs" ? "costs" : driver.label)).toEqual(["Harbor", "Atlas"]);
  });

  it("groups a contractor's milestones with its bills, under the contractor's name", () => {
    const result = cashScenario(
      basis({
        cash: 500,
        outflows: [
          bill("Linh: Logo", 100, 0, { kind: "milestone", note: "verified", id: "m1", payee: "Linh" }),
          bill("Linh: Icons", 80, 0, { kind: "milestone", note: "payable once verified", id: "m2", payee: "Linh" }),
          bill("Linh", 90, 4),
          bill("Harbor", 200, 5),
        ],
      }),
      levers({ lateDays: 0 })
    );
    expect(result.drivers).toEqual([
      { kind: "payee", label: "Linh", amount: 270, bills: 1, recurring: 0, milestones: 2 },
      { kind: "payee", label: "Harbor", amount: 200, bills: 1, recurring: 0, milestones: 0 },
    ]);
  });

  it("is empty when nothing leaves", () => {
    expect(cashScenario(basis(), levers()).drivers).toEqual([]);
  });
});

describe("cashScenario: what it is built from", () => {
  const start = basis({
    outflows: [
      bill("A", 10, 3),
      bill("B", 20, 20),
      bill("C", 30, 50),
      bill("R", 5, 10, { kind: "recurring", note: "recurring, not billed yet", id: "rec-1:2026-10-12" }),
      bill("R", 5, 40, { kind: "recurring", note: "recurring, not billed yet", id: "rec-1:2026-11-11" }),
      bill("Linh: Logo", 7, 0, { kind: "milestone", note: "payable once verified", id: "m1" }),
    ],
    receivables: [owed("X", 100, 5, { client: "cx" }), owed("Y", 50, 45, { client: "cy" }), owed("Z", 60, 70, { client: "cx" })],
    clients: { cx: { paidOnTime: 2, paidLate: 1, averageDaysLate: 6 } },
    eurc: [
      { kind: "bill", amount: 9, day: 12 },
      { kind: "receivable", amount: 4, day: 80 },
    ],
  });

  it("counts bills, recurring payments, milestones and receivables within the horizon, and how far bills are known", () => {
    expect(cashScenario(start, levers({ horizon: 30 })).coverage).toEqual({
      horizon: 30,
      bills: { count: 2, amount: 30, lastDay: ymd(20) },
      recurring: { count: 1, amount: 5, schedules: 1, read: true },
      milestones: { count: 1, amount: 7 },
      receivables: { count: 1, amount: 100, withRecord: 1 },
      records: [{ label: "X", paidOnTime: 2, paidLate: 1, averageDaysLate: 6 }],
      eurc: { bills: { count: 1, amount: 9 }, receivables: { count: 0, amount: 0 } },
      billsKnownDays: 21,
    });
    expect(cashScenario(start, levers({ horizon: 90 })).coverage).toMatchObject({
      bills: { count: 3, amount: 60, lastDay: ymd(50) },
      recurring: { count: 2, amount: 10, schedules: 1 },
      receivables: { count: 3, amount: 210, withRecord: 2 },
      records: [{ label: "X", paidOnTime: 2, paidLate: 1, averageDaysLate: 6 }],
      eurc: { bills: { count: 1, amount: 9 }, receivables: { count: 1, amount: 4 } },
      billsKnownDays: 51,
    });
  });

  it("says when no bill is known, and when recurring payments could not be read", () => {
    const coverage = cashScenario(basis({ recurringRead: false }), levers()).coverage;
    expect(coverage).toMatchObject({ bills: { count: 0, amount: 0, lastDay: null }, billsKnownDays: 0, recurring: { read: false } });
  });
});

describe("the default levers", () => {
  it("look 60 days ahead with every client 14 days late and bill costs unchanged", () => {
    expect(DEFAULT_LEVERS).toEqual({ horizon: 60, lateDays: 14, choices: {}, costPct: 0, costScope: "all" });
  });
});
