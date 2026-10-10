import { agentSide, compareActuals, type ActualsFacts, type AgentStance } from "./actual-payments-compare";
import type { Network } from "./network";
import { reportValue, type BaselineState, type ReportValueGroups } from "./report-value";
import { agreementRate } from "./verdict-rate";
import { buildReport, reportScope, stopOf, type CurrencyAmount, type PaymentRow, type ReportBill, type ReportDecision, type ReportFacts } from "./workspace-report";

/**
 * The shared report (docs/superpowers/specs/2026-10-10-shared-report-design.md S4, S6, S7): what a public link shows of
 * the workspace report, under the options its owner chose. Pure and browser-safe: the facts come in already read
 * (src/lib/platform/shared-report.ts), so every rule about what leaves the workspace is tested on hand-made rows.
 *
 * Never in the view: memos, notes, references, a person's typed reasons, people's names, emails or ids, invoice or
 * supplier ids, addresses, the workspace's id. Supplier names are replaced by stable labels unless the share shows
 * them; amounts are hidden everywhere when the share hides them. The agent's reasoning is its first sentence, at most
 * 200 characters, scrubbed of what the share hides.
 */

export interface ShareOptions {
  names: "labels" | "shown";
  amounts: "shown" | "hidden";
  title: "workspace" | "neutral";
}

/** One decided bill: its newest decision, as a reader may see it. */
export interface SharedDecision {
  /** The decision's entry number, whose signature the reader's browser can check. */
  seq: number;
  at: string;
  supplier: string;
  /** The bill's amount; null when the share hides amounts. */
  amount: CurrencyAmount | null;
  /** Paid on Arc, would pay, scheduled, held or waited (agent vs what really happened's words). */
  stance: Exclude<AgentStance, "none">;
  /** The day a schedule pays on, YYYY-MM-DD. */
  payOn: string | null;
  /** The agent's first sentence, scrubbed; null when it gave none. */
  reasoning: string | null;
  /** Why code held it, or what it waited for, in Vestiarion's fixed words; never the agent's own. */
  rule: string | null;
  verdict: "agree" | "disagree" | null;
  /** The bill's confirmed payment: simulated in a sandbox, with no transaction. */
  payment: { simulated: true } | { simulated: false; txHash: string | null } | null;
}

export interface SharedPayment {
  at: string;
  supplier: string;
  amount: CurrencyAmount | null;
  /** The bill as written in another currency; null when it was in USDC, or when amounts are hidden. */
  bill: CurrencyAmount | null;
  decidedBy: PaymentRow["decidedBy"];
  mirror: boolean;
  simulated: boolean;
  txHash: string | null;
}

export type SharedComparison =
  | { kind: "not_ready" }
  | { kind: "none"; notRecorded: number }
  | { kind: "totals"; compared: number; notRecorded: number; same: number; different: number; medianDays: number | null; daysCompared: number };

export interface SharedReportView {
  /** The workspace's name when the share shows it; otherwise a neutral title. */
  title: string;
  named: boolean;
  options: ShareOptions;
  network: Network;
  /** When this view was computed: it is live, recomputed on each view (S1). */
  computedAt: string;
  /** The workspace's first entry: the period runs from it to `computedAt`. */
  openedAt: string | null;
  /** When the link was made. */
  sharedAt: string;
  realMoney: boolean;
  simulated: boolean;
  source: "real" | "sample";
  shadow: { currency: string; startedAt: string } | null;
  figures: {
    handled: number;
    decided: number;
    medianMinutesToDecision: number | null;
    paid: { count: number; onTime: number; byCurrency: CurrencyAmount[] | null };
    stopped: { total: number; byCode: number; byAgent: number; waited: number; notSent: number };
    verdicts: { agreed: number; disagreed: number; rate: number | null } | null;
  };
  value: ReportValueGroups;
  comparison: SharedComparison;
  decisions: SharedDecision[];
  /** How many bills the agent decided, of which `decisions` lists the newest. */
  decisionCount: number;
  payments: SharedPayment[];
}

export interface SharedReportInput {
  facts: ReportFacts;
  actuals: { available: false } | { available: true; facts: ActualsFacts };
  baseline: BaselineState;
  options: ShareOptions;
  /** The workspace's name, which the lookup gives only when the share shows it. */
  name: string | null;
  sharedAt: string;
  /** Every supplier name the workspace knows: a name outside the report's bills is hidden from the reasoning too. */
  knownNames: readonly string[];
  now: string;
}

