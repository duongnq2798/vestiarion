import type { ActualRecord } from "./actual-payment-fields";
import { HELD_FOR_VERDICT } from "./agent/shadow-hold";
import { billDigits } from "./bill-amount";
import type { Network } from "./network";
import { reportScope, stopOf, WAIT_MARKERS, type CurrencyAmount, type ReportBill, type ReportDecision, type ReportFacts, type ReportPayment } from "./workspace-report";

/**
 * Agent vs what really happened (docs/superpowers/specs/2026-10-10-actual-payments-design.md A7): bill by bill, what the
 * agent decided and paid on Arc next to what the business recorded paying outside Vestiarion. Pure and browser-safe: the
 * report's facts and the records come in already read, so every rule is tested on hand-made rows.
 *
 * A bill with no record says so: nothing here guesses what the business did from a payment on Arc, a verdict or a
 * status. Two currencies are never compared or added together, and USD and USDC are two currencies.
 */

export type { ActualRecord };

export interface ActualsFacts {
  records: ActualRecord[];
  /** The ledger entry that recorded each record, by its id. */
  entries: Map<string, number>;
  /** Each verdict's own `decision_verdict` entry, by the decision entry it is about. */
  verdictEntries: Map<number, number>;
}

/**
 * Where the agent stood on the bill: paid on Arc (a confirmed payment), would pay (it decided to pay and nothing in the
 * bill stopped it), scheduled, held (its own hold, flag or question, or a check in code), waited (for cash, a pause or
 * the spending limit), or no decision yet.
 */
export type AgentStance = "paid" | "pay" | "schedule" | "held" | "waited" | "none";

export interface AgentSide {
  stance: AgentStance;
  /** The agent's newest decision about the bill. */
  decision: { seq: number; ts: string; action: string } | null;
  /** Why it held or waited, in plain words. */
  why: string | null;
  /** The bill's confirmed payment on Arc: simulated in a sandbox, where it has no transaction. */
  payment: { at: string; amount: number; token: string; txHash: string | null; simulated: boolean } | null;
  /** The day it is compared on, YYYY-MM-DD: the earliest day the agent decided to pay it, else the day it was paid on Arc. */
  day: string | null;
  dayKind: "decided" | "scheduled" | "paidOnArc" | null;
}

export type ComparisonFlag = "held_but_paid" | "paid_not_paid" | "amount_differs";

export interface ComparisonRow {
  invoiceId: string;
  payee: string;
  dueDate: string | null;
  /** The bill in its own currency: as written, when it was in a currency of its own; else the invoice's amount. */
  bill: CurrencyAmount;
  agent: AgentSide;
  /** The verdict on the newest of the agent's decisions that has one, and the entry that recorded it. */
  verdict: { verdict: "agree" | "disagree"; decisionSeq: number; entrySeq: number | null } | null;
  /** The bill's newest record, with the ledger entry that recorded it; null when none is recorded. */
  actual: (ActualRecord & { entrySeq: number | null }) | null;
  /** How many earlier records the newest one corrects. */
  corrections: number;
  /** The business's paid day less the agent's day: positive when the agent was earlier. */
  daysDiff: number | null;
  /** What the business paid against what Arc carried, or the bill, in the same currency; null when no figure is in it. */
  amount: { business: number; against: number; currency: string; of: "arc" | "bill"; differs: boolean } | null;
  flags: ComparisonFlag[];
  /** Whether the agent and the business did the same: both paid it, or neither did. Null when there is nothing to compare. */
  agrees: boolean | null;
  discount: {
    pct: number;
    /** The last day of the discount, YYYY-MM-DD. */
    deadline: string;
    /** Estimated, from the terms: the bill in its own currency times the percent. */
    onOffer: CurrencyAmount;
    /** Measured: the bill less what its transfer carried. */
    agent: CurrencyAmount | null;
    /** Measured: the bill less what the business recorded paying, by the deadline, up to the discount on offer. */
    business: CurrencyAmount | null;
    /** Whether the business paid it on or before the deadline; null when it recorded no payment. */
    businessInTime: boolean | null;
  } | null;
}

