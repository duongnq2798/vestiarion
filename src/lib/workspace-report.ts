import { HELD_FOR_VERDICT } from "./agent/shadow-hold";
import { heldWords } from "./latest-decision";
import type { Network } from "./network";
import { ruleInBrief } from "./next-step";

/**
 * The workspace report (docs/superpowers/specs/2026-10-09-workspace-report-design.md): what the agent did with the
 * workspace's real bills since it opened, counted from its ledger and its confirmed transfers. Pure: the facts come in
 * already read (`readReportFacts` in ./workspace-report-read), so every rule here is tested on hand-made rows.
 */

/** A payable. Its counterparty says whether it is sample data, and whether it is paid at a mirror address (S7). */
export interface ReportBill {
  id: string;
  createdAt: string;
  dueDate: string | null;
  amount: number;
  currency: string;
  status: string;
  reviewedBy: string | null;
  /**
   * What left when it was paid (`paid_amount`, 0038), written with the transfer that went through. The payment intent
   * keeps the amount of its first try, which a resend after the discount deadline does not change.
   */
  paidAmount: number | null;
  /** The early-payment discount its terms carry (`invoiceDiscount`), or null. */
  discount: { pct: number; deadline: string } | null;
  /** The bill as it was written, when it was in a currency of its own (shadow mode S6). */
  bill: { amount: number; currency: string } | null;
  payee: { id: string; name: string; mirror: boolean; sample: boolean };
}

/** One of the agent's AP decisions about a payable, from its ledger entry. */
export interface ReportDecision {
  seq: number;
  ts: string;
  action: string;
  invoiceId: string;
  guardrailBlocked: boolean;
  guardrailRule: string | null;
  heldBecause: string | null;
  resultingStatus: string | null;
  /** Decided in shadow mode (`detail.shadow`). */
  shadow: boolean;
  reasoning: string | null;
}

/** A person's approve, reject or return of a payable. */
export interface ReportPersonAction {
  seq: number;
  ts: string;
  action: "approval_paid" | "approval_rejected" | "approval_returned";
  invoiceId: string;
}

export interface ReportVerdict {
  entrySeq: number;
  verdict: "agree" | "disagree";
}

/** A payable's confirmed live Circle payment: what the transfer carried, its transaction, and when it settled. */
export interface ReportPayment {
  invoiceId: string;
  amount: number;
  token: string;
  txHash: string | null;
  at: string;
}

export interface ReportFacts {
  network: Network;
  /** The workspace's first ledger entry; null when it has none yet. */
  openedAt: string | null;
  shadow: { currency: string; startedAt: string } | null;
  bills: ReportBill[];
  decisions: ReportDecision[];
  personActions: ReportPersonAction[];
  verdicts: ReportVerdict[];
  payments: ReportPayment[];
}

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

/** Refused by code, waited for something outside the bill, the agent's own call, or a payment it made that was not sent. */
export type StopKind = "code" | "waited" | "agent" | "notSent";

export interface StoppedRow {
  invoiceId: string;
  at: string;
  payee: string;
  amount: number;
  currency: string;
  kind: StopKind;
  why: string;
  /** What happened to the bill since: paid (by anyone), its transfer in flight, rejected, or still open. */
  since: "paid" | "paying" | "rejected" | "open";
}

export interface PaymentRow {
  invoiceId: string;
  at: string;
  payee: string;
  amount: number;
  token: string;
  bill: { amount: number; currency: string } | null;
  /** Who decided it: the agent alone, a person approving it, or a person's verdict in shadow mode. */
  decidedBy: "agent" | "person" | "verdict";
  /** It mirrors a bill the business paid itself, in shadow mode. */
  mirror: boolean;
  txHash: string | null;
}

export type ReadinessStep =
  | { key: "verdicts"; done: boolean; given: number; target: number }
  | { key: "waiting"; done: boolean; waiting: number }
  | { key: "addresses"; done: boolean; mirrorPayees: number }
  | { key: "mainnet"; done: null };

export interface WorkspaceReport {
  network: Network;
  realMoney: boolean;
  openedAt: string | null;
  shadow: { currency: string; startedAt: string } | null;
  bills: { handled: number; decided: number; medianMinutesToDecision: number | null };
  paid: { count: number; byCurrency: CurrencyAmount[]; onTime: number; untouched: number; mirrored: number };
  stopped: { total: number; byCode: number; waited: number; byAgent: number; notSent: number };
  people: { steppedIn: number };
  verdicts: { agreed: number; disagreed: number; waiting: number } | null;
  discounts: { captured: { count: number; byCurrency: CurrencyAmount[] }; onOffer: { count: number; byCurrency: CurrencyAmount[] } };
  stoppedList: StoppedRow[];
  paymentList: PaymentRow[];
  readiness: ReadinessStep[] | null;
}

