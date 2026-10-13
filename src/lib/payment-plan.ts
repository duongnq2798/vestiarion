import { amountToPay, discountApplies } from "./agent/payment-timing";
import { utcDay } from "./copy";

/**
 * The payment plan (docs/superpowers/specs/2026-10-11-payment-plan-design.md): the next 14 UTC days of what leaves the
 * operating wallet, bill by bill, in the order the cash allows, with the balance after each and the day each bill is
 * best paid on. Pure: the page and the command each hand it the rows they read, so both build the same plan, with the
 * same fingerprints.
 *
 * It is a preview. It never pays: approving one of its lines only moves the day a scheduled bill is decided again on
 * (src/lib/payment-plan-apply.ts), and the agent checks everything again on that day.
 */

/** The window: today and the 13 UTC days after it (P2). */
export const PLAN_DAYS = 14;
/** How old the chain's balance may be before approving waits for a fresh read (P12). */
export const BALANCE_FRESH_MS = 10 * 60_000;

/** One payable, as the plan reads it. */
export interface PlanBill {
  id: string;
  counterpartyId: string;
  payee: string;
  /** Where it is paid: part of the line's fingerprint, so a changed address invalidates the line shown (P11). */
  payeeAddress: string | null;
  amount: number;
  /** USDC, or EURC, which the plan names apart (P2). */
  currency: string;
  /** ISO timestamp. */
  dueDate: string;
  status: string;
  /** ISO timestamp: the day the agent committed to, while `scheduled`. */
  scheduledFor: string | null;
  discount: { pct: number; deadline: string } | null;
  paymentLimit: number | null;
  riskLevel: string | null;
  /** Who entered it: they may not approve its day (P10). */
  createdBy: string | null;
}

/** One milestone, as the plan reads it. */
export interface PlanMilestone {
  id: string;
  counterpartyId: string;
  payee: string;
  title: string;
  amount: number;
  status: string;
  escrowState: string | null;
  /** The contractor's payment limit and screening, which the agent checks before it releases a milestone (P7). */
  paymentLimit: number | null;
  riskLevel: string | null;
}

/** What the agent may pay on its own, and the figure above which two people approve (P7). */
export interface PlanLimits {
  /** The agent's spending limit and what it paid against it; null when no figure is set. */
  budget: { dailyUsdc: number | null; weeklyUsdc: number | null; spentToday: number; spentThisWeek: number } | null;
  twoApprovalsAbove: number | null;
}

/** Where the balance comes from: a sandbox's own figure, or the chain's, read at `syncedAt` (P12). */
export type PlanBalanceSource = { kind: "simulated" } | { kind: "chain"; syncedAt: string | null };

export interface PaymentPlanInput {
  now: number;
  operatingUsdc: number;
  /** The USYC reserve's value in USDC, which comes back to the wallet in seconds (P3). */
  reserveUsdc: number;
  /**
   * The reserve's yield, annualised, as a fraction (0.045 for 4.5%): the agent pays early for a discount only when the
   * discount is worth at least the yield of holding the cash to the due date (payment timing), and so does the plan (P4).
   */
  reserveApy: number;
  /** Safe to spend's cushion: 15% of what leaves within 7 days and of the open milestones (P3). */
  cushion: number;
  bills: PlanBill[];
  milestones: PlanMilestone[];
  limits: PlanLimits;
  balance: PlanBalanceSource;
  /** What could not be read, in words ("the agent's spending limit"): approving waits until it can be (P12). */
  unread: string[];
  /**
   * Money expected in: the open receivables, a deal's released lines included, and the deal lines not invoiced yet
   * (docs/superpowers/specs/2026-10-12-deal-schedule-design.md D14). Listed apart; never cash, never in a balance.
   */
  incoming?: PlanIncomingInput;
}

/** One amount expected in, as the rows give it. */
export interface IncomingInput {
  id: string;
  /** The client, or "Client: deal title" for a planned deal line. */
  from: string;
  /** The receivable's memo, or the deal line's name. */
  what: string | null;
  amount: number;
  currency: string;
  /** `YYYY-MM-DD`. */
  dueOn: string;
}

export interface PlanIncomingInput {
  receivables: IncomingInput[];
  /** Null when the deal lines could not be read. */
  planned: IncomingInput[] | null;
}

/** One amount expected in within the window, on its due day (today when past). */
export interface IncomingLine {
  id: string;
  from: string;
  what: string | null;
  amount: number;
  currency: string;
  on: string;
  overdue: boolean;
}

export interface PlanIncoming {
  /** Open receivables due within the window: money expected, never cash. */
  expected: IncomingLine[];
  /** Deal lines not invoiced yet, due within the window. */
  planned: IncomingLine[];
  expectedUsdc: number;
  plannedUsdc: number;
  plannedRead: boolean;
}

export type PlanFlagCode = "short" | "below_cushion" | "over_agent_limit" | "two_approvals" | "payment_limit" | "high_risk" | "same_as_milestone" | "due_unreadable";

export interface PlanFlag {
  code: PlanFlagCode;
  text: string;
  /** Whether it keeps the line from being approved. */
  blocks: boolean;
}

/**
 * `planned`: the plan gives it a day (a bill the agent scheduled, or has not decided yet). `on_its_way`: a payment
 * sent, or a verified milestone the agent releases now. `waiting`: a person decides it. `not_counted`: listed, not
 * counted (P6).
 */
export type PlanLineState = "planned" | "on_its_way" | "waiting" | "not_counted";

