/**
 * The bounds on a swap of USDC for EURC (docs/superpowers/specs/2026-10-01-eurc-swap-design.md S1, S5),
 * kept apart from the service client so the guardrails and the UI read them without loading it.
 */

/** The swap's slippage floor, as App Kit's swaps default to: its minimum output is 97% of the estimate. */
export const SWAP_SLIPPAGE_BPS = 300;
/** The most a swap may cost above the rate its payable was weighed at (R3). */
export const SWAP_COST_CAP_PERCENT = 3;
