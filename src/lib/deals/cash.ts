import { utcDay } from "../copy";
import { costBasis, costCount, liveCosts, type DealCost } from "./costs";
import { inForce, lineState, type DealFacts, type DealLine } from "./lines";
import { formatMinor } from "./money";
import { addDays, isDay, percentBasisPoints, type DealTemplate } from "./schedule";

/**
 * A deal's cash readiness (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md K4-K8): the money the deal's
 * schedule brings in against what its costs take out, day by day from today, the first day it would be short and by how
 * much, what was collected and paid out to date, and an estimated margin. With a try of a different deposit, never
 * saved. Browser-safe and pure: the deal page works it out as a person moves the levers, the deals list for its badge.
 *
 * Nothing here is cash but what was collected and paid out to date: a planned line is planned, a receivable not paid is
 * expected, and no likelihood is applied to any of them (K5). Nothing that decides or pays reads this module.
 */

export interface CashItem {
  /** The line's or the cost's id. */
  id: string;
  source: "line" | "cost";
  direction: "in" | "out";
  label: string;
  /** What it is now and its day, in words: where the figure comes from. */
  basis: string;
  /** `planned`: a line not invoiced, or a cost with no bill; `expected`: a receivable not paid; `due`: a bill or milestone to pay. */
  kind: "planned" | "expected" | "due";
  amountMinor: number;
  /** Its own day was before today, so it is counted today. */
  late: boolean;
  /** A cost no document backs yet. */
  noDocument: boolean;
}

export interface CashDay {
  /** `YYYY-MM-DD`, today or later. */
  day: string;
  items: CashItem[];
  inMinor: number;
  outMinor: number;
  /** Where the deal stands at the end of the day: everything to date and every day up to this one. */
  positionMinor: number;
}

export type CashMargin =
  | { state: "not_enough_data"; why: "no_costs" | "costs_unread" }
  | {
      state: "estimated";
      /** The deal's total in force: its charges, less any credit owed to the customer. */
      totalMinor: number;
      /** Every cost counted: planned, a bill or milestone to pay, or paid. */
      costsMinor: number;
      marginMinor: number;
      /** The margin in hundredths of a percent of the total; null for a total of zero. */
      basisPoints: number | null;
      costCount: number;
      /** Costs no document backs yet. */
      withoutDocument: number;
    };

export interface CashReadiness {
  today: string;
  currency: string;
  digits: number;
  /** The lines paid by the customer: money that arrived. */
  collected: { totalMinor: number; lines: Array<{ id: string; label: string; amountMinor: number }> };
  /** The costs paid: money that left. */
  paidOut: { totalMinor: number; costs: Array<{ id: string; label: string; amountMinor: number; on: string | null }> };
  /** Collected less paid out. */
  toDateMinor: number;
  /** Only the days money is planned or expected to move, from today. */
  days: CashDay[];
  /** The first day the position is below zero and by how much then, and the deepest gap; null when it never is. */
  short: { day: string; byMinor: number; deepest: { day: string; byMinor: number } } | null;
  /** Where the deal stands once every line and cost is counted. */
  endMinor: number;
  in: { plannedMinor: number; expectedMinor: number };
  out: { plannedMinor: number; dueMinor: number };
  /** Credits owed back to the customer: never money in or out here (deal schedule D8). */
  creditMinor: number;
  /** The costs counted, and whether they could be read at all. */
  costs: { entered: number; read: boolean };
  margin: CashMargin;
}

const dayWords = (day: string) => utcDay(`${day}T00:00:00.000Z`);
const byDay = (a: DealLine, b: DealLine) => a.invoiceOn.localeCompare(b.invoiceOn) || a.position - b.position;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** A charge's money in, as it stands (K4); null for a paid one (collected) and for a credit. */
function lineItem(line: DealLine, today: string): CashItem | null {
  const state = lineState(line, today);
  const base = { id: line.id, source: "line" as const, direction: "in" as const, label: line.label, amountMinor: line.amountMinor, noDocument: false };
  const due = (line.receivable?.dueDate || line.dueOn).slice(0, 10);
  switch (state) {
    case "planned": {
      const late = line.dueOn < today;
      return {
        ...base,
        kind: "planned",
        late,
        basis: `Planned line, invoiced ${dayWords(line.invoiceOn)}, due ${dayWords(line.dueOn)}${late ? " (past its due day: counted today)" : ""}`,
      };
    }
    case "released":
      return { ...base, kind: "expected", late: false, basis: `Invoiced, due ${dayWords(due)}` };
    case "overdue":
      return { ...base, kind: "expected", late: true, basis: `Invoiced, due ${dayWords(due)}, overdue: counted today` };
    case "not_made":
      return { ...base, kind: "expected", late: line.dueOn < today, basis: `Released, its receivable not made yet, due ${dayWords(line.dueOn)}` };
    default:
      return null;
  }
}