export interface PlanLine {
  id: string;
  kind: "bill" | "milestone";
  payee: string;
  counterpartyId: string;
  /** The milestone's title; null for a bill. */
  title: string | null;
  amount: number;
  status: string;
  state: PlanLineState;
  /** A bill's due day; null for a milestone, or a due date that cannot be read. */
  dueOn: string | null;
  /** The day the agent scheduled it for, while it is scheduled. */
  agentOn: string | null;
  /** The day the plan counts it on; null when it is not counted. */
  on: string | null;
  /** Whether `on` falls inside the window; a bill paid after it is listed, not counted in the days shown. */
  inWindow: boolean;
  /** What leaves on that day: less the discount when paid by its deadline. */
  pays: number;
  discount: { pct: number; value: number; until: string; taken: boolean } | null;
  /** Why this day, in one sentence. */
  reason: string;
  flags: PlanFlag[];
  /** The balance after it, under the plan; null when it is not counted in the window. */
  balanceAfter: number | null;
  /** Whether the agent pays it on its own, using its spending limit's room that day. */
  agentPays: boolean;
  /** The day it would move from and to, for a bill the agent scheduled on another day than the plan's (P9). */
  move: { from: string; to: string } | null;
  /** A move whose own checks pass (P10). Freshness is the plan's (`blocked`), checked apart. */
  approvable: boolean;
  createdBy: string | null;
  fingerprint: string;
}

export interface PlanDay {
  day: string;
  /** What leaves that day under the plan. */
  out: number;
  /** The balance after the day, under the plan. */
  balance: number;
  /** The balance after the day, as the bills are scheduled now. */
  balanceNow: number;
}

export interface PlanFreshness {
  state: "simulated" | "fresh" | "stale" | "unread";
  syncedAt: string | null;
  /** Whole minutes since the chain's read. */
  minutes: number | null;
  /** Why approving waits, or null. */
  blocked: string | null;
}

export interface PaymentPlan {
  today: string;
  through: string;
  cash: number;
  operating: number;
  reserve: number;
  cushion: number;
  lines: PlanLine[];
  /** The days money leaves, in either the plan or the schedule as it stands. */
  days: PlanDay[];
  lowest: { day: string; balance: number } | null;
  lowestNow: { day: string; balance: number } | null;
  /** What the bills marked short come to: owed in full, and not paid on their day. */
  stillOwed: number;
  stillOwedNow: number;
  /** The discounts the plan's days take, if paid as planned: an estimate (P14). */
  discountsPlanned: number;
  eurc: { count: number; amount: number };
  /** How many lines can be approved. */
  moves: number;
  freshness: PlanFreshness;
  /** Why approving is off for the whole plan, or null (P12). */
  blocked: string | null;
  fingerprint: string;
  /** Listed apart from the days: in no balance, flag or fingerprint (deal schedule D14). */
  incoming: PlanIncoming;
}

const DAY_MS = 86_400_000;
const EPSILON = 0.0000005;
/** Bills the plan counts (P2, P6, P8); `flagged` is listed and not counted. */
const COUNTED_BILLS = new Set(["pending", "scheduled", "matched", "held", "awaiting_info", "processing"]);
const LISTED_BILLS = new Set([...COUNTED_BILLS, "flagged"]);
const OPEN_MILESTONES = new Set(["pending", "verified", "held"]);
/** The flags that keep a line from being approved: all but the cushion's, which an obligation on its due day may breach. */
const BLOCKING: ReadonlySet<PlanFlagCode> = new Set(["short", "over_agent_limit", "two_approvals", "payment_limit", "high_risk", "same_as_milestone", "due_unreadable"]);

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const usdc = (value: number) => `${AMOUNT.format(value)} USDC`;
const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);

/** A UTC day, `YYYY-MM-DD`, of a timestamp; null when it cannot be read. */
function dayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
}

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

const later = (a: string, b: string) => (a > b ? a : b);

/** What leaves on `day` for `amount`: less the discount when that day is on or before its deadline. */
function paysOn(amount: number, discount: PlanBill["discount"], day: string): number {
  return amountToPay(amount, discount, new Date(`${day}T12:00:00.000Z`)).amountPaid;
}

/** A short, stable hash of a string: two 53-bit halves (cyrb53), in base 36. A staleness check, not a secret. */
export function planHash(text: string): string {
  const half = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  return `${half(1)}${half(2)}`;
}

/** "25 minutes ago", "3 hours ago", "2 days ago". */
function ageWords(minutes: number): string {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * Whether the plan's facts are fresh enough to act on (P12): a sandbox's own balance always is; the chain's is for 10
 * minutes after it was read. Anything that could not be read turns approving off too.
 */
export function planFreshness(balance: PlanBalanceSource, unread: readonly string[], now: number): PlanFreshness {
  let freshness: PlanFreshness;
  if (balance.kind === "simulated") {
    freshness = { state: "simulated", syncedAt: null, minutes: null, blocked: null };
  } else if (balance.syncedAt === null || Number.isNaN(Date.parse(balance.syncedAt))) {
    freshness = {
      state: "unread",
      syncedAt: null,
      minutes: null,
      blocked: "The balance has not been read from the chain yet. Refresh it to approve the plan.",
    };
  } else {
    const age = Math.max(0, now - Date.parse(balance.syncedAt));
    const minutes = Math.floor(age / 60_000);
    freshness =
      age > BALANCE_FRESH_MS
        ? { state: "stale", syncedAt: balance.syncedAt, minutes, blocked: `The balance was read from the chain ${ageWords(minutes)}. Refresh it to approve the plan.` }
        : { state: "fresh", syncedAt: balance.syncedAt, minutes, blocked: null };
  }
  if (freshness.blocked === null && unread.length > 0) {
    const what = unread.join(" and ");
    freshness = {
      ...freshness,
      blocked: `${what.charAt(0).toUpperCase()}${what.slice(1)} could not be read, so the plan's checks are incomplete. Approving waits until it can be read.`,
    };
  }
  return freshness;
}

/** A line while it is being built: everything but what the simulation and the fingerprint add. */
interface Draft {
  line: Omit<PlanLine, "on" | "pays" | "balanceAfter" | "agentPays" | "approvable" | "fingerprint" | "inWindow" | "move" | "reason" | "flags" | "discount"> & {
    flags: PlanFlag[];
    reason: string;
  };
  bill: PlanBill | null;
  /** The day it counts on as things are scheduled now. */
  nowOn: string | null;
  /** The plan's day, before any discount is tried: the due date or today, or the agent's own day when that is earlier. */
  defaultOn: string | null;
  /** A discount's deadline the plan may pay on instead (P4): earlier than the day the agent chose, if it chose one. */
  deadlineOn: string | null;
  /**
   * The agent scheduled it, for a day still to come, on or before the discount's deadline: that day takes the discount,
   * and the plan keeps it, trying no other and never moving it later, whatever the cushion, the cash or the limit (P4).
   */
  keptByAgent: boolean;
  /** Sort order within a day (P5). */
  group: number;
  /** Whether the agent pays it on its own, when nothing stops it (P7). */
  agentEligible: boolean;
  /** Hard caps that stop the agent paying it at all (P7). */
  caps: PlanFlag[];
  /** The payee's payment limit and screening, as read: part of the line's fingerprint, since they decide its caps (P11). */
  payeeChecks: { paymentLimit: number | null; riskLevel: string | null };
}

interface Placement {
  draft: Draft;
  day: string;
  pays: number;
}

interface Simulation {
  /** By line id. */
  balanceAfter: Map<string, number>;
  short: Map<string, number>;
  belowCushion: Map<string, number>;
  overLimit: Set<string>;
  agentPays: Set<string>;
  /** The balance after each day of the window. */
  dayBalance: Map<string, number>;
  dayOut: Map<string, number>;
  stillOwed: number;
}

function placementOrder(a: Placement, b: Placement): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.draft.group !== b.draft.group) return a.draft.group - b.draft.group;
  const dueA = a.draft.line.dueOn ?? "";
  const dueB = b.draft.line.dueOn ?? "";
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.pays !== b.pays) return a.pays - b.pays;
  return a.draft.line.id < b.draft.line.id ? -1 : a.draft.line.id > b.draft.line.id ? 1 : 0;
}

