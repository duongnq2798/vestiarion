import { AGENT_DECISION_ACTIONS } from "./agent/shadow-hold";
import type { LedgerEntry } from "./ledger";

/**
 * What a card shows of a person's verdict on the agent's decision about a payable
 * (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S3–S5): the agent's newest decision, the verdict given on it,
 * and whether one can be given now. Browser-safe and pure; the pages read the facts, `src/lib/verdicts.ts` keeps them.
 */

export interface VerdictView {
  /** The agent's decision entry the verdict is about. */
  entrySeq: number;
  agentAction: string;
  given: { verdict: "agree" | "disagree"; reason: string | null } | null;
  /** A verdict can be given now: shadow mode is on, the decision came after it started, and the viewer may decide payments. */
  open: boolean;
  /** The payment waits for this verdict: Agree pays it. */
  heldForVerdict: boolean;
}

export interface VerdictFacts {
  /** The workspace's shadow mode, null when it is off. */
  shadow: { startedAt: string } | null;
  /** The verdicts given, by decision entry. */
  given: Map<number, { verdict: "agree" | "disagree"; reason: string | null }>;
  /** Whether the viewer may decide payments (`approval.decide`). */
  canGive: boolean;
}

const DECISIONS: readonly string[] = AGENT_DECISION_ACTIONS;

/** The parts of a ledger entry a verdict reads. */
export type DecisionEntryFacts = Pick<LedgerEntry, "seq" | "ts" | "actor" | "action" | "detail">;

/** The view for the payable's card, or undefined where there is no verdict to show or give. Entries are newest first. */
export function verdictView(invoiceId: string, entries: readonly DecisionEntryFacts[], facts: VerdictFacts, heldForVerdict: boolean): VerdictView | undefined {
  const decision = entries.find((entry) => entry.actor === "agent" && DECISIONS.includes(entry.action) && entry.detail.invoiceId === invoiceId);
  if (!decision) return undefined;
  const given = facts.given.get(decision.seq) ?? null;
  const inShadow = facts.shadow !== null && Date.parse(decision.ts) >= Date.parse(facts.shadow.startedAt);
  if (!given && !inShadow) return undefined;
  return { entrySeq: decision.seq, agentAction: decision.action, given, open: !given && inShadow && facts.canGive, heldForVerdict };
}
