import { latestDecision } from "../added-details";
import { cashOutlook } from "../cash-outlook";
import { outlookInputOf } from "../cash-outlook-input";
import { db, unwrap } from "../dal";
import { firstSentence } from "../email/waiting-digest";
import { listLedgerEntriesForTargets, type LedgerEntry } from "../ledger";
import { codeStoppedLine, stopRuleOf } from "../next-step";
import { listAccounts, listInvoices, listMilestones } from "../queries";
import { awaitingVerdicts } from "../verdicts";

/**
 * What /today and /waiting say (Telegram bot design R9), read in the workspace's scope and worked out by code the way
 * the console works it out: safe to spend today from the same cash outlook, and the payments a person must decide.
 */

export interface TodayFacts {
  safeToSpend: number;
  cash: number;
  /** The USYC reserve's value in USDC, counted in safe to spend: it comes back to the wallet within seconds. */
  reserve: number;
  dueIn30d: number;
  /** EURC payables due within 30 days, paid from EURC and so outside the figure. */
  eurcLeftOut: number;
  /** The first day the wallet would run short before any receivable arrives; null when it never does. */
  shortOn: string | null;
  /** Payables held, flagged or waiting for information, and milestones held. */
  waiting: number;
  /** The next three payments the agent scheduled, soonest first. */
  scheduled: Array<{ name: string; amount: number; currency: string; on: string }>;
  lastCycleAt: string | null;
}

export interface WaitingFact {
  kind: "payable" | "milestone";
  id: string;
  name: string;
  amount: number;
  currency: string;
  status: string;
  /**
   * Why it waits: for a payable code stopped, "Code stopped it: …", as its row on Bills says it
   * (docs/superpowers/specs/2026-10-24-chat-code-stop-reason-design.md CS4); else the first sentence of the agent's
   * reasoning, without a bracketed guardrail note.
   */
  reason: string | null;
  /** Held in shadow mode for a person's verdict, which is given in Vestiarion (shadow mode S4); absent otherwise. */
  forVerdict?: true;
}

const WAITING_PAYABLE = ["held", "flagged", "awaiting_info"] as const;
const SCHEDULED_SHOWN = 3;
/** The most /waiting lists; the console holds the rest. */
export const WAITING_SHOWN = 10;

export async function todayFacts(now: number = Date.now()): Promise<TodayFacts> {
  const [accounts, invoices, milestones, lastCycle] = await Promise.all([
    listAccounts(),
    listInvoices(),
    listMilestones(),
    db().from("ledger_entries").select("ts").eq("action", "cycle_complete").order("seq", { ascending: false }).limit(1),
  ]);
  const payables = invoices.filter((invoice) => invoice.direction === "payable");
  const outlook = cashOutlook(outlookInputOf({ now, accounts, invoices, milestones }));
  const waiting =
    payables.filter((invoice) => (WAITING_PAYABLE as readonly string[]).includes(invoice.status)).length +
    milestones.filter((milestone) => milestone.status === "held").length;
  const scheduled = payables
    .filter((invoice) => invoice.status === "scheduled" && invoice.scheduled_for)
    .sort((a, b) => (a.scheduled_for as string).localeCompare(b.scheduled_for as string))
    .slice(0, SCHEDULED_SHOWN)
    .map((invoice) => ({ name: invoice.counterparty_name, amount: invoice.amount, currency: invoice.currency ?? "USDC", on: (invoice.scheduled_for as string).slice(0, 10) }));

  return {
    safeToSpend: outlook.safeToSpend,
    cash: outlook.cash,
    reserve: outlook.reserve,
    dueIn30d: outlook.dueIn30d,
    eurcLeftOut: outlook.eurcLeftOut,
    shortOn: outlook.shortOn,
    waiting,
    scheduled,
    lastCycleAt: (unwrap(lastCycle) as Array<{ ts: string }>)[0]?.ts ?? null,
  };
}

/** The payables and milestones a person must decide, payables soonest due first, at most `WAITING_SHOWN`. */
export async function waitingFacts(): Promise<WaitingFact[]> {
  const [invoices, milestones] = await Promise.all([
    db()
      .from("invoices")
      .select("id, amount, currency, status, agent_reasoning, due_date, counterparties(name)")
      .eq("direction", "payable")
      .in("status", [...WAITING_PAYABLE])
      .order("due_date", { ascending: true })
      .limit(WAITING_SHOWN),
    db()
      .from("milestones")
      .select("id, title, amount, status, agent_reasoning, counterparties(name)")
      .eq("status", "held")
      .order("created_at", { ascending: true })
      .limit(WAITING_SHOWN),
  ]);
  const payables = (unwrap(invoices) as unknown as Array<{
    id: string;
    amount: number | string;
    currency: string | null;
    status: string;
    agent_reasoning: string | null;
    counterparties: { name: string } | null;
  }>).map<WaitingFact>((row) => ({
    kind: "payable",
    id: row.id,
    name: row.counterparties?.name ?? "a counterparty",
    amount: Number(row.amount),
    currency: row.currency === "EURC" ? "EURC" : "USDC",
    status: row.status,
    reason: firstSentence(row.agent_reasoning),
  }));
  const held = (unwrap(milestones) as unknown as Array<{
    id: string;
    title: string;
    amount: number | string;
    status: string;
    agent_reasoning: string | null;
    counterparties: { name: string } | null;
  }>).map<WaitingFact>((row) => ({
    kind: "milestone",
    id: row.id,
    name: `${row.counterparties?.name ?? "a contractor"}: ${row.title}`,
    amount: Number(row.amount),
    currency: "USDC",
    status: row.status,
    reason: firstSentence(row.agent_reasoning),
  }));
  // Which payables wait for a verdict, said as such, and why code stopped each, from its latest decision, in place of the
  // model's sentence that may say it pays (CS4); best effort, so the list still shows if either cannot be read.
  const [verdicts, entries] = await Promise.all([
    awaitingVerdicts(payables.filter((fact) => fact.status === "held").map((fact) => fact.id)).catch((error: unknown) => {
      console.error("waiting: verdicts not read", error instanceof Error ? error.message : error);
      return new Set<string>();
    }),
    listLedgerEntriesForTargets({ invoiceIds: payables.map((fact) => fact.id) }).catch((error: unknown): LedgerEntry[] => {
      console.error("waiting: why code stopped them was not read", error instanceof Error ? error.message : error);
      return [];
    }),
  ]);
  const marked = payables.map((fact) => {
    const stopped = codeStoppedLine(stopRuleOf(latestDecision(entries, fact.id)?.detail));
    const said = stopped ? { ...fact, reason: stopped } : fact;
    return verdicts.has(fact.id) ? { ...said, forVerdict: true as const } : said;
  });
  return [...marked, ...held].slice(0, WAITING_SHOWN);
}
