# The agent's spending limit

Date: 2026-10-02. Status: shipped with this PR (design decided under the standing autonomy grant;
rulings below carry their cost if wrong). Roadmap A6, first half; the on-chain half is A6b.

## 1. Why

Every guardrail so far is about one payment: its counterparty's risk, its limit, its address, its
fee. Nothing bounds what the agent pays out in total. Twenty invoices each within their limit can
still empty the wallet in one cycle. An owner who hands payments to an agent wants the same thing
a company card gives: a ceiling per day and per week, and anything past it waits for a person.

## 2. What it does

- An owner or admin sets the agent's **spending limit**: a daily figure, a 7-day figure, either, or
  neither, in USDC.
- Each payment the agent decides on its own counts against both. A payment that would take the
  agent past either is not sent. It is held for a person, with the rule `workspace.outflow_budget`.
- The console shows what the agent has paid today and in the last 7 days against each figure.

## 3. Rulings

- **R1 — only the agent's own payments count.** What counts is every agent decision entry that sent
  money: `ap_pay` and `milestone_release` whose `execution.resultingStatus` is `paid` or `matched`.
  - A payment a person approves in Approvals is that person's decision. It does not count, and the
    limit never stops it.
  - A resubmitted transfer is the same decision, so it is not counted again.
  - Network and bridge fees do not count; the amount sent does.
  - A transfer that later failed still counts. Cost if wrong: the limit is stricter than it needed to be.
- **R2 — USDC value.** A EURC payment counts at the USDC value its decision recorded
  (`amountPaid × usdcValue ÷ amount`). The check weighs the invoice's full USDC value, as the payment
  limit does.
- **R3 — the windows.** "Today" is the current UTC day. "7 days" is today and the six UTC days before
  it. Both reset at 00:00 UTC; nothing is carried over. A sandbox uses real time, not its simulated day.
- **R4 — checked when money would move.** The check runs on `pay` and `release`, after every
  counterparty check and before any EURC swap. A `schedule` is not checked: a scheduled payable is
  decided again on its day, with every check, this one included.
- **R5 — one running total per cycle.** The cycle reads what was spent once, then adds each payment
  it makes. The AP and contractor stages share it, so the second payment sees the first.
- **R6 — after a hold.**
  - An invoice goes to Approvals, where a person may pay it at once (R1).
  - A milestone has no approval path. Like one held while the agent was paused, it records
    `execution.heldBecause: "outflow_budget"`.
  - The follow-up stage reopens a payable or a milestone held for the limit once the limit has room
    for it: a new day, a higher figure, or no limit. Until then it waits, and does not repeat its
    decision every cycle.
- **R7 — storage.** One row per workspace in `agent_budgets` (migration 0052): `daily_usdc` and
  `weekly_usdc`, each positive or null, and who changed them last.
  - The 7-day figure, when both are set, is at least the daily one; otherwise it is meaningless.
  - Owners and admins set it (`agent.budget`).
  - Each change appends `agent_budget_changed` (actor `human`, domain `system`) with the figures
    before and after.
- **R8 — fail closed.** If the limit or what was spent cannot be read, the stage fails as any read
  failure does, and nothing is paid. Paying past an unknown limit is the failure this exists to stop.

## 4. What a person sees

- **Console, "Agent spending limit".** For each figure that is set: what the agent paid against it,
  and what is left. With none set, it says that the agent pays anything within each counterparty's
  limit. Owners and admins see "Set limit", which opens a form with both figures.
- **A held payable's card.** The band names `workspace.outflow_budget`. It shows the amount attempted
  against what was left, and names which figure stopped it and what was already paid against it.

## 5. Not in this PR

- **A6b — the same limit on chain:** a contract on Arc the agent's wallet pays through, which itself
  refuses a transfer past the limit. This PR makes the limit and its records; A6b makes it binding
  even on a compromised server.
