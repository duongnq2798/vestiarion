import type { OutlookItem } from "./cash-outlook";

/**
 * Cash scenarios (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md): from what Treasury already counts
 * (`scenarioBasis`), the balance every day over 30, 60 or 90 days, as it stands and with the levers a person sets:
 * clients paying late, a receivable that never arrives, bills costing more or less. Then the first short day, the bills
 * it touches, advice in words, the three sources that move it most, and what the figure is built from.
 *
 * Three buckets stay apart (C3): cash (the wallet and the USYC reserve), receivables (invoiced, counted only on the day
 * they arrive in that case) and a pipeline of deals not invoiced, which this version does not count. Pure, and run in
 * the browser: nothing here is saved, signed, or read by the agent, a payment or a guardrail (C9).
 */

export type Horizon = 30 | 60 | 90;
export const HORIZONS: readonly Horizon[] = [30, 60, 90];

export type OutflowNote = Exclude<OutlookItem["note"], "expected"> | "recurring, not billed yet";

/** Money leaving, on its day. */
export interface BasisOutflow {
  id: string;
  kind: "bill" | "milestone" | "recurring";
  /** Who is paid: a bill's or a recurring payment's counterparty, or "contractor: milestone". */
  label: string;
  amount: number;
  /** Days from today: 0 is today, an overdue bill and an open milestone included. */
  day: number;
  note: OutflowNote;
  /** Written in another currency, its USDC amount worked out at a rate: the narrower scope of the cost lever. */
  foreign: boolean;
  /** A scheduled bill's own due day, in days from today, when it is later than the day it is scheduled for. */
  dueDay?: number;
}

/** An open USDC receivable, on the day it is due (an overdue one today). */
export interface BasisReceivable {
  id: string;
  label: string;
  amount: number;
  day: number;
  overdue: boolean;
  /** The client's counterparty id, whose record `clients` holds. */
  client: string | null;
}

/** How a client paid its earlier receivables: counts and an average, never a likelihood. */
export interface ClientRecord {
  paidOnTime: number;
  paidLate: number;
  averageDaysLate: number | null;
}

export interface ScenarioBasis {
  /** Today, the UTC day the rows were read on. */
  today: string;
  /** The operating wallet's USDC. */
  cash: number;
  /** The USYC reserve's value in USDC, back in the wallet within seconds. */
  reserve: number;
  /** Within 90 days. */
  outflows: BasisOutflow[];
  receivables: BasisReceivable[];
  clients: Record<string, ClientRecord>;
  /** EURC moving within 90 days, each on its day: never in a USDC figure. */
  eurc: Array<{ kind: "bill" | "receivable"; amount: number; day: number }>;
  /** False when the recurring payments could not be read: none is projected. */
  recurringRead: boolean;
}

export type ReceivableChoice = "late" | "on_time" | "never";

export interface ScenarioLevers {
  horizon: Horizon;
  /** Days late, 0 to 90. */
  lateDays: number;
  /** Each receivable's choice, by id; one not listed is late. */
  choices: Record<string, ReceivableChoice>;
  /** A change in what bills cost, in percent: from −50 to 100. */
  costPct: number;
  costScope: "all" | "foreign";
}

export const DEFAULT_LEVERS: ScenarioLevers = { horizon: 60, lateDays: 14, choices: {}, costPct: 0, costScope: "all" };
export const MAX_LATE_DAYS = 90;
export const COST_RANGE = { min: -50, max: 100 } as const;

export interface ScenarioDay {
  /** A UTC day, YYYY-MM-DD. */
  day: string;
  /** The balance after the day, as things stand: cash, less what left, plus receivables arrived on their due days. */
  base: number;
  /** The same in the scenario. */
  scenario: number;
  /** The cushion the treasury keeps on that day in the scenario: 15% of what leaves in the 7 days from it. */
  cushion: number;
}

export interface CaseSummary {
  /** The first day the balance is below zero. */
  shortOn: string | null;
  /** The first day the balance is below the cushion. */
  belowCushionOn: string | null;
  lowest: { day: string; balance: number };
  /** The balance on the horizon's last day. */
  end: number;
}

/** A receivable the scenario makes late or drops. */
export interface MovedReceivable {
  id: string;
  label: string;
  amount: number;
  /** The day it is expected as things stand. */
  expected: string;
  /** The day it arrives in the scenario; null when it never does. */
  arrives: string | null;
  /** It arrives after the horizon. */
  outside: boolean;
}

