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
  /** What the bills marked short come to: owed, and not paid on their day. */
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
  /** The plan's day, before any discount is tried: the due date, or today. */
  defaultOn: string | null;
  /** A discount's deadline the plan may pay on instead (P4). */
  deadlineOn: string | null;
  /** Sort order within a day (P5). */
  group: number;
  /** Whether the agent pays it on its own, when nothing stops it (P7). */
  agentEligible: boolean;
  /** Hard caps that stop the agent paying it at all (P7). */
  caps: PlanFlag[];
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
        result.stillOwed = round6(result.stillOwed + pays);
        continue;
      }
      balance = round6(balance - pays);
      out = round6(out + pays);
      result.balanceAfter.set(id, balance);
      if (balance + EPSILON < cushion) result.belowCushion.set(id, round6(cushion - balance));
      if (draft.agentEligible && draft.caps.length === 0) {
        const index = daysBetween(today, day);
        if (pays > roomFor(index) + EPSILON) result.overLimit.add(id);
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

/** The checks that stop the agent paying a bill on its own, whatever the day (P7). */
function capsOf(bill: PlanBill, limits: PlanLimits): PlanFlag[] {
  const caps: PlanFlag[] = [];
  if (bill.paymentLimit !== null && bill.amount > bill.paymentLimit + EPSILON) {
    caps.push({ code: "payment_limit", blocks: true, text: `Above ${bill.payee}'s payment limit of ${usdc(bill.paymentLimit)}: a person approves it.` });
  }
  if (limits.twoApprovalsAbove !== null && bill.amount > limits.twoApprovalsAbove + EPSILON) {
    caps.push({ code: "two_approvals", blocks: true, text: `Above ${usdc(limits.twoApprovalsAbove)}: two people approve it in Approvals.` });
  }
  if (bill.riskLevel === "high") {
    caps.push({ code: "high_risk", blocks: true, text: `${bill.payee} is screened high risk: it is not paid until Compliance clears it.` });
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
  const discountLive = bill.discount !== null && discountApplies(bill.discount, new Date(`${today}T12:00:00.000Z`));
  const deadlineOn = discountLive ? dayOf(bill.discount!.deadline) : null;
  // The yield decides only whether to propose paying early: a bill the agent already scheduled on or before the
  // discount's deadline keeps that day, since the plan never moves a payment later only to earn yield.
  const earlyByAgent = agentOn !== null && deadlineOn !== null && agentOn <= deadlineOn;
  const heldForYield =
    deadlineOn !== null && dueOn !== null && deadlineOn < dueOn && !earlyByAgent ? yieldWins(bill, deadlineOn, dueOn, reserveApy) : null;
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
    group,
    agentEligible: false,
    caps: [],
    ...extra,
  });

  if (bill.status === "flagged") {
    return draft("not_counted", "Flagged for review by the agent: not counted unless a person approves it.", { nowOn: null, defaultOn: null });
  }
  if (bill.status === "matched") return draft("on_its_way", "Payment sent; waiting for confirmation.", { nowOn: today, defaultOn: today });
  if (bill.status === "processing") return draft("waiting", "A person is deciding it now in Approvals; counted today.", { nowOn: today, defaultOn: today });
  if (bill.status === "held" || bill.status === "awaiting_info") {
    const reason =
      bill.status === "held" ? "Waits for a person in Approvals; counted on its due date." : "Waits for details a person adds; counted on its due date.";
    return draft("waiting", reason);
  }

  // pending or scheduled: the plan gives it a day.
  const result = draft("planned", "", {
    nowOn: agentOn !== null ? later(agentOn, today) : dueOrToday,
    deadlineOn: deadlineOn !== null && dueOn !== null && deadlineOn < dueOn && heldForYield === null ? later(deadlineOn, today) : null,
    agentEligible: true,
    caps: capsOf(bill, limits),
  });
  if (dueOn === null) {
    result.line.flags.push({ code: "due_unreadable", blocks: true, text: "Its due date cannot be read: counted today." });
    result.line.reason = "Its due date cannot be read, so it is counted today.";
  } else if (overdue) {
    result.line.reason = `Overdue since ${dayWords(dueOn)}: first in line today.`;
  } else if (dueOn === today) {
    result.line.reason = "Due today.";
  } else if (bill.discount && heldForYield !== null) {
    result.line.reason = `Pays on its due date, ${dayWords(dueOn)}: the reserve's yield until then (${usdc(heldForYield.yieldValue)}) is worth more than the ${bill.discount.pct}% early-payment discount (${usdc(heldForYield.discountValue)}), as the agent decides.`;
  } else if (bill.discount && deadlineOn !== null && deadlineOn === dueOn) {
    const value = round6(bill.amount - paysOn(bill.amount, bill.discount, dueOn));
    result.line.reason = `Pays on its due date, ${dayWords(dueOn)}, which is also the discount's last day (${bill.discount.pct}%, ${usdc(value)}).`;
  } else if (bill.discount && !discountLive) {
    result.line.reason = `Pays on its due date, ${dayWords(dueOn)}; its ${bill.discount.pct}% discount ended ${dayWords(dayOf(bill.discount.deadline) ?? dueOn)}.`;
  } else {
    result.line.reason = `No early-payment discount: pays on its due date, ${dayWords(dueOn)}.`;
  }
  return result;
}