/**
 * Walks the window day by day, paying each placement in order while the cash allows (P5): a payment the balance cannot
 * cover is short and not taken off; one the agent pays on its own uses its spending limit's room that day (P7).
 */
function simulate(placements: Placement[], cash: number, cushion: number, limits: PlanLimits, today: string, days: string[]): Simulation {
  const result: Simulation = {
    balanceAfter: new Map(),
    short: new Map(),
    belowCushion: new Map(),
    overLimit: new Set(),
    agentPays: new Set(),
    dayBalance: new Map(),
    dayOut: new Map(),
    stillOwed: 0,
  };
  const agentSpend = days.map(() => 0);
  const budget = limits.budget;
  const roomFor = (index: number): number => {
    if (!budget) return Number.POSITIVE_INFINITY;
    const daily = budget.dailyUsdc === null ? Number.POSITIVE_INFINITY : budget.dailyUsdc - (index === 0 ? budget.spentToday : 0) - agentSpend[index];
    let week = index <= 6 ? budget.spentThisWeek : 0;
    for (let back = Math.max(0, index - 6); back <= index; back++) week += agentSpend[back];
    const weekly = budget.weeklyUsdc === null ? Number.POSITIVE_INFINITY : budget.weeklyUsdc - week;
    return Math.min(daily, weekly);
  };

  let balance = cash;
  const sorted = [...placements].sort(placementOrder);
  let cursor = 0;
  for (const day of days) {
    let out = 0;
    while (cursor < sorted.length && sorted[cursor].day === day) {
      const { draft, pays } = sorted[cursor++];
      const id = draft.line.id;
      if (balance + EPSILON < pays) {
        result.short.set(id, round6(pays - balance));
        result.balanceAfter.set(id, round6(balance));
        // Owed in full: not paid on its day, a bill also loses a discount ending that day.
        result.stillOwed = round6(result.stillOwed + draft.line.amount);
        continue;
      }
      balance = round6(balance - pays);
      out = round6(out + pays);
      result.balanceAfter.set(id, balance);
      if (balance + EPSILON < cushion) result.belowCushion.set(id, round6(cushion - balance));
      if (draft.agentEligible && draft.caps.length === 0) {
        const index = daysBetween(today, day);
        // The guardrail weighs the billed amount (`enforceApGuardrails`); the limit then counts what left (`countedUsdc`).
        if (draft.line.amount > roomFor(index) + EPSILON) result.overLimit.add(id);
        else {
          agentSpend[index] = round6(agentSpend[index] + pays);
          result.agentPays.add(id);
        }
      }
    }
    result.dayBalance.set(day, balance);
    result.dayOut.set(day, out);
  }
  return result;
}

/**
 * The checks that stop the agent paying a bill, or releasing a milestone, on its own, whatever the day (P7): its
 * guardrails', ahead of the spending limit, so such a line uses none of the agent's room.
 */
function capsOf(
  owed: { payee: string; amount: number; paymentLimit: number | null; riskLevel: string | null },
  limits: PlanLimits,
  approvedWhere: "in Approvals" | "on Contractors"
): PlanFlag[] {
  const caps: PlanFlag[] = [];
  if (owed.paymentLimit !== null && owed.amount > owed.paymentLimit + EPSILON) {
    caps.push({ code: "payment_limit", blocks: true, text: `Above ${owed.payee}'s payment limit of ${usdc(owed.paymentLimit)}: a person approves it.` });
  }
  if (limits.twoApprovalsAbove !== null && owed.amount > limits.twoApprovalsAbove + EPSILON) {
    caps.push({ code: "two_approvals", blocks: true, text: `Above ${usdc(limits.twoApprovalsAbove)}: two people approve it ${approvedWhere}.` });
  }
  if (owed.riskLevel === "high") {
    caps.push({ code: "high_risk", blocks: true, text: `${owed.payee} is screened high risk: it is not paid until Compliance clears it.` });
  }
  return caps;
}

/**
 * Whether paying early for the discount is the agent's own choice too (payment timing): the discount is worth at least
 * the yield of holding the cash from its deadline to the due date, with the agent's own figures. Null when it is.
 */