export interface AffectedBill {
  id: string;
  label: string;
  amount: number;
  day: string;
  kind: BasisOutflow["kind"];
  note: OutflowNote;
}

/** Advice, said in words (C7): never an action. */
export type Suggestion =
  | { kind: "need"; amount: number; by: string }
  | { kind: "pay_on_due"; label: string; amount: number; scheduledFor: string; dueOn: string }
  | { kind: "follow_up"; label: string; amount: number; expected: string; arrives: string | null };

export type Driver =
  | { kind: "payee"; label: string; amount: number; bills: number; recurring: number; milestones: number }
  | { kind: "receivable"; label: string; amount: number; count: number; arrives: string | null; never: boolean }
  | { kind: "costs"; amount: number; pct: number; scope: ScenarioLevers["costScope"] };

export interface Coverage {
  horizon: Horizon;
  bills: { count: number; amount: number; lastDay: string | null };
  recurring: { count: number; amount: number; schedules: number; read: boolean };
  milestones: { count: number; amount: number };
  receivables: { count: number; amount: number; withRecord: number };
  /** The record of each client with a receivable in the horizon that has one. */
  records: Array<{ label: string } & ClientRecord>;
  eurc: { bills: { count: number; amount: number }; receivables: { count: number; amount: number } };
  /** From today to the latest bill's day, counted in days; 0 with no bill. */
  billsKnownDays: number;
}

export interface ScenarioResult {
  horizon: Horizon;
  today: string;
  lastDay: string;
  cash: number;
  reserve: number;
  /** Receivables arriving within the horizon: on their due days, and as the scenario times them. */
  receivables: { base: number; scenario: number };
  /** What leaves within the horizon, in each case. */
  outflows: { base: number; scenario: number };
  /** The scenario's outflows less the base case's: the cost lever's effect. */
  costDelta: number;
  days: ScenarioDay[];
  base: CaseSummary;
  scenario: CaseSummary;
  moved: MovedReceivable[];
  /** Bills, recurring payments and milestones leaving on a day the scenario's balance is below zero. */
  affected: AffectedBill[];
  /** What the scenario lacks at its lowest; 0 when it never runs short. */
  shortfall: number;
  suggestions: Suggestion[];
  /** The day the drivers are measured on: the scenario's short day, or its lowest. */
  driversOn: string;
  drivers: Driver[];
  coverage: Coverage;
}

const DAY_MS = 86_400_000;
const CUSHION = 0.15;
const CUSHION_DAYS = 7;

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, min: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0);

/** The receivables expected within a horizon, as things stand: the ones whose choice a person can set. */
export function receivablesIn(basis: ScenarioBasis, horizon: Horizon): BasisReceivable[] {
  return basis.receivables.filter((receivable) => receivable.day < horizon);
}

