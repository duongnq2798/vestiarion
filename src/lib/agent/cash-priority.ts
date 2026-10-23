import crypto from "node:crypto";
import { lateFeeOf, type LateFee } from "./late-fee";

/**
 * Which bill first when the cash cannot cover them all (docs/superpowers/specs/2026-10-18-cash-priority-design.md).
 *
 * When the bills competing for the same cash add up to more than the agent has, the model chooses the order they are
 * paid in, with the written policy's order as its reference (P2), and code keeps each bill in that order while the kept
 * total fits the cash; the rest wait (P3). Pure: the AP stage reads the rows, asks the model and applies the plan.
 */

/** Bills due within this many days, or overdue, compete for the same cash (P1). */
export const PRIORITY_HORIZON_DAYS = 14;

const DAY_MS = 86_400_000;
const CENT_MILLIONTH = 0.0000005;

/** An open payable as the stage reads it. */
export interface PriorityRow {
  id: string;
  status: string;
  amount: number;
  currency: "USDC" | "EURC";
  dueDate: string;
  /** Held, and its latest decision held it for want of cash. */
  heldForCash: boolean;
  /** Paid to a bank account in another token (bank payouts B13). */
  paidToBank: boolean;
  /** Its late fee (late fees LF6); none when absent. */
  lateFee?: LateFee | null;
}

/** A bill competing for the cash, with its due day. */
export interface Competing {
  id: string;
  amount: number;
  /** `YYYY-MM-DD`. */
  dueOn: string;
  status: string;
  /** What its late fee costs in the coming month, in USDC (`lateFeeOf`, late fees LF6); 0 for none. */
  lateFee: number;
}

const dayOf = (value: string): string | null => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
};

/**
 * The bills competing for the same cash (P1): open USDC payables, pending, scheduled, or held for want of cash, due
 * within the horizon or overdue, not paid to a bank account. A bill whose due day cannot be read competes too, as due
 * today: it may well come first.
 */
export function competingBills(rows: readonly PriorityRow[], today: string): Competing[] {
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + PRIORITY_HORIZON_DAYS * DAY_MS).toISOString().slice(0, 10);
  const competing: Competing[] = [];
  for (const row of rows) {
    if (row.currency !== "USDC" || row.paidToBank || !(row.amount > 0)) continue;
    const open = row.status === "pending" || row.status === "scheduled" || (row.status === "held" && row.heldForCash);
    if (!open) continue;
    const dueOn = dayOf(row.dueDate) ?? today;
    if (dueOn > last) continue;
    competing.push({ id: row.id, amount: row.amount, dueOn, status: row.status, lateFee: lateFeeOf({ amount: row.amount, lateFee: row.lateFee ?? null }, today) });
  }
  return competing;
}

/** Whether there is a choice to make (P1): the competing bills add up to more than the cash left after what is committed. */
export function needsPlan(competing: readonly Competing[], cash: number): boolean {
  return competing.reduce((sum, bill) => sum + bill.amount, 0) > cash + CENT_MILLIONTH;
}

/**
 * The written policy's order (P2): among the bills due or overdue, the one whose late fee costs most in the coming month
 * first (late fees LF6); then overdue first, by due day, the smaller first on the same day, then by id.
 */
export function referenceOrder(competing: readonly Competing[], today: string): string[] {
  const due = (bill: Competing) => bill.dueOn <= today;
  return [...competing]
    .sort((a, b) =>
      due(a) && due(b) && Math.abs(a.lateFee - b.lateFee) > CENT_MILLIONTH
        ? b.lateFee - a.lateFee
        : a.dueOn !== b.dueOn
          ? a.dueOn < b.dueOn
            ? -1
            : 1
          : a.amount !== b.amount
            ? a.amount - b.amount
            : a.id < b.id
              ? -1
              : 1
    )
    .map((bill) => bill.id);
}

/**
 * The model's order as code lets it stand (P3): each bill once, in the model's order, unknown and repeated ones dropped,
 * and any it left out appended in the written policy's order. `corrected` says whether code changed anything.
 */
export function boundOrder(modelOrder: readonly string[], reference: readonly string[]): { order: string[]; corrected: boolean } {
  const known = new Set(reference);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of modelOrder) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of reference) if (!seen.has(id)) order.push(id);
  return { order, corrected: order.length !== modelOrder.length || order.some((id, index) => modelOrder[index] !== id) };
}

/**
 * The plan (P3): walking the order, each bill is kept while the kept total fits the cash; one that does not fit waits,
 * and a smaller one after it may still be kept. The agent never keeps more than it has.
 */
export function planFrom(order: readonly string[], competing: readonly Competing[], cash: number): { keep: string[]; wait: string[] } {
  const amount = new Map(competing.map((bill) => [bill.id, bill.amount] as const));
  const keep: string[] = [];
  const wait: string[] = [];
  let kept = 0;
  for (const id of order) {
    const value = amount.get(id) ?? 0;
    if (kept + value <= cash + CENT_MILLIONTH) {
      keep.push(id);
      kept += value;
    } else {
      wait.push(id);
    }
  }
  return { keep, wait };
}

