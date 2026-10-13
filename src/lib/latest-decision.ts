import { activityAmount } from "./agent-activity";
import { utcMinute } from "./copy";
import { networkProfile, type Network } from "./network";
import { txUrl } from "./payee-chains";
import { ruleWords } from "./rule-words";
import type { SignedLink } from "./receipts/verify";

/**
 * The landing's latest decision (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R2): the newest decision
 * the agent made in one of the team's own workspaces, said from the entry's recorded facts alone. The entry's summary,
 * the model's reasoning and every name stay in the workspace; nothing here can name a bill, a payee or a workspace.
 */

/**
 * A decision's facts as the team's decision functions give them (0087, 0100), which name no one: what the page says
 * about the latest decision and the earlier ones alike.
 */
export interface DecisionFacts {
  seq: number;
  ts: string;
  action: string;
  network: Network;
  amount: number | null;
  currency: string;
  decisionMode: string | null;
  agreedWithReference: boolean | null;
  guardrailBlocked: boolean | null;
  guardrailRule: string | null;
  heldBecause: string | null;
  resultingStatus: string | null;
  txRef: string | null;
  payOn: string | null;
  verdict: "agree" | "disagree" | null;
  /**
   * The confirmed payment of the bill or milestone a pay or release decision was about, whoever sent it (0088): a
   * payment held for a person is sent by them later, so the agent's own entry never records it.
   */
  paidTxHash: string | null;
  /** A payment of it failed and none confirmed (0100); absent from `latest_team_decision()`, which does not say. */
  paymentFailed?: boolean;
}

/** What `latest_team_decision()` (migration 0087) gives the page: never the workspace's id, which the server keeps. */
export interface LatestDecisionFacts extends DecisionFacts {
  link: SignedLink;
}

export interface LatestDecisionFact {
  label: string;
  value: string;
  tone: "proof" | "held" | "refused" | "neutral";
}

export interface LatestDecisionView {
  seq: number;
  at: string;
  ago: string;
  network: string;
  headline: string;
  why: string | null;
  facts: LatestDecisionFact[];
  txUrl: string | null;
  link: SignedLink;
}

/** Why a decision held, by the marker the stage recorded (src/lib/agent/shadow-hold.ts, liquidity.ts, pause.ts, outflow-budget.ts). */
const HELD_FOR_VERDICT = "shadow_verdict";
const HELD_WORDS: Record<string, string> = {
  [HELD_FOR_VERDICT]: "It waits for a person's verdict, in shadow mode.",
  cash_shortfall: "The operating wallet was short of cash for it.",
  agent_paused: "The agent was paused.",
  outflow_budget: "It would have passed the workspace's spending limit.",
};

/** Why a decision was held, by its `heldBecause` marker, as a sentence; null for a marker without words. */
export function heldWords(marker: string | null | undefined): string | null {
  return (marker && HELD_WORDS[marker]) || null;
}