function yieldWins(bill: PlanBill, deadlineOn: string, dueOn: string, reserveApy: number): { yieldValue: number; discountValue: number } | null {
  const discountValue = Number((bill.amount * (bill.discount!.pct / 100)).toFixed(6));
  const yieldValue = Number(((bill.amount * reserveApy * daysBetween(deadlineOn, dueOn)) / 365).toFixed(6));
  return discountValue >= yieldValue ? null : { yieldValue, discountValue };
}

function billDraft(bill: PlanBill, today: string, through: string, limits: PlanLimits, reserveApy: number): Draft | null {
  if (!LISTED_BILLS.has(bill.status)) return null;
  const dueOn = dayOf(bill.dueDate);
  const agentOn = bill.status === "scheduled" ? dayOf(bill.scheduledFor) : null;
  // A scheduled bill whose day has come is decided again at the agent's next cycle (`dueForDecision`), by the agent's
  // own rule: the plan counts it where that rule puts it, and nobody can move it (P8).
  const decidedNext = agentOn !== null && agentOn <= today;
  const discountLive = bill.discount !== null && discountApplies(bill.discount, new Date(`${today}T12:00:00.000Z`));
  const deadlineOn = discountLive ? dayOf(bill.discount!.deadline) : null;
  // A day the agent chose on or before the discount's deadline (and its due date) takes the discount: the plan keeps it,
  // tries no other and never moves it later, to earn yield, to protect the cushion or for anything else (P4). The yield
  // decides only whether to propose paying early.
  const keptByAgent = !decidedNext && agentOn !== null && deadlineOn !== null && dueOn !== null && agentOn <= deadlineOn && agentOn <= dueOn;
  const heldForYield =
    deadlineOn !== null && dueOn !== null && deadlineOn < dueOn && !keptByAgent ? yieldWins(bill, deadlineOn, dueOn, reserveApy) : null;
  const inView = dueOn === null || dueOn <= through || (agentOn !== null && agentOn <= through) || (deadlineOn !== null && deadlineOn <= through);
  if (!inView) return null;

  const base = {
    id: bill.id,
    kind: "bill" as const,
    payee: bill.payee,
    counterpartyId: bill.counterpartyId,
    title: null,
    amount: bill.amount,
    status: bill.status,
    dueOn,
    agentOn,
    createdBy: bill.createdBy,
    flags: [] as PlanFlag[],
  };
  const dueOrToday = dueOn === null ? today : later(dueOn, today);
  const overdue = dueOn !== null && dueOn < today;
  const group = bill.status === "matched" || bill.status === "processing" ? 0 : overdue ? 2 : 3;
  const draft = (state: PlanLineState, reason: string, extra: Partial<Draft> = {}): Draft => ({
    line: { ...base, state, reason },
    bill,
    nowOn: dueOrToday,
    defaultOn: dueOrToday,
    deadlineOn: null,
    keptByAgent: false,
    group,
    agentEligible: false,
    caps: [],
    payeeChecks: { paymentLimit: bill.paymentLimit, riskLevel: bill.riskLevel },
    ...extra,
  });

  if (bill.status === "flagged") {
    return draft("not_counted", "Flagged for review by the agent: not counted unless a person approves it.", { nowOn: null, defaultOn: null });
  }
  // Submitted, never "sent", until Circle confirms it (settlement lifecycle I17).
  if (bill.status === "matched") return draft("on_its_way", "Payment submitted; waiting for Circle to confirm it.", { nowOn: today, defaultOn: today });
  if (bill.status === "processing") return draft("waiting", "A person is deciding it now in Approvals; counted today.", { nowOn: today, defaultOn: today });
  if (bill.status === "held" || bill.status === "awaiting_info") {
    const reason =
      bill.status === "held" ? "Waits for a person in Approvals; counted on its due date." : "Waits for details a person adds; counted on its due date.";
    return draft("waiting", reason);
  }

  // pending or scheduled: the plan gives it a day.
  const discountOn = !keptByAgent && deadlineOn !== null && dueOn !== null && deadlineOn < dueOn && heldForYield === null ? later(deadlineOn, today) : null;
  // Where the agent's rule puts it at its next cycle (payment timing): today when overdue or due today, a discount
  // worth taking on its deadline, the due date otherwise.
  const agentNext = dueOn === null || dueOn <= today ? today : (discountOn ?? dueOn);
  // The plan's own day: today or the due date, but never later than a day the agent chose (P4), and the agent's day
  // when the plan's would fall after the window, since no move is offered out of it (P9).
  let planOn = decidedNext ? agentNext : dueOrToday;
  if (!decidedNext && agentOn !== null && (keptByAgent || agentOn < planOn || planOn > through)) planOn = agentOn;
  const result = draft("planned", "", {
    nowOn: decidedNext ? agentNext : agentOn !== null ? agentOn : dueOrToday,
    defaultOn: planOn,
    deadlineOn: decidedNext || discountOn === null || (agentOn !== null && discountOn >= agentOn) ? null : discountOn,
    keptByAgent,
    agentEligible: true,
    caps: capsOf(bill, limits, "in Approvals"),
  });
  if (dueOn === null) {
    result.line.flags.push({ code: "due_unreadable", blocks: true, text: "Its due date cannot be read: counted today." });
    result.line.reason = "Its due date cannot be read, so it is counted today.";
  } else if (overdue) {
    result.line.reason = `Overdue since ${dayWords(dueOn)}: first in line today.`;
  } else if (dueOn === today) {
    result.line.reason = "Due today.";
  } else if (bill.discount && decidedNext && discountOn !== null) {
    const value = round6(bill.amount - paysOn(bill.amount, bill.discount, discountOn));
    result.line.reason = `Pays ${discountOn === today ? "today" : `on ${dayWords(discountOn)}`}, the discount's last day, to take the ${bill.discount.pct}% early-payment discount (${usdc(value)}), as the agent decides at its next cycle.`;
  } else if (keptByAgent && agentOn !== dueOn) {
    // The agent's day before the due date: said once the days are walked, with what the cushion does (planPayments).
  } else if (planOn === agentOn && agentOn !== dueOn) {
    result.line.reason =
      agentOn! < dueOn
        ? `Pays on ${dayWords(agentOn!)}, as the agent scheduled it, ahead of its due date, ${dayWords(dueOn)}: the plan never moves a payment later than the agent chose.`
        : `Pays on ${dayWords(agentOn!)}, as the agent scheduled it, after its due date, ${dayWords(dueOn)}: both fall after the 14 days shown.`;
  } else if (bill.discount && heldForYield !== null) {
    result.line.reason = `Pays on its due date, ${dayWords(dueOn)}: the reserve's yield until then (${usdc(heldForYield.yieldValue)}) is worth more than the ${bill.discount.pct}% early-payment discount (${usdc(heldForYield.discountValue)}), as the agent decides.`;
  } else if (bill.discount && deadlineOn !== null && deadlineOn >= dueOn) {
    const value = round6(bill.amount - paysOn(bill.amount, bill.discount, dueOn));
    result.line.reason =
      deadlineOn === dueOn
        ? `Pays on its due date, ${dayWords(dueOn)}, which is also the discount's last day (${bill.discount.pct}%, ${usdc(value)}).`
        : `Pays on its due date, ${dayWords(dueOn)}, within its ${bill.discount.pct}% early-payment discount (${usdc(value)}), which lasts until ${dayWords(deadlineOn)}.`;
  } else if (bill.discount && !discountLive) {
    result.line.reason = `Pays on its due date, ${dayWords(dueOn)}; its ${bill.discount.pct}% discount ended ${dayWords(dayOf(bill.discount.deadline) ?? dueOn)}.`;
  } else {
    result.line.reason = `No early-payment discount: pays on its due date, ${dayWords(dueOn)}.`;
  }
  return result;
}

