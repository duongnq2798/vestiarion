import { OPEN_PAYABLE_STATUSES } from "./agent/obligations";

/**
 * Safe to spend today, and the next 30 days of money moving
 * (docs/superpowers/specs/2026-10-02-safe-to-spend-design.md).
 *
 * The figure starts from the operating wallet's USDC, and the USYC reserve's, which comes back to the wallet within
 * seconds at any hour and which the agent brings back itself before it pays what is due. The treasury keeps only a
 * cushion in the wallet and sweeps the rest to the reserve, so the wallet alone would read nearly nothing. From that
 * it takes off what the agent itself counts as owed:
 * every open USDC payable leaving within 30 days (a scheduled one on its day, an overdue one today, a held
 * one still, since a hold is unresolved and never forgiven), every open milestone (payable the day it is
 * verified, so counted today), and the cushion the treasury keeps over what leaves within 7 days (its
 * 1.15 buffer). Receivables are only expected: they are shown, never counted as cash. EURC payables are
 * paid from the EURC balance, so they are left out of this USDC figure and counted apart.
 *
 * Pure: the console passes the rows it already loaded. The cash scenarios read the same rules over 90 days through
 * `outlookMoves` (docs/superpowers/specs/2026-10-11-cash-scenarios-design.md C2).
 */

export interface OutlookInput {
  now: number;
  operatingUsdc: number;
  /** The USYC reserve's value in USDC; 0 without one. */
  reserveUsdc?: number;
  payables: Array<{
    id: string;
    counterparty: string;
    amount: number;
    currency: string | null;
    due_date: string;
    status: string;
    scheduled_for: string | null;
    /** The currency the bill was written in, when its USDC amount was worked out at a rate (0084, shadow mode S6). */
    original_currency?: string | null;
    /** The recurring payment it was created for, and that payment's period (`YYYY-MM-DD`), when it was. */
    recurring_id?: string | null;
    recurring_period?: string | null;
  }>;
  milestones: Array<{ id: string; title: string; contractor: string; amount: number; status: string; escrow_state?: string | null }>;
  receivables: Array<{
    id: string;
    counterparty: string;
    amount: number;
    currency: string | null;
    due_date: string;
    status: string;
    /** The client: its earlier receivables say how it paid (cash scenarios C8). */
    counterparty_id?: string | null;
    /** When a received receivable arrived. */
    settled_at?: string | null;
  }>;
}

export interface OutlookItem {
  kind: "out" | "milestone" | "in";
  label: string;
  amount: number;
  note: "due" | "overdue" | "scheduled" | "held" | "verified" | "payable once verified" | "expected";
}

export interface OutlookDay {
  /** A UTC day, YYYY-MM-DD. */
  day: string;
  items: OutlookItem[];
  /** The wallet after this day's committed outflows, counting no receivable. */
  balance: number;
  /** The same, had every receivable expected so far arrived. */
  balanceWithExpected: number;
}

export interface CashOutlook {
  safeToSpend: number;
  /** The operating wallet's USDC. */
  cash: number;
  /** The USYC reserve's value in USDC, counted as cash today. */
  reserve: number;
  dueIn30d: number;
  dueCount: number;
  milestonesOpen: number;
  milestoneCount: number;
  cushion: number;
  expectedIn30d: number;
  /** EURC payables due within 30 days, paid from EURC and so outside this figure. */
  eurcLeftOut: number;
  /** The first day the wallet would run short before any receivable arrives; null when it never does. */
  shortOn: string | null;
  days: OutlookDay[];
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const BUFFER_DAYS = 7;
/** The treasury keeps 1.15 times what leaves within 7 days (planTreasury's bufferRatio). */
const CUSHION = 0.15;
const OPEN_RECEIVABLE = new Set(["pending", "matched"]);
const OPEN_MILESTONE = new Set(["pending", "verified"]);

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const utcDayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
/** Midnight UTC of the day `at` falls on. */
const utcMidnight = (at: number) => Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate());

/** One amount the outlook counts, on the day it moves. */
export interface OutlookMove {
  /** The payable's, milestone's or receivable's id. */
  id: string;
  /** Midnight UTC of the day it moves: a past day is today. */
  at: number;
  /** Its own day was before today. */
  overdue: boolean;
  item: OutlookItem;
  /** A scheduled payable's own due day, `YYYY-MM-DD`: it leaves on `at`, the day it was scheduled for. */
  dueDay?: string;
  /** A payable written in another currency, whose USDC amount was worked out at a rate. */
  foreign?: boolean;
  /** A receivable's client. */
  counterpartyId?: string | null;
}

export interface OutlookMoves {
  /** Midnight UTC today. */
  today: number;
  /** Payables in their order, then milestones, then receivables. */
  moves: OutlookMove[];
  /** EURC moving within the window, each on its day: paid from and into the EURC balance, so left out of every USDC figure. */
  eurc: Array<{ kind: "out" | "in"; at: number; amount: number }>;
}

/**
 * What the outlook counts within `windowDays` from today, each on its day (cash scenarios C2): every open USDC
 * payable (a scheduled one on its day, an overdue or held one today), every open milestone today unless its USDC is
 * locked in escrow, every open USDC receivable on its due day (an overdue one today), and EURC apart. `cashOutlook`
 * reads it over 30 days, the cash scenarios over 90.
 */