const MODELS: Record<string, string> = {
  anthropic: "Anthropic model",
  openai: "OpenAI model",
  deepseek: "DeepSeek model",
  heuristic: "Written policy",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** How long ago, roughly: "just now", "25 min ago", "3 h ago" up to two days, then days. */
export function timeAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** What was decided about, with its amount when the entry recorded one: "a 0.35 USDC bill", "a 0.30 USDC contractor milestone". */
function subject(facts: DecisionFacts): string {
  const milestone = facts.action.startsWith("milestone_");
  const thing = milestone ? "contractor milestone" : "bill";
  if (facts.amount === null) return milestone ? "a contractor milestone" : "a bill";
  return `a ${activityAmount(facts.amount, facts.currency)} ${thing}`;
}

/** Whether a schedule decision went ahead: code did not refuse it and nothing held it. */
function scheduledAsDecided(facts: DecisionFacts): boolean {
  return !facts.guardrailBlocked && !facts.heldBecause && facts.resultingStatus !== "held";
}

function headline(facts: DecisionFacts, network: string): string {
  const what = subject(facts);
  switch (facts.action) {
    case "ap_pay":
    case "milestone_release":
      if (facts.resultingStatus === "paid") return `Paid ${what}.`;
      // Submitted, not confirmed when the agent recorded it: what came of it since, when that is known. Submitted, never
      // "sent", until Circle confirms it (settlement lifecycle I17).
      if (facts.resultingStatus === "matched" || facts.resultingStatus === "verified") {
        if (facts.paidTxHash) return `Paid ${what}.`;
        if (facts.paymentFailed) return `Submitted ${what}; the transfer failed.`;
        return `Submitted ${what}; waiting for Circle to confirm it on ${network}.`;
      }
      // Held for a person, who then paid it.
      if (facts.paidTxHash) return facts.verdict === "agree" ? `Paid ${what} after a person agreed.` : `Paid ${what} after a person approved it.`;
      return `Decided to pay ${what}.`;
    case "ap_schedule": {
      const day = facts.payOn ? ` for ${MONTHS[Number(facts.payOn.slice(5, 7)) - 1]} ${Number(facts.payOn.slice(8, 10))}` : "";
      // Code refused the day the model chose, or something held it: chosen, never scheduled.
      return scheduledAsDecided(facts) ? `Scheduled ${what}${day}.` : `Decided to schedule ${what}${day}.`;
    }
    case "ap_request_info":
      return `Asked for a missing detail on ${what}.`;
    case "ap_flag_fraud":
      return `Flagged ${what} as possible fraud.`;
    default:
      return `Held ${what}.`;
  }
}

/** Why it did not go out, when it did not: the recorded marker, then the rule code refused it by, then the model's own hold. */
function why(facts: DecisionFacts): string | null {
  // Held for a verdict that was given: never "still waits" once a person answered.
  if (facts.heldBecause === HELD_FOR_VERDICT && facts.verdict === "agree") {
    return facts.paidTxHash ? "In shadow mode, a person agrees before anything is paid." : "A person agreed, in shadow mode; its payment has not confirmed yet.";
  }
  if (facts.heldBecause === HELD_FOR_VERDICT && facts.verdict === "disagree") return "In shadow mode, a person disagreed, so it was not paid.";
  if (heldWords(facts.heldBecause)) return heldWords(facts.heldBecause);
  if (facts.guardrailBlocked) return `Code refused it: ${ruleWords(facts.guardrailRule) || "a hard limit in code"}.`;
  if (facts.action === "ap_hold" || facts.action === "milestone_hold") return "The model held it for a person to look at.";
  return null;
}

function factsOf(facts: DecisionFacts): LatestDecisionFact[] {
  const shown: LatestDecisionFact[] = [];
  if (facts.decisionMode) shown.push({ label: "Proposed by", value: MODELS[facts.decisionMode] ?? "A model", tone: "neutral" });
  // The written policy decides beside every model; when it decided itself, there is nothing to compare.
  if (facts.agreedWithReference !== null && facts.decisionMode !== "heuristic") {
    shown.push({ label: "Written policy", value: facts.agreedWithReference ? "Agreed" : "Disagreed", tone: facts.agreedWithReference ? "proof" : "held" });
  }
  if (facts.guardrailBlocked !== null) {
    shown.push({ label: "Code checks", value: facts.guardrailBlocked ? "Refused it" : "Passed", tone: facts.guardrailBlocked ? "refused" : "proof" });
  }
  if (facts.verdict) shown.push({ label: "Person", value: facts.verdict === "agree" ? "Agreed" : "Disagreed", tone: facts.verdict === "agree" ? "proof" : "held" });
  else if (facts.heldBecause === HELD_FOR_VERDICT) shown.push({ label: "Person", value: "Deciding", tone: "held" });
  return shown;
}

/** The explorer link of the transaction a decision sent, or of the payment that followed it; null when neither is a transaction hash. */
function transactionUrl(facts: DecisionFacts): string | null {
  return [facts.txRef, facts.paidTxHash].map((ref) => (ref && TX_HASH.test(ref) ? txUrl(facts.network, ref) : null)).find(Boolean) ?? null;
}

export function latestDecisionView(facts: LatestDecisionFacts, now: number = Date.now()): LatestDecisionView {
  const network = networkProfile(facts.network).label;
  return {
    seq: facts.seq,
    at: facts.ts,
    ago: timeAgo(facts.ts, now),
    network,
    headline: headline(facts, network),
    why: why(facts),
    facts: factsOf(facts),
    txUrl: transactionUrl(facts),
    link: facts.link,
  };
}

/**
 * What came of a decision, in words a visitor can scan down a column (landing recent decisions D3): paid, held,
 * refused by code. Read only from what the entry recorded, in this order: a confirmed payment first, whoever sent it,
 * then a person's verdict in shadow mode, then code's refusal, then the model's own action.
 */
export type DecisionOutcomeKind =
  | "paid"
  | "confirming"
  | "failed"
  | "person_agreed"
  | "person_disagreed"
  | "awaiting_person"
  | "refused"
  | "flagged"
  | "scheduled"
  | "asked"
  | "held";

export interface DecisionOutcome {
  kind: DecisionOutcomeKind;
  label: string;
  tone: "proof" | "agent" | "held" | "refused" | "neutral";
}

const OUTCOMES: Record<DecisionOutcomeKind, Omit<DecisionOutcome, "kind">> = {
  paid: { label: "Paid", tone: "proof" },
  confirming: { label: "Confirming", tone: "neutral" },
  failed: { label: "Transfer failed", tone: "refused" },
  person_agreed: { label: "Person agreed", tone: "agent" },
  person_disagreed: { label: "Person disagreed", tone: "held" },
  awaiting_person: { label: "Awaiting a person", tone: "held" },
  refused: { label: "Refused by code", tone: "refused" },
  flagged: { label: "Flagged", tone: "refused" },
  scheduled: { label: "Scheduled", tone: "agent" },
  asked: { label: "Asked for details", tone: "held" },
  held: { label: "Held", tone: "held" },
};

function outcomeKind(facts: DecisionFacts): DecisionOutcomeKind {
  const pays = facts.action === "ap_pay" || facts.action === "milestone_release";
  if (pays && (facts.resultingStatus === "paid" || facts.paidTxHash)) return "paid";
  if (pays && (facts.resultingStatus === "matched" || facts.resultingStatus === "verified")) return facts.paymentFailed ? "failed" : "confirming";
  if (facts.heldBecause === HELD_FOR_VERDICT) {
    return facts.verdict === "agree" ? "person_agreed" : facts.verdict === "disagree" ? "person_disagreed" : "awaiting_person";
  }
  if (facts.guardrailBlocked) return "refused";
  if (facts.heldBecause) return "held";
  if (facts.action === "ap_flag_fraud") return "flagged";
  if (facts.action === "ap_schedule") return scheduledAsDecided(facts) ? "scheduled" : "held";
  if (facts.action === "ap_request_info") return "asked";
  return "held";
}

export function decisionOutcome(facts: DecisionFacts): DecisionOutcome {
  const kind = outcomeKind(facts);
  return { kind, ...OUTCOMES[kind] };
}

/**
 * What was checked before a decision went ahead, for one that did (paid, sent, scheduled): the written policy's answer
 * beside the model's, and code's checks. Only what the entry recorded; null when it recorded neither.
 */
function checksSentence(facts: DecisionFacts): string | null {
  const policy =
    facts.decisionMode === "heuristic"
      ? "The written policy decided"
      : facts.agreedWithReference === true
        ? "The written policy agreed"
        : facts.agreedWithReference === false
          ? "The written policy disagreed"
          : null;
  const code = facts.guardrailBlocked === false ? "code checks passed" : null;
  if (policy && code) return `${policy}; ${code}.`;
  if (policy) return `${policy}.`;
  return code ? "Code checks passed." : null;
}

/**
 * Why, in one sentence: why it did not go out when it did not, else what was checked before it did. A flag or a question
 * says itself in its headline; what became of the bill afterwards is not the decision's to say.
 */
function detail(facts: DecisionFacts, outcome: DecisionOutcomeKind): string | null {
  const reason = why(facts);
  if (reason) return reason;
  if (outcome === "paid" || outcome === "confirming" || outcome === "scheduled") return checksSentence(facts);
  return null;
}

/** One of the agent's earlier decisions as the landing lists it (landing recent decisions D3): no signature, no badges. */
export interface RecentDecisionView {
  seq: number;
  at: string;
  /** "8 h ago". */
  ago: string;
  /** "Oct 11, 2026, 03:21 UTC", for the time's title. */
  atUtc: string;
  network: Network;
  /** "Arc mainnet". */
  networkLabel: string;
  /** Whether the network moves real money: Arc mainnet does; Arc testnet moves test money with no value. */
  realMoney: boolean;
  outcome: DecisionOutcome;
  headline: string;
  detail: string | null;
  txUrl: string | null;
}

export function recentDecisionView(facts: DecisionFacts, now: number = Date.now()): RecentDecisionView {
  const profile = networkProfile(facts.network);
  const outcome = decisionOutcome(facts);
  return {
    seq: facts.seq,
    at: facts.ts,
    ago: timeAgo(facts.ts, now),
    atUtc: utcMinute(facts.ts),
    network: facts.network,
    networkLabel: profile.label,
    realMoney: facts.network === "arc-mainnet",
    outcome,
    headline: headline(facts, profile.label),
    detail: detail(facts, outcome.kind),
    txUrl: transactionUrl(facts),
  };
}