export interface ComparisonTotals {
  /** Bills with a decision of the agent's and a record of what the business did. */
  compared: number;
  /** Bills with a decision of the agent's and no record yet. */
  notRecorded: number;
  agreed: number;
  disagreed: number;
  /** The median of the days between them, positive when the agent was earlier; null with none to compare. */
  medianDays: number | null;
  daysCompared: number;
  flags: { heldButPaid: number; paidNotPaid: number; amountDiffers: number };
  /** What the business recorded paying, per currency. */
  paidByBusiness: CurrencyAmount[];
  discounts: { agent: CurrencyAmount[]; business: CurrencyAmount[]; onOffer: CurrencyAmount[] };
}

export interface ActualsComparison {
  network: Network;
  /** A sandbox: the agent's payments are simulated. */
  simulated: boolean;
  /** The real bills, or the sample data while the workspace has no real bill. */
  source: "real" | "sample";
  rows: ComparisonRow[];
  totals: ComparisonTotals;
}

const DAY_MS = 86_400_000;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const utcDate = (iso: string) => iso.slice(0, 10);
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
/** Half the currency's smallest unit: two amounts closer than that are the same amount. */
const tolerance = (currency: string) => 0.5 * 10 ** -billDigits(currency);
const roundTo = (value: number, currency: string) => {
  const factor = 10 ** billDigits(currency);
  return Math.round(value * factor) / factor;
};

/** Sums per currency, in the order of their codes. */
function byCurrency(items: CurrencyAmount[]): CurrencyAmount[] {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(item.currency, round6((sums.get(item.currency) ?? 0) + item.amount));
  return [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, amount]) => ({ currency, amount }));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Each bill's newest record, and how many it corrects. A record that no other replaces is the newest; the history is
 * one line (0090's unique indexes), and should two ever stand, the later recorded one is read.
 */
export function currentActuals(records: readonly ActualRecord[]): Map<string, { current: ActualRecord; corrections: number }> {
  const replaced = new Set(records.flatMap((record) => (record.replaces ? [record.replaces] : [])));
  const byId = new Map(records.map((record) => [record.id, record]));
  const current = new Map<string, { current: ActualRecord; corrections: number }>();
  for (const record of records) {
    if (replaced.has(record.id)) continue;
    const held = current.get(record.invoiceId);
    if (held && Date.parse(held.current.recordedAt) >= Date.parse(record.recordedAt)) continue;
    let corrections = 0;
    const seen = new Set<string>([record.id]);
    for (let earlier = record.replaces ? byId.get(record.replaces) : undefined; earlier && !seen.has(earlier.id); earlier = earlier.replaces ? byId.get(earlier.replaces) : undefined) {
      seen.add(earlier.id);
      corrections += 1;
    }
    current.set(record.invoiceId, { current: record, corrections });
  }
  return current;
}

/** A decision that passed every check and was not held for cash, a pause or the spending limit: the agent would pay. */
const decidedToPay = (decision: ReportDecision) =>
  (decision.action === "ap_pay" || decision.action === "ap_schedule") && !decision.guardrailBlocked && !(decision.heldBecause && WAIT_MARKERS.has(decision.heldBecause));

function agentSide(decisions: readonly ReportDecision[], payment: ReportPayment | undefined): AgentSide {
  const newest = decisions.at(-1) ?? null;
  const paidOnArc = payment ? { at: payment.at, amount: payment.amount, token: payment.token, txHash: payment.simulated ? null : payment.txHash, simulated: payment.simulated } : null;

  // The earliest day it decided to pay the bill on: the day of a payment it decided, or the day a schedule pays on.
  const days = decisions.filter(decidedToPay).map((decision) =>
    decision.action === "ap_schedule" && decision.payOn ? { day: decision.payOn.slice(0, 10), kind: "scheduled" as const } : { day: utcDate(decision.ts), kind: "decided" as const }
  );
  const earliest = days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))[0] ?? null;
  const day = earliest ?? (paidOnArc ? { day: utcDate(paidOnArc.at), kind: "paidOnArc" as const } : null);

  let stance: AgentStance = "none";
  let why: string | null = null;
  if (paidOnArc) stance = "paid";
  else if (newest) {
    const stop = stopOf(newest);
    if (!stop) {
      stance = newest.heldBecause === HELD_FOR_VERDICT || newest.action === "ap_pay" ? "pay" : newest.action === "ap_schedule" ? "schedule" : "held";
    } else if (stop.kind === "waited") {
      [stance, why] = ["waited", stop.why];
    } else if (stop.kind === "notSent") {
      // It decided to pay and passed every check; the transfer itself did not go through.
      stance = "pay";
    } else {
      [stance, why] = ["held", stop.why];
    }
  }
  return {
    stance,
    decision: newest ? { seq: newest.seq, ts: newest.ts, action: newest.action } : null,
    why,
    payment: paidOnArc,
    day: day?.day ?? null,
    dayKind: day?.kind ?? null,
  };
}

