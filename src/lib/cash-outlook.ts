import { OPEN_PAYABLE_STATUSES } from "./agent/obligations";

/**
 * Safe to spend today, and the next 30 days of money moving
 * (docs/superpowers/specs/2026-10-02-safe-to-spend-design.md).
 *
 * The figure starts from the operating wallet's USDC and takes off what the agent itself counts as owed:
 * every open USDC payable leaving within 30 days (a scheduled one on its day, an overdue one today, a held
 * one still, since a hold is unresolved and never forgiven), every open milestone (payable the day it is
 * verified, so counted today), and the cushion the treasury keeps over what leaves within 7 days (its
 * 1.15 buffer). Receivables are only expected: they are shown, never counted as cash. EURC payables are
 * paid from the EURC balance, so they are left out of this USDC figure and counted apart.
 *
 * Pure: the console passes the rows it already loaded.
 */

export interface OutlookInput {
  now: number;
  operatingUsdc: number;
  payables: Array<{ id: string; counterparty: string; amount: number; currency: string | null; due_date: string; status: string; scheduled_for: string | null }>;
  milestones: Array<{ id: string; title: string; contractor: string; amount: number; status: string; escrow_state?: string | null }>;
  receivables: Array<{ id: string; counterparty: string; amount: number; currency: string | null; due_date: string; status: string }>;
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
  cash: number;
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

export function cashOutlook(input: OutlookInput): CashOutlook {
  const today = Date.UTC(new Date(input.now).getUTCFullYear(), new Date(input.now).getUTCMonth(), new Date(input.now).getUTCDate());
  const lastDay = today + (WINDOW_DAYS - 1) * DAY_MS;
  const bufferEnd = today + (BUFFER_DAYS - 1) * DAY_MS;
  // The day money leaves: a past day is today; null when it falls outside the window.
  const dayOf = (iso: string): { at: number; overdue: boolean } | null => {
    const parsed = Date.parse(iso);
    const at = Date.UTC(new Date(parsed).getUTCFullYear(), new Date(parsed).getUTCMonth(), new Date(parsed).getUTCDate());
    if (at > lastDay) return null;
    return { at: Math.max(at, today), overdue: at < today };
  };

  const byDay = new Map<number, OutlookItem[]>();
  const add = (at: number, item: OutlookItem) => byDay.set(at, [...(byDay.get(at) ?? []), item]);
  let dueIn30d = 0;
  let dueCount = 0;
  let dueIn7d = 0;
  let eurcLeftOut = 0;

  for (const payable of input.payables) {
    if (!(OPEN_PAYABLE_STATUSES as readonly string[]).includes(payable.status)) continue;
    const scheduled = payable.status === "scheduled" && payable.scheduled_for;
    const when = dayOf(scheduled ? (payable.scheduled_for as string) : payable.due_date);
    if (!when) continue;
    if ((payable.currency ?? "USDC") !== "USDC") {
      eurcLeftOut += payable.amount;
      continue;
    }
    dueIn30d += payable.amount;
    dueCount += 1;
    if (when.at <= bufferEnd) dueIn7d += payable.amount;
    const note: OutlookItem["note"] = scheduled ? "scheduled" : payable.status === "held" ? "held" : when.overdue ? "overdue" : "due";
    add(when.at, { kind: "out", label: payable.counterparty, amount: payable.amount, note });
  }

  let milestonesOpen = 0;
  let milestoneCount = 0;
  for (const milestone of input.milestones) {
    if (!OPEN_MILESTONE.has(milestone.status) || milestone.escrow_state === "funded") continue;
    milestonesOpen += milestone.amount;
    milestoneCount += 1;
    add(today, {
      kind: "milestone",
      label: `${milestone.contractor}: ${milestone.title}`,
      amount: milestone.amount,
      note: milestone.status === "verified" ? "verified" : "payable once verified",
    });
  }

  let expectedIn30d = 0;
  for (const receivable of input.receivables) {
    if (!OPEN_RECEIVABLE.has(receivable.status) || (receivable.currency ?? "USDC") !== "USDC") continue;
    const when = dayOf(receivable.due_date);
    if (!when) continue;
    expectedIn30d += receivable.amount;
    add(when.at, { kind: "in", label: receivable.counterparty, amount: receivable.amount, note: "expected" });
  }

  const order: Record<OutlookItem["kind"], number> = { out: 0, milestone: 1, in: 2 };
  let balance = input.operatingUsdc;
  let withExpected = input.operatingUsdc;
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
    safeToSpend: round(input.operatingUsdc - dueIn30d - milestonesOpen - cushion),
    cash: input.operatingUsdc,
    dueIn30d: round(dueIn30d),
    dueCount,
    milestonesOpen: round(milestonesOpen),
    milestoneCount,
    cushion,
    expectedIn30d: round(expectedIn30d),
    eurcLeftOut: round(eurcLeftOut),
    shortOn,
    days,
  };
}