/**
 * What the plan was made from (P5): the competing bills, their ids, amounts and due days, and a late fee's cost in the
 * coming month where there is one, so a fee added or changed asks again (a bill without one reads as before). Statuses
 * are left out, so applying the plan, which moves bills between scheduled, held and pending, does not ask again; so is
 * the cash, which moves with every sweep and every cent of yield: the last plan is reused while its order still splits
 * the bills the same way against the cash there is now (`sameSplit`).
 */
export function planFingerprint(competing: readonly Competing[]): string {
  const bills = [...competing]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((bill) => `${bill.id}:${bill.amount.toFixed(6)}:${bill.dueOn}${bill.lateFee > 0 ? `:${bill.lateFee.toFixed(6)}` : ""}`);
  return crypto.createHash("sha256").update(bills.join("|"), "utf8").digest("hex").slice(0, 32);
}

/** Whether the last plan's order splits the bills the same way against the cash there is now (P5). */
export function sameSplit(plan: PriorityPlan, competing: readonly Competing[], cash: number): boolean {
  const again = planFrom(plan.order, competing, cash);
  return again.keep.length === plan.keep.length && again.keep.every((id, index) => plan.keep[index] === id);
}

/** A plan as the ledger signs it, and as the next cycle reads it back. */
export interface PriorityPlan {
  fingerprint: string;
  /** Every bill, in the agent's order. */
  order: string[];
  keep: string[];
  wait: string[];
  /** Each bill's reason, by id, as the model gave it; the written policy's when it decided. */
  reasons: Record<string, string>;
  /** The member who set this order from the payment plan (order design O3), or null when the agent did. */
  byPerson: string | null;
  /**
   * Each bill's amount and due day as the order was signed, by id, and its late fee's cost when it had one: what a
   * person's order was set for (O4).
   */
  bills: Record<string, { amount: number | null; dueOn: string | null; lateFee?: number }>;
}

/** The last signed plan, when its detail can be read. */
export function planOf(detail: Record<string, unknown> | null | undefined): PriorityPlan | null {
  if (!detail || typeof detail.fingerprint !== "string" || !Array.isArray(detail.order)) return null;
  const order: string[] = [];
  const keep: string[] = [];
  const wait: string[] = [];
  const reasons: Record<string, string> = {};
  const bills: PriorityPlan["bills"] = {};
  for (const item of detail.order as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.invoiceId !== "string") return null;
    order.push(entry.invoiceId);
    (entry.keep === true ? keep : wait).push(entry.invoiceId);
    if (typeof entry.reason === "string") reasons[entry.invoiceId] = entry.reason;
    bills[entry.invoiceId] = {
      amount: typeof entry.amount === "number" ? entry.amount : null,
      dueOn: typeof entry.dueOn === "string" ? entry.dueOn : null,
      ...(typeof entry.lateFee === "number" ? { lateFee: entry.lateFee } : {}),
    };
  }
  const byPerson = detail.decisionMode === "person" && typeof detail.by === "string" ? detail.by : null;
  return { fingerprint: detail.fingerprint, order, keep, wait, reasons, byPerson, bills };
}

/**
 * A person's order still standing for the bills competing now (order design O4): every one of them was in it, at the same
 * amount, due day and late fee, so the order goes on with the bills that left it (paid, or past the window) taken out.
 * Null for an agent's order, or when a bill is new or changed: the agent then orders the bills again.
 */
export function carriedOrder(plan: PriorityPlan, competing: readonly Competing[]): string[] | null {
  if (!plan.byPerson) return null;
  for (const bill of competing) {
    const was = plan.bills[bill.id];
    if (!was || was.amount === null || Math.abs(was.amount - bill.amount) > CENT_MILLIONTH || was.dueOn !== bill.dueOn) return null;
    if (Math.abs((was.lateFee ?? 0) - bill.lateFee) > CENT_MILLIONTH) return null;
  }
  const now = new Set(competing.map((bill) => bill.id));
  return plan.order.filter((id) => now.has(id));
}

/**
 * A reason, or the reasoning, as a person reads it on the payment plan and a waiting bill's card (live test, Oct 18):
 * each ref the model was given ("pairs with B3") becomes the bill it stands for ("Cobalt Cloud 45.00 USDC"), and an
 * amount written with a dollar sign ("$45") is written in USDC, the only currency competing bills are in. A ref it was
 * not given stays as it is.
 */
export function namedRefs(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?USDC\b)?/g, (_match, whole: string, fraction: string | undefined) => `${whole}${fraction ?? ""} USDC`)
    .replace(/\bB\d+\b/g, (ref) => names.get(ref) ?? ref);
}

/**
 * A person's order (order design O3): every competing bill once, in the order given; null when it names a bill that is
 * not competing, leaves one out, or names one twice.
 */
export function personOrder(order: readonly string[], competing: readonly Competing[]): string[] | null {
  const ids = new Set(competing.map((bill) => bill.id));
  if (order.length !== ids.size || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) return null;
  return [...order];
}
