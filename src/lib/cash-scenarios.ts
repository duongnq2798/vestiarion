import type { OutlookItem } from "./cash-outlook";
import { convertMoney, numberOf, pegRate, rateValue, roundedMoney } from "./money";

/**
 * Cash scenarios (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md): from what Treasury already counts
 * (`scenarioBasis`), the balance every day over 30, 60 or 90 days: in the base case, with every client paying on its due
 * day (an assumption, said so on screen), and with the levers a person sets: clients paying late, a receivable that never
 * arrives, bills costing more or less. Then the first short day, the bills it touches, advice in words, the three
 * sources that move it most, and what the figure is built from.
 *
 * Three buckets stay apart (C3): cash (the wallet and the USYC reserve), receivables (invoiced, counted only on the day
 * they arrive in that case) and deal lines not invoiced yet, which the coverage names and no balance counts
 * (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D14). Pure, and run in
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
  /** A milestone's contractor: what moves it most groups by it, beside the contractor's bills. */
  payee?: string;
  amount: number;
  /** Days from today: 0 is today, an overdue bill and an open milestone included. */
  day: number;
  note: OutflowNote;
  /** Written in another currency, its USDC amount worked out at a rate: the narrower scope of the cost lever. */
  foreign: boolean;
  /**
   * Such a bill as written and the rate it was converted at (how many of its currency made one US dollar), as decimal
   * strings: a rate typed for its currency values it again from these (currency provenance M7).
   */
  original?: { currency: string; amount: string; perUsd: string };
  /** A scheduled bill's own due day, in days from today, when it is later than the day it is scheduled for. */
  dueDay?: number;
  /**
   * Its own due day was before today, whatever its note (a held bill, a scheduled one, a recurring period already due):
   * it leaves today, and tells nothing about the bills of the days ahead, so it fills no week of coverage.
   */
  overdue?: true;
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
  /**
   * Deal lines not invoiced yet, within 90 days, on their due day (docs/superpowers/specs/2026-10-12-deal-schedule-design.md
   * D14): what the figure is built from names them, and no balance counts them. Absent where deals are not read.
   */
  planned?: PlannedBasis[];
  /** False when the deal lines could not be read. */
  plannedRead?: boolean;
}

/** A deal's line not invoiced yet, in its deal's currency, on its due day in days from today. */
export interface PlannedBasis {
  id: string;
  label: string;
  line: string;
  amount: number;
  currency: string;
  day: number;
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
  /**
   * A rate per currency, how many of it make one US dollar, as typed: each open bill written in that currency is valued
   * at it (its own amount divided by the rate, to the cent) instead of the rate it was converted at. A currency not
   * listed, or a rate that does not read, keeps each bill at its own conversion (currency provenance M7).
   */
  rates?: Record<string, string>;
}

/** What a typed rate did to the bills of its currency within the horizon. */
export interface RateEffect {
  currency: string;
  /** The rate as read, how many of the currency make one US dollar. */
  perUsd: string;
  bills: number;
  /** What those bills come to at the rates they were converted at, and at the typed rate, in USDC. */
  converted: number;
  atRate: number;
}

export const DEFAULT_LEVERS: ScenarioLevers = { horizon: 60, lateDays: 14, choices: {}, costPct: 0, costScope: "all" };
export const MAX_LATE_DAYS = 90;
export const COST_RANGE = { min: -50, max: 100 } as const;

