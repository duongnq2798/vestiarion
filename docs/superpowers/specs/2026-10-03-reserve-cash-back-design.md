# Cash back from the reserve, when payments need it

Date: 2026-10-03. Status: implemented on `feat/reserve-cash-back`. Asked for by the partner after the first real USYC
sweep: "Can a user get their USDC back, or do they have to wait?"

## 1. The problem

The first real sweep (#1013) moved 53.28 USDC into USYC and left 0.12 USDC in the operating wallet. That is what the
treasury policy wants while nothing is due, but three things then went wrong for a payable due today:

- **The AP stage held it.** A payment due today counts only the operating balance (`availableBy` in
  `payment-timing.ts`): the treasury stage, which redeems from the reserve, ran after AP. A 0.35 USDC payable due today
  was held with 60 USDC sitting in the reserve.
- **Nothing reopened it.** The treasury stage then redeemed for the payables due within 7 days, held ones included, so
  the cash came back a few seconds later. But the follow-up stage reopens a held payable only when one of the facts its
  decision rested on changes (purchase order, goods, risk, limit, spending-limit room), and cash was not one of them.
  The payable stayed held until a person paid it in Approvals.
- **No one could bring cash back.** Settings showed what the reserve held and nothing to do with it. Redemptions are
  open at any hour (only buying waits for USYC's daily window), but only the agent could make one.

## 2. Rulings

- **R1 — a rule, not a model's call.** Bringing cash back for payments due today is arithmetic on figures the cycle
  already has. No model is asked, and nothing beyond what those payments need is moved by the agent.
- **R2 — a person can bring cash back.** On **Settings** → **USYC reserve**, once the reserve is on and holds
  anything, an owner or admin (`treasury.manage`) enters an amount, or leaves it empty for everything, and chooses
  **Bring cash back**. The reserve wallet sells the USYC at its latest price and the USDC comes back to the operating
  wallet. It works while the agent is paused: the pause holds the agent, not a person. It is recorded as
  `cash_brought_back`, actor `human`, with `{ by, reason: "person", amount, all, reserveBalance, earnMode, execution? }`,
  and as a `treasury_actions` row `redeem_from_usyc`. It then raises the cycle event `cash_returned`, so payments that
  waited for cash are decided within a minute. More than the reserve holds, an empty reserve, or no reserve is refused
  with a sentence, moving nothing.
- **R3 — the cycle brings cash back before it decides payments.** A new stage, `liquidity`, runs after `services` and
  before `ap`, and needs only `reconcile`. It adds up the USDC payables due today: `pending` ones due today or overdue,
  and `scheduled` ones whose day is today. EURC is paid from EURC and is not counted. When they need more than the
  operating balance and the reserve holds anything, it redeems the difference, up to what the reserve holds, rounded up
  to the next micro-USDC, with the idempotency key `<cycle>/liquidity/redeem_from_usyc`. It records
  `cash_brought_back`, actor `agent`, with `{ reason: "payments_due_today", amount, reasoning, neededUsdc, payments,
  operatingBalance, reserveBalance, executed, executionNote, earnMode, execution? }` and no `decision`, so it is never
  counted as a decision. The AP stage then sees the new balances. A redemption that fails, or waits on a pause, moves
  nothing, says why ("Could not bring …"), and the AP stage decides with the cash it has.
- **R4 — a hold for want of cash is decided again once cash moves.** An AP decision held because the cash was not
  there (`timing.shortfall`), in USDC from the operating wallet (not EURC, not a Gateway payout), that nothing else
  stopped (no guardrail, not the pause), records `execution.heldBecause: "cash_shortfall"`, `execution.cashNeededUsdc`
  (what it needed with the payables due before it) and `execution.cashSeen: { operating, reserve }`. The follow-up
  stage reads both balances when such a hold exists and reopens the payable when they cover what it needed **and** cash
  has moved since: the operating balance rose (faucet, a person's cash back, the treasury stage's redemption) or the
  total did. `followUp.changes` reads "the cash it needs is there now (*n* USDC in the operating wallet and the
  reserve)". Cash that stood still means the redemption that failed would fail again; reopening then would hold it
  again at every cycle, so it waits. The treasury stage's own redemption for what is due within 7 days, which counts
  held payables, is what moves it.
- **R5 — a person is told what it waits for.** A payable held for want of cash says so on its card on AP / AR and the
  console's **Stopped** section: "The operating wallet did not hold the cash it needs, and the reserve could not cover
  it. The agent decides it again on its own once cash comes in: add USDC to the operating wallet, or bring cash back
  from the USYC reserve; or pay it in Approvals." For an owner or admin it links **USYC reserve** in Settings. On
  Approvals, the person who entered it is told the agent decides it again once cash comes in. It is not a guardrail
  rule: the key `treasury.cash_shortfall` only picks the sentence.

## 3. What does not change

- The treasury stage, its buffer (1.15 times what falls due within 7 days) and its sweeps.
  - Changed on 2026-10-05 (`2026-10-05-approval-cash-from-reserve-design.md` R6): for 24 hours after a person's Bring cash back, the treasury stage sweeps nothing. Approve and pay, and Pay now, bring back what their payment lacks (R1, R7).
- What counts toward a later day's payment: the operating balance and the reserve, as before.
- The AP stage's shortfall rule: a payment due today still counts only the operating balance, which the liquidity step
  has already topped up.

## 4. Known limits

- A Gateway payout due today is counted by the liquidity step, though it is paid from the Gateway balance. The cash
  brought back for it stays in the operating wallet until the treasury stage sweeps it again.
- A payable that the AP stage holds for another reason after the liquidity step brought cash back for it leaves that
  cash in the operating wallet; the treasury stage counts it against its buffer.
- A live redemption is proven by its first use: this branch was tested against the simulated provider and the
  provider's existing redemption path.

## 5. Tests

- `tests/liquidity.test.ts`: what is due today; the liquidity step's amount, ledger entry, treasury action, nothing to
  move, the reserve's cap, the pause; a person's cash back, all or an amount, and each refusal; the marker the cards
  read.
- `tests/ap-stage.test.ts`: a hold for want of cash records its marker, what it needed and the cash it saw.
- `tests/follow-up.test.ts`: reopened once cash came in or was brought back; waits while cash stood still, falls short
  or was not read; never for another hold.
- `tests/cash-back-action.test.ts`: the permission, all or an amount, a bad amount, a refusal, the cycle event.
- `tests/agent-activity.test.ts`, `tests/control-ui.test.tsx`: the sentence, the link, the stage before AP, the panel.
