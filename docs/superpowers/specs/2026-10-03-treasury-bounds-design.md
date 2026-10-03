# Code bounds the treasury's moves

Date: 2026-10-03. Status: implemented on `fix/client-payables-treasury-bounds`. Found in testnet-2's ledger while
testing the agent's reminders.

## 1. Why

At 07:43 UTC on Oct 3 (#1063) the treasury stage redeemed 58.1 USDC, nearly the whole USYC reserve, to cover 0.10 USDC
due in two days. The written policy redeemed 0.114999 USDC, enough to restore the buffer. Code moved whatever amount
the model chose, capped only by the balance, and the entry recorded `agreedWithReference: true`, because only the
action was compared.

No money left the workspace: it moved between its own two wallets. But the reserve stopped earning, and USYC can be
bought back only in its weekday window.

## 2. Rulings

- **R1 — a sweep takes only what sits above the buffer.** At most the operating balance less the 7-day buffer (115% of
  what falls due within 7 days). With nothing above it, nothing is swept.
- **R2 — a redemption brings back at most what the next 14 days need.** At most 115% of what falls due within 14 days,
  less the operating balance, and never more than the reserve holds. With nothing needed, nothing is redeemed.
- **R3 — and at least what the written policy redeems.** A smaller redemption would leave the buffer short; it is
  raised to the policy's.
- **R4 — agreement weighs the amount.** A treasury decision agrees with the written policy only when it makes the same
  move for an amount within 5% of the policy's, or 0.01 USDC. The research script judges every entry this way, so
  #1063 counts as a difference. Payables and milestones are compared as before.
- **R5 — the model is told, and the entry says what changed.** The prompt carries the bounds (`sweepAtMostUsdc`,
  `redeemAtMostUsdc`, `redeemAtLeastUsdc`). A move outside them is brought within them. Then `decision` is what moved,
  `boundedByCode` keeps what the model chose and why, and the reasoning ends with "[Code limited this: …]".

A hold stays the model's choice. The liquidity stage already brings back what today's payments need.

## 3. Tests

`tests/treasury.test.ts` (the bounds on #1063's figures, a sweep above the buffer, agreement by amount),
`tests/model-vs-policy.test.ts` (the note's count) and `tests/control-ui.test.tsx` (the stage moves the bounded
decision and records it).
