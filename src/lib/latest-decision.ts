import { activityAmount } from "./agent-activity";
import { networkProfile, type Network } from "./network";
import { txUrl } from "./payee-chains";
import type { SignedLink } from "./receipts/verify";

/**
 * The landing's latest decision (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R2): the newest decision
 * the agent made in one of the team's own workspaces, said from the entry's recorded facts alone. The entry's summary,
 * the model's reasoning and every name stay in the workspace; nothing here can name a bill, a payee or a workspace.
 */

/** What `latest_team_decision()` (migration 0087) gives the page: never the workspace's id, which the server keeps. */
export interface LatestDecisionFacts {
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

/** A guardrail rule in words that name no one: the payee is "the payee", whoever it is. */
const RULE_WORDS: Record<string, string> = {
  "counterparty.payment_limit": "it is above the payee's payment limit",
  "counterparty.address_unconfirmed": "the payee's address changed and no one had confirmed it",
  "counterparty.unscreened": "the payee had not been screened yet",
  "counterparty.high_risk": "the payee was screened high risk",
  "counterparty.client_payable": "the payee is a client, who pays the business",
  "counterparty.new_payee": "a first payment to a new address needs two people",
  "invoice.duplicate_of_settled": "it repeats a bill already paid",
  "invoice.match_incomplete": "its purchase order or goods receipt was missing",
  "workspace.outflow_budget": "it would pass the workspace's spending limit",
  "workspace.onchain_limit": "it would pass the spending limit set on Arc",
  "workspace.onchain_limit_route": "the spending limit on Arc cannot pay it this way",
  "treasury.insufficient_eurc": "the wallet held too little EURC",
  "fx.rate_unavailable": "no exchange rate could be read",
  "fx.swap_cost_above_cap": "the currency swap cost more than its cap",
  "fx.swap_usdc_short": "too little USDC was left to swap",
  "bridge.fee_above_cap": "the cross-chain fee was above its cap",
  "bridge.fee_unavailable": "the cross-chain fee could not be read",
  "bridge.gateway_balance_short": "the Gateway balance was short",
  "bridge.unsupported_token": "that token cannot cross chains",
};

/** Why a decision held, by the marker the stage recorded (src/lib/agent/shadow-hold.ts, liquidity.ts, pause.ts, outflow-budget.ts). */
const HELD_FOR_VERDICT = "shadow_verdict";
const HELD_WORDS: Record<string, string> = {
  [HELD_FOR_VERDICT]: "It waits for a person's verdict, in shadow mode.",
  cash_shortfall: "The operating wallet was short of cash for it.",
  agent_paused: "The agent was paused.",
  outflow_budget: "It would have passed the workspace's spending limit.",
};

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
function subject(facts: LatestDecisionFacts): string {
  const milestone = facts.action.startsWith("milestone_");
  const thing = milestone ? "contractor milestone" : "bill";
  if (facts.amount === null) return milestone ? "a contractor milestone" : "a bill";
  return `a ${activityAmount(facts.amount, facts.currency)} ${thing}`;
}

function headline(facts: LatestDecisionFacts, network: string): string {
  const what = subject(facts);
  switch (facts.action) {
    case "ap_pay":
    case "milestone_release":
      if (facts.resultingStatus === "paid") return `Paid ${what}.`;
      if (facts.resultingStatus === "matched" || facts.resultingStatus === "verified") return `Sent ${what}; ${network} is confirming it.`;
      // Held for a person, who then paid it.
      if (facts.paidTxHash) return facts.verdict === "agree" ? `Paid ${what} after a person agreed.` : `Paid ${what} after a person approved it.`;
      return `Decided to pay ${what}.`;
    case "ap_schedule":
      return facts.payOn ? `Scheduled ${what} for ${MONTHS[Number(facts.payOn.slice(5, 7)) - 1]} ${Number(facts.payOn.slice(8, 10))}.` : `Scheduled ${what}.`;
    case "ap_request_info":
      return `Asked for a missing detail on ${what}.`;
    case "ap_flag_fraud":
      return `Flagged ${what} as possible fraud.`;
    default:
      return `Held ${what}.`;
  }
}

/** Why it did not go out, when it did not: the recorded marker, then the rule code refused it by, then the model's own hold. */
function why(facts: LatestDecisionFacts): string | null {
  // Held for a verdict that was given: never "still waits" once a person answered.
  if (facts.heldBecause === HELD_FOR_VERDICT && facts.verdict === "agree") {
    return facts.paidTxHash ? "In shadow mode, a person agrees before anything is paid." : "A person agreed, in shadow mode; its payment has not confirmed yet.";
  }
  if (facts.heldBecause === HELD_FOR_VERDICT && facts.verdict === "disagree") return "In shadow mode, a person disagreed, so it was not paid.";
  if (facts.heldBecause && HELD_WORDS[facts.heldBecause]) return HELD_WORDS[facts.heldBecause];
  if (facts.guardrailBlocked) return `Code refused it: ${(facts.guardrailRule && RULE_WORDS[facts.guardrailRule]) || "a hard limit in code"}.`;
  if (facts.action === "ap_hold" || facts.action === "milestone_hold") return "The model held it for a person to look at.";
  return null;
}

function factsOf(facts: LatestDecisionFacts): LatestDecisionFact[] {
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
    txUrl: [facts.txRef, facts.paidTxHash].map((ref) => (ref && TX_HASH.test(ref) ? txUrl(facts.network, ref) : null)).find(Boolean) ?? null,
    link: facts.link,
  };
}