export function cashScenario(basis: ScenarioBasis, levers: ScenarioLevers): ScenarioResult {
  const horizon: Horizon = HORIZONS.includes(levers.horizon) ? levers.horizon : DEFAULT_LEVERS.horizon;
  const lateDays = Math.floor(clamp(levers.lateDays, 0, MAX_LATE_DAYS));
  const costPct = clamp(levers.costPct, COST_RANGE.min, COST_RANGE.max);
  const start = Date.parse(`${basis.today}T00:00:00Z`);
  const dayOf = (offset: number) => new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
  const available = basis.cash + basis.reserve;

  // The cost lever: every bill and recurring payment, or only those written in another currency; never a milestone.
  const changed = (outflow: BasisOutflow) => costPct !== 0 && outflow.kind !== "milestone" && (levers.costScope === "all" || outflow.foreign);
  const scenarioAmount = (outflow: BasisOutflow) => (changed(outflow) ? round(outflow.amount * (1 + costPct / 100)) : outflow.amount);
  // When a receivable arrives in the scenario: late from its day (today for one overdue), or never.
  const arrival = (receivable: BasisReceivable): number | null => {
    const choice = levers.choices[receivable.id] ?? "late";
    if (choice === "never") return null;
    return choice === "on_time" ? receivable.day : receivable.day + lateDays;
  };

  const inHorizon = basis.outflows.filter((outflow) => outflow.day < horizon);
  const expected = receivablesIn(basis, horizon);

  // Each day's movements, in each case.
  const baseOut = new Array<number>(horizon).fill(0);
  const scenarioOut = new Array<number>(horizon).fill(0);
  for (const outflow of inHorizon) {
    baseOut[outflow.day] += outflow.amount;
    scenarioOut[outflow.day] += scenarioAmount(outflow);
  }
  const baseIn = new Array<number>(horizon).fill(0);
  const scenarioIn = new Array<number>(horizon).fill(0);
  for (const receivable of expected) {
    baseIn[receivable.day] += receivable.amount;
    const arrives = arrival(receivable);
    if (arrives !== null && arrives < horizon) scenarioIn[arrives] += receivable.amount;
  }
  // The cushion on a day: 15% of what leaves in the 7 days from it, past the horizon included where it is known.
  const leaving = (day: number, amountOf: (outflow: BasisOutflow) => number) =>
    basis.outflows.filter((outflow) => outflow.day >= day && outflow.day < day + CUSHION_DAYS).reduce((sum, outflow) => sum + amountOf(outflow), 0);

  let base = available;
  let scenario = available;
  const days: ScenarioDay[] = [];
  const baseCushions: number[] = [];
  for (let day = 0; day < horizon; day += 1) {
    base += baseIn[day] - baseOut[day];
    scenario += scenarioIn[day] - scenarioOut[day];
    baseCushions.push(round(leaving(day, (outflow) => outflow.amount) * CUSHION));
    days.push({ day: dayOf(day), base: round(base), scenario: round(scenario), cushion: round(leaving(day, scenarioAmount) * CUSHION) });
  }

  const summary = (balanceOf: (day: ScenarioDay) => number, cushionOf: (index: number) => number): CaseSummary => {
    let lowest = { day: days[0].day, balance: balanceOf(days[0]) };
    let shortOn: string | null = null;
    let belowCushionOn: string | null = null;
    for (let index = 0; index < days.length; index += 1) {
      const balance = balanceOf(days[index]);
      if (balance < lowest.balance) lowest = { day: days[index].day, balance };
      if (shortOn === null && balance < 0) shortOn = days[index].day;
      if (belowCushionOn === null && balance < cushionOf(index)) belowCushionOn = days[index].day;
    }
    return { shortOn, belowCushionOn, lowest, end: balanceOf(days[days.length - 1]) };
  };
  const baseCase = summary((day) => day.base, (index) => baseCushions[index]);
  const scenarioCase = summary((day) => day.scenario, (index) => days[index].cushion);

  const moved: MovedReceivable[] = expected.flatMap((receivable) => {
    const arrives = arrival(receivable);
    if (arrives === receivable.day) return [];
    return [{ id: receivable.id, label: receivable.label, amount: receivable.amount, expected: dayOf(receivable.day), arrives: arrives === null ? null : dayOf(arrives), outside: arrives !== null && arrives >= horizon }];
  });

  const affected: AffectedBill[] = inHorizon
    .filter((outflow) => days[outflow.day].scenario < 0)
    .sort((a, b) => a.day - b.day)
    .map((outflow) => ({ id: outflow.id, label: outflow.label, amount: scenarioAmount(outflow), day: dayOf(outflow.day), kind: outflow.kind, note: outflow.note }));
  const shortfall = scenarioCase.shortOn ? round(-scenarioCase.lowest.balance) : 0;

  const offsetOf = (day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - start) / DAY_MS);
  // A receivable that would have arrived by `day` as things stand, but not in the scenario.
  const missedBy = (day: number) =>
    expected.filter((receivable) => {
      const arrives = arrival(receivable);
      return receivable.day <= day && (arrives === null || arrives > day);
    });

  const suggestions: Suggestion[] = [];
  if (scenarioCase.shortOn) {
    const short = offsetOf(scenarioCase.shortOn);
    suggestions.push({ kind: "need", amount: shortfall, by: scenarioCase.shortOn });
    const early = inHorizon
      .filter((outflow) => outflow.note === "scheduled" && outflow.dueDay !== undefined && outflow.day <= short && outflow.dueDay > short)
      .sort((a, b) => scenarioAmount(b) - scenarioAmount(a))[0];
    if (early?.dueDay !== undefined) {
      suggestions.push({ kind: "pay_on_due", label: early.label, amount: scenarioAmount(early), scheduledFor: dayOf(early.day), dueOn: dayOf(early.dueDay) });
    }
    const matters = missedBy(short).sort((a, b) => b.amount - a.amount)[0];
    if (matters) {
      const arrives = arrival(matters);
      suggestions.push({ kind: "follow_up", label: matters.label, amount: matters.amount, expected: dayOf(matters.day), arrives: arrives === null ? null : dayOf(arrives) });
    }
  }

  // What moves it most (C8): on the short day, or the lowest, the sources that pull the balance down most.
  const driversOn = scenarioCase.shortOn ?? scenarioCase.lowest.day;
  const on = offsetOf(driversOn);
  const payees = new Map<string, Extract<Driver, { kind: "payee" }>>();
  let costs = 0;
  for (const outflow of inHorizon.filter((candidate) => candidate.day <= on)) {
    const payee = payees.get(outflow.label) ?? { kind: "payee", label: outflow.label, amount: 0, bills: 0, recurring: 0, milestones: 0 };
    payee.amount = round(payee.amount + outflow.amount);
    if (outflow.kind === "bill") payee.bills += 1;
    else if (outflow.kind === "recurring") payee.recurring += 1;
    else payee.milestones += 1;
    payees.set(outflow.label, payee);
    costs += scenarioAmount(outflow) - outflow.amount;
  }
  const late = new Map<string, Extract<Driver, { kind: "receivable" }>>();
  for (const receivable of missedBy(on)) {
    const arrives = arrival(receivable);
    const known = late.get(receivable.label);
    late.set(
      receivable.label,
      known
        ? { ...known, amount: round(known.amount + receivable.amount), count: known.count + 1, arrives: null, never: known.never && arrives === null }
        : { kind: "receivable", label: receivable.label, amount: receivable.amount, count: 1, arrives: arrives === null ? null : dayOf(arrives), never: arrives === null }
    );
  }
  const sources: Driver[] = [...payees.values(), ...late.values(), ...(round(costs) > 0 ? [{ kind: "costs" as const, amount: round(costs), pct: costPct, scope: levers.costScope }] : [])];
  const drivers = sources
    .filter((source) => source.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.kind === "costs" ? 1 : b.kind === "costs" ? -1 : a.label.localeCompare(b.label)))
    .slice(0, 3);

  const sum = (rows: Array<{ amount: number }>) => round(rows.reduce((total, row) => total + row.amount, 0));
  const bills = inHorizon.filter((outflow) => outflow.kind === "bill");
  const recurring = inHorizon.filter((outflow) => outflow.kind === "recurring");
  const milestones = inHorizon.filter((outflow) => outflow.kind === "milestone");
  const lastBill = bills.reduce<number | null>((latest, outflow) => (latest === null || outflow.day > latest ? outflow.day : latest), null);
  // Each client once, under the name on its first receivable here.
  const recorded = new Map<string, Coverage["records"][number]>();
  for (const receivable of expected) {
    const record = receivable.client ? basis.clients[receivable.client] : undefined;
    if (record && receivable.client && !recorded.has(receivable.client)) recorded.set(receivable.client, { label: receivable.label, ...record });
  }
  const records = [...recorded.values()];
  const eurcIn = basis.eurc.filter((move) => move.day < horizon);

  return {
    horizon,
    today: basis.today,
    lastDay: dayOf(horizon - 1),
    cash: basis.cash,
    reserve: basis.reserve,
    receivables: { base: sum(expected), scenario: round(scenarioIn.reduce((total, amount) => total + amount, 0)) },
    outflows: { base: sum(inHorizon), scenario: round(scenarioOut.reduce((total, amount) => total + amount, 0)) },
    costDelta: round(scenarioOut.reduce((total, amount) => total + amount, 0) - inHorizon.reduce((total, outflow) => total + outflow.amount, 0)),
    days,
    base: baseCase,
    scenario: scenarioCase,
    moved,
    affected,
    shortfall,
    suggestions,
    driversOn,
    drivers,
    coverage: {
      horizon,
      bills: { count: bills.length, amount: sum(bills), lastDay: lastBill === null ? null : dayOf(lastBill) },
      recurring: { count: recurring.length, amount: sum(recurring), schedules: new Set(recurring.map((outflow) => outflow.id.split(":")[0])).size, read: basis.recurringRead },
      milestones: { count: milestones.length, amount: sum(milestones) },
      receivables: { count: expected.length, amount: sum(expected), withRecord: expected.filter((receivable) => receivable.client && basis.clients[receivable.client]).length },
      records,
      eurc: {
        bills: { count: eurcIn.filter((move) => move.kind === "bill").length, amount: sum(eurcIn.filter((move) => move.kind === "bill")) },
        receivables: { count: eurcIn.filter((move) => move.kind === "receivable").length, amount: sum(eurcIn.filter((move) => move.kind === "receivable")) },
      },
      billsKnownDays: lastBill === null ? 0 : lastBill + 1,
    },
  };
}
