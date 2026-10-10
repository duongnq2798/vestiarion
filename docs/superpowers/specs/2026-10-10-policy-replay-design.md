# Try a rule on your own history before you change it

Date: 2026-10-10. Status: shipped with this PR (design decided under the standing autonomy grant; each ruling carries
its cost if wrong). Roadmap F20, with I10 and I21.

## 1. Why

A finance person who owns the workspace's limits hesitates to change one: they cannot see which of their own bills a
new figure would have stopped, or let through. Today the only way to find out is to change it and watch.

The agent's decisions already record the facts code weighed: the amount (and a EURC bill's USDC value), the
counterparty and its risk level, the rule that stopped it if one did, the spending limit's room for a payment now, and
what was paid. That is enough to run the code's checks again with one figure changed, without asking the model.

## 2. What it does

- Next to each setting that holds a rule figure, a person who may change that setting enters a candidate figure, picks
  a window (the last 30 or 90 days) and chooses **Try it on past decisions**.
- The server reads the workspace's agent decisions on bills and contractor milestones in the window and replays the
  code's checks on each, twice: with the figures in force now, and with the candidate swapped in. No model is asked.
- The result counts the decisions **unchanged**, those that **would now be held**, **would now be paid**, **would now
  need two people**, and those it **can't tell**, and lists every decision that changes, and every one it cannot tell,
  with the bill, counterparty, amount, date, the rule, and a link to its ledger entry.
- **Apply this figure** saves the candidate through the setting's own action, with the same permission and checks as
  saving it by hand. It is refused if the setting changed since the replay. Its ledger entry records the replay it was
  applied after: the window and the counts.

## 3. Rulings

- **P1 — the settings it tries.** The three figures code checks a payment against, each with its own permission:
  - a counterparty's payment limit (`records.write`, owners and admins), on **Counterparties**, **Edit limit**;
  - the figure above which a payment needs two approvals (`approval.policy`, owners), in **Settings**, **Two
    approvals**;
  - the agent's daily and 7-day spending limit (`agent.budget`, owners and admins), on the console's **Agent spending
    limit**.

  Trying a figure needs the permission that changes it, so the control shows only where the setting can be saved.
  *Cost if wrong:* an admin who wants to try a two-approvals figure asks an owner; trying is read-only, so widening it
  later is a one-line change.

- **P2 — out of scope, said in the UI and the guide.**
  - The spending-limit contract on Arc is not asked again. A decision the contract refused for want of room, replayed
    under different spending-limit figures, is counted as can't tell; its other answers (a route it cannot carry, a
    payment already made) stand as recorded. Its figures are changed only where they are today (an owner's wallet
    changes its own contract in Settings, under Go live).
  - Tenant isolation, the new payee check, maker and checker, screening, duplicates and every other check no setting
    here changes are taken as they were when the decision was made.
  - The model's own judgment: a decision where the model chose to hold, flag or ask for information stays as it was.
  - The sandbox's daily cycle cap counts cycles, not payments, and is not a figure anyone sets; Slack's figure for
    deciding from Slack governs people, not the agent.
  *Cost if wrong:* low; each is a separate rule with its own record, and adding one is a new stage in the replay.

- **P3 — before is today's figures, after is today's with the candidate.** Both columns are replays: the figures in
  force now for every setting, and the same with the one figure swapped. So the difference is the candidate's alone,
  and a figure someone changed earlier in the window does not show up as a change. What actually happened is one click
  away, in the ledger entry. *Cost if wrong:* a person who expected "what happened" in the before column reads the
  guide's sentence about it.

- **P4 — the order of the checks is code's.** The replay walks the stages in the order `enforceApGuardrails` runs them
  for a bill, and the contractor stage runs them for a milestone release. For a check no setting here changes, what it
  said is read from the decision's recorded rule: a stage before the recorded rule passed, the recorded rule fired, and
  nothing past it was asked.
  - A stage past the recorded rule that the replay reaches is read from the facts where they settle it: a payee on Arc
    (no `payout`) passes the cross-chain checks; a USDC bill passes the EURC checks; a first payment is read from
    `observed.newPayee`; a pay decision's spending-limit contract from its recorded check (absent means the workspace
    did not enforce one, since the stage asks before the checks run); a sandbox has no contract.
  - Any other such stage is can't tell.
  *Cost if wrong:* a decision is can't tell that a closer reading could settle; never a guess.

- **P5 — the figure checks.**
  - Payment limit: the counterparty's configured limit as screening allows it for the risk the decision recorded
    (`paymentLimitForRisk`: all of it when clear, a quarter when medium, none when high). A counterparty no longer in
    the workspace keeps the limit its decision recorded, in both columns. A bill weighs its USDC value.
  - Two approvals: strictly above the figure, a pay or a schedule, a bill or a release.
  - Spending limit: a payment now or a release only, against what the replay itself has the agent paying that UTC day
    and in the 7 days ending it.
  *Cost if wrong:* the same as the live check's, since these are the live check's functions (`exceedsBudget`,
  `budgetRoom`, `paymentLimitForRisk`).

- **P6 — running totals, in recorded order.** Decisions are replayed by ledger sequence. Each column carries its own
  running total of what the agent pays:
  - a decision the replay lets through counts what it paid if it paid; if code had stopped it, its full USDC value (an
    early-payment discount it might have taken is not known); if something other than a rule stopped it (a pause, the
    cash it needed, a failed transfer), nothing, as then; in shadow mode nothing, since a person's verdict pays;
  - the agent's payments in the six days before the window count as recorded, so the first week's totals are right;
  - once the replay has paid a bill, a later decision on the same bill is that bill paid earlier: it counts nothing
    and is unchanged if the bill is paid in both columns.
  - A decision the replay cannot tell, which might have paid, widens the total to a range. A later spending-limit
    check that the low and the high end of the range answer differently is can't tell.
  *Cost if wrong:* totals that overstate the agent's spend by a discount; never one that hides spend.

