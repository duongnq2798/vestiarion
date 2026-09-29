import { db, unwrap } from "../dal";

/**
 * Thrown when `begin_cycle_run` (migration 0025) reports that the
 * organization's agent is paused. The pause itself, and who may set or clear
 * it, live in the database — this class only translates the raised
 * `agent_paused: …` error into the message a member sees.
 */
export class AgentPausedError extends Error {
  constructor() {
    super("The agent is paused. Resume it to run a cycle.");
    this.name = "AgentPausedError";
  }
}

/**
 * Reads straight from `agent_paused` (migration 0025): true once a member
 * has paused this organization's agent, false otherwise. Thrown on any read
 * failure — a payment step must never treat "could not tell" as "not
 * paused" and pay anyway.
 */
export async function agentPaused(): Promise<boolean> {
  return unwrap(await db().rpc("agent_paused").single<boolean>());
}

/** Appended to a payment's reasoning, and nowhere else, so the AP and
 * contractor stages record the same words for the same cause. */
export const PAUSE_NOTE = " [not paid: the agent was paused]";

/** Recorded on a treasury decision's `executionNote` when the pause is why
 * nothing moved — the treasury stage's own equivalent of `PAUSE_NOTE`. */
export const PAUSE_TREASURY_NOTE = " [not moved: the agent was paused]";

/**
 * The marker every ledger entry a pause held carries, alongside the human
 * reasoning: `execution.heldBecause` for the AP and contractor stages (whose
 * ledger detail already has an `execution` object), `heldBecause` at the top
 * of the detail for the treasury stage (which has none). One value, so an
 * auditor filtering the ledger for "the pause is why this held" has exactly
 * one thing to look for regardless of which stage wrote the entry.
 */
export const HELD_BECAUSE_PAUSED = "agent_paused";

/**
 * The `{ heldBecause: "agent_paused" }` fragment to spread into a ledger
 * entry's detail — into `execution` for the AP and contractor stages,
 * top-level for the treasury stage — when, and only when, the pause is why
 * that entry holds. Empty otherwise, so spreading it never adds a stray key
 * to an entry a guardrail or a failed transfer held for its own reason.
 *
 * Pulled out so the exact object every stage spreads into its ledger detail
 * is one small, directly testable function, rather than three copies of the
 * same ternary that could drift from each other.
 */
export function heldBecausePausedDetail(heldBecausePaused: boolean): { heldBecause?: string } {
  return heldBecausePaused ? { heldBecause: HELD_BECAUSE_PAUSED } : {};
}

/**
 * The check every payment step makes right before it would move money: null
 * when the agent is not paused (the caller proceeds as it always did), the
 * note to append to the reasoning when it is (the caller holds instead, and
 * never calls the provider).
 *
 * Pulled out on its own rather than inlined at each call site so the AP and
 * contractor stages check — and record — the pause identically, and so this
 * one branch is unit-testable without driving a whole cycle through
 * `runAgentCycle()` to reach it.
 */
export async function pausedPaymentNote(): Promise<string | null> {
  return (await agentPaused()) ? PAUSE_NOTE : null;
}

/** The same check, for the treasury stage's own wording: null to proceed
 * with a sweep or redemption, `PAUSE_TREASURY_NOTE` to record instead and
 * never call the provider. */
export async function pausedTreasuryNote(): Promise<string | null> {
  return (await agentPaused()) ? PAUSE_TREASURY_NOTE : null;
}