/**
 * What a receivable a payment was applied to holds now (allocations L11), in its own currency's micros: its amount, what
 * the customer's payments brought to it, and what it is still owed. A receivable nobody applied money to is absent, and
 * its line counts in full.
 */
export interface ReceivableHeld {
  amount: number;
  paid: number;
  outstanding: number;
}

/**
 * A part of a receivable as the same part of its line, in the deal's minor units, to the nearest: exact for USDC and
 * EURC, in proportion for a shadow deal's currency, whose receivable is in USDC at the day's rate.
 */
function lineShare(lineMinor: number, part: number, whole: number): number {
  if (!(whole > 0) || !(part > 0)) return 0;
  if (part >= whole) return lineMinor;
  const total = BigInt(Math.round(whole));
  return Number((BigInt(lineMinor) * BigInt(Math.round(part)) * BigInt(2) + total) / (total * BigInt(2)));
}

/**
 * The deal's money in and out from today, against its costs (K4). `costs` is null when they could not be read, or before
 * migration 0108: then no cost is counted and the margin is not enough data. `applied` holds, by receivable id, what was
 * applied to a released line's receivable (allocations L11): a part-paid line's arrived part is collected, and only what
 * is still owed is expected, as Treasury and the payment plan count it.
 */
export function dealCashReadiness(
  deal: { facts: DealFacts; digits: number },
  costs: readonly DealCost[] | null,
  today: string,
  applied: Readonly<Record<string, ReceivableHeld>> = {}
): CashReadiness {
  const money = (minor: number) => `${formatMinor(minor, deal.digits)} ${deal.facts.currency}`;
  const lines = inForce(deal.facts.lines);
  const collected: CashReadiness["collected"]["lines"] = [];
  const items: Array<CashItem & { day: string }> = [];
  let creditMinor = 0;
  for (const line of [...lines].sort(byDay)) {
    if (line.kind === "credit") {
      creditMinor += line.amountMinor;
      continue;
    }
    if (lineState(line, today) === "paid") {
      collected.push({ id: line.id, label: line.label, amountMinor: line.amountMinor });
      continue;
    }
    const item = lineItem(line, today);
    if (!item) continue;
    const held = line.receivable ? applied[line.receivable.id] : undefined;
    if (held) {
      // Part paid: what arrived is collected to date, and only what is still owed is expected, once.
      const owed = lineShare(line.amountMinor, held.outstanding, held.amount);
      const arrived = Math.min(line.amountMinor - owed, lineShare(line.amountMinor, held.paid, held.amount));
      if (arrived > 0) collected.push({ id: line.id, label: `${line.label}, part paid`, amountMinor: arrived });
      if (owed <= 0) continue;
      if (owed < line.amountMinor) {
        item.amountMinor = owed;
        item.basis = `${item.basis}, part paid: ${money(owed)} of ${money(line.amountMinor)} still owed`;
      }
    }
    const day = item.late ? today : (line.receivable?.dueDate || line.dueOn).slice(0, 10);
    items.push({ ...item, day: day < today ? today : day });
  }

  const live = costs ? liveCosts(costs) : [];
  const paidOut: CashReadiness["paidOut"]["costs"] = [];
  let costsMinor = 0;
  for (const cost of [...live].sort((a, b) => a.expectedOn.localeCompare(b.expectedOn) || a.createdAt.localeCompare(b.createdAt))) {
    const count = costCount(cost, today);
    if (count.as === "removed") continue;
    costsMinor += count.amountMinor;
    if (count.as === "paid") {
      paidOut.push({ id: cost.id, label: cost.label, amountMinor: count.amountMinor, on: count.on });
      continue;
    }
    items.push({
      id: cost.id,
      source: "cost",
      direction: "out",
      label: cost.label,
      basis: costBasis(cost, count, deal.facts.currency),
      kind: count.as === "due" ? "due" : "planned",
      amountMinor: count.amountMinor,
      late: count.late,
      noDocument: cost.noDocument && !cost.link,
      day: count.day,
    });
  }

  const collectedMinor = sum(collected.map((line) => line.amountMinor));
  const paidOutMinor = sum(paidOut.map((cost) => cost.amountMinor));
  const toDateMinor = collectedMinor - paidOutMinor;

  const byDayMap = new Map<string, CashItem[]>();
  for (const { day, ...item } of items) byDayMap.set(day, [...(byDayMap.get(day) ?? []), item]);
  let position = toDateMinor;
  // Short today already when more was paid out than collected and nothing moves today; a day's own end says it otherwise.
  let short: CashReadiness["short"] = toDateMinor < 0 && !byDayMap.has(today) ? { day: today, byMinor: -toDateMinor, deepest: { day: today, byMinor: -toDateMinor } } : null;
  const days: CashDay[] = [...byDayMap.keys()].sort().map((day) => {
    // Money in first, then out, within a day: the position is the day's end.
    const dayItems = (byDayMap.get(day) ?? []).sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "in" ? -1 : 1));
    const inMinor = sum(dayItems.filter((item) => item.direction === "in").map((item) => item.amountMinor));
    const outMinor = sum(dayItems.filter((item) => item.direction === "out").map((item) => item.amountMinor));
    position += inMinor - outMinor;
    if (position < 0) {
      if (!short) short = { day, byMinor: -position, deepest: { day, byMinor: -position } };
      else if (-position > short.deepest.byMinor) short = { ...short, deepest: { day, byMinor: -position } };
    }
    return { day, items: dayItems, inMinor, outMinor, positionMinor: position };
  });

  const ofKind = (direction: "in" | "out", kind: CashItem["kind"]) => sum(items.filter((item) => item.direction === direction && item.kind === kind).map((item) => item.amountMinor));
  const totalMinor = sum(lines.map((line) => line.amountMinor));
  const margin: CashMargin =
    costs === null
      ? { state: "not_enough_data", why: "costs_unread" }
      : live.length === 0
        ? { state: "not_enough_data", why: "no_costs" }
        : {
            state: "estimated",
            totalMinor,
            costsMinor,
            marginMinor: totalMinor - costsMinor,
            basisPoints: totalMinor > 0 ? Math.round(((totalMinor - costsMinor) * 10_000) / totalMinor) : null,
            costCount: live.length,
            withoutDocument: live.filter((cost) => cost.noDocument && !cost.link).length,
          };

  return {
    today,
    currency: deal.facts.currency,
    digits: deal.digits,
    collected: { totalMinor: collectedMinor, lines: collected },
    paidOut: { totalMinor: paidOutMinor, costs: paidOut },
    toDateMinor,
    days,
    short,
    endMinor: position,
    in: { plannedMinor: ofKind("in", "planned"), expectedMinor: ofKind("in", "expected") },
    out: { plannedMinor: ofKind("out", "planned"), dueMinor: ofKind("out", "due") },
    creditMinor,
    costs: { entered: live.length, read: costs !== null },
    margin,
  };
}

