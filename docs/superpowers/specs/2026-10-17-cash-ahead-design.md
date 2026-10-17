# Scheduled payments checked against the cash ahead

Date: 2026-10-17. Status: building.

## Problem

A bill the agent schedules waits, undecided, until its day (payment timing P3). It was scheduled when the cash covered
it on that day, after what fell due before it. When something takes that cash later (a new bill due earlier, a bill
held for want of cash that falls due first, a milestone verified), nothing looks at the scheduled bill again until its
day. On the day it is held for want of cash, with no time left to do anything about it.

Seen live on Oct 17 in our own test workspace: two 45 USDC bills scheduled for Oct 23 and Oct 24, then a 140 USDC bill
due Oct 22 scheduled once cash came in. The wallet holds 150.03 USDC. On Oct 23 it will hold 10.03.

The agent already has what it needs to act days ahead: asking a supplier for more time (term requests, 0128) and
offering customers a discount to pay sooner (0129). Both act on bills held for want of cash. A bill that is short on
its day is only held on its day.

## Design

**A1. Each cycle, code checks every scheduled bill against the cash ahead.** For a USDC bill scheduled for a later
day, not paid to a bank account: the cash the written policy counts for a later day (operating plus reserve), less
what falls due on or before its day (`obligationsDueBy`, the same function the decision uses: every other open payable
on its day, held ones on their due date, verified milestones), against what it needs on its day (its discount
included). Short, and the AP stage decides it again now, with every check, rather than on its day.

**A2. Decided again, never treated as a new fact by itself.** The decision is the AP stage's own: the written policy
holds a bill it cannot cover (`timing.shortfall`), the model decides with the same facts and `scheduledEarlier`, now
with `decidedBeforeItsDay: true`. Held, it is held for want of cash, so the follow-up reopens it once cash comes in,
and the customer discount and more-time stages act on it the same cycle.

**A3. No treadmill.** A bill is not checked again when:
- its latest scheduling was a person's move from the payment plan (`payment_rescheduled`): that day is theirs;
- its latest decision scheduled it knowing the cash fell short (`timing.shortfall: true`): the model chose that;
- its latest decision was itself one of these checks (`cashAhead` in its detail), and the cash counted is not lower
  and what falls due before it is not higher than then. A Gateway payout or a bank payout, whose decision counts
  other cash, is therefore decided early at most once per change.

At most 5 bills a cycle, the earliest scheduled first.

**A4. Recorded.** The AP decision's ledger entry carries `cashAhead: { scheduledFor, cashCounted, dueBefore: { total,
count }, needed }`. The activity feed (console, Telegram, Slack) says "Held Cobalt Cloud 45.00 USDC, set for Oct 23:
the cash will not cover it then." The cycle log says it was decided before its day.

**A5. Customer discounts count scheduled payments.** The shortfall the discount stage works from was the bills held
for want of cash less the operating USDC, as if none of that USDC were already set for a scheduled bill. It is now
held-for-cash bills plus scheduled USDC payables, less the operating USDC and the receivables accepted at a discount
and not yet paid.

## Out of scope

- EURC bills (paid from the EURC balance) and bills paid to a bank account.
- Choosing which of two competing bills to hold: they are decided in the order the stage always uses.
- Counting receivables as cash: the policy never does; the more-time stage weighs them.

## Tests

- `shortAhead`: short and covered, the reserve counted, a discount on the day, same-day competition, each A3 guard,
  the cap and its order, EURC and bank-paid left out.
- AP stage: a scheduled bill short ahead is decided now and held, its entry carries `cashAhead`, the prompt says
  `decidedBeforeItsDay`; a covered one waits; a person's move waits.
- Customer discount shortfall with scheduled payments.
- Activity feed line for a hold with `cashAhead`.
