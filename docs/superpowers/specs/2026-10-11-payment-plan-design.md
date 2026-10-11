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
  bill whose plan day falls after the window is listed as "After <day>" and not counted in the days shown. A bill the
  agent scheduled inside the window keeps that day even when its due date falls after it: no move leaves the window
  (P9), so the days shown count it where the agent will pay it.
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
- Otherwise the due date, or the day the agent scheduled it for when that is earlier: the plan never moves a payment
  later than the day the agent chose. A later day only holds the cash a few days (nothing at all when the reserve earns
  nothing), takes away the margin a missed cycle would need, and frees cash and room that another move could then rely
  on. Never earlier for any reason but a discount, except a day the agent chose after the due date (a due date edited
  since): that is brought back to the due date when the checks below hold on their own (the cash covers it, no other
  bill is left short, nothing goes past the agent's limit), whatever the cushion; otherwise the agent's day stays, and
  the line says why. Such bills are brought back one at a time, in order of that day, each weighed against the plan
  with the ones brought back before it as well as on its own, so two are never brought back to days they do not fit
  together.
- Earlier only to take an early-payment discount that still applies, on its deadline (today when the deadline is
  today), for a bill the agent has not already scheduled on or before that deadline, and only when, with that bill
  paid then:
  - the cash covers it that day: a bill the cash cannot pay on its deadline keeps its day and counts in full as owed,
    rather than showing a discount it cannot take;
  - no other bill is left short. Never traded for another bill's shortfall, not even when the bill itself is short
    without the discount and less would be left owed with it: that would offer a move that leaves a covered bill short,
    possibly one whose own discount the agent would take;
  - the agent's spending limit has room for its billed amount that day without taking the room a payment already
    fitting there had (P7), even when the bill had no room on its own day either: the first version only refused a
    move that left a line newly past the limit, so a bill already past it on the agent's day could be offered a day
    whose room another move had freed, and approved alone it waited for a person on its discount's last day. Now a
    move the agent could not pay on its own is never offered, so what the plan shows for that day is what the agent
    does, and no discount is counted that the agent would not take on its own;
  - the balance stays at or above the cushion on every day from the deadline to the day before the bill would
    otherwise pay, or is at least no lower there than without the discount. The cushion is weighed only on those days:
    from then on, the discount leaves more cash, never less, so a balance that goes under the cushion later in the
    window because of another bill is no reason to refuse it. And it is not weighed at all when, without the discount,
    the cash would not cover the bill on the day it would otherwise pay: paying early is then what pays it at all, and
    the cushion is no reason to leave a bill unpaid.
- Each of those checks holds twice: against the plan as it stands (the discounts already taken, in order of deadline,
  then larger discount first), and against the schedule as it stands now with only this bill moved, so a move the plan
  offers never holds only because another line is approved too (P9).
- The discount must also be worth at least the yield of holding the cash in the reserve from its deadline to the due
  date, with the reserve's own rate (`accounts.apy`): the agent's own rule (payment timing), so a day the plan proposes
  is one the agent pays on when it decides the bill again, and a move is never undone by the agent's next decision.
  The yield only decides whether to propose paying early.
- A bill the agent scheduled on or before the discount's deadline (and its due date) keeps that day: that day takes
  the discount, and the plan tries no other day and never moves it later, to earn yield, to protect the cushion, or
  because the cash or the limit fall short that day. Its line says what the day holds: the day the balance goes under
  the cushion, or that it is short or over the agent's limit (the agent then holds it, or a person pays it). The
  plan's first version offered the due date instead when paying early left another bill short or the agent past its
  limit; that rule was dropped as too clever to get right. With no money coming in, the plan's later day pays more and
  covers no more, it could fall after the window where nothing is checked, and Approve lost a discount the agent would
  take.
- A taken discount's line says the balance stays above the cushion, or until which day when it goes under it later
  in the window, or, when paying early is what lets the cash cover the bill, that the cash would not cover it on the
  day it would otherwise pay, so the sentence is true of the plan shown.
- The section states above its lines only what holds of every move it offers: "Each bill is paid on its due date, or
  on an earlier day the agent chose. The plan proposes paying before that only for a discount worth at least what the
  cash would earn until then; each line says why it is on its day." A day the agent chose after the due date is
  brought back to the due date, not before it, so the rule's "only" holds of that move too. The cushion is left to
  each line's reason and its Under the cushion mark: the first version added "while the balance stays above the
  cushion", which the Approve beside a discount day the cash needed, or a bill brought back to its due date, under the
  cushion both, contradicted. Saying each exception there made the sentence longer than the rule it summed up.
- Cost if wrong: a discount missed (one that would have needed another bill left short, or one on a bill the agent's
  limit has no room for on either day, which waits for a person on the agent's day), a person asked to approve the
  agent's own discount day where a later day's limit had room, the agent's early payment kept while the balance sits
  under the cushion for a few days, or a bill kept on a day the agent chose a few days before its due date. All are
  estimates; the bill is still paid by its due date, and the agent decides again on the day.

**P5. Ordered by cash.**
- Within a day: a payment already on its way first, then milestones, then overdue bills (oldest first), then by due
  date, then the smaller amount, then the id.
- A bill the balance cannot cover on its day is marked short, with by how much. It is not taken off the balance (the
  agent holds a bill it cannot pay for cash), and what such bills come to is shown as still owed, at the billed amount:
  unpaid on its day, a bill also loses a discount ending that day, so its discount is not counted as taken. The balance
  shown is never below zero, so the plan never spends cash that is not there.
- A payment due on its day that leaves the balance under the cushion is still planned on that day, and says so: an
  obligation is never delayed to protect the cushion, neither past its due date nor later than the day the agent
  chose (P4), and never past its due date to earn yield.
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
- The spending limit is weighed against the billed amount, as the agent's guardrail weighs it (`enforceApGuardrails`
  is given the full amount, not the discounted one); what leaves, less any discount, is what then uses the room, as the
  agent counts it (`countedUsdc`).
- A verified milestone gets the release's own checks (the contractor's payment limit, two approvals, screened high
  risk), read from the contractor's row. One that fails is not the agent's to release: it waits for people, says so,
  and uses none of the agent's room, as the release itself never reads the limit for it.
