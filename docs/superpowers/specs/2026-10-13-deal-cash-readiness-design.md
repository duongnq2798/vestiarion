# Deal cash readiness and exceptions with an owner

Date: 2026-10-13. Status: decided (autonomy grant 2026-10-05). Roadmap: F06, with I12.

## Why

A deal with a good total can still need money before the customer pays: a contractor paid in week one, a vendor's
deposit, a licence bought up front. The deal page (`2026-10-12-deal-schedule-design.md`) says what the customer owes and
when; nothing says what the deal costs, when that money leaves, or whether the deal pays its own way as it goes.

Separately, a payable the agent holds waits on Approvals with no owner, no priority and no date: it is decided when
someone happens to look, and nobody is told when it waited too long.

## Decisions: deal costs and cash readiness (F06)

**K1. A planned cost belongs to one deal.**
- What it is (up to 80 characters), who it is for (optional: a vendor or contractor of the workspace), the amount in the
  deal's currency (minor units, as the deal's lines), the day it is expected to leave, and "No document yet" when no
  bill or quote backs it yet.
- Cost if wrong: a cost shared by two deals is entered on each with its share.

**K2. A planned cost that becomes a real payable or milestone is linked to it, and counted from it.**
- **Link to a bill** (a payable of the workspace, in the deal's currency, or written in it in shadow mode) or **Link to a
  milestone** (USDC deals). From then on the bill's or milestone's amount, day and status count, never the planned
  amount, so the money is counted once. One bill or milestone backs at most one cost of any deal (a unique index).
- A bill that is paid counts as paid out; an open one leaves on its scheduled day or due day (today when past); a
  rejected bill or a closed milestone no longer stands for money leaving, so the cost counts as planned again, and says
  so.
- Cost if wrong: a bill paid in parts for two deals is linked to one and planned on the other.

**K3. Costs are entered, removed and linked; never edited.**
- **Remove** keeps the row (with who removed it) and counts it nowhere. A wrong amount is removed and entered again.
- Each is a signed entry: `deal_cost_added`, `deal_cost_removed`, `deal_cost_linked`, actor `human`, domain `ar`.
- The form carries a key made when the page is drawn: the same form sent twice adds one cost; the same key with other
  details is refused (`key_reused`).
- Commands `deal.add_cost`, `deal.remove_cost`, `deal.link_cost` need `records.write`, from the console only.

**K4. Cash readiness is worked out in the browser from what the page read, by one pure function.**
- `dealCashReadiness(deal, costs, today)` (`src/lib/deals/cash.ts`). Money in: each charge in force: a planned line on
  its due day ("planned"), a released line on its receivable's due day ("expected"), an overdue one today, a paid one
  as collected to date. Credits owed to the customer are no money in or out (deal schedule D8). Money out: each cost as
  in K2, a planned cost past its day today.
- **To date**: collected less paid out. Then day by day from today, only days with money moving: what comes in, what
  goes out, and the position after it. **Short** is the first day the position is below zero, by how much on that day,
  and the deepest gap with its day.
- Every figure says what it is built from: each day lists its lines and costs by name, state and day, and each total
  says its sum.
- Cost if wrong: a person reads the gap of a deal on its own, not the workspace's cash; Treasury says that.

**K5. Planned and expected money is never called cash.**
- The section is "Cash readiness"; its position is "if the customer pays each line on its due day". Only "Collected to
  date" and "Paid out to date" are money that moved. No likelihood is applied to any line: a line is in or out.
- No figure here enters Treasury, the payment plan, a guardrail or a fingerprint; `tests/deal-cash.test.ts` holds that
  no file under `src/lib/agent`, `src/lib/commands`, `src/app/actions` or `src/app/api` imports the module.

**K6. Margin is estimated, and says so; with no cost entered it is "Not enough data".**
- Estimated margin = the deal's total in force (charges and credits) less the costs counted (K2), as an amount and a
  percent of the total. With no cost, it says "Not enough data: no cost is entered for this deal", never 100%. Costs
  with "No document yet" are counted and named.

**K7. Try a change: the deposit's day and percent, never saved.**
- The deposit is the first charge in force by invoice day, while it is still planned, on a deal billed as a deposit
  and balance or whose first line is named as a deposit; a retainer or milestones offer no try. Moving its invoice day moves its
  due day by the deal's terms. A new percent sets the deposit to that share of the deal's total, and the difference
  comes off (or goes onto) the other planned charges from the last backwards, as a lower price does (D8); a percent the
  planned lines cannot absorb is refused in words.
- The view shows the gap before and after. Nothing is written: keeping it is **Change deal**, a new version.

**K8. The deals list says the gap in one badge.**
- On the Receivables tab each active deal gets one badge: "Short 1,240.00 USDC on Oct 20, 2026", "No cash gap", or "No
  costs entered". A cancelled deal gets none.

**K9. Migration 0108.**
- `deal_costs`: tenant table, row level security as every tenant table, composite foreign keys to `deals`,
  `counterparties` (set null), `invoices` (set null: a deleted bill leaves the cost planned) and `milestones` (set
  null); terms fixed by a trigger; a link set once, to a payable only; removal once. Unique per workspace on
  `idempotency_key`; one live cost per bill and per milestone.
- Before 0108 runs the deal page says "Costs are not set up on this deployment yet.", margin says not enough data and
  the badge is not shown.

## Decisions: exceptions with an owner (I12)

**E1. Each held payable has a decide-by day.** Its due date, or its early-payment discount's deadline while that is
still ahead and earlier. Pure: `exceptionFacts` (`src/lib/exceptions.ts`).

**E2. A priority from that day**: Overdue (past it), Due today, Due this week (within 7 days), Later.

**E3. Who can act**: the members whose role holds `approval.decide` (owner, admin, approver), less the person who
entered it unless they are the only one who may approve. Shown on the Approvals card and on the payable's row on Bills.

**E4. One escalation email when the day passes undecided.** After a scheduled cycle, `escalateOverdueDecisions` claims
`approval_escalations` (unique per payable and decide-by day) for each waiting payable past its day, and emails each
member who has notifications on (the digest's recipients and switch) one message about the payables they can act on
(E3), and records `decision_escalated` with ids and counts. A payable nobody received is released, so the next cycle
tries again; a claim kept is never sent again. A new decide-by day (the due date moved) is news again.

**E5. Every status keeps a next action.** Held, flagged and awaiting information: decide in Approvals, or add the
missing detail; being decided: who is deciding; a viewer: who can act.

## Screenshots

`docs/superpowers/specs/deal-cash-shots/`, from `/docs-shots/deal-cash/<state>` (flag-gated, sample data) at 1440, 1024
and 390 px.