/** The bill's amount in a currency: as written, when it was written in it, or the invoice's, when that is it. */
function billIn(bill: ReportBill, currency: string): number | null {
  if (bill.bill && bill.bill.currency === currency) return bill.bill.amount;
  if (bill.currency === currency) return bill.amount;
  return null;
}

export function compareActuals(facts: ReportFacts, actuals: ActualsFacts): ActualsComparison {
  const { source, bills, decisions, payments } = reportScope(facts);
  const decisionsOf = new Map<string, ReportDecision[]>();
  for (const decision of decisions) decisionsOf.set(decision.invoiceId, [...(decisionsOf.get(decision.invoiceId) ?? []), decision]);
  const paymentOf = new Map(payments.map((payment) => [payment.invoiceId, payment]));
  const verdictOf = new Map(facts.verdicts.map((verdict) => [verdict.entrySeq, verdict.verdict]));
  const current = currentActuals(actuals.records);

  const rows: ComparisonRow[] = [];
  /** When each bill last moved: added, decided on, or recorded. */
  const lastMoved = new Map<string, number>();
  for (const bill of bills) {
    const list = decisionsOf.get(bill.id) ?? [];
    const recorded = current.get(bill.id);
    if (list.length === 0 && !recorded) continue;
    const agent = agentSide(list, paymentOf.get(bill.id));
    const own: CurrencyAmount = bill.bill ? { amount: bill.bill.amount, currency: bill.bill.currency } : { amount: bill.amount, currency: bill.currency };
    const actual = recorded ? { ...recorded.current, entrySeq: actuals.entries.get(recorded.current.id) ?? null } : null;
    const paidActual = actual?.outcome === "paid" && actual.amount !== null && actual.currency !== null ? { ...actual, amount: actual.amount, currency: actual.currency } : null;

    const withVerdict = [...list].reverse().find((decision) => verdictOf.has(decision.seq));
    const verdict = withVerdict
      ? { verdict: verdictOf.get(withVerdict.seq)!, decisionSeq: withVerdict.seq, entrySeq: actuals.verdictEntries.get(withVerdict.seq) ?? null }
      : null;

    const daysDiff = paidActual?.paidOn && agent.day ? dayNumber(paidActual.paidOn) - dayNumber(agent.day) : null;

    let amount: ComparisonRow["amount"] = null;
    if (paidActual) {
      const arc = agent.payment && agent.payment.token === paidActual.currency ? agent.payment.amount : null;
      const against = arc ?? billIn(bill, paidActual.currency);
      if (against !== null) {
        amount = {
          business: paidActual.amount,
          against,
          currency: paidActual.currency,
          of: arc !== null ? "arc" : "bill",
          differs: Math.abs(paidActual.amount - against) >= tolerance(paidActual.currency),
        };
      }
    }

    const agentPays = agent.stance === "paid" || agent.stance === "pay" || agent.stance === "schedule";
    const flags: ComparisonFlag[] = [];
    if (actual && agent.stance === "held" && actual.outcome === "paid") flags.push("held_but_paid");
    if (actual && agentPays && actual.outcome === "not_paid") flags.push("paid_not_paid");
    if (amount?.differs) flags.push("amount_differs");
    const agrees = !actual ? null : agentPays ? actual.outcome === "paid" : agent.stance === "held" ? actual.outcome === "not_paid" : null;

    let discount: ComparisonRow["discount"] = null;
    if (bill.discount) {
      const deadline = utcDate(bill.discount.deadline);
      const pct = bill.discount.pct;
      const arcOff = agent.payment && agent.payment.token === bill.currency ? round6(bill.amount - agent.payment.amount) : 0;
      let business: CurrencyAmount | null = null;
      const inTime = paidActual?.paidOn ? paidActual.paidOn <= deadline : null;
      if (paidActual && inTime) {
        const full = billIn(bill, paidActual.currency);
        if (full !== null) {
          const off = round6(full - paidActual.amount);
          const offer = (full * pct) / 100;
          // Less than the bill by no more than the discount on offer: the discount; by more, a part payment.
          if (off >= tolerance(paidActual.currency) && off <= offer + tolerance(paidActual.currency)) business = { amount: off, currency: paidActual.currency };
        }
      }
      discount = {
        pct,
        deadline,
        onOffer: { amount: roundTo((own.amount * pct) / 100, own.currency), currency: own.currency },
        agent: arcOff > 0 ? { amount: arcOff, currency: bill.currency } : null,
        business,
        businessInTime: inTime,
      };
    }

    lastMoved.set(bill.id, Math.max(Date.parse(bill.createdAt), ...list.map((decision) => Date.parse(decision.ts)), actual ? Date.parse(actual.recordedAt) : 0));
    rows.push({
      invoiceId: bill.id,
      payee: bill.payee.name,
      dueDate: bill.dueDate,
      bill: own,
      agent,
      verdict,
      actual,
      corrections: recorded?.corrections ?? 0,
      daysDiff,
      amount,
      flags,
      agrees,
      discount,
    });
  }

  // What is worth a look first, then the newest.
  rows.sort(
    (a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0) || lastMoved.get(b.invoiceId)! - lastMoved.get(a.invoiceId)! || (a.invoiceId < b.invoiceId ? -1 : 1)
  );
  const decided = rows.filter((row) => row.agent.stance !== "none");
  const days = rows.flatMap((row) => (row.daysDiff === null ? [] : [row.daysDiff]));

  return {
    network: facts.network,
    simulated: facts.sandbox,
    source,
    rows,
    totals: {
      compared: decided.filter((row) => row.actual !== null).length,
      notRecorded: decided.filter((row) => row.actual === null).length,
      agreed: rows.filter((row) => row.agrees === true).length,
      disagreed: rows.filter((row) => row.agrees === false).length,
      medianDays: median(days),
      daysCompared: days.length,
      flags: {
        heldButPaid: rows.filter((row) => row.flags.includes("held_but_paid")).length,
        paidNotPaid: rows.filter((row) => row.flags.includes("paid_not_paid")).length,
        amountDiffers: rows.filter((row) => row.flags.includes("amount_differs")).length,
      },
      paidByBusiness: byCurrency(rows.flatMap((row) => (row.actual?.outcome === "paid" && row.actual.amount !== null && row.actual.currency ? [{ currency: row.actual.currency, amount: row.actual.amount }] : []))),
      discounts: {
        agent: byCurrency(rows.flatMap((row) => (row.discount?.agent ? [row.discount.agent] : []))),
        business: byCurrency(rows.flatMap((row) => (row.discount?.business ? [row.discount.business] : []))),
        onOffer: byCurrency(rows.flatMap((row) => (row.discount ? [row.discount.onOffer] : []))),
      },
    },
  };
}
