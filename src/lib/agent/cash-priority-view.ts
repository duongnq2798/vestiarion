import { unwrap, type OrgDb } from "../dal";
import { readShadowMode } from "../shadow-mode";
import { planFrom, referenceOrder } from "./cash-priority";
import { readLatestPriority, readPriorityFacts } from "./cash-priority-plan";

/**
 * Which bill first, as the payment plan shows it (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md O1):
 * the latest signed order, when it still covers the bills competing for the cash now (the same fingerprint), each bill
 * with its place, whether the cash covers it today, and its reason; who set it and when; and what the written policy
 * would pay first. Nothing when the cash covers every bill, in shadow mode, or before the agent has ordered these bills.
 */

export interface PriorityBillView {
  id: string;
  payee: string;
  amount: number;
  dueOn: string;
  reason: string;
}

export interface PriorityView {
  fingerprint: string;
  /** The cash the order is applied to today, after what is committed. */
  available: number;
  /** Every competing bill, in the order set. */
  bills: PriorityBillView[];
  /** The member who set it, or null when the agent did. */
  setBy: string | null;
  setAt: string;
  /** The bills the written policy's order would pay first with the same cash, by payee. */
  policyFirst: string[];
}

/** The operating and reserve USDC as the accounts last read them. */
export async function readCashBalances(orgDb: OrgDb): Promise<{ operating: number; reserve: number }> {
  const rows = unwrap(await orgDb.from("accounts").select("kind, balance").in("kind", ["operating", "reserve"])) as Array<{ kind: string; balance: string | number | null }>;
  const sum = (kind: string) => rows.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row.balance ?? 0), 0);
  return { operating: sum("operating"), reserve: sum("reserve") };
}

export async function readPriorityView(orgDb: OrgDb, now: Date = new Date()): Promise<PriorityView | null> {
  if (await readShadowMode(orgDb)) return null;
  const { operating, reserve } = await readCashBalances(orgDb);
  const facts = await readPriorityFacts({ db: orgDb, now, operatingBalance: operating, reserveBalance: reserve });
  if (!facts) return null;
  const latest = await readLatestPriority(orgDb);
  if (!latest || latest.plan.fingerprint !== facts.fingerprint) return null;
  const available = Math.max(0, facts.available);
  const byId = new Map(facts.competing.map((bill) => [bill.id, bill] as const));
  const payee = (id: string) => facts.byId.get(id)?.counterparties?.name ?? "A supplier";
  const policyFirst = planFrom(referenceOrder(facts.competing, facts.today), facts.competing, available).keep.map(payee);
  return {
    fingerprint: facts.fingerprint,
    available,
    bills: latest.plan.order.map((id) => ({
      id,
      payee: payee(id),
      amount: byId.get(id)?.amount ?? 0,
      dueOn: byId.get(id)?.dueOn ?? "",
      reason: latest.plan.reasons[id] ?? "",
    })),
    setBy: latest.plan.byPerson,
    setAt: latest.at,
    policyFirst,
  };
}