- EURC bills use the agent's limit too, at their USDC value, for which the plan has no quote: the preview leaves them
  out, so on a day the agent pays a EURC bill on its own it may have less room than the plan shows. The guardrail
  decides on the day.
- The 7-day limit is counted carefully: what the agent paid in the last 7 days counts against every one of the first
  7 days of the window, and nothing of it after (the plan knows the week's total, not each day's).
- A line that fails is still counted (it will be paid, by a person), is marked with the reason, and is not the agent's
  to pay: it does not use the agent's room on that day.
- Cost if wrong: a line marked that the agent would have paid, or the reverse. The agent's guardrails decide on the day;
  the plan only previews them.

**P8. Waiting for a person.**
- Held, awaiting information, being decided, and held milestones: listed with what they wait for and a link to
  Approvals, counted on their due day (today when overdue), never given a plan day. Nothing in the plan acts on them.
  A verified milestone the agent may not release on its own (P7) waits for people too, counted today.
- A bill the agent has not decided yet gets a plan day and cannot be moved: the agent decides it first.
- A scheduled bill whose day has come (today or before, still `scheduled` until the next cycle runs) is decided again
  at the agent's next cycle (`dueForDecision`). The plan counts it where the agent's rule (payment timing) puts it then,
  in the plan and as scheduled now alike: today when overdue or due today, a discount's deadline when the discount is
  worth at least the yield, its due date otherwise, whatever the cushion. It is not a discount the plan tries, and it
  cannot be moved; it says "The agent decides it again at its next cycle". Counting it on another day would show a
  balance, a lowest figure and a reason for a day that will not happen.

**P9. Approving a line moves a scheduled bill's day. Nothing else.**
- Offered only for a bill the agent scheduled, whose plan day is earlier than the agent's (a discount's deadline, or
  the due date when the agent's day is after it), inside the 14 days shown. Never later than the agent's day, never out
  of the window, never for a bill whose day already takes a discount, and only when the line's checks hold on their own,
  as the bills are scheduled now, as well as together with every other line shown (P4): approving one line never relies
  on another being approved. Two lines can still each hold on their own, and all the lines together, yet not the two
  without a third that frees the room both need: the plan weighs each move alone and all of them together, never every
  subset, so the command weighs again the moves a press actually makes (P10).
- It writes `scheduled_for`, compare-and-set on the status, the day shown, the amount, the payee and the due date, and
  appends a signed `payment_rescheduled` entry (domain `ap`): who, from, to, the facts the line showed and the plan's
  fingerprint. The bill's decision trail shows it.
- It never sends money and never approves a payment. On the new day the agent decides the bill again with every check
  (payment timing P3): screening, the payment limit, two approvals, the spending limit on Arc and in code, the cash. A
  day the plan proposes is a discount's deadline or the due date, and on either the agent's own policy pays: the
  discount on its last day, or the bill on its due date.
- Moving a bill to today raises a cycle (`plan_approved`), so a discount ending today is not missed waiting for the
  schedule.
- Cost if wrong: a bill paid a few days earlier than the agent chose, never after its due date, always after every
  check. The entry says who moved it.

**P10. Who approves, and one press never skips a check.**
- `approval.decide` (owner, admin, approver), through the command `payment_plan.approve`, from the console only.
- Nobody approves the day of a bill they created, unless they are the workspace's only approver; then the entry says
  so (`soleApprover: true`), as Approvals does.