function milestoneDraft(milestone: PlanMilestone, today: string): Draft | null {
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
    group: 1,
    agentEligible: false,
    caps: [],
    ...extra,
  });
  if (milestone.escrowState === "funded") return draft("not_counted", "Its USDC is held in escrow already: not counted again.", { nowOn: null, defaultOn: null });
  if (milestone.status === "verified") return draft("on_its_way", "Verified: the agent releases it at its next cycle.", { agentEligible: true });
  if (milestone.status === "held") return draft("waiting", "Waits for a person in Contractors; counted today.");
  return draft("planned", "Paid once its work is verified; counted today.");
}

/**
 * The plan (P2–P11): each counted line on its day, in the order the cash allows, every discount tried in turn, and the
 * balance after each day beside the balance as the bills are scheduled now.
 */
export function planPayments(input: PaymentPlanInput): PaymentPlan {
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
    const draft = milestoneDraft(milestone, today);
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
  const place = (chosen: Map<string, string>, which: "plan" | "now"): Placement[] =>
    drafts.flatMap((draft) => {
      const day = which === "now" ? draft.nowOn : chosen.get(draft.line.id) ?? draft.defaultOn;
      if (day === null || day > through) return [];
      return [{ draft, day, pays: amountOf(draft, day) }];
    });
  const run = (chosen: Map<string, string>) => simulate(place(chosen, "plan"), cash, input.cushion, input.limits, today, days);

  // Discounts, in order of deadline and then the larger first, each against the plan as it stands (P4).
  const chosen = new Map<string, string>();
  const outcome = new Map<string, { taken: true } | { taken: false; why: string }>();
  let current = run(chosen);
  const candidates = drafts
    .filter((draft) => draft.deadlineOn !== null && draft.bill !== null)
    .map((draft) => ({ draft, value: round6(draft.line.amount - amountOf(draft, draft.deadlineOn!)) }))
    .sort((a, b) => (a.draft.deadlineOn! !== b.draft.deadlineOn! ? (a.draft.deadlineOn! < b.draft.deadlineOn! ? -1 : 1) : b.value - a.value || (a.draft.line.id < b.draft.line.id ? -1 : 1)));
  for (const { draft } of candidates) {
    const on = draft.deadlineOn!;
    const trial = new Map(chosen).set(draft.line.id, on);
    const tried = run(trial);
    const newlyShort = drafts.find((other) => tried.short.has(other.line.id) && !current.short.has(other.line.id));
    // Within the agent's limits too: a discount the agent could not pay on its own that day, or one that would take the
    // room another payment had, is not worth a person's approval.
    const newlyOver = drafts.find((other) => tried.overLimit.has(other.line.id) && !current.overLimit.has(other.line.id));
    const underDay = days.find((day) => day >= on && (tried.dayBalance.get(day) ?? 0) + EPSILON < input.cushion);
    const dayIn = (map: Map<string, string>, which: Draft) => place(map, "plan").find((placement) => placement.draft === which)?.day ?? on;
    if (newlyShort) {
      outcome.set(draft.line.id, { taken: false, why: `would leave ${newlyShort.line.payee} short on ${dayWords(dayIn(trial, newlyShort))}` });
    } else if (newlyOver) {
      const where = dayWords(dayIn(trial, newlyOver));
      outcome.set(draft.line.id, {
        taken: false,
        why: newlyOver === draft ? `would be above what the agent may pay on its own on ${where}` : `would leave ${newlyOver.line.payee} above what the agent may pay on its own on ${where}`,
      });
    } else if (underDay) {
      outcome.set(draft.line.id, { taken: false, why: `would take the balance under the cushion on ${dayWords(underDay)}` });
    } else {
      chosen.set(draft.line.id, on);
      current = tried;
      outcome.set(draft.line.id, { taken: true });
    }
  }

  const now = simulate(place(chosen, "now"), cash, input.cushion, input.limits, today, days);
  const lines: Array<PlanLine & { sortDay: string; group: number }> = drafts.map((draft) => {
    const id = draft.line.id;
    const on = draft.line.state === "not_counted" ? null : chosen.get(id) ?? draft.defaultOn;
    const inWindow = on !== null && on <= through;
    const pays = on === null ? 0 : amountOf(draft, on);
    const flags = [...draft.line.flags];
    let reason = draft.line.reason;
    const bill = draft.bill;
    let discount: PlanLine["discount"] = null;
    if (bill?.discount && draft.line.state === "planned") {
      const until = dayOf(bill.discount.deadline);
      const live = discountApplies(bill.discount, new Date(`${today}T12:00:00.000Z`));
      if (until !== null && live) {
        const value = round6(bill.amount - paysOn(bill.amount, bill.discount, until));
        discount = { pct: bill.discount.pct, value, until, taken: on !== null && on <= until };
      }
    }
    const tried = outcome.get(id);
    if (bill?.discount && tried && draft.line.dueOn) {
      const value = discount?.value ?? 0;
      reason = tried.taken
        ? `Pays ${on === today ? "today" : `on ${dayWords(on!)}`}, the discount's last day, to take the ${bill.discount.pct}% early-payment discount (${usdc(value)}); the balance stays above the cushion.`
        : `Pays on its due date, ${dayWords(draft.line.dueOn)}: paying on ${dayWords(draft.deadlineOn!)} for the ${bill.discount.pct}% discount (${usdc(value)}) ${tried.why}.`;
    }
    if (on !== null && inWindow) {
      const short = current.short.get(id);
      if (short !== undefined) flags.push({ code: "short", blocks: true, text: `Short by ${usdc(short)} on ${dayWords(on)}: the agent holds it until there is cash.` });
      const below = current.belowCushion.get(id);
      if (below !== undefined) flags.push({ code: "below_cushion", blocks: false, text: `Leaves ${usdc(below)} less than the cushion on ${dayWords(on)}.` });
      if (current.overLimit.has(id)) {
        flags.push({ code: "over_agent_limit", blocks: true, text: `Above what the agent may pay on its own on ${dayWords(on)}: it waits for a person's approval.` });
      }
    }
    flags.push(...draft.caps);
    const move =
      bill !== null && draft.line.state === "planned" && bill.status === "scheduled" && draft.line.agentOn !== null && draft.line.agentOn > today && on !== null && on !== draft.line.agentOn
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
        on,
        pays,
      ])
    );
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
      sortDay: on ?? "9999-12-31",
      group: draft.group,
    };
  });

  // In the order the cash goes: by day, then as the simulation pays them; what is not counted last.
  const placementRank = new Map(place(chosen, "plan").sort(placementOrder).map((placement, index) => [placement.draft.line.id, index]));
  lines.sort((a, b) => {
    if (a.sortDay !== b.sortDay) return a.sortDay < b.sortDay ? -1 : 1;
    const rankA = placementRank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rankB = placementRank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.group - b.group || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  // The days anything is counted on, in the plan or as scheduled now: a day whose only bill is short is one too.
  const landing = new Set([...place(chosen, "plan"), ...place(chosen, "now")].map((placement) => placement.day));
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
  const finished: PlanLine[] = lines.map(({ sortDay: _sortDay, group: _group, ...planLine }) => planLine);
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
      finished.map((planLine) => planLine.fingerprint),
    ])
  );

  return {
    today,
    through,
    cash,
    operating: round6(input.operatingUsdc),
    reserve: round6(input.reserveUsdc),
    cushion: round6(input.cushion),
    lines: finished,
    days: planDays,
    lowest: lowestOf((planDay) => planDay.balance),
    lowestNow: lowestOf((planDay) => planDay.balanceNow),
    stillOwed: current.stillOwed,
    stillOwedNow: now.stillOwed,
    discountsPlanned: round6(
      finished.filter((planLine) => planLine.discount?.taken && planLine.inWindow && !planLine.flags.some((flag) => flag.code === "short")).reduce((sum, planLine) => sum + planLine.discount!.value, 0)
    ),
    eurc,
    moves: finished.filter((planLine) => planLine.approvable).length,
    freshness,
    blocked: freshness.blocked,
    fingerprint,
  };
}