export const NEUTRAL_TITLE = "A business on Vestiarion";
export const DECISIONS_SHOWN = 50;
export const REASONING_MAX = 200;
const HIDDEN = "[hidden]";

/** What a share shows, in words, for its ledger entry and its row in the list of live links. */
export function shareOptionWords(options: ShareOptions): string[] {
  return [
    options.names === "shown" ? "supplier names" : "supplier labels",
    options.amounts === "shown" ? "amounts shown" : "amounts hidden",
    options.title === "workspace" ? "the workspace's name as its title" : "a neutral title",
  ];
}

/** "Supplier A" … "Supplier Z", then "Supplier AA", "Supplier AB" … */
export function supplierLabel(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return `Supplier ${letters}`;
}

/** Each supplier's label, by its id, in the order its first bill arrived (then its id): a new bill never moves one. */
function labelsOf(bills: readonly ReportBill[]): Map<string, string> {
  const first = new Map<string, number>();
  for (const bill of bills) {
    const at = Date.parse(bill.createdAt);
    const held = first.get(bill.payee.id);
    if (held === undefined || at < held) first.set(bill.payee.id, at);
  }
  const order = [...first].sort(([idA, atA], [idB, atB]) => atA - atB || (idA < idB ? -1 : idA > idB ? 1 : 0));
  return new Map(order.map(([id], index) => [id, supplierLabel(index)]));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9]/g;
const HEX = /0x[0-9a-fA-F]{4,}/g;
const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * The agent's reasoning as a shared report says it: its first sentence; any email or `0x` address or hash hidden
 * always (S4's "never"); with names hidden, each name in `names` (lower case → its label) replaced and each of `others`
 * hidden, longest first, ignoring case, whole words only; with amounts hidden, every number "#"; then cut to 200
 * characters.
 */
export function scrubReasoning(text: string | null, rules: { names: ReadonlyMap<string, string> | null; others: readonly string[]; hideAmounts: boolean }): string | null {
  if (!text || text.trim() === "") return null;
  let said = (text.trim().split(/(?<=[.!?])\s/)[0] ?? text).trim();
  said = said.replace(EMAIL, HIDDEN).replace(HEX, HIDDEN);
  if (rules.names) {
    const replacements = new Map<string, string>(rules.others.filter((name) => name.trim()).map((name) => [name.trim().toLowerCase(), HIDDEN]));
    for (const [name, label] of rules.names) if (name.trim()) replacements.set(name.trim().toLowerCase(), label);
    const names = [...replacements.keys()].sort((a, b) => b.length - a.length);
    if (names.length > 0) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu");
      said = said.replace(pattern, (match) => replacements.get(match.toLowerCase()) ?? HIDDEN);
    }
  }
  if (rules.hideAmounts) said = said.replace(NUMBER, "#");
  return said.length > REASONING_MAX ? `${said.slice(0, REASONING_MAX - 1).trimEnd()}…` : said;
}

