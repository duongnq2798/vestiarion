# How long swept cash would stay

Date: 2026-10-03. Status: implemented on `fix/treasury-hold-horizon`. Found while checking the treasury bounds (#169)
in testnet-2.

## 1. Why

A sweep is worth making when the yield it earns beats the two transfers it costs. The policy weighed that yield over
the days until the next obligation, as if every swept dollar came back that day. In testnet-2 on Oct 3 (#1103) the
operating wallet held 118.7 USDC and 0.10 USDC was due in 1.64 days. The yield weighed was about $0.018 on 118.59 USDC,
against $0.00638 for the transfers. The written policy still swept. The model held, calling the gain "too thin", and
the cash stayed idle.

But only 0.115 USDC of it would ever come back for that bill. The 7-day buffer the operating wallet keeps pays it, so
nothing would come back at all, and the rest could earn for weeks.

## 2. Rulings

- **R1 — what falls due, each on its day.** The treasury stage hands the plan each open USDC payable due within 30
  days, on the day it leaves (a scheduled one on its scheduled day, an overdue one today), and every open milestone
  today.
- **R2 — how long the swept cash would stay.** After a sweep, the operating wallet keeps the rest. Each obligation is
  paid from it first, and only what it cannot cover comes back from the reserve, on the obligation's day. Cash nothing
  calls back stays 30 days, the most the policy counts. The average, floored at a day, is the sweep's hold, and the
  yield is weighed over it: about $0.336 on #1103's figures, fifty times the transfers' cost.
- **R3 — the model weighs the same figures.** `expectedHoldDays` and `projectedYieldUsd`, in the prompt and the
  entry's `economics`, are the new ones, and the prompt says what the hold means. The reasoning says "over the *n*
  days the swept cash would stay, on average, before what falls due calls it back".

Without a schedule, `planTreasury` keeps the old horizon, for its other callers.

## 3. Tests

`tests/treasury.test.ts` (the hold on its own, the plan on #1103's figures, a sweep still too small) and
`tests/obligations.test.ts` (the schedule, and the stage handing it over).