export interface ScenarioDay {
  /** A UTC day, YYYY-MM-DD. */
  day: string;
  /** The balance after the day, if clients pay on time (the base case): cash, less what left, plus receivables arrived on their due days. */
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
  /** The day it is expected if clients pay on time: its due day, or today when overdue. */
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
  | {
      kind: "pay_on_due";
      label: string;
      amount: number;
      scheduledFor: string;
      dueOn: string;
      /** The scenario worked out again with the bill paid on its due day: its first short day (null when none)… */
      shortOn: string | null;
      /** …and what it then lacks at its lowest. One of the two is always better than the scenario's own. */
      shortfall: number;
    }
  | { kind: "follow_up"; label: string; amount: number; expected: string; arrives: string | null };

export type Driver =
  | { kind: "payee"; label: string; amount: number; bills: number; recurring: number; milestones: number }
  | {
      kind: "receivable";
      /** The client's counterparty id, or the receivable's own id when it has no client: two clients sharing a name stay apart. */
      key: string;
      label: string;
      amount: number;
      count: number;
      /** How many of them never arrive, and how many arrive after the horizon. */
      never: number;
      outside: number;
      /** The latest day one of the rest arrives, within the horizon; null when none does. */
      arrivesBy: string | null;
    }
  | { kind: "costs"; amount: number; pct: number; scope: ScenarioLevers["costScope"] }
  /** Bills written in another currency, valued at the rates typed for it. */
  | { kind: "rates"; amount: number; currencies: string[] };

export interface Coverage {
  horizon: Horizon;
  /** `lastDay` is the latest due day: a scheduled bill's own due day, not the earlier day it is scheduled for. */
  bills: { count: number; amount: number; lastDay: string | null };
  recurring: { count: number; amount: number; schedules: number; read: boolean };
  milestones: { count: number; amount: number };
  receivables: { count: number; amount: number; withRecord: number };
  /** The record of each client with a receivable in the horizon that has one. */
  records: Array<{ label: string } & ClientRecord>;
  eurc: { bills: { count: number; amount: number }; receivables: { count: number; amount: number } };
  /** Deal lines not invoiced yet, due within the horizon: USDC, and other currencies apart; never in a balance. */
  planned: { count: number; amount: number; other: Array<{ currency: string; amount: number; count: number }>; read: boolean };
  /**
   * The horizon in weeks from today (the last one may be short), and in how many a bill or recurring payment leaves:
   * one far bill fills one week, not the horizon. An overdue bill is due before today, so it fills none.
   */
  weeks: { total: number; withBills: number };
}

export interface ScenarioResult {
  horizon: Horizon;
  /** The levers as they were applied, each held within its range; `rates` only those that read and value a bill. */
  levers: { lateDays: number; costPct: number; costScope: ScenarioLevers["costScope"]; rates: Record<string, string> };
  today: string;
  lastDay: string;
  cash: number;
  reserve: number;
  /** Receivables arriving within the horizon: on their due days, and as the scenario times them. */
  receivables: { base: number; scenario: number };
  /** What leaves within the horizon, in each case. */
  outflows: { base: number; scenario: number };
  /** The cost lever's effect on what leaves: the scenario's outflows less the same at the typed rates. */
  costDelta: number;
  /** The typed rates' effect: the outflows at the typed rates less at the rates bills were converted at. */
  rateDelta: number;
  /** Each typed rate, with the bills of its currency within the horizon. */
  rateEffects: RateEffect[];
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

/** The receivables expected within a horizon, on their due days: the ones whose choice a person can set. */
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

  // A typed rate per currency, read exactly; one that does not read is no rate.
  const typedRates: Record<string, string> = {};
  for (const [currency, typed] of Object.entries(levers.rates ?? {})) {
    const value = rateValue(typed);
    if (value !== null && /^[A-Z]{3}$/.test(currency) && currency !== "USD") typedRates[currency] = value;
  }
  // A bill written in a currency with a typed rate, valued at it to the cent, exactly; any other at its own amount.
  const atRate = (outflow: BasisOutflow): number => {
    const original = outflow.original;
    const perUsd = original ? typedRates[original.currency] : undefined;
    if (!original || !perUsd) return outflow.amount;
    try {
      const written = roundedMoney(original.amount, original.currency);
      const rate = { from: "USD", to: original.currency, value: perUsd, kind: "manual" as const, source: "this scenario", at: "" };
      return numberOf(convertMoney(written, [rate, pegRate("USDC")], "USDC", { digits: 2 }));
    } catch {
      return outflow.amount;
    }
  };
  // The cost lever: every bill and recurring payment, or only those written in another currency; never a milestone.
  const changed = (outflow: BasisOutflow) => costPct !== 0 && outflow.kind !== "milestone" && (levers.costScope === "all" || outflow.foreign);
  const scenarioAmount = (outflow: BasisOutflow) => (changed(outflow) ? round(atRate(outflow) * (1 + costPct / 100)) : atRate(outflow));
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