export function buildSharedReport(input: SharedReportInput): SharedReportView {
  const { facts, options } = input;
  const report = buildReport(facts);
  const { source, bills, billsById, decisions, payments } = reportScope(facts);
  const hideAmounts = options.amounts === "hidden";
  const labels = labelsOf(bills);
  const supplierOf = (bill: ReportBill) => (options.names === "shown" ? bill.payee.name : (labels.get(bill.payee.id) ?? supplierLabel(labels.size)));

  // Each supplier's name, lower case, to the label it is shown as; a name shared by two suppliers takes the earlier one's.
  let names: Map<string, string> | null = null;
  if (options.names === "labels") {
    names = new Map();
    const byArrival = [...bills].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const bill of byArrival) {
      const key = bill.payee.name.trim().toLowerCase();
      if (key && !names.has(key)) names.set(key, supplierOf(bill));
    }
  }
  // Every name the workspace knows, its sample data's included, and every bill's payee.
  const others = [...input.knownNames, ...facts.bills.map((bill) => bill.payee.name)];
  const scrub = (text: string | null) => scrubReasoning(text, { names, others, hideAmounts });
  const amountOf = (value: CurrencyAmount) => (hideAmounts ? null : value);

  const verdictOf = new Map(facts.verdicts.map((verdict) => [verdict.entrySeq, verdict.verdict]));
  const paymentOf = new Map(payments.map((payment) => [payment.invoiceId, payment]));
  const decisionsOf = new Map<string, ReportDecision[]>();
  for (const decision of decisions) decisionsOf.set(decision.invoiceId, [...(decisionsOf.get(decision.invoiceId) ?? []), decision]);

  const decided: SharedDecision[] = [...decisionsOf].map(([invoiceId, list]) => {
    const bill = billsById.get(invoiceId)!;
    const newest = list.at(-1)!;
    const payment = paymentOf.get(invoiceId);
    const side = agentSide(list, payment);
    const stance = side.stance === "none" ? "held" : side.stance;
    const stop = stopOf(newest);
    return {
      seq: newest.seq,
      at: newest.ts,
      supplier: supplierOf(bill),
      amount: amountOf({ amount: bill.amount, currency: bill.currency }),
      stance,
      payOn: newest.action === "ap_schedule" && newest.payOn ? newest.payOn.slice(0, 10) : null,
      reasoning: scrub(newest.reasoning),
      rule: (stance === "held" || stance === "waited") && stop && (stop.kind === "code" || stop.kind === "waited") ? stop.why : null,
      verdict: verdictOf.get(newest.seq) ?? null,
      payment: payment ? (payment.simulated ? { simulated: true } : { simulated: false, txHash: payment.txHash }) : null,
    };
  });
  decided.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.seq - a.seq);

  const sharedPayments: SharedPayment[] = report.paymentList.map((row) => {
    const bill = billsById.get(row.invoiceId)!;
    return {
      at: row.at,
      supplier: supplierOf(bill),
      amount: amountOf({ amount: row.amount, currency: row.token }),
      bill: row.bill ? amountOf(row.bill) : null,
      decidedBy: row.decidedBy,
      mirror: row.mirror,
      simulated: row.simulated,
      txHash: row.txHash,
    };
  });

  let comparison: SharedComparison = { kind: "not_ready" };
  if (input.actuals.available) {
    const { totals } = compareActuals(facts, input.actuals.facts);
    comparison =
      totals.compared === 0
        ? { kind: "none", notRecorded: totals.notRecorded }
        : {
            kind: "totals",
            compared: totals.compared,
            notRecorded: totals.notRecorded,
            same: totals.agreed,
            different: totals.disagreed,
            medianDays: totals.medianDays,
            daysCompared: totals.daysCompared,
          };
  }

  const value = reportValue(report, input.baseline);
  const named = options.title === "workspace" && Boolean(input.name?.trim());

  return {
    title: named ? input.name!.trim() : NEUTRAL_TITLE,
    named,
    options,
    network: facts.network,
    computedAt: input.now,
    openedAt: facts.openedAt,
    sharedAt: input.sharedAt,
    realMoney: report.realMoney,
    simulated: report.simulated,
    source,
    shadow: report.shadow,
    figures: {
      handled: report.bills.handled,
      decided: report.bills.decided,
      medianMinutesToDecision: report.bills.medianMinutesToDecision,
      paid: { count: report.paid.count, onTime: report.paid.onTime, byCurrency: hideAmounts ? null : report.paid.byCurrency },
      stopped: report.stopped,
      verdicts: report.verdicts ? { agreed: report.verdicts.agreed, disagreed: report.verdicts.disagreed, rate: agreementRate(report.verdicts) } : null,
    },
    value: {
      measured: { ...value.measured, discountsTaken: { ...value.measured.discountsTaken, byCurrency: hideAmounts ? null : value.measured.discountsTaken.byCurrency } },
      // Who answered is a person: a shared copy never names one.
      estimate: value.estimate.kind === "answered" ? { ...value.estimate, answeredBy: null } : value.estimate,
      notCounted: {
        ...value.notCounted,
        discountsNotTaken: { ...value.notCounted.discountsNotTaken, byCurrency: hideAmounts ? null : value.notCounted.discountsNotTaken.byCurrency },
      },
    },
    comparison,
    decisions: decided.slice(0, DECISIONS_SHOWN),
    decisionCount: decided.length,
    payments: sharedPayments,
  };
}