- "Approve all shown" sends every line it shows as approvable (less the person's own bills). The server reads the rows
  again and builds the plan from them; then, in the plan's order whatever order the lines came in, it checks each line
  on its own and weighs its move against the schedule as it stands with the moves this press has already made
  (`moveObjection`, the plan's own checks: no other bill newly short or past the agent's limit, the bill itself covered
  and within the limit, a discount's cushion). A line that fails is not moved, and says "Together with the moves just
  made, it would ...", so the moves made always hold together, whichever lines a press approves or refuses. A single
  line passes as the plan showed it, since the plan offered it only when its checks held on their own. Only lines that
  pass move, and the message says which did not and why.
- A write that fails (the database or the network) stops the press there: it may or may not have landed, so no later
  line can be weighed against the schedule as it stands. The lines already moved stay moved, a move to today still
  raises its cycle (P9), the line that failed and those after it say "That did not work. Try again in a moment.", and
  the answer refreshes the page (`changed` when nothing moved).
- Cost if wrong: a refusal a person did not expect, which names the reason, or a line the plan showed as approvable
  refused at approval because the line that freed its room was not approved; the page then shows the plan as it is.

**P11. A stale plan is refused.**
- The plan has a fingerprint (today, the cash, the cushion, the limits and every line's) and each line its own (the
  bill's amount, currency, payee and its address, due day, status, scheduled day, discount, who created it, the
  payee's payment limit and screening, and the plan's day for it). A milestone's carries its contractor's limit and
  screening too: whether the agent may release it decides whose room it uses.
- The server reads everything again and rebuilds the plan. A plan fingerprint that differs refuses the whole request; a
  line whose own fingerprint differs is refused. A change of payee, amount, balance or due date therefore invalidates
  what was shown, and so does a payee screened high risk or a payment limit changed since: the line's Approve is not
  left on screen to be refused again. Since the plan's fingerprint covers every line's, a change to one bill reads as
  a changed plan; a line refused for its own fingerprint is a request the console does not send. A bill that changes
  between the read and the write loses the compare-and-set (P9): "This bill changed a moment ago. Look at the new
  plan."
- Such a refusal, and a stale balance's (P12), carries `changed`, so the console refreshes the page: the person sees
  the new plan, or the stale warning with Refresh balance, instead of the old plan's buttons refused again.
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
  which reads worse than reality, never better). EURC bills' use of the agent's spending limit (P7).
- Moving a bill later than the agent chose, or trading one bill's shortfall for another's (P4).
- Recurring periods whose bill does not exist yet.
- The agent being paused or payments switched off: the header already says so; the plan still shows the days the agent
  would pay on.

## Testing

- `tests/payment-plan.test.ts`: the pure planner over hand-made rows: overdue first, due date by default, the agent's
  earlier day kept, a discount taken only when the cushion holds until the bill would otherwise pay (or the cash covers
  the bill only that way), the agent's own discount day kept whatever its day holds, no move out of the window, later
  than the agent's day or relying on another move (a bill already past the agent's limit on its own day among them),
  bills brought back to their due dates one at a time, a scheduled bill whose day has come placed by the agent's rule,
  short lines not spent and counted in full as still owed, each obligation once (flagged, escrow, in flight, bill and
  milestone alike), the per-line checks on the billed amount, a capped milestone outside the agent's room, the 7-day
  window, moves only for scheduled bills, fingerprints that change with payee, amount, balance, due date, payment
  limit and screening, freshness, and a fixture plan that never spends more than the cash or pays the agent past its
  limit.
- `tests/payment-plan-apply.test.ts`: the write is a compare-and-set with the shown facts and appends the signed entry.
- `tests/commands-payment-plan.test.ts`: the gate, a running cycle, stale balance, changed plan (a payee screened
  high risk or its limit lowered among them; both marked `changed`, so the page refreshes), a line's own checks, the
  creator refused unless sole approver, a batch applying only the passing lines, each weighed in the plan's order with
  the moves made before it, a write failing part way, and a cycle raised for today.
- `tests/payment-plan-ui.test.tsx`: the section's words, its rule true beside the moves that go under the cushion (a
  discount day the cash needs, a bill brought back to its due date), the stale warning with approving off, the viewer
  without Approve, the projected figures labelled, and the struck amount and a balance under the cushion said in words.
- `tests/payment-plan-input.test.ts`: the rows turned into the planner's input as the page and the command both read
  them, the reserve's rate and a milestone's contractor limit and screening among them; `tests/payment-plan-outcomes.test.ts`: the three measures.
- The guide (`content/docs/guides/payment-plan.mdx`, Everyday work) with its screenshot (`payment-plan`, from
  `src/app/docs-shots/payment-plan-fixture.ts`); the docs tests pin its quotes and its place, and the decision trail
  test the new step.
