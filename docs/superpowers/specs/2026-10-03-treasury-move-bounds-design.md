# Treasury moves bounded by the buffer

Date: 2026-10-03. Status: implemented on `fix/treasury-move-bounds`. Decided under the standing autonomy grant.

## 1. What happened

In testnet-2 at 07:43 UTC, the cycle's treasury stage redeemed 58.1 of the reserve's 58.21 USDC back into the
operating wallet (ledger #1063, redeem tx `0x9da3fae1c398b294f6178d317cf2525a4848be2e51d50137cef3e6607f5051ba`). The
operating wallet was empty and 0.10 USDC fell due within 7 days.

- The written policy (`planTreasury`) answered: redeem 0.114999 USDC, which is the shortfall below the 7-day buffer
  (0.10 × 1.15).
- DeepSeek answered: redeem 58.1 USDC, "which costs nothing since redemptions are always possible".

The stage executed the model's amount. `moveTreasuryIfNotPaused` caps a redeem only at the reserve's balance and a
sweep only at the operating balance. The ledger recorded `agreedWithReference: true`, because agreement compares
actions and not amounts. No harm was done to anyone else: the money moved between the workspace's own wallets. But the
reserve stopped earning, and the same gap in the other direction would let a sweep take cash that payments due within
7 days need.

The payment stages do not work this way. After the model answers, code re-checks every payment and release
(`enforceApGuardrails`, the spending limit, the cash shortfall). The treasury stage had no such check, although the docs
say the agent "keeps a liquidity buffer".

## 2. Rulings

- **R1. Code bounds the agent's treasury move after the model answers, by the buffer the policy works out.**
  - A redeem is at most the shortfall below the buffer: `buffer − operatingBalance`, and never more than the reserve
    holds.
  - A sweep is at most the cash above the buffer: `operatingBalance − buffer`.
  - A redeem with no shortfall, or a sweep with nothing above the buffer, becomes a hold.
  - Redemptions are always possible, so cash comes back when obligations need it, not before.
  - The bound decides only how much moves at most. Whether a sweep pays for itself stays the model's judgement, as it
    is today.
- **R2. Only the agent's own moves are bounded.** A person's **Bring cash back** (reserve cash back R2) moves what the
  person asked for. The liquidity stage, which brings back what today's payments need, is unchanged.
- **R3. A bounded move is recorded as code's.**
  - The treasury entry keeps the model's `decision` as it answered.
  - The entry's `action` and summary say what actually moved.
  - It adds `guardrailBlocked: true`, `guardrailRule` (`treasury.redeem_above_need` or `treasury.sweep_below_buffer`)
    and `boundedTo: { action, amount }`, the fields the payment stages use for code's refusals.
  - The `treasury_actions` row and its reasoning are the move that happened, with a sentence saying code limited it.
  - The cycle counts it as a guardrail override.
- **R4. The prompt says it too.** The system prompt's treasury rules add that a redeem brings the operating balance up
  to the buffer and no further, and that code caps both moves, as it already says for the payment rules code enforces.
- **R5. Agreement still compares actions.** `agreedWithReference` keeps its meaning across every stage, so the research
  note's figures stay comparable over time. A departure in amount now shows as a guardrail entry instead.

## 3. Rollout

Merge, then watch testnet-2's next treasury decision. A redeem or sweep the model sizes above the bound must move only
the bounded amount, and its entry must carry `guardrailRule`.