  // The balance after each day, from what arrives and what leaves.
  const balances = (incoming: number[], outgoing: number[]) => {
    let balance = available;
    return incoming.map((amount, day) => round((balance += amount - outgoing[day])));
  };
  const baseBalances = balances(baseIn, baseOut);
  const scenarioBalances = balances(scenarioIn, scenarioOut);
  const days: ScenarioDay[] = [];
  const baseCushions: number[] = [];
  for (let day = 0; day < horizon; day += 1) {
    baseCushions.push(round(leaving(day, (outflow) => outflow.amount) * CUSHION));
    days.push({ day: dayOf(day), base: baseBalances[day], scenario: scenarioBalances[day], cushion: round(leaving(day, scenarioAmount) * CUSHION) });
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
  // A receivable that would have arrived by `day` if clients paid on time, but not in the scenario.
  const missedBy = (day: number) =>
    expected.filter((receivable) => {
      const arrives = arrival(receivable);
      return receivable.day <= day && (arrives === null || arrives > day);
    });

  const suggestions: Suggestion[] = [];
  if (scenarioCase.shortOn) {
    const short = offsetOf(scenarioCase.shortOn);
    suggestions.push({ kind: "need", amount: shortfall, by: scenarioCase.shortOn });
    // A bill scheduled on or before the short day and due after it, paid on its due day instead (out of the horizon
    // when that is past it): the scenario worked out again. Advised only when that moves the short day later or
    // shrinks the gap, the bill that helps most first: the smallest gap left, then the latest short day.
    const early = inHorizon
      .filter((outflow): outflow is BasisOutflow & { dueDay: number } => outflow.note === "scheduled" && outflow.dueDay !== undefined && outflow.day <= short && outflow.dueDay > short)
      .map((outflow) => {
        const outgoing = [...scenarioOut];
        outgoing[outflow.day] -= scenarioAmount(outflow);
        if (outflow.dueDay < horizon) outgoing[outflow.dueDay] += scenarioAmount(outflow);
        const after = balances(scenarioIn, outgoing);
        const shortAfter = after.findIndex((balance) => balance < 0);
        return { outflow, shortOn: shortAfter < 0 ? null : shortAfter, shortfall: shortAfter < 0 ? 0 : round(-Math.min(...after)) };
      })
      .filter((option) => option.shortOn === null || option.shortOn > short || option.shortfall < shortfall)
      .sort((a, b) => a.shortfall - b.shortfall || (b.shortOn ?? horizon) - (a.shortOn ?? horizon) || scenarioAmount(b.outflow) - scenarioAmount(a.outflow))[0];
    if (early) {
      suggestions.push({
        kind: "pay_on_due",
        label: early.outflow.label,
        amount: scenarioAmount(early.outflow),
        scheduledFor: dayOf(early.outflow.day),
        dueOn: dayOf(early.outflow.dueDay),
        shortOn: early.shortOn === null ? null : dayOf(early.shortOn),
        shortfall: early.shortfall,
      });
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
  let rated = 0;
  const ratedCurrencies = new Set<string>();
  for (const outflow of inHorizon.filter((candidate) => candidate.day <= on)) {
    const name = outflow.payee ?? outflow.label;
    const payee = payees.get(name) ?? { kind: "payee", label: name, amount: 0, bills: 0, recurring: 0, milestones: 0 };
    payee.amount = round(payee.amount + outflow.amount);
    if (outflow.kind === "bill") payee.bills += 1;
    else if (outflow.kind === "recurring") payee.recurring += 1;
    else payee.milestones += 1;
    payees.set(name, payee);
    costs += scenarioAmount(outflow) - atRate(outflow);
    if (atRate(outflow) !== outflow.amount && outflow.original) {
      rated += atRate(outflow) - outflow.amount;
      ratedCurrencies.add(outflow.original.currency);
    }
  }
  // A client's receivables together, by the client (by its own id without one), each one's arrival kept.
  type ReceivableDriver = Extract<Driver, { kind: "receivable" }>;
  const late = new Map<string, ReceivableDriver>();
  for (const receivable of missedBy(on)) {
    const arrives = arrival(receivable);
    const key = receivable.client ?? receivable.id;
    const group: ReceivableDriver = late.get(key) ?? { kind: "receivable", key, label: receivable.label, amount: 0, count: 0, never: 0, outside: 0, arrivesBy: null };
    group.amount = round(group.amount + receivable.amount);
    group.count += 1;
    if (arrives === null) group.never += 1;
    else if (arrives >= horizon) group.outside += 1;
    else if (group.arrivesBy === null || dayOf(arrives) > group.arrivesBy) group.arrivesBy = dayOf(arrives);
    late.set(key, group);
  }
  const sources: Driver[] = [
    ...payees.values(),
    ...late.values(),
    ...(round(costs) > 0 ? [{ kind: "costs" as const, amount: round(costs), pct: costPct, scope: levers.costScope }] : []),
    ...(round(rated) > 0 ? [{ kind: "rates" as const, amount: round(rated), currencies: [...ratedCurrencies].sort() }] : []),
  ];
  const drivers = sources
    .filter((source) => source.amount > 0)
    .sort((a, b) => b.amount - a.amount || (a.kind === "costs" || a.kind === "rates" ? 1 : b.kind === "costs" || b.kind === "rates" ? -1 : a.label.localeCompare(b.label)))
    .slice(0, 3);

  const sum = (rows: Array<{ amount: number }>) => round(rows.reduce((total, row) => total + row.amount, 0));
  const bills = inHorizon.filter((outflow) => outflow.kind === "bill");
  const recurring = inHorizon.filter((outflow) => outflow.kind === "recurring");
  const milestones = inHorizon.filter((outflow) => outflow.kind === "milestone");
  // The latest due day: a scheduled bill's own, which may be past the horizon, not the day it is scheduled for.
  const lastBill = bills.reduce<number | null>((latest, outflow) => Math.max(latest ?? 0, outflow.dueDay ?? outflow.day), null);
  // The weeks from today in which a bill or a recurring payment leaves; one due before today fills none.
  const weeksWithBills = new Set(inHorizon.filter((outflow) => outflow.kind !== "milestone" && !outflow.overdue).map((outflow) => Math.floor(outflow.day / 7)));
  // Each client once, under the name on its first receivable here.
  const recorded = new Map<string, Coverage["records"][number]>();
  for (const receivable of expected) {
    const record = receivable.client ? basis.clients[receivable.client] : undefined;
    if (record && receivable.client && !recorded.has(receivable.client)) recorded.set(receivable.client, { label: receivable.label, ...record });
  }
  const records = [...recorded.values()];
  const eurcIn = basis.eurc.filter((move) => move.day < horizon);
  const plannedIn = (basis.planned ?? []).filter((line) => line.day < horizon);
  const plannedUsdc = plannedIn.filter((line) => line.currency === "USDC");
  const plannedOther = new Map<string, { currency: string; amount: number; count: number }>();
  for (const line of plannedIn.filter((candidate) => candidate.currency !== "USDC")) {
    const entry = plannedOther.get(line.currency) ?? { currency: line.currency, amount: 0, count: 0 };
    entry.amount = round(entry.amount + line.amount);
    entry.count += 1;
    plannedOther.set(line.currency, entry);
  }

  // Each typed rate that values a bill within the horizon, with what those bills come to either way.
  const rateEffects: RateEffect[] = Object.entries(typedRates)
    .map(([currency, perUsd]) => {
      const bills = inHorizon.filter((outflow) => outflow.original?.currency === currency);
      return { currency, perUsd, bills: bills.length, converted: sum(bills), atRate: round(bills.reduce((total, outflow) => total + atRate(outflow), 0)) };
    })
    .filter((effect) => effect.bills > 0)
    .sort((a, b) => a.currency.localeCompare(b.currency));
  const atRates = round(inHorizon.reduce((total, outflow) => total + atRate(outflow), 0));

  return {
    horizon,
    levers: { lateDays, costPct, costScope: levers.costScope, rates: Object.fromEntries(rateEffects.map((effect) => [effect.currency, effect.perUsd])) },
    today: basis.today,
    lastDay: dayOf(horizon - 1),
    cash: basis.cash,
    reserve: basis.reserve,
    receivables: { base: sum(expected), scenario: round(scenarioIn.reduce((total, amount) => total + amount, 0)) },
    outflows: { base: sum(inHorizon), scenario: round(scenarioOut.reduce((total, amount) => total + amount, 0)) },
    costDelta: round(scenarioOut.reduce((total, amount) => total + amount, 0) - atRates),
    rateDelta: round(atRates - inHorizon.reduce((total, outflow) => total + outflow.amount, 0)),
    rateEffects,
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
      weeks: { total: Math.ceil(horizon / 7), withBills: weeksWithBills.size },
      planned: {
        count: plannedUsdc.length,
        amount: sum(plannedUsdc),
        other: [...plannedOther.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
        read: basis.plannedRead !== false,
      },
    },
  };
}
