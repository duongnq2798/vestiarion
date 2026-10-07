/**
 * A payment held in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S2): it passed every check,
 * and waits for a person to agree before anything is sent. Browser-safe: the cards read the same marker.
 */

/** `execution.heldBecause` on the decision entry: a person's verdict ends the hold, never the follow-up. */
export const HELD_FOR_VERDICT = "shadow_verdict";

/** What the held payment's reasoning ends with. */
export const SHADOW_HELD_NOTE = " [shadow mode: held for a person to agree; nothing is paid until they do]";

/** The entries in which the agent decided about a payable. `ap_reconcile` records a settlement, not a decision. */
export const AGENT_DECISION_ACTIONS = ["ap_pay", "ap_schedule", "ap_hold", "ap_flag_fraud", "ap_request_info"] as const;
