import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import { agreementRate } from "./verdict-rate";
import { VERDICTS_BEFORE_LIVE, type ReportFacts } from "./workspace-report";

/**
 * The autonomy ladder's first step (docs/superpowers/specs/2026-10-26-autonomy-ladder-design.md): how often a person
 * agreed with the agent in shadow mode, by decision kind and by vendor, with the number of verdicts behind each figure,
 * so an owner sees where the agent already decides as they would. It only measures (AL4).
 *
 * Agreement is the shadow-mode verdict and nothing else (AL1): Agree or Disagree on one of the agent's decisions,
 * counted with the one `agreementRate`. Not the model against the written policy, the agent against what the business
 * paid, or /open's flags upheld. Pure and browser-safe: the report page works it out from the facts it already read
 * (`readReportFacts`), so it has no read of its own (AL6).
 */

/** One verdict, with what it is about: the decision's kind and the payable's counterparty. */
export interface LadderVerdict {
  /** The action of the decision the verdict is about, as `decision_verdicts.agent_action` stores it (`ap_pay` …). */
  action: string;
  verdict: "agree" | "disagree";
  vendor: { id: string; name: string; sample: boolean };
}

/** One decision kind's or one vendor's verdicts. */
export interface LadderRow {
  /** The decision kind (`ap_pay` …), or the vendor's counterparty id. */
  key: string;
  /** In plain words: "Pay" …, or the vendor's name. */
  label: string;
  /** Verdicts given in this category: decisions, never bills, since a bill decided twice can carry two (AL3). */
  given: number;
  agreed: number;
  disagreed: number;
  /** The whole percent agreed, once there are enough verdicts to tell; null below (AL4). */
  rate: number | null;
  /** At least `VERDICTS_BEFORE_LIVE` verdicts. */
  enough: boolean;
}

export interface AutonomyLadder {
  given: number;
  agreed: number;
  disagreed: number;
  /** In the agent's own order of its decisions, only those with a verdict (AL5). */
  byKind: LadderRow[];
  /** Most verdicts first, then by name, then by id (AL5). */
  byVendor: LadderRow[];
}

/** Each decision kind in the product's own words: "flag it for review" and "Asked for details" are how it says them (AL2). */
const KIND_LABELS: Record<(typeof AGENT_DECISION_ACTIONS)[number], string> = {
  ap_pay: "Pay",
  ap_schedule: "Schedule",
  ap_hold: "Hold",
  ap_flag_fraud: "Flag for review",
  ap_request_info: "Ask for details",
};

const KIND_ORDER: readonly string[] = AGENT_DECISION_ACTIONS;

/** A decision kind in plain words; one outside the agent's list, which no verdict carries today, as "Another decision". */
export function decisionKindLabel(action: string): string {
  return (KIND_LABELS as Record<string, string>)[action] ?? "Another decision";
}

/**
 * The report's verdicts, each with its decision's kind and its payable's counterparty (AL2, AL3). A verdict whose
 * decision or payable is not among the facts is dropped, as the report's own verdict figures drop it.
 */
export function ladderVerdicts(facts: Pick<ReportFacts, "bills" | "decisions" | "verdicts">): LadderVerdict[] {
  const bills = new Map(facts.bills.map((bill) => [bill.id, bill]));
  const decisions = new Map(facts.decisions.map((decision) => [decision.seq, decision]));
  return facts.verdicts.flatMap((verdict) => {
    const decision = decisions.get(verdict.entrySeq);
    const bill = decision ? bills.get(decision.invoiceId) : undefined;
    if (!decision || !bill) return [];
    return [{ action: decision.action, verdict: verdict.verdict, vendor: { id: bill.payee.id, name: bill.payee.name, sample: bill.payee.sample } }];
  });
}

/** Adds one verdict to its row, made on its first verdict. */
function tally(rows: Map<string, Omit<LadderRow, "rate" | "enough">>, key: string, label: string, verdict: LadderVerdict["verdict"]) {
  const row = rows.get(key) ?? { key, label, given: 0, agreed: 0, disagreed: 0 };
  row.given += 1;
  if (verdict === "agree") row.agreed += 1;
  else row.disagreed += 1;
  rows.set(key, row);
}

/** A rate only from `VERDICTS_BEFORE_LIVE` verdicts: under it, too few to tell (AL4). */
function finished(row: Omit<LadderRow, "rate" | "enough">): LadderRow {
  const enough = row.given >= VERDICTS_BEFORE_LIVE;
  return { ...row, rate: enough ? agreementRate(row) : null, enough };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The ladder from the verdicts, sample vendors left out of every row and total (AL3). */
export function autonomyLadder(verdicts: readonly LadderVerdict[]): AutonomyLadder {
  const real = verdicts.filter((verdict) => !verdict.vendor.sample);
  const kinds = new Map<string, Omit<LadderRow, "rate" | "enough">>();
  const vendors = new Map<string, Omit<LadderRow, "rate" | "enough">>();
  for (const verdict of real) {
    tally(kinds, verdict.action, decisionKindLabel(verdict.action), verdict.verdict);
    tally(vendors, verdict.vendor.id, verdict.vendor.name, verdict.verdict);
  }
  // The agent's own order of its decisions, then any other kind by its id.
  const place = (key: string) => (KIND_ORDER.includes(key) ? KIND_ORDER.indexOf(key) : KIND_ORDER.length);
  const byKind = [...kinds.values()].sort((a, b) => place(a.key) - place(b.key) || byText(a.key, b.key)).map(finished);
  const byVendor = [...vendors.values()]
    .sort((a, b) => b.given - a.given || a.label.localeCompare(b.label, "en") || byText(a.key, b.key))
    .map(finished);
  const agreed = real.filter((verdict) => verdict.verdict === "agree").length;
  return { given: real.length, agreed, disagreed: real.length - agreed, byKind, byVendor };
}