- **P7 — can't tell is never a guess.** A decision is can't tell, in its column and in the counts, when:
  - it recorded no amount, no decision, or no rule (a stopped decision with no `guardrailRule`), or a rule this replay
    does not know;
  - the payment limit is reached and the counterparty's recorded risk level is missing;
  - it reaches a stage its facts do not settle (P4), or a spending-limit check its range does not settle (P6), or a
    contract refusal for want of room under other figures (P2);
  - an earlier decision on the same bill was can't tell and might have paid it.

- **P8 — the five counts.** Each decision is compared on one question: does the agent go ahead (pay, schedule or
  release, or the bill was paid earlier in the replay) or not.
  - Unchanged: the same answer in both columns, whatever the rule.
  - Would now be paid: stopped before, goes ahead after.
  - Would now need two people: went ahead before, stopped after by the two-approvals figure. This is the person asked
    above an amount.
  - Would now be held: went ahead before, stopped after by any other rule (a payment limit or the spending limit).
  - Can't tell: either column.
  *Cost if wrong:* a reader who wants the change between two rules that both stop a bill does not see it counted; the
  list names each column's rule for every decision it shows.

- **P9 — the window.** 30 or 90 days ending now, read in pages of 1,000 entries. A window over 20,000 agent decisions is
  refused with a message to try 30 days. *Cost if wrong:* a very busy workspace tries the shorter window.

- **P10 — applying it (I10).** **Apply this figure** posts to the setting's existing action (`updateCounterpartyLimitAction`,
  `setTwoApprovalsAction`, `setAgentBudgetAction`), which authorizes the same permission and calls the same library
  function as **Save**: refused while a cycle runs, the two-approvals and Arc mainnet rules, the contract on Arc changed
  first where enforced, the cycle event when a figure is loosened. Nothing new can approve a payment or change who
  approves one.
  - The form carries the figure in force when the replay ran. The library compares it with the figure it reads before
    writing and refuses with "...changed since you tried it" when they differ. For a counterparty's limit the write is
    also the existing compare-and-set.
  - The action replays again on the server, with the same window and candidate, and the library adds that summary to
    the change's signed entry as `detail.replay`: the window's days, start and end, and the five counts. The browser's
    copy is never trusted for the record. The entries reach webhook endpoints and `GET /api/v1/ledger` as before,
    with the new field, so `content/docs/changelog.mdx` says so.
  - The dialog shows the change as a before and after: the figure in force and the candidate, beside the counts. While a
    result is shown the form's button reads **Apply this figure**; editing the figure or the window clears the result,
    and the button saves without a replay again, as **Save** always did.
  - Two approvals tried at Off (the figure emptied) is applied by **Turn off**, behind its existing confirmation, which
    then carries the replay; the set form never turns it off. On Arc mainnet trying Off is refused, as saving it is.
  *Cost if wrong:* a decision written between the try and the apply makes the recorded counts differ from the ones
  shown by that decision; the entry records what the server saw when it applied.

- **P11 — no new command name and no migration.** Settings changes are console-only server actions today, outside
  `COMMAND_PERMISSIONS`, which lists what other surfaces may run; this keeps them there. The replay reads
  `ledger_entries`, `counterparties`, `invoices`, `milestones`, `approval_policies` and `agent_budgets` through the
  organization-scoped `db()`. *Cost if wrong:* if settings move into commands, the apply moves with them.

## 4. Code

- `src/lib/policy-replay.ts`: pure. `replayDecisions(entries, { windowStart, current, candidate })` returns each
  decision's outcome before and after and the counts; `withCandidate`, the stage orders, `replaySummary` for the ledger.
- `src/lib/policy-replay-read.ts`: server. Parses the form's candidate with each setting's own parser, reads the
  figures in force and the window's entries, runs the replay, and names each decision's bill and counterparty.
- `src/app/actions/policy-replay.ts`: `tryRuleAction`, read-only, authorized by the setting's permission.
- The three existing actions and library functions take an optional `expected` figure and `replay` summary.
- `src/lib/policy-replay-apply.ts`: what the three actions read from a form that tried the figure first.
- `src/components/RuleTrial.tsx`: the window, **Try it on past decisions**, the result, and the apply fields, used by
  the three settings' forms. A request that never answers is said in the form, never thrown at the page.
- `src/app/design/replay-fixture.ts`: the sample data's first week replayed with the pure functions, for /design (an
  interactive demo) and the guide's screenshot (`/docs-shots/try-a-rule-result`).

## 5. Tests

- `tests/policy-replay.test.ts`: each figure rule, a fixed rule before and after a figure rule, running spending-limit
  totals in order across days and weeks, a bill paid earlier, missing facts as can't tell, a range that cannot settle,
  unchanged decisions and the model's own holds, milestone order.
- `tests/policy-replay-read.test.ts`: the reader against a recorded fake Supabase.
- The apply path: permission, the stale refusal, and `detail.replay` in each setting's signed entry
  (`tests/policy-replay-actions.test.ts`, and each library's own test).
- `tests/rule-trial.test.tsx`: the result's markup on the sample, the apply fields, and the control in each form.