/** A margin in hundredths of a percent, in words: `37.5%`. */
export function percentWords(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

/**
 * The deposit a person may try moving (K7): the first charge in force by invoice day, while it is still planned, on a deal
 * billed as a deposit and balance or whose first line is named as a deposit. A retainer's first month or a milestone is
 * no deposit, and offers no try.
 */
export interface DepositLever {
  lineId: string;
  label: string;
  invoiceOn: string;
  dueOn: string;
  amountMinor: number;
  /** Its share of the charges in force, in hundredths of a percent. */
  basisPoints: number;
  /** The charges in force, the share's base. */
  chargesMinor: number;
}

export function depositLever(facts: DealFacts, template?: DealTemplate): DepositLever | null {
  if (facts.status !== "active") return null;
  const charges = inForce(facts.lines)
    .filter((line) => line.kind === "charge")
    .sort(byDay);
  const first = charges[0];
  if (!first || first.status !== "planned" || charges.length < 2) return null;
  if (template !== "deposit" && !/\bdeposit\b/i.test(first.label)) return null;
  const chargesMinor = sum(charges.map((line) => line.amountMinor));
  return {
    lineId: first.id,
    label: first.label,
    invoiceOn: first.invoiceOn,
    dueOn: first.dueOn,
    amountMinor: first.amountMinor,
    basisPoints: Math.round((first.amountMinor * 10_000) / chargesMinor),
    chargesMinor,
  };
}

export interface DepositTry {
  /** `YYYY-MM-DD`: the deposit's invoice day instead of its own. */
  depositOn?: string;
  /** The deposit's percent of the charges in force, as typed: `50`, `37.5`. */
  depositPct?: string;
}

export type DepositTried =
  | { ok: true; facts: DealFacts; changes: string[] }
  | { ok: false; field: "depositOn" | "depositPct"; message: string };

const latestDay = (startsOn: string) => `${Number(startsOn.slice(0, 4)) + 10}${startsOn.slice(4)}`;

/**
 * The deal as it would be with its deposit moved or set to another percent (K7), and each change in words; nothing is
 * saved. A new percent sets the deposit to that share of the charges in force, and the difference comes off the other
 * planned charges from the last backwards (a line taken to nothing drops out), or goes onto the last one.
 */
export function tryDeposit(facts: DealFacts, change: DepositTry, digits: number, template?: DealTemplate): DepositTried {
  const lever = depositLever(facts, template);
  const money = (minor: number) => `${formatMinor(minor, digits)} ${facts.currency}`;
  if (!lever) return { ok: true, facts, changes: [] };
  const lines = facts.lines.map((line) => ({ ...line }));
  const deposit = lines.find((line) => line.id === lever.lineId) as DealLine;
  const changes: string[] = [];

  const depositOn = change.depositOn?.trim();
  if (depositOn && depositOn !== deposit.invoiceOn) {
    if (!isDay(depositOn) || depositOn < facts.startsOn || depositOn > latestDay(facts.startsOn)) {
      return { ok: false, field: "depositOn", message: "Give a day on or after the deal's start, within ten years of it." };
    }
    deposit.invoiceOn = depositOn;
    deposit.dueOn = addDays(depositOn, facts.termsDays);
    changes.push(`${deposit.label}: invoiced ${dayWords(depositOn)} and due ${dayWords(deposit.dueOn)}, not ${dayWords(lever.invoiceOn)} and ${dayWords(lever.dueOn)}`);
  }

  const pct = change.depositPct?.trim();
  if (pct) {
    const bp = percentBasisPoints(pct);
    if (bp === null) return { ok: false, field: "depositPct", message: "Give the deposit as a percent above 0 and below 100, with at most two decimals." };
    const wanted = Number((BigInt(lever.chargesMinor) * BigInt(bp)) / BigInt(10_000));
    const others = lines
      .filter((line) => line.id !== deposit.id && line.kind === "charge" && line.status === "planned")
      .sort((a, b) => byDay(b, a));
    const room = sum(others.map((line) => line.amountMinor));
    if (wanted < 1) return { ok: false, field: "depositPct", message: "That percent leaves no deposit. Give a larger one." };
    const difference = wanted - deposit.amountMinor;
    if (difference > 0 && difference > room) {
      const most = Math.floor(((deposit.amountMinor + room) * 10_000) / lever.chargesMinor);
      return { ok: false, field: "depositPct", message: `The lines not invoiced yet after the deposit come to ${money(room)}: the deposit can be at most ${percentWords(most)}.` };
    }
    if (difference < 0 && others.length === 0) {
      return { ok: false, field: "depositPct", message: "No line after the deposit is still planned to take the rest. Change the deal instead." };
    }
    if (difference !== 0) {
      const before = new Map(others.map((line) => [line.id, line.amountMinor]));
      changes.push(`${deposit.label}: ${money(wanted)} (${percentWords(bp)}), not ${money(deposit.amountMinor)}`);
      deposit.amountMinor = wanted;
      if (difference > 0) {
        let left = difference;
        for (const line of others) {
          if (left === 0) break;
          const take = Math.min(left, line.amountMinor);
          line.amountMinor -= take;
          left -= take;
          // A line taken to nothing drops out of the try, as a lower price cancels one.
          if (line.amountMinor === 0) line.status = "cancelled";
        }
      } else {
        others[0].amountMinor += -difference;
      }
      for (const line of others) {
        const was = before.get(line.id) as number;
        if (line.amountMinor !== was) changes.push(line.status === "cancelled" ? `${line.label}: nothing left to invoice, not ${money(was)}` : `${line.label}: ${money(line.amountMinor)}, not ${money(was)}`);
      }
    }
  }
  return { ok: true, facts: { ...facts, lines }, changes };
}

/** One badge for the deals list (K8): short and when, no gap, or no cost entered; none for a cancelled deal or unread costs. */
export function cashBadge(readiness: CashReadiness, status: DealFacts["status"]): { label: string; tone: "held" | "proof" | "neutral" } | null {
  if (status !== "active" || !readiness.costs.read) return null;
  if (readiness.short) return { label: `Short ${formatMinor(readiness.short.byMinor, readiness.digits)} ${readiness.currency} on ${dayWords(readiness.short.day)}`, tone: "held" };
  if (readiness.costs.entered === 0) return { label: "No costs entered", tone: "neutral" };
  return { label: "No cash gap", tone: "proof" };
}