export function outlookMoves(input: OutlookInput, windowDays: number): OutlookMoves {
  const today = utcMidnight(input.now);
  const lastDay = today + (windowDays - 1) * DAY_MS;
  // The day money moves: a past day is today; null when it falls outside the window.
  const dayOf = (iso: string): { at: number; overdue: boolean } | null => {
    const at = utcMidnight(Date.parse(iso));
    if (at > lastDay) return null;
    return { at: Math.max(at, today), overdue: at < today };
  };

  const moves: OutlookMove[] = [];
  const eurc: OutlookMoves["eurc"] = [];

  for (const payable of input.payables) {
    if (!(OPEN_PAYABLE_STATUSES as readonly string[]).includes(payable.status)) continue;
    const scheduled = payable.status === "scheduled" && payable.scheduled_for;
    const when = dayOf(scheduled ? (payable.scheduled_for as string) : payable.due_date);
    if (!when) continue;
    if ((payable.currency ?? "USDC") !== "USDC") {
      eurc.push({ kind: "out", at: when.at, amount: payable.amount });
      continue;
    }
    const note: OutlookItem["note"] = scheduled ? "scheduled" : payable.status === "held" ? "held" : when.overdue ? "overdue" : "due";
    moves.push({
      id: payable.id,
      at: when.at,
      overdue: when.overdue,
      item: { kind: "out", label: payable.counterparty, amount: payable.amount, note },
      ...(scheduled ? { dueDay: utcDayOf(utcMidnight(Date.parse(payable.due_date))) } : {}),
      foreign: Boolean(payable.original_currency) && payable.original_currency !== "USDC",
    });
  }

  for (const milestone of input.milestones) {
    if (!OPEN_MILESTONE.has(milestone.status) || milestone.escrow_state === "funded") continue;
    moves.push({
      id: milestone.id,
      at: today,
      overdue: false,
      item: {
        kind: "milestone",
        label: `${milestone.contractor}: ${milestone.title}`,
        amount: milestone.amount,
        note: milestone.status === "verified" ? "verified" : "payable once verified",
      },
    });
  }

  for (const receivable of input.receivables) {
    if (!OPEN_RECEIVABLE.has(receivable.status)) continue;
    const when = dayOf(receivable.due_date);
    if ((receivable.currency ?? "USDC") !== "USDC") {
      if (when) eurc.push({ kind: "in", at: when.at, amount: receivable.amount });
      continue;
    }
    if (!when) continue;
    moves.push({
      id: receivable.id,
      at: when.at,
      overdue: when.overdue,
      item: { kind: "in", label: receivable.counterparty, amount: receivable.amount, note: "expected" },
      counterpartyId: receivable.counterparty_id ?? null,
    });
  }

  return { today, moves, eurc };
}

export function cashOutlook(input: OutlookInput): CashOutlook {
  const { today, moves, eurc } = outlookMoves(input, WINDOW_DAYS);
  const bufferEnd = today + (BUFFER_DAYS - 1) * DAY_MS;

  const byDay = new Map<number, OutlookItem[]>();
  const add = (at: number, item: OutlookItem) => byDay.set(at, [...(byDay.get(at) ?? []), item]);
  let dueIn30d = 0;
  let dueCount = 0;
  let dueIn7d = 0;
  let milestonesOpen = 0;
  let milestoneCount = 0;
  let expectedIn30d = 0;

  for (const move of moves) {
    if (move.item.kind === "out") {
      dueIn30d += move.item.amount;
      dueCount += 1;
      if (move.at <= bufferEnd) dueIn7d += move.item.amount;
    } else if (move.item.kind === "milestone") {
      milestonesOpen += move.item.amount;
      milestoneCount += 1;
    } else {
      expectedIn30d += move.item.amount;
    }
    add(move.at, move.item);
  }

  const order: Record<OutlookItem["kind"], number> = { out: 0, milestone: 1, in: 2 };
  const reserve = input.reserveUsdc ?? 0;
  // What the agent can pay with today: the wallet, and the reserve it brings back in seconds.
  const available = input.operatingUsdc + reserve;
  let balance = available;
  let withExpected = available;
  let shortOn: string | null = null;
  const days: OutlookDay[] = [...byDay.keys()]
    .sort((a, b) => a - b)
    .map((at) => {
      const items = (byDay.get(at) ?? []).sort((a, b) => order[a.kind] - order[b.kind]);
      for (const item of items) {
        if (item.kind === "in") withExpected += item.amount;
        else {
          balance -= item.amount;
          withExpected -= item.amount;
        }
      }
      if (shortOn === null && balance < 0) shortOn = utcDayOf(at);
      return { day: utcDayOf(at), items, balance: round(balance), balanceWithExpected: round(withExpected) };
    });

  const cushion = round((dueIn7d + milestonesOpen) * CUSHION);
  return {
    safeToSpend: round(available - dueIn30d - milestonesOpen - cushion),
    cash: input.operatingUsdc,
    reserve: round(reserve),
    dueIn30d: round(dueIn30d),
    dueCount,
    milestonesOpen: round(milestonesOpen),
    milestoneCount,
    cushion,
    expectedIn30d: round(expectedIn30d),
    eurcLeftOut: round(eurc.reduce((sum, move) => (move.kind === "out" ? sum + move.amount : sum), 0)),
    shortOn,
    days,
  };
}
