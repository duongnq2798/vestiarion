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
      // Paid on day 25, Northwind's 60 covers Harbor on day 12, and Acme is back by day 25: never short.
      { kind: "pay_on_due", label: "Northwind", amount: 60, scheduledFor: ymd(6), dueOn: ymd(25), shortOn: null, shortfall: 0 },
      { kind: "follow_up", label: "Acme", amount: 70, expected: ymd(10), arrives: ymd(24) },
    ]);
  });

  // The guide's studio: paying Northwind Cloud on its due day only moves its 860 to a day that is short anyway.
  const studio = (northwindDue: number) =>
    basis({
      cash: 1840.5,
      reserve: 3200,
      outflows: [
        bill("Minh Pham: Landing page", 600, 0, { kind: "milestone", note: "verified", id: "m-landing" }),
        bill("Linh Design", 1500, 3, { kind: "recurring", note: "recurring, not billed yet", id: "rec-linh:1" }),
        bill("Northwind Cloud", 860, 5, { note: "scheduled", dueDay: northwindDue }),
        bill("Atlas Compute", 1240, 8),
        bill("Harbor Print", 2150, 18),
        bill("Kestrel Legal", 950, 27, { foreign: true }),
        bill("Linh Design", 1500, 34, { kind: "recurring", note: "recurring, not billed yet", id: "rec-linh:2" }),
      ],
      receivables: [owed("Acme Studio", 3400, 9), owed("Beacon Labs", 1800, 16)],
    });

  it("suggests paying a scheduled bill on its due day only when that moves the short day or shrinks the gap", () => {
    const unchanged = cashScenario(studio(20), levers({ horizon: 60 }));
    expect(unchanged.scenario.shortOn).toBe(ymd(18));
    expect(unchanged.shortfall).toBe(1309.5);
    // On day 20 the 860 leaves anyway, before Acme Studio's 3,400 arrives on day 23: the lowest is still 1,309.50 short.
    expect(unchanged.suggestions.map((suggestion) => suggestion.kind)).toEqual(["need", "follow_up"]);
    const helps = cashScenario(studio(25), levers({ horizon: 60 }));
    expect(helps.suggestions).toContainEqual({
      kind: "pay_on_due", label: "Northwind Cloud", amount: 860, scheduledFor: ymd(5), dueOn: ymd(25), shortOn: ymd(18), shortfall: 449.5,
    });
  });

  it("picks the scheduled bill whose move helps most, not the largest", () => {
    const result = cashScenario(
      basis({
        cash: 200,
        outflows: [
          bill("Big", 100, 2, { note: "scheduled", dueDay: 12 }),
          bill("Small", 80, 3, { note: "scheduled", dueDay: 25 }),
          bill("Harbor", 120, 10),
        ],
        receivables: [owed("Acme", 300, 5)],
      }),
      levers()
    );
    expect(result.scenario.shortOn).toBe(ymd(10));
    expect(result.shortfall).toBe(100);
    // Big on day 12 only moves the same 100 short two days on; Small on day 25 leaves 20 short.
    expect(result.suggestions).toContainEqual({ kind: "pay_on_due", label: "Small", amount: 80, scheduledFor: ymd(3), dueOn: ymd(25), shortOn: ymd(10), shortfall: 20 });
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
      // Due day 7, 30 days late: day 37, after the 30 days.
      { kind: "receivable", key: "client-Acme", label: "Acme", amount: 300, count: 1, never: 0, outside: 1, arrivesBy: null },
      { kind: "payee", label: "Linh", amount: 250, bills: 1, recurring: 1, milestones: 0 },
    ]);
  });

  it("groups a client's receivables under the client, and keeps when each of them arrives", () => {
    const start = basis({
      outflows: [bill("Harbor", 150, 10)],
      receivables: [owed("Acme", 30, 3, { id: "a1", client: "c-acme" }), owed("Acme", 30, 5, { id: "a2", client: "c-acme" })],
    });
    const late = cashScenario(start, levers({ horizon: 60 }));
    expect(late.scenario.shortOn).toBe(ymd(10));
    // Both arrive inside the 60 days, on days 17 and 19: by the later one.
    expect(late.drivers).toContainEqual({ kind: "receivable", key: "c-acme", label: "Acme", amount: 60, count: 2, never: 0, outside: 0, arrivesBy: ymd(19) });
    const mixed = cashScenario(start, levers({ horizon: 60, choices: { a1: "never" } }));
    expect(mixed.drivers).toContainEqual({ kind: "receivable", key: "c-acme", label: "Acme", amount: 60, count: 2, never: 1, outside: 0, arrivesBy: ymd(19) });
    // Day 3 + 26 is day 29, inside the 30 days; day 5 + 26 is day 31, after them.
    const outside = cashScenario(start, levers({ horizon: 30, lateDays: 26 }));
    expect(outside.drivers).toContainEqual({ kind: "receivable", key: "c-acme", label: "Acme", amount: 60, count: 2, never: 0, outside: 1, arrivesBy: ymd(29) });
  });

  it("keeps two clients with the same name apart, and each receivable with no client on its own", () => {
    const start = basis({
      outflows: [bill("Harbor", 400, 10)],
      receivables: [
        owed("Acme", 100, 3, { id: "a1", client: "c-one" }),
        owed("Acme", 90, 4, { id: "a2", client: "c-two" }),
        owed("Walk-in", 80, 5, { id: "w1", client: null }),
        owed("Walk-in", 70, 6, { id: "w2", client: null }),
      ],
    });
    const receivableDrivers = (result: ReturnType<typeof cashScenario>) =>
      result.drivers.flatMap((driver) => (driver.kind === "receivable" ? [[driver.key, driver.label, driver.amount, driver.count]] : []));
    expect(receivableDrivers(cashScenario(start, levers()))).toEqual([
      ["c-one", "Acme", 100, 1],
      ["c-two", "Acme", 90, 1],
    ]);
    expect(receivableDrivers(cashScenario({ ...start, receivables: start.receivables.slice(2) }, levers()))).toEqual([
      ["w1", "Walk-in", 80, 1],
      ["w2", "Walk-in", 70, 1],
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
    expect(result.drivers.map((driver) => driver.kind === "costs" || driver.kind === "rates" ? driver.kind : driver.label)).toEqual(["Harbor", "Atlas"]);
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

  it("counts bills, recurring payments, milestones and receivables within the horizon, and the weeks with a bill on record", () => {
    expect(cashScenario(start, levers({ horizon: 30 })).coverage).toEqual({
      horizon: 30,
      bills: { count: 2, amount: 30, lastDay: ymd(20) },
      recurring: { count: 1, amount: 5, schedules: 1, read: true },
      milestones: { count: 1, amount: 7 },
      receivables: { count: 1, amount: 100, withRecord: 1 },
      records: [{ label: "X", paidOnTime: 2, paidLate: 1, averageDaysLate: 6 }],
      eurc: { bills: { count: 1, amount: 9 }, receivables: { count: 0, amount: 0 } },
      // Weeks from today: days 0-6, 7-13, 14-20, 21-27 and 28-29. A, R and B fall in the first three.
      weeks: { total: 5, withBills: 3 },
      // No deal lines here.
      planned: { count: 0, amount: 0, other: [], read: true },
    });
    expect(cashScenario(start, levers({ horizon: 90 })).coverage).toMatchObject({
      bills: { count: 3, amount: 60, lastDay: ymd(50) },
      recurring: { count: 2, amount: 10, schedules: 1 },
      receivables: { count: 3, amount: 210, withRecord: 2 },
      records: [{ label: "X", paidOnTime: 2, paidLate: 1, averageDaysLate: 6 }],
      eurc: { bills: { count: 1, amount: 9 }, receivables: { count: 1, amount: 4 } },
      weeks: { total: 13, withBills: 5 },
    });
  });

  it("is not filled by one far bill or an overdue one, and gives a scheduled bill's due day as its latest", () => {
    // An overdue bill and a held one past its due day were due before today: they leave today but fill no week.
    const sparse = cashScenario(
      basis({ outflows: [bill("Late", 40, 0, { note: "overdue", overdue: true }), bill("Held", 30, 0, { note: "held", overdue: true }), bill("Insurance", 900, 89)] }),
      levers({ horizon: 90 })
    ).coverage;
    expect(sparse.weeks).toEqual({ total: 13, withBills: 1 });
    // A bill due this week fills it.
    expect(cashScenario(basis({ outflows: [bill("Soon", 10, 2)] }), levers()).coverage.weeks).toEqual({ total: 5, withBills: 1 });
    expect(sparse.bills.lastDay).toBe(ymd(89));
    const scheduled = cashScenario(basis({ outflows: [bill("Harbor", 10, 3), bill("Northwind", 50, 5, { note: "scheduled", dueDay: 20 })] }), levers()).coverage;
    expect(scheduled.bills.lastDay).toBe(ymd(20));
    // The week it leaves in is the scheduled day's.
    expect(scheduled.weeks).toEqual({ total: 5, withBills: 1 });
  });

  it("says when no bill is known, and when recurring payments could not be read", () => {
    const coverage = cashScenario(basis({ recurringRead: false }), levers()).coverage;
    expect(coverage).toMatchObject({ bills: { count: 0, amount: 0, lastDay: null }, weeks: { total: 5, withBills: 0 }, recurring: { read: false } });
  });
});

describe("the default levers", () => {
  it("look 60 days ahead with every client 14 days late and bill costs unchanged", () => {
    expect(DEFAULT_LEVERS).toEqual({ horizon: 60, lateDays: 14, choices: {}, costPct: 0, costScope: "all" });
  });
});

describe("deal lines not invoiced yet (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D14)", () => {
  it("are in what the figure is built from, within the horizon, and in no balance", () => {
    const withPlanned = basis({
      outflows: [bill("Rent", 80, 5)],
      planned: [
        { id: "p1", label: "Acme Studio: Website rebuild", line: "Balance", amount: 700, currency: "USDC", day: 10 },
        { id: "p2", label: "Acme Studio: Website rebuild", line: "Later", amount: 300, currency: "USDC", day: 45 },
        { id: "p3", label: "Kobe Ltd: Retainer", line: "March", amount: 100_000, currency: "JPY", day: 12 },
      ],
      plannedRead: true,
    });
    const result = cashScenario(withPlanned, levers({ horizon: 30 }));
    const without = cashScenario(basis({ outflows: [bill("Rent", 80, 5)] }), levers({ horizon: 30 }));
    expect(result.days).toEqual(without.days);
    expect(result.coverage.planned).toEqual({ count: 1, amount: 700, other: [{ currency: "JPY", amount: 100_000, count: 1 }], read: true });
    expect(cashScenario(withPlanned, levers({ horizon: 60 })).coverage.planned).toMatchObject({ count: 2, amount: 1000 });
  });

  it("is none for a basis without deals", () => {
    expect(cashScenario(basis(), levers()).coverage.planned).toEqual({ count: 0, amount: 0, other: [], read: true });
  });
});