function milestoneDraft(milestone: PlanMilestone, today: string, limits: PlanLimits): Draft | null {
  if (!OPEN_MILESTONES.has(milestone.status)) return null;
  const base = {
    id: milestone.id,
    kind: "milestone" as const,
    payee: milestone.payee,
    counterpartyId: milestone.counterpartyId,
    title: milestone.title,
    amount: milestone.amount,
    status: milestone.status,
    dueOn: null,
    agentOn: null,
    createdBy: null,
    flags: [] as PlanFlag[],
  };
  const draft = (state: PlanLineState, reason: string, extra: Partial<Draft> = {}): Draft => ({
    line: { ...base, state, reason },
    bill: null,
    nowOn: today,
    defaultOn: today,
    deadlineOn: null,
    keptByAgent: false,
    group: 1,
    agentEligible: false,
    caps: [],
    payeeChecks: { paymentLimit: milestone.paymentLimit, riskLevel: milestone.riskLevel },
    ...extra,
  });
  if (milestone.escrowState === "funded") return draft("not_counted", "Its USDC is held in escrow already: not counted again.", { nowOn: null, defaultOn: null });
  if (milestone.status === "held") return draft("waiting", "Waits for a person in Contractors; counted today.");
  // The release's own checks (P7): one the agent may not release on its own waits for people and uses none of its room.
  const caps = capsOf(milestone, limits, "on Contractors");
  if (milestone.status === "verified") {
    return caps.length > 0
      ? draft("waiting", "Verified, but not the agent's to release on its own: counted today.", { caps })
      : draft("on_its_way", "Verified: the agent releases it at its next cycle.", { agentEligible: true });
  }
  return draft("planned", "Paid once its work is verified; counted today.", { caps });
}

/**
 * The schedule as it stands (P2–P8): each obligation's draft, and the window walked with every counted line on the day
 * it has now. The plan builds on it, and so does the check of the moves a request makes (`moveObjection`), so the two
 * weigh a move alike.
 */
