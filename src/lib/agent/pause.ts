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