/** How many verdicts we suggest before a slice of real USDC: the shadow mode done-when (SM1). */
export const VERDICTS_BEFORE_LIVE = 5;
const LIST_LENGTH = 10;
const STOPPED_STATUSES = new Set(["held", "flagged", "awaiting_info"]);
/** Holds for a reason outside the bill: no cash, the agent paused, or the spending limit full for the day. */
const WAIT_MARKERS = new Set(["cash_shortfall", "agent_paused", "outflow_budget"]);
const AGENT_CALL: Record<string, string> = {
  ap_hold: "it held the bill for a person to look at",
  ap_flag_fraud: "it flagged the bill",
  ap_request_info: "it asked for more information",
};

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const utcDate = (iso: string) => iso.slice(0, 10);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Sums per currency, in the order each currency first appears. */
function byCurrency(items: CurrencyAmount[]): CurrencyAmount[] {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(item.currency, round6((sums.get(item.currency) ?? 0) + item.amount));
  return [...sums].map(([currency, amount]) => ({ currency, amount }));
}

/** The first sentence of the agent's reasoning. */
function firstSentence(text: string | null): string | null {
  if (!text || text.trim() === "") return null;
  return (text.trim().split(/(?<=[.!?])\s/)[0] ?? text).trim();
}

/** A held for a verdict in shadow mode: a person decides it by design, so it is no stop. */
const heldForVerdict = (decision: ReportDecision) => decision.heldBecause === HELD_FOR_VERDICT;

function stopOf(decision: ReportDecision): { kind: StopKind; why: string } | null {
  if (heldForVerdict(decision)) return null;
  const stopped = STOPPED_STATUSES.has(decision.resultingStatus ?? "") || decision.guardrailBlocked;
  if (!stopped) return null;
  // A wait first: the spending limit's hold is set by code too, but it lifts by itself once the limit has room.
  if (decision.heldBecause && WAIT_MARKERS.has(decision.heldBecause)) {
    return { kind: "waited", why: heldWords(decision.heldBecause) ?? "It waited for a reason outside the bill." };
  }
  if (decision.guardrailBlocked) return { kind: "code", why: `Code refused it: ${ruleInBrief(decision.guardrailRule) ?? "a hard limit in code"}.` };
  if (AGENT_CALL[decision.action]) {
    return { kind: "agent", why: `The agent's call: ${firstSentence(decision.reasoning) ?? `${AGENT_CALL[decision.action]}.`}` };
  }
  // The agent decided to pay and passed every check, but the transfer was not made: Circle refused it, or it failed.
  return { kind: "notSent", why: "The agent decided to pay, and the transfer did not go through." };
}