function scheduleOf(input: PaymentPlanInput) {
  const today = new Date(input.now).toISOString().slice(0, 10);
  const days = Array.from({ length: PLAN_DAYS }, (_, index) => addDays(today, index));
  const through = days[days.length - 1];
  const cash = round6(input.operatingUsdc + input.reserveUsdc);

  const eurc = { count: 0, amount: 0 };
  const drafts: Draft[] = [];
  for (const bill of input.bills) {
    if ((bill.currency ?? "USDC") !== "USDC") {
      if (COUNTED_BILLS.has(bill.status)) {
        eurc.count += 1;
        eurc.amount = round6(eurc.amount + bill.amount);
      }
      continue;
    }
    const draft = billDraft(bill, today, through, input.limits, input.reserveApy);
    if (draft) drafts.push(draft);
  }
  for (const milestone of input.milestones) {
    const draft = milestoneDraft(milestone, today, input.limits);
    if (draft) drafts.push(draft);
  }

  // A bill and a milestone for the same payee and amount may be one payment entered twice (P6).
  const counted = (draft: Draft) => draft.line.state !== "not_counted";
  for (const bill of drafts.filter((draft) => draft.line.kind === "bill" && counted(draft))) {
    for (const milestone of drafts.filter((draft) => draft.line.kind === "milestone" && counted(draft))) {
      if (bill.line.counterpartyId !== milestone.line.counterpartyId || Math.abs(bill.line.amount - milestone.line.amount) > EPSILON) continue;
      const flag: PlanFlag = {
        code: "same_as_milestone",
        blocks: true,
        text: `A milestone and a bill for ${bill.line.payee} have the same amount: they may be the same payment. Both are counted until one is closed.`,
      };
      if (!bill.line.flags.some((existing) => existing.code === flag.code)) bill.line.flags.push(flag);
      if (!milestone.line.flags.some((existing) => existing.code === flag.code)) milestone.line.flags.push(flag);
    }
  }

  const amountOf = (draft: Draft, day: string) => (draft.bill ? paysOn(draft.bill.amount, draft.bill.discount, day) : draft.line.amount);
  /** Each counted line on the day `dayOf` gives it, within the window. */
  const place = (dayOf: (draft: Draft) => string | null): Placement[] =>
    drafts.flatMap((draft) => {
      const day = dayOf(draft);
      if (day === null || day > through) return [];
      return [{ draft, day, pays: amountOf(draft, day) }];
    });
  const run = (placements: Placement[]) => simulate(placements, cash, input.cushion, input.limits, today, days);
  const now = run(place((draft) => draft.nowOn));

  const balanceOn = (simulation: Simulation, day: string) => simulation.dayBalance.get(day) ?? cash;
  /**
   * Why paying `draft` on `on` instead of `otherwiseOn`, where `base` has it, would not do; null when it would (P4, P9).
   * The cash must cover it on that day, no other bill may be left short, and the agent's limit must have room for its
   * billed amount that day without taking the room another payment had. For a discount (`weighCushion`), the balance
   * must also stay at or above the cushion on the days paying early costs cash, from the deadline to the day before it
   * would otherwise pay, or at least no lower there, unless paying early is what lets the cash cover the bill at all:
   * from that day on, the discount leaves more cash, never less.
   */
  const objection = (
    draft: Draft,
    on: string,
    base: Simulation,
    trial: Placement[],
    tried: Simulation,
    otherwiseOn: string | null,
    weighCushion: boolean
  ): string | null => {
    const id = draft.line.id;
    const dayIn = (which: Draft) => dayWords(trial.find((placement) => placement.draft === which)?.day ?? on);
    if (tried.short.has(id)) return `would be short of cash on ${dayWords(on)}`;
    const newlyShort = drafts.find((other) => tried.short.has(other.line.id) && !base.short.has(other.line.id));
    if (newlyShort) return `would leave ${newlyShort.line.payee} short on ${dayIn(newlyShort)}`;
    // Within the agent's limits too: a payment the agent could not make on its own that day, even one it could not make
    // on its old day either, or one that would take the room another payment had, is not worth a person's approval.
    const newlyOver = tried.overLimit.has(id) ? draft : drafts.find((other) => tried.overLimit.has(other.line.id) && !base.overLimit.has(other.line.id));
    if (newlyOver) {
      return newlyOver === draft
        ? `would be above what the agent may pay on its own on ${dayIn(newlyOver)}`
        : `would leave ${newlyOver.line.payee} above what the agent may pay on its own on ${dayIn(newlyOver)}`;
    }
    if (!weighCushion || base.short.has(id)) return null;
    const underDay = days.find(
      (day) =>
        day >= on &&
        (otherwiseOn === null || day < otherwiseOn) &&
        balanceOn(tried, day) + EPSILON < input.cushion &&
        balanceOn(tried, day) + EPSILON < balanceOn(base, day)
    );
    if (underDay === undefined) return null;
    // Under it already, without this discount: it would go further under.
    return balanceOn(base, underDay) + EPSILON < input.cushion
      ? `would take the balance further under the cushion on ${dayWords(underDay)}`
      : `would take the balance under the cushion on ${dayWords(underDay)}`;
  };
  /**
   * The same, against the schedule as it stands with only the `moved` bills (by id, to their new day) moved too: from
   * the day it has now, with the cushion weighed for a discount's day, never for a due date's (P4, P9).
   */
  const objectionWith = (moved: ReadonlyMap<string, string>, draft: Draft, on: string): string | null => {
    const dayIn = (other: Draft) => moved.get(other.line.id) ?? other.nowOn;
    const trial = place((other) => (other === draft ? on : dayIn(other)));
    return objection(draft, on, moved.size === 0 ? now : run(place(dayIn)), trial, run(trial), draft.nowOn, on === draft.deadlineOn);
  };
  return { today, days, through, cash, eurc, drafts, amountOf, place, run, now, balanceOn, objection, objectionWith };
}

/**
 * Why moving the bill `id` to `on` would not do, with the schedule as it stands and only the `moved` bills (by id, to
 * their new day) moved too; null when it would (P9, P10). The plan's own checks, which every move it offers passes on
 * its own: the command weighs each line it applies after those it moved before it, so the moves made hold together
 * whichever of the lines shown a person approves.
 */
export function moveObjection(input: PaymentPlanInput, moved: ReadonlyMap<string, string>, id: string, on: string): string | null {
  const { drafts, objectionWith } = scheduleOf(input);
  const draft = drafts.find((candidate) => candidate.line.id === id);
  return draft ? objectionWith(moved, draft, on) : "is no longer in the plan";
}

/**
 * The plan (P2–P11): each counted line on its day, in the order the cash allows, every discount tried in turn, and the
 * balance after each day beside the balance as the bills are scheduled now.
 */
