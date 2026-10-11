# Payment plan

Date: 2026-10-11. Status: decided (autonomy grant 2026-10-05). Roadmap: F21, with I20 (stale data blocks the actions
that need fresh data) and I21 (a batch keeps every line's own checks).

## Why

A small business knows today's balance, not which bill to pay first so that it does not run short at the end of the
week. The agent decides each bill on its own (payment timing, `2026-09-30-payment-timing-design.md`): pay on the due
date, or on an early-payment discount's deadline when the discount is worth more than holding the cash. Each decision
checks that the cash covers the bills due before it, but nothing shows the next two weeks as one sequence: which bills
leave on which day, what the balance is after each, which discount is worth taking without eating into the cushion, and
which bill cannot be paid on its day.

The plan shows that, from facts the workspace already keeps, and lets a person who approves payments move a scheduled
bill to the plan's day. It never pays anything itself.

## Decisions

**P1. A section on Bills & receivables, not a new page.**
- "Payment plan" heads the sections of `/o/<slug>/invoices`, under the figures, over the whole list: under a status
  filter it is neither shown nor read. Every member reads it; only someone with `approval.decide` sees its Approve
  buttons.
- Cost if wrong: a longer page. The section is one component and moves without touching its logic.

**P2. What it covers.**
- Fourteen UTC days, today included (`PLAN_DAYS`).
- USDC payables still open (pending, scheduled, in flight, held, awaiting information, being decided, flagged) and open
  milestones. A bill enters the plan when its due day, its scheduled day or its discount deadline falls in the window; a
  bill whose plan day falls after the window is listed as "After <day>" and not counted in the days shown.
- EURC payables are paid from the EURC balance: their count and total are named apart, never added to USDC.
- Receivables are never counted. Recurring payments count once their bill for the period exists.
- Cost if wrong: a bill not yet entered is not in the plan, which then reads better than reality. The section says
  what it counts.

**P3. Cash and the cushion are Safe to spend's.**
- Cash at the start: the operating wallet's USDC plus the USYC reserve's value, as Safe to spend counts it (the
  reserve comes back in seconds, and the agent brings back what a day needs before it pays).
- The cushion is Safe to spend's: 15% of what leaves within 7 days and of the open milestones (`cashOutlook(...).cushion`),
  so the two figures never disagree.
- Cost if wrong: if the reserve could not come back in time, a day's balance would be optimistic. The agent checks the
  cash again before every payment either way.

**P4. Each bill's day.**
- Overdue or due today: today.
- Otherwise the due date. Never later, never earlier for any reason but a discount.
- Earlier only to take an early-payment discount that still applies, on its deadline (today when the deadline is
  today), and only when, with that bill paid then, the balance stays at or above the cushion on every day from then to
  the end of the window, no other bill is left short, and the agent's spending limit has room for it that day without
  taking the room a payment already fitting there had. Discounts are tried in order of deadline, then larger discount
  first, each against the plan as it stands.
- The discount must also be worth at least the yield of holding the cash in the reserve from its deadline to the due
  date, with the reserve's own rate (`accounts.apy`): the agent's own rule (payment timing), so a day the plan proposes
  is one the agent pays on when it decides the bill again, and a move is never undone by the agent's next decision.
  The yield only decides whether to propose paying early: a bill the agent already scheduled on or before the
  discount's deadline keeps that day, since the plan never moves a payment later only to earn yield.
- Cost if wrong: a discount missed, or one taken that the cushion could have spared. Both are estimates; the bill is
  still paid by its due date, and the agent decides again on the day.

**P5. Ordered by cash.**
- Within a day: a payment already on its way first, then milestones, then overdue bills (oldest first), then by due
  date, then the smaller amount, then the id.
- A bill the balance cannot cover on its day is marked short, with by how much. It is not taken off the balance (the
  agent holds a bill it cannot pay for cash), and what such bills come to is shown as still owed. The balance shown is
  never below zero, so the plan never spends cash that is not there.
- A payment due on its day that leaves the balance under the cushion is still planned on that day, and says so: an
  obligation is never delayed to protect the cushion, and never past its due date to earn yield.
- Cost if wrong: the agent pays in the order it decides; the plan's order is a preview, which is why it moves nothing
  by itself.

**P6. Each obligation is counted once.**
- Every row is counted once, by id. A bill with a payment in flight is that one payment.
- A milestone whose escrow already holds its USDC is listed, not counted: its cash has left the wallet.
- A bill the agent flagged for review (a likely duplicate among them) is listed, not counted, as Safe to spend does.
- A bill and an open milestone with the same payee and amount may be one payment entered twice. The plan cannot tell,
  and the agent would pay both, so both are counted, both are marked "may be the same payment", and neither can be
  moved from the plan until one of them is closed.
- Cost if wrong: two real payments to one payee for the same amount are marked until one is paid; nothing is hidden.

**P7. Each line's checks, as the agent's on the day.**
- Within the payee's payment limit; at or below the workspace's figure for two approvals; within the agent's daily and
  7-day spending limit on that day; payee not screened high risk.
- The 7-day limit is counted carefully: what the agent paid in the last 7 days counts against every one of the first
  7 days of the window, and nothing of it after (the plan knows the week's total, not each day's).
- A line that fails is still counted (it will be paid, by a person), is marked with the reason, and is not the agent's
  to pay: it does not use the agent's room on that day.
- Cost if wrong: a line marked that the agent would have paid, or the reverse. The agent's guardrails decide on the day;
  the plan only previews them.

**P8. Waiting for a person.**
- Held, awaiting information, being decided, and held milestones: listed with what they wait for and a link to
  Approvals, counted on their due day (today when overdue), never given a plan day. Nothing in the plan acts on them.
- A bill the agent has not decided yet gets a plan day and cannot be moved: the agent decides it first.

**P9. Approving a line moves a scheduled bill's day. Nothing else.**
- Offered only for a bill the agent scheduled, whose plan day differs from the agent's, within today and its due date.
- It writes `scheduled_for`, compare-and-set on the status, the day shown, the amount, the payee and the due date, and
  appends a signed `payment_rescheduled` entry (domain `ap`): who, from, to, the facts the line showed and the plan's
  fingerprint. The bill's decision trail shows it.
- It never sends money and never approves a payment. On the new day the agent decides the bill again with every check
  (payment timing P3): screening, the payment limit, two approvals, the spending limit on Arc and in code, the cash. A
  day the plan proposes is a discount's deadline or the due date, and on either the agent's own policy pays: the
  discount on its last day, or the bill on its due date.
- Moving a bill to today raises a cycle (`plan_approved`), so a discount ending today is not missed waiting for the
  schedule.
- Cost if wrong: a bill paid a few days earlier or later than the agent chose, never after its due date, always after
  every check. The entry says who moved it.

**P10. Who approves, and one press never skips a check.**
- `approval.decide` (owner, admin, approver), through the command `payment_plan.approve`, from the console only.
- Nobody approves the day of a bill they created, unless they are the workspace's only approver; then the entry says
  so (`soleApprover: true`), as Approvals does.
- "Approve all shown" sends every line it shows as approvable; the server checks each line on its own and moves only
  those that pass, and says which did not and why.
- Cost if wrong: a refusal a person did not expect, which names the reason.

**P11. A stale plan is refused.**
- The plan has a fingerprint (today, the cash, the cushion, the limits and every line's) and each line its own (the
  bill's amount, currency, payee and its address, due day, status, scheduled day, discount, who created it, and the
  plan's day for it).
- The server reads everything again and rebuilds the plan. A plan fingerprint that differs refuses the whole request; a
  line whose own fingerprint differs is refused. A change of payee, amount, balance or due date therefore invalidates
  what was shown.
- Cost if wrong: a person asked to approve again after an unrelated change (a payment elsewhere changed the balance).

**P12. Fresh data first (I20).**
- In a live workspace the balance is the chain's, read into `accounts.balance_synced_at`. Older than 10 minutes, or
  never read: the plan stays on screen, says how old the figure is, offers **Refresh balance** (the console's existing
  read, `workspace.read`), and turns approving off until the figure is fresh. The server refuses too.
- The spending limit, the figure for two approvals or the milestones that cannot be read: the same, naming what.
- A sandbox's balance is its own simulated figure, so it is always current.
- Cost if wrong: approving waits for a refresh a person did not think necessary.

**P13. Not while a cycle runs.** The agent's AP stage writes a decided bill without a compare-and-set, so a move is
refused while a cycle is running ("try again in a minute"), as changing the spending limit is.

**P14. What each figure is.**
- Projections are labelled as such: "Balance with this plan", "Discounts this plan would take, if paid as planned".
- Over the last 30 days, measured: bills paid by their due day, discounts taken (a paid bill's amount less what its
  transfer carried, as the report measures it), and days moved by a person (`payment_rescheduled` entries). These are the
  feature's three measures: overdue avoided, discount captured, manual reschedules.
- Nothing on the plan says "saved" about a discount not yet taken.

**P15. No migration; one new ledger action.** Every column exists (`invoices.scheduled_for`, `created_by`,
`paid_amount`, `accounts.balance_synced_at`, `accounts.apy`), so the migration number reserved for this feature (0097)
is left unused. No endpoint changes, but the ledger is part of the integration surface: `payment_rescheduled` entries
appear in `GET /api/v1/ledger` and as `ledger.appended`, a moved bill's `scheduledFor` changes in
`GET /api/v1/invoices`, and an event cycle's `events` can name `plan_approved`. `content/docs/changelog.mdx` says so
(2026-10-11).

## Not now

- Choosing another day by hand. A person approves the plan's day or leaves the agent's.
- Spreading bills over days to stay within the agent's daily limit: the plan marks a line over it.
- A plan for EURC, and the Gateway balance as cash for payouts sent through it (still counted against the wallet,
  which reads worse than reality, never better).
- Recurring periods whose bill does not exist yet.
- The agent being paused or payments switched off: the header already says so; the plan still shows the days the agent
  would pay on.

## Testing

- `tests/payment-plan.test.ts`: the pure planner over hand-made rows: overdue first, due date by default, a discount
  taken only when the cushion holds, short lines not spent and counted as still owed, each obligation once (flagged,
  escrow, in flight, bill and milestone alike), the per-line checks and the 7-day window, moves only for scheduled bills,
  fingerprints that change with payee, amount, balance and due date, freshness, and a fixture plan that never spends
  more than the cash or pays the agent past its limit.
- `tests/payment-plan-apply.test.ts`: the write is a compare-and-set with the shown facts and appends the signed entry.
- `tests/commands-payment-plan.test.ts`: the gate, a running cycle, stale balance, changed plan, a line's own checks, the
  creator refused unless sole approver, a batch applying only the passing lines, and a cycle raised for today.
- `tests/payment-plan-ui.test.tsx`: the section's words, the stale warning with approving off, the viewer without
  Approve, the projected figures labelled, and the struck amount and a balance under the cushion said in words.
- `tests/payment-plan-input.test.ts`: the rows turned into the planner's input as the page and the command both read
  them, the reserve's rate among them; `tests/payment-plan-outcomes.test.ts`: the three measures.
- The guide (`content/docs/guides/payment-plan.mdx`, Everyday work) with its screenshot (`payment-plan`, from
  `src/app/docs-shots/payment-plan-fixture.ts`); the docs tests pin its quotes and its place, and the decision trail
  test the new step.