export function buildReport(facts: ReportFacts): WorkspaceReport {
  const bills = facts.bills.filter((bill) => !bill.payee.sample);
  const billsById = new Map(bills.map((bill) => [bill.id, bill]));
  const decisions = facts.decisions.filter((decision) => billsById.has(decision.invoiceId)).sort((a, b) => a.seq - b.seq);
  const actions = facts.personActions.filter((action) => billsById.has(action.invoiceId)).sort((a, b) => a.seq - b.seq);
  // What a paid bill's transfer carried: the bill's own record of it, else the intent's first amount.
  const payments = facts.payments
    .filter((payment) => billsById.has(payment.invoiceId))
    .map((payment) => ({ ...payment, amount: billsById.get(payment.invoiceId)!.paidAmount ?? payment.amount }));
  // Verdicts on the agent's decisions about real bills only.
  const decisionSeqs = new Set(decisions.map((decision) => decision.seq));
  const verdicts = facts.verdicts.filter((verdict) => decisionSeqs.has(verdict.entrySeq));
  const verdictBySeq = new Map(verdicts.map((verdict) => [verdict.entrySeq, verdict.verdict]));

  const decisionsOf = new Map<string, ReportDecision[]>();
  for (const decision of decisions) decisionsOf.set(decision.invoiceId, [...(decisionsOf.get(decision.invoiceId) ?? []), decision]);
  const actionsOf = new Map<string, ReportPersonAction[]>();
  for (const action of actions) actionsOf.set(action.invoiceId, [...(actionsOf.get(action.invoiceId) ?? []), action]);
  const paymentOf = new Map(payments.map((payment) => [payment.invoiceId, payment]));

  // How long a bill waited for the agent's first word on it.
  const minutes = [...decisionsOf].map(([invoiceId, list]) => Math.max(0, (Date.parse(list[0].ts) - Date.parse(billsById.get(invoiceId)!.createdAt)) / 60_000));

  // A person stepped in when they approved, rejected or returned a bill the agent had not simply left to their verdict.
  const steppedIn = new Set<string>();
  for (const action of actions) {
    const before = (decisionsOf.get(action.invoiceId) ?? []).filter((decision) => decision.seq < action.seq).at(-1);
    if (!before || !heldForVerdict(before)) steppedIn.add(action.invoiceId);
  }

  const hasVerdict = (invoiceId: string) => (decisionsOf.get(invoiceId) ?? []).some((decision) => verdictBySeq.has(decision.seq));
  // A person agreed with the agent's decision to pay (held for the verdict, or by a check in code): the payment is theirs
  // by verdict. Agreeing that it should hold a bill, then paying it, is a person's decision.
  const agreedToPay = (invoiceId: string) =>
    (decisionsOf.get(invoiceId) ?? []).some((decision) => (decision.action === "ap_pay" || decision.action === "ap_schedule") && verdictBySeq.get(decision.seq) === "agree");
  const mirrored = (payment: ReportPayment) =>
    (decisionsOf.get(payment.invoiceId) ?? []).some((decision) => decision.shadow) ||
    hasVerdict(payment.invoiceId) ||
    (facts.shadow !== null && Date.parse(payment.at) >= Date.parse(facts.shadow.startedAt));

  const paymentRows: PaymentRow[] = payments.map((payment) => {
    const bill = billsById.get(payment.invoiceId)!;
    const decidedBy = agreedToPay(payment.invoiceId)
      ? "verdict"
      : (actionsOf.get(payment.invoiceId) ?? []).some((action) => action.action === "approval_paid")
        ? "person"
        : "agent";
    return {
      invoiceId: payment.invoiceId,
      at: payment.at,
      payee: bill.payee.name,
      amount: payment.amount,
      token: payment.token,
      bill: bill.bill,
      decidedBy,
      mirror: mirrored(payment),
      txHash: payment.txHash,
    };
  });

  const stoppedRows: StoppedRow[] = [];
  for (const [invoiceId, list] of decisionsOf) {
    const newestStop = [...list].reverse().map((decision) => ({ decision, stop: stopOf(decision) })).find((item) => item.stop !== null);
    if (!newestStop?.stop) continue;
    const bill = billsById.get(invoiceId)!;
    stoppedRows.push({
      invoiceId,
      at: newestStop.decision.ts,
      payee: bill.payee.name,
      amount: bill.amount,
      currency: bill.currency,
      kind: newestStop.stop.kind,
      why: newestStop.stop.why,
      since:
        paymentOf.has(invoiceId) || bill.status === "paid"
          ? "paid"
          : bill.status === "matched" || bill.status === "processing"
            ? "paying"
            : bill.status === "rejected"
              ? "rejected"
              : "open",
    });
  }

  const captured = payments.flatMap((payment) => {
    const bill = billsById.get(payment.invoiceId)!;
    const off = round6(bill.amount - payment.amount);
    return bill.discount && payment.token === bill.currency && off > 0 ? [{ currency: bill.currency, amount: off }] : [];
  });
  const onOffer = bills.flatMap((bill) => (bill.discount ? [{ currency: bill.currency, amount: round6((bill.amount * bill.discount.pct) / 100) }] : []));

  // The bills whose newest decision since shadow mode started waits for a verdict, as the console counts them (S5).
  const waiting = facts.shadow
    ? [...decisionsOf.values()]
        .map((list) => list.at(-1)!)
        .filter((newest) => Date.parse(newest.ts) >= Date.parse(facts.shadow!.startedAt) && !verdictBySeq.has(newest.seq)).length
    : 0;
  const agreed = verdicts.filter((verdict) => verdict.verdict === "agree").length;
  const disagreed = verdicts.length - agreed;
  const mirrorPayees = new Set(bills.filter((bill) => bill.payee.mirror).map((bill) => bill.payee.id)).size;

  return {
    network: facts.network,
    realMoney: facts.network === "arc-mainnet",
    openedAt: facts.openedAt,
    shadow: facts.shadow,
    bills: { handled: bills.length, decided: decisionsOf.size, medianMinutesToDecision: median(minutes) },
    paid: {
      count: payments.length,
      byCurrency: byCurrency(payments.map((payment) => ({ currency: payment.token, amount: payment.amount }))),
      onTime: payments.filter((payment) => {
        const due = billsById.get(payment.invoiceId)!.dueDate;
        return due !== null && utcDate(payment.at) <= utcDate(due);
      }).length,
      untouched: payments.filter((payment) => !actionsOf.has(payment.invoiceId) && billsById.get(payment.invoiceId)!.reviewedBy === null).length,
      mirrored: paymentRows.filter((row) => row.mirror).length,
    },
    stopped: {
      total: stoppedRows.length,
      byCode: stoppedRows.filter((row) => row.kind === "code").length,
      waited: stoppedRows.filter((row) => row.kind === "waited").length,
      byAgent: stoppedRows.filter((row) => row.kind === "agent").length,
      notSent: stoppedRows.filter((row) => row.kind === "notSent").length,
    },
    people: { steppedIn: steppedIn.size },
    verdicts: facts.shadow || verdicts.length > 0 ? { agreed, disagreed, waiting } : null,
    discounts: {
      captured: { count: captured.length, byCurrency: byCurrency(captured) },
      onOffer: { count: onOffer.length, byCurrency: byCurrency(onOffer) },
    },
    stoppedList: stoppedRows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LIST_LENGTH),
    paymentList: paymentRows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LIST_LENGTH),
    readiness: facts.shadow
      ? [
          { key: "verdicts", done: agreed + disagreed >= VERDICTS_BEFORE_LIVE, given: agreed + disagreed, target: VERDICTS_BEFORE_LIVE },
          { key: "waiting", done: waiting === 0, waiting },
          { key: "addresses", done: mirrorPayees === 0, mirrorPayees },
          { key: "mainnet", done: null },
        ]
      : null,
  };
}