export function planPayments(input: PaymentPlanInput): PaymentPlan {
  const { today, days, through, cash, eurc, drafts, amountOf, place, run, now, balanceOn, objection, objectionWith } = scheduleOf(input);
  const nowDay = (draft: Draft) => draft.nowOn;
  const planDay = (chosen: Map<string, string>) => (draft: Draft) => chosen.get(draft.line.id) ?? draft.defaultOn;
  /** Weighed on its own: as the bills are scheduled now, with only this one moved (P9). */
  const objectionOnItsOwn = (draft: Draft, on: string): string | null => {
    const why = objectionWith(new Map(), draft, on);
    return why === null ? null : `${why}, as the bills are scheduled now`;
  };

  // A bill the agent scheduled after the plan's day for it (its due date, or today when overdue) is brought back to it
  // only when that passes the checks against the plan as it stands, with the bills brought back before it, and on its
  // own; otherwise it keeps the agent's day. In order of that day, one at a time, so no two are moved that do not fit
  // together and no move is offered whose checks hold only with another one approved too (P9). The cushion never
  // delays it.
  const broughtBack = drafts
    .filter((draft) => {
      const agentOn = draft.line.agentOn;
      const on = draft.defaultOn;
      return draft.line.state === "planned" && draft.line.dueOn !== null && agentOn !== null && agentOn > today && on !== null && on < agentOn;
    })
    .map((draft) => ({ draft, on: draft.defaultOn! }))
    .sort((a, b) => (a.on !== b.on ? (a.on < b.on ? -1 : 1) : a.draft.line.id < b.draft.line.id ? -1 : 1));
  for (const { draft } of broughtBack) draft.defaultOn = draft.line.agentOn;
  let current = run(place(planDay(new Map())));
  for (const { draft, on } of broughtBack) {
    const agentOn = draft.line.agentOn!;
    draft.defaultOn = on;
    const inPlan = place(planDay(new Map()));
    const tried = run(inPlan);
    const why = objectionOnItsOwn(draft, on) ?? objection(draft, on, current, inPlan, tried, agentOn, false);
    if (why === null) {
      current = tried;
      continue;
    }
    draft.defaultOn = agentOn;
    draft.line.reason = `Pays on ${dayWords(agentOn)}, as the agent scheduled it: paying ${on === today ? "today" : `on its due date, ${dayWords(on)},`} ${why}.`;
  }

  // Discounts the agent did not choose itself, in order of deadline and the larger first (P4). Each is weighed against
  // the plan as it stands, then against the schedule as it stands now with only it moved, so a move never relies on
  // another one being approved too (P9).
  const chosen = new Map<string, string>();
  /** A discount taken (`freed`: paying early is what lets the cash cover the bill at all), or why not. */
  const outcome = new Map<string, { taken: true; freed: boolean } | { taken: false; why: string }>();
  current = run(place(planDay(chosen)));
  const candidates = drafts
    .filter((draft) => draft.deadlineOn !== null && draft.bill !== null)
    .map((draft) => ({ draft, value: round6(draft.line.amount - amountOf(draft, draft.deadlineOn!)) }))
    .sort((a, b) =>
      a.draft.deadlineOn! !== b.draft.deadlineOn! ? (a.draft.deadlineOn! < b.draft.deadlineOn! ? -1 : 1) : b.value - a.value || (a.draft.line.id < b.draft.line.id ? -1 : 1)
    );
  for (const { draft } of candidates) {
    const id = draft.line.id;
    const on = draft.deadlineOn!;
    const trial = new Map(chosen).set(id, on);
    const inPlan = place(planDay(trial));
    const tried = run(inPlan);
    const why = objection(draft, on, current, inPlan, tried, draft.defaultOn, true) ?? objectionOnItsOwn(draft, on);
    if (why !== null) {
      outcome.set(id, { taken: false, why });
    } else {
      outcome.set(id, { taken: true, freed: current.short.has(id) });
      chosen.set(id, on);
      current = tried;
    }
  }

  /** Each line's day and group, for the order below: kept beside the lines, never on them. */
  const sortKey = new Map<string, { day: string; group: number }>();
  const lines: PlanLine[] = drafts.map((draft) => {
    const id = draft.line.id;
    const on = draft.line.state === "not_counted" ? null : chosen.get(id) ?? draft.defaultOn;
    const inWindow = on !== null && on <= through;
    const pays = on === null ? 0 : amountOf(draft, on);
    const flags = [...draft.line.flags];
    let reason = draft.line.reason;
    const bill = draft.bill;
    const short = on !== null && inWindow ? current.short.get(id) : undefined;
    let discount: PlanLine["discount"] = null;
    if (bill?.discount && draft.line.state === "planned") {
      const until = dayOf(bill.discount.deadline);
      const live = discountApplies(bill.discount, new Date(`${today}T12:00:00.000Z`));
      if (until !== null && live) {
        const value = round6(bill.amount - paysOn(bill.amount, bill.discount, until));
        // A bill short on its day is not paid then: a discount ending that day is not taken (P5).
        discount = { pct: bill.discount.pct, value, until, taken: on !== null && on <= until && short === undefined };
      }
    }
    const tried = outcome.get(id);
    const dueOn = draft.line.dueOn;
    if (bill?.discount && discount && dueOn && on !== null && (tried || (draft.keptByAgent && on !== dueOn))) {
      const terms = `the ${bill.discount.pct}% early-payment discount (${usdc(discount.value)})`;
      const when = on === today ? "today" : `on ${dayWords(on)}`;
      // Said of the plan as a whole: the first day from this one that its balance is under the cushion, if any.
      const under = days.find((day) => day >= on && balanceOn(current, day) + EPSILON < input.cushion);
      const above = `the balance stays above the cushion${under !== undefined ? ` until ${dayWords(under)}` : ""}`;
      // The day it pays without the discount: its due date, or the agent's own earlier day.
      const otherwise = (day: string) => (day === dueOn ? `on its due date, ${dayWords(dueOn)}` : `on ${dayWords(day)}, as the agent scheduled it`);
      if (tried && !tried.taken) {
        reason = `Pays ${otherwise(on)}: paying on ${dayWords(draft.deadlineOn!)} for the ${bill.discount.pct}% discount (${usdc(discount.value)}) ${tried.why}.`;
      } else if (tried?.taken) {
        reason = tried.freed
          ? `Pays ${when}, the discount's last day, to take ${terms}: ${otherwise(draft.defaultOn!)}, the cash would not cover it.`
          : `Pays ${when}, the discount's last day, to take ${terms}; ${above}.`;
      } else {
        // The agent's own day, kept whatever the cushion: a payment is never moved later only to protect it (P4, P5).
        const head =
          on === discount.until
            ? `Pays ${when}, the discount's last day, as the agent scheduled it, to take ${terms}`
            : `Pays ${when}, as the agent scheduled it, to take ${terms}, which lasts until ${dayWords(discount.until)}`;
        reason =
          short !== undefined
            ? `${head}.`
            : under !== undefined && under < dueOn
              ? `${head}. The balance goes under the cushion on ${dayWords(under)}; the plan never moves a payment later only to protect the cushion.`
              : `${head}; ${above}.`;
      }
    }
    if (on !== null && inWindow) {
      if (short !== undefined) flags.push({ code: "short", blocks: true, text: `Short by ${usdc(short)} on ${dayWords(on)}: the agent holds it until there is cash.` });
      const below = current.belowCushion.get(id);
      if (below !== undefined) flags.push({ code: "below_cushion", blocks: false, text: `Leaves ${usdc(below)} less than the cushion on ${dayWords(on)}.` });
      if (current.overLimit.has(id)) {
        flags.push({ code: "over_agent_limit", blocks: true, text: `Above what the agent may pay on its own on ${dayWords(on)}: it waits for a person's approval.` });
      }
    }
    flags.push(...draft.caps);
    // Never out of the window (P9): a bill whose plan day falls after it keeps the agent's day (billDraft).
    const move =
      bill !== null &&
      draft.line.state === "planned" &&
      bill.status === "scheduled" &&
      draft.line.agentOn !== null &&
      draft.line.agentOn > today &&
      on !== null &&
      inWindow &&
      on !== draft.line.agentOn
        ? { from: draft.line.agentOn, to: on }
        : null;
    const approvable = move !== null && !flags.some((flag) => flag.blocks && BLOCKING.has(flag.code));
    const fingerprint = planHash(
      JSON.stringify([
        draft.line.kind,
        id,
        draft.line.status,
        draft.line.amount,
        bill?.currency ?? "USDC",
        draft.line.counterpartyId,
        bill?.payeeAddress ?? null,
        draft.line.dueOn,
        draft.line.agentOn,
        bill?.discount ? [bill.discount.pct, dayOf(bill.discount.deadline)] : null,
        draft.line.createdBy,
        // A payee screened high risk, or a payment limit changed, after the plan was shown changes what may be approved.
        [draft.payeeChecks.paymentLimit, draft.payeeChecks.riskLevel],
        on,
        pays,
      ])
    );
    sortKey.set(id, { day: on ?? "9999-12-31", group: draft.group });
    return {
      ...draft.line,
      on,
      inWindow,
      pays,
      discount,
      reason,
      flags,
      balanceAfter: on !== null && inWindow ? (current.balanceAfter.get(id) ?? null) : null,
      agentPays: current.agentPays.has(id),
      move,
      approvable,
      fingerprint,
    };
  });

  // In the order the cash goes: by day, then as the simulation pays them; what is not counted last.
  const placementRank = new Map(place(planDay(chosen)).sort(placementOrder).map((placement, index) => [placement.draft.line.id, index]));
  lines.sort((a, b) => {
    const keyA = sortKey.get(a.id)!;
    const keyB = sortKey.get(b.id)!;
    if (keyA.day !== keyB.day) return keyA.day < keyB.day ? -1 : 1;
    const rankA = placementRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rankB = placementRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return keyA.group - keyB.group || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  // The days anything is counted on, in the plan or as scheduled now: a day whose only bill is short is one too.
  const landing = new Set([...place(planDay(chosen)), ...place(nowDay)].map((placement) => placement.day));
  const active = days.filter((day) => landing.has(day));
  const planDays: PlanDay[] = active.map((day) => ({
    day,
    out: current.dayOut.get(day) ?? 0,
    balance: current.dayBalance.get(day) ?? cash,
    balanceNow: now.dayBalance.get(day) ?? cash,
  }));
  const lowestOf = (pick: (planDay: PlanDay) => number) =>
    planDays.reduce<{ day: string; balance: number } | null>((low, planDay) => (low === null || pick(planDay) < low.balance ? { day: planDay.day, balance: pick(planDay) } : low), null);

  const freshness = planFreshness(input.balance, input.unread, input.now);
  const budget = input.limits.budget;
  const fingerprint = planHash(
    JSON.stringify([
      today,
      round6(input.operatingUsdc),
      round6(input.reserveUsdc),
      input.reserveApy,
      round6(input.cushion),
      budget ? [budget.dailyUsdc, budget.weeklyUsdc, budget.spentToday, budget.spentThisWeek] : null,
      input.limits.twoApprovalsAbove,
      lines.map((planLine) => planLine.fingerprint),
    ])
  );

  return {
    today,
    through,
    cash,
    operating: round6(input.operatingUsdc),
    reserve: round6(input.reserveUsdc),
    cushion: round6(input.cushion),
    lines,
    days: planDays,
    lowest: lowestOf((planDay) => planDay.balance),
    lowestNow: lowestOf((planDay) => planDay.balanceNow),
    stillOwed: current.stillOwed,
    stillOwedNow: now.stillOwed,
    discountsPlanned: round6(
      lines.filter((planLine) => planLine.discount?.taken && planLine.inWindow && !planLine.flags.some((flag) => flag.code === "short")).reduce((sum, planLine) => sum + planLine.discount!.value, 0)
    ),
    eurc,
    moves: lines.filter((planLine) => planLine.approvable).length,
    freshness,
    blocked: freshness.blocked,
    fingerprint,
    incoming: incomingOf(input.incoming, today, through),
  };
}

/** What is expected in within the window, each on its due day, today when past; nothing else of the plan reads it. */
function incomingOf(incoming: PlanIncomingInput | undefined, today: string, through: string): PlanIncoming {
  const within = (rows: IncomingInput[]): IncomingLine[] =>
    rows
      .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.dueOn) && row.dueOn <= through && row.amount > 0)
      .map((row) => ({ id: row.id, from: row.from, what: row.what, amount: row.amount, currency: row.currency, on: later(row.dueOn, today), overdue: row.dueOn < today }))
      .sort((a, b) => (a.on !== b.on ? (a.on < b.on ? -1 : 1) : a.id < b.id ? -1 : 1));
  const expected = within(incoming?.receivables ?? []);
  const planned = within(incoming?.planned ?? []);
  const usdcOf = (lines: IncomingLine[]) => round6(lines.filter((line) => line.currency === "USDC").reduce((sum, line) => sum + line.amount, 0));
  return { expected, planned, expectedUsdc: usdcOf(expected), plannedUsdc: usdcOf(planned), plannedRead: incoming?.planned !== null };
}
