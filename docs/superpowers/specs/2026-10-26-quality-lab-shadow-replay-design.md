# Quality Lab: replaying the shadow-mode decisions (2026-10-26)

Status: the export and the replay are accepted and built. The export (SX1-SX10) writes the file; the replay (SR1-SR13)
runs it through today's decision code in CI and publishes the result beside the scenarios.

## Why

The Quality Lab (`2026-10-26-quality-lab-design.md`) runs fixed scenarios through the real decision code, with the
model's answers scripted. Shadow mode has real ones: every decision the agent made on a bill while a workspace ran in
shadow mode, with a person's verdict on many of them. Replaying each of those decisions through today's decision code
in CI, the way `tests/quality-lab.test.ts` runs its scenarios, shows how many reach the same outcome today.

CI has no database and no secrets, and this repository is public. So the decisions are first exported into a committed
file, by a script the partner runs, and only from the team's own workspaces. This section covers the export. The replay
reads the file and nothing else.

## Export

Each rule ends with what it costs if it is wrong. Code comments and tests cite the ids, for example "(shadow replay
SX3)".

**SX1. What is exported.**
- Every agent decision on a bill made in shadow mode: a `ledger_entries` row by the agent, in the `ap` domain, with
  `action` in `AGENT_DECISION_ACTIONS` (`src/lib/agent/shadow-hold.ts`: `ap_pay`, `ap_schedule`, `ap_hold`,
  `ap_flag_fraud`, `ap_request_info`) and `detail->>'shadow' = 'true'`.
- Left out: entries the guardrail fixture planted (`detail ? 'guardrailFixture'`, `scripts/guardrail-fixture.ts`), and
  decisions on a sample counterparty (`counterparties.sample`), as `open_verdicts` leaves them out (0086).
- Each decision carries the person's verdict from `decision_verdicts` (`entry_seq = seq`): `agree`, `disagree`, or null
  when none was given. The verdict's reason is never read.
- If wrong: a planted or sample decision would be replayed as if the agent had made it on a real bill.

**SX2. Only the team's own workspaces, on Arc testnet.**
- A workspace is exported only when it is the founding workspace, by its id (`FOUNDING_ORG_ID`,
  `src/lib/dal/org-config.ts`), or its `orgs.created_by` is in `platform_team`: the rule every reader that publishes rows
  uses (`latest_team_decision` 0087, `recent_team_decisions` 0100, the landing's journeys 0134). Customers' workspaces
  are never read into the file, whatever they hold.
- Not `orgs.created_by is null`, the split `open_verdicts` (0086) counts with: a workspace's creator is cleared when
  they delete their account (0023) and the workspace stays whenever another owner remains
  (`src/lib/platform/delete-account.ts`), so it may be a former customer's (0037). Counting it as ours under-counts
  customers; publishing it would publish a customer's decisions.
- The read also selects each row's side as `founding`, `team` or `customers`, and the mapping refuses the whole export
  if any row is not `team`, or is `founding` with any id but the founding workspace's: a broken filter fails loudly
  rather than writing.
- Only `orgs.network = 'arc-testnet'`. Shadow mode runs nowhere else (`startShadowMode` refuses Arc mainnet), so this
  only makes the file's "on Arc testnet" true by construction.
- If wrong: a customer's bills, amounts and verdicts would be published in a public repository.

**SX3. An allowlist, in a pure function.**
- `exportShadowDecisions(rows, verdicts, readAt)` in `src/lib/quality-lab/shadow-export.ts` maps the read rows to the
  file. It copies only fields it names, one by one, from the decision's ledger detail (the AP stage writes it in
  `src/lib/agent/orchestrator.ts`, `appendLedgerEntry` in `decideApPayable`). Every other field is dropped, so a field
  added to the ledger later never reaches the file until someone names it here.
- A named field passes only as what it should be: a finite number, a boolean, or an enum-like token (lowercase letters,
  digits, `_`, `.`, `-`, at most 40 characters; a currency as 3 to 5 capitals). Anything else becomes null.
- What passes, enough to rebuild the bill, the payee and the workspace for the same decision:
  - the decision as the entry records it: its action, `payOn` as days from the decision day, `fundWithSwap`,
    `confidence`; `decisionMode`; the written policy's action only; `agreedWithReference`; `guardrailBlocked`,
    `guardrailRule`; `currency`; `timingRule` and the model's requested day when code moved it;
  - `observed`: the amount, payment limit, risk level, the performance score, status and counts, whether a purchase
    order was present (`poPresent`, never the reference itself), goods received, whether a purchase order is required,
    the two-approvals figure, the operating balance, whether the address is unconfirmed or missing, the new payee
    check's kind of giver, how the address was asked for and its booleans, the bought payee history's counts, whether
    the document named a pay-to address and whether it differed from the one on file (SX4), the project's state and
    figures, the same work's kind, status and signal, and the duplicate check's counts with each match's status,
    confidence and signals;
  - the spending limit's figures (`outflowBudget`), the contract's coverage and verdict state and figures
    (`onChainLimit`), the payout route and fee with the Gateway balance a Gateway payout was weighed against and both
    routes' quotes (`bridge.gateway_balance_short`), a EURC bill's USDC value, rate, the FX quote's USDC minimum and
    balance, with the USDC due within 7 days, the swap offered (USDC in, cost percent, EURC minimum) and why none was,
    as a kind (`no_route`, `quote_unreadable`, `quote_unanswered`, `not_quoted`, `minimum_short`, `payment_started`,
    `other`; never the sentence) for `fx.swap_cost_above_cap` and `fx.swap_usdc_short`, the timing figures, the terms'
    figures, cash ahead's figures, whether the cash priority plan made it wait, an FX reopen's trigger and the action it
    followed, what a payment sent and the discount it took;
  - `execution.resultingStatus`, `execution.heldBecause` and `execution.chainMode` (`live` or `simulate`), nothing else
    of the execution;
  - beside the entry, from the payee's row (`payeeOnFile`), only what it says of the decision: its role (`vendor`,
    `client`, `contractor`; nothing changes it once the payee is added) for `counterparty.client_payable`, and how many
    whole hours before the decision its address last changed, which the payee lock's cooling-off weighs in hours. That
    time is kept only when the address has not changed since the decision: not by its `address_changed_at`, and not by
    a `counterparty_address_changed` entry after the decision's (a mirror address clears the time). Otherwise it is
    null, and `addressChangedSinceDecision` says so;
  - beside the entry, from the workspace's signed ledger, the payee lock in force at the decision (`payeeLock`, SX9).
- If wrong: a field added to the ledger detail later, a memo, a name, would reach a public file with no one deciding it.

**SX4. No text, names or identifiers; pseudonyms link decisions.**
- Never exported: the model's or the policy's reasoning, any free text (`finding`, `note`, `reason`, `about`,
  `explanation`), names, memos, purchase order references, invoice numbers, addresses, emails, UUIDs, transaction
  hashes, the contract's ref, the vendor document's request id and file hash, members' ids, and the ledger's `seq`,
  which would link the file to the workspace's signed ledger (an FX reopen's entry numbers included).
- An id that links two decisions becomes a pseudonym local to the file, assigned in decision order: workspaces `w1`,
  `w2`…, bills `b1`…, payees `p1`…, projects `pj1`…, milestones `m1`…. The same bill decided twice, a duplicate match's
  other bill and a bill of the same work all get the bill's one pseudonym, so the replay can rebuild the book they
  share.
- Whether the document's pay-to address differed is the decision's, not today's: true when the decision was held for
  exactly that (`invoice.pay_to_differs`, usually resolved by making the document's address the one on file); false
  when the document named none; otherwise computed against the payee's address on file when the export runs
  (`payToDiffers`) only if that address has not changed since the decision (SX3), and null (unknown) if it has. The
  address itself is not kept.
- Each decision's id is `shadow-01`, `shadow-02`… in time order (the ledger's order breaks a tie), and its time is kept to
  the minute.
- If wrong: an id or a hash would let anyone tie a public file to a private workspace's records.

**SX5. Dates as days from the decision.**
- Every date the decision names (its `payOn`, the due date, the policy's target day, the discount deadline, a late
  fee's first day, the day it was scheduled for earlier) is kept as whole UTC days from the decision's day
  (`…InDays`, negative when before). The replay sets its clock to that day and adds them back.
- The decision's day is `decidedOn`: the day the decision code measured its timing on (`timing.today`, from the `now`
  `decideApPayable` takes before the model's answer and the checks), when it is a real calendar day within a day of the
  entry's; the day of the entry's time otherwise. The entry is written after the model's answer and the checks, so a
  cycle that crosses UTC midnight writes it the next day: counting from that day would bring every bill a day closer.
- If wrong: a replay at another day would see a bill already overdue, or a discount long gone.

**SX6. The output is refused, whole, if anything looks private.**
- `assertShareable(file)` walks every key and string in the decisions and `readAt`, and throws, naming the path of the
  first offending value and never the value, when one looks like an address or hash (`0x` and 40 hex digits or more),
  an email address, or a UUID, holds 32 hex digits in a row (an address without its `0x`, 40 digits, or a UUID without
  its dashes, 32, both shaped like tokens), or is longer than 40 characters. The file's `source` must be the module's
  own sentence.
- The script runs it before writing; nothing is written when it throws.
- If wrong: one mistake in the allowlist would publish what SX4 forbids.

**SX7. The script reads once, read-only, and writes one file.**
- `npm run quality-lab:shadow` (`scripts/quality-lab-shadow.ts`) connects as `npm run research:replay` does (`.env.local`
  then `.env`, `SUPABASE_DB_URL`, or the project id and database password), opens `begin transaction read only`, makes
  one read of the entries (joined to `orgs`, `platform_team` and `counterparties` for SX1 and SX2, looking for a later
  `counterparty_address_changed` entry for SX3, and reading the workspace's `payee_lock_changed` entries and its
  `approval_policies` row for SX9) and one of their verdicts, commits and closes. It writes nothing to the database.
- It writes `src/lib/quality-lab/shadow-decisions.json` (2-space JSON, LF, a trailing newline) and prints one line: how
  many decisions, from how many workspaces, and their verdicts.
- The query and write are `runShadowExport({ client, write, now })` in `scripts/lib/quality-lab-shadow.ts`, which takes
  any client with `query(text, params)` and any writer, so tests run it on fakes and on PGlite with the real migrations.
- The partner runs it and commits the file; it is not run in CI and not wired into any page.
- If wrong: a write to the database from an export script, or a read outside one transaction, could change or mix what
  is exported.

**SX8. The file.**
- `{ source, readAt, decisions }`: `source` is a plain sentence of what it is (the team's own workspaces in shadow mode
  on Arc testnet; customers' workspaces are never exported), `readAt` the export's time, `decisions` in time order.
- Its types (`ShadowDecisionsFile`, `ShadowDecision` and their parts) are exported from
  `src/lib/quality-lab/shadow-export.ts` for the replay.
- If wrong: a replay would guess the shape of what it reads.

**SX9. The payee lock each decision was made under.**
- `counterparty.cooling_off` (`enforceApGuardrails`, `inCoolingOff` in `src/lib/payee-lock-rules.ts`) holds a payment
  or a schedule to an address changed less than the lock's wait ago, while the lock is on. The AP stage reads the lock
  once, when it begins, and `changePayeeLock` refuses a change while a cycle runs (PL1), so the lock a decision was made
  under is the one in force when its entry was written.
- Each decision carries `payeeLock: { on, coolingHours }`, from the workspace's signed ledger: the `to` of its latest
  `payee_lock_changed` entry (domain `system`, written by `changePayeeLock` in `src/lib/payee-lock.ts`) before the
  decision's, by the ledger's order; with none, the setting a workspace starts with, off with no wait (the column
  defaults, 0135; a workspace with no `approval_policies` row reads as off).
- Kept only when the ledger accounts for it: the first change after the decision must have changed it from that same
  setting, or with no change after it, the setting on file now (`approval_policies`) must be it. Otherwise a change went
  unrecorded, and when it happened is unknown: `changePayeeLock` writes its entry best effort, after the setting, so a
  failed append leaves a change with no entry; and an Arc mainnet workspace starts with the lock on
  (`MAINNET_STARTING_PAYEE_LOCK`, recorded in its `org_created` entry, never as a change; none is exported, SX2). Then
  `payeeLock` is null: unknown, never off.
- Read in SQL, which returns only a boolean and a number; the mapping keeps a boolean and whole hours from 0 to
  `COOLING_HOURS_MAX` (168), and turns anything else into null. Who changed it (`by`), when, and the change's summary
  are never read.
- Not covered: a change that passed `changePayeeLock`'s check for a running cycle just as a cycle began, after that
  cycle read the lock. The ledger puts it before the cycle's decisions, which were made under the lock before it.
- If wrong: a replay would weigh a changed address under a wait the decision was not made under, and count a difference
  that is not one, or miss one that is.

**SX10. What the export cannot rebuild.**
- `enforceApGuardrails` (`src/lib/agent/guardrails.ts`, `ApGuardrailInput`) is filled in `decideApPayable`
  (`src/lib/agent/orchestrator.ts`). The file carries each of its inputs, as recorded or so the replay derives it:
  - as recorded: the action; the risk level, payment limit and two-approvals figure; the purchase order's presence,
    goods received and whether a purchase order is required; whether the address is missing, and unconfirmed (as
    `addressUnconfirmed` measured it); the new payee check's `twoParties` and `unanswered`, present only for a first
    payment; the currency; `paidToBank`; the spending limit's figures; the contract's coverage and verdict; the vendor
    document's source; the payee's role (`payeeOnFile.role`); the address's last change as hours before the decision
    (`payeeOnFile`) and the payee lock (SX9);
  - the amount weighed: `eurc.usdcValue` for a EURC bill, `observed.amount` otherwise;
  - the duplicates: the entry keeps the five strongest matches (`DUPLICATE_MATCHES_IN_CONTEXT`) and the guardrail weighs
    all of them, but a match refuses only at a confidence of 0.9 or more against money already committed, any other
    match is capped at 0.85, and matches are kept strongest first, so a match that refuses is always among those kept;
  - `fxAvailable`: not a EURC bill, or `eurc.fxRate` is not null;
  - `bridge`: present when `payout` is. Its fee percent is `payout.feeUsdc` over `observed.amount` (0 for EURC, which
    never crosses); `gatewayShort` is a Gateway route whose `gatewayBalanceUsdc` is below the amount and its fee (only a
    route an earlier attempt took can be);
  - `eurcShort`: for a EURC bill, `eurc.eurcBalance` against the amount less the early-payment discount when
    `terms.earlyPayDiscount.deadlineInDays` is 0 or more (`discountApplies`). A null balance with `execution.chainMode`
    `live` is one that could not be read; with `simulate`, none is checked. Its swap is `decision.fundWithSwap`,
    `eurc.swapOffer`, `observed.operatingBalance` (in shadow mode nothing is sent before the entry is written, so it is
    the balance the check saw) and `eurc.usdcDueWithin7Days`;
  - `now`: the entry's time, from which the address's hours are counted. The guardrail's clock read a moment earlier, so
    a wait that ended in between is not told apart;
  - the reasoning, the vendor's name and whether the network has a faucet change only the words of a hold, which the
    replay does not compare.
- Not exported, or exported as unknown. A replay must count a decision that depends on one as "cannot rebuild", never
  as the same or a different outcome:
  1. An address on OFAC's SDN list (`sanctionedWallet`, over the list the cycle's sweep read) is weighed as high risk
     whatever `counterparties.risk_level` says, and `observed.riskLevel` is that column. A decision held as
     `counterparty.high_risk` whose `riskLevel` is not `high` shows the address was listed, and one the guardrail
     weighed past that rule shows it was not. Otherwise (the decision was not to pay or schedule, or
     `invoice.duplicate_of_settled` stopped it first) whether it was listed is not in the ledger, so a replay that pays
     or schedules it cannot be rebuilt.
  2. The spending limit and the contract's check are read only for a payment now to a payee with an address (the
     contract's not for a bank payout). A replay that pays a bill the decision did not pay has neither, and cannot
     rebuild `workspace.outflow_budget`, `workspace.onchain_limit_route` or `workspace.onchain_limit`.
  3. The address changed again after the decision (`payeeOnFile.addressChangedSinceDecision`): its hours before the
     decision are unknown, and `counterparty.cooling_off` cannot be rebuilt unless `payeeLock` is known to be off or to
     have no wait.
  4. `observed.documentPayTo.differs` is null (SX4): `invoice.pay_to_differs` cannot be rebuilt.
  5. `payeeLock` is null (SX9): `counterparty.cooling_off` cannot be rebuilt when the address changed at or before the
     decision, or when that is unknown (3). An address that never changed waits under no lock.
  6. After the guardrails, the project budget (`project.budget_exceeded`, project budgets P5) is checked, and its
     reservation recorded (`observed.project`), only for a payment or schedule they let through that no earlier
     milestone for the same work held (`obligations.reserve` in `decideApPayable`). A replay that pays or schedules a
     bill in a project (`projectId` is not null) whose decision did not go ahead (it was not to pay or schedule, or a
     guardrail or the same work held it) has no `project`, and cannot rebuild `project.budget_exceeded`. A bill in no
     project never meets it. Since the same-work check (7), the same work (`sameWork`, P9) is recorded whether or not
     the bill went ahead, so `obligation.duplicate_reference` can be rebuilt.
  7. The same-work check (`obligation.duplicate_reference`, project budgets P9) and its ledger field arrived together,
     merged at 07:31 UTC on Oct 13, 2026 (with migration 0111), and an entry carries `sameWork` only when the check found
     earlier work: an absent field means "found none" after it, and "never looked" before it. When that release reached
     production is not in the repository, so a decision through the end of that day (`decidedAt` before
     `SAME_WORK_RECORDED_FROM`, 2026-10-14T00:00Z) counts as made before it. Its entry cannot say whether an earlier
     milestone was for the same work, and a replay that pays or schedules it cannot rebuild
     `obligation.duplicate_reference` unless the entry records a match. The export maps the absent field to `[]` either
     way and does not change; the replay tells the two apart by the date. Before 0111 a milestone had no purchase order,
     so the earlier work such a bill could repeat is a milestone that delivered the same work (a web address in the
     bill's memo, which the export never carries, equal to the milestone's verification source).
- Each counts only for a replayed payment or schedule that reaches the rule. A hold, a flag or a request for information
  meets no rule, and a rule ahead of it that stops the replayed decision settles the outcome whatever the unknown input.
- If wrong: a replay would count as a regression, or as agreement, an outcome that rests on an input it never had.

## Replay

The replay asks one question of every exported decision: given the model's answer as recorded, on the facts the
decision was made on, would today's code let money move? Code comments and tests cite these ids, for example "(shadow
replay SR4)".

**SR1. The runner is a vitest file over the lab's harness, run live.**
- `tests/quality-lab-shadow.test.ts` replays every decision in `src/lib/quality-lab/shadow-decisions.json` and nothing
  else: no database, no key, no network. Like the scenarios (Quality Lab QL1) it must be a vitest file, since the
  model's answer is scripted through `vi.mock("@/lib/agent/decide")`.
- Each decision gets its own world in `tests/support/ap-harness.ts`, and `runApStage` runs once over it for real, with
  the same stand-ins as the scenarios: the database (`fakeSupabase`), the clock, the payment provider (`LabChain`) and
  the spending limit contract's answer on Arc. The harness gains three inputs, each optional and unused by the
  scenarios, so `tests/quality-lab.test.ts` still writes the same `src/lib/data/quality-lab.json`: the spending limit's
  room handed in as the decision recorded it (`spendingLimitRoom`), the checks after the guardrails (`obligations`), and
  the reserve's yield (`reserveApy`, 0.045 when absent).
- Shadow mode is off in the replay: a pay that passes every check is sent, so the provider counts it. The question is
  whether code would let the money move, not whether a person was asked.
- The clock is the decision's minute (`decidedAt`) on the day its dates count from (`decidedOn`, SX5); a decision
  written after midnight is replayed at the last minute of `decidedOn`.
- If wrong: a replay in shadow mode would hold every payment that passed and could never show one code lets through.

**SR2. The world is rebuilt from the exported record, and nothing else.**
- `replayWorld(decision, variant)` in `src/lib/quality-lab/shadow-replay.ts`, pure, turns a decision into plain data;
  the runner turns that into rows. It never reads anything but the exported decision. That is the signed ledger entry
  the agent wrote, and the facts the export reads beside it: the payee lock in force, from the workspace's signed lock
  changes (SX9); the payee's role, from its row as it is at export; and, only while the address has not changed since
  the decision, how many whole hours before it the address last changed and whether the document's pay-to differed
  from it (SX3, SX4). The public page says the same, and never that the entry alone is enough.
- The bill: its amount in USDC, whether it had a purchase order, goods received, its due day, its early-payment
  discount and late fee, the day an earlier cycle scheduled it for when it is decided on or after it, whether its
  document named an address and whether that was the one on file, whether it is in a project, whether its purchase
  order came from the vendor's document, and a paid bill it repeats when a recorded match would refuse it (a match
  refuses only at 0.9 or more against committed money, so it is rebuilt as a paid bill with the same purchase order and
  amount, which the real duplicate check scores 0.95).
- The payee: its risk level, payment limit, role, whether its address is missing, and an address on OFAC's list when
  the record shows it was listed (SX10.1); whether its address was unconfirmed, and how many hours before the decision
  it changed, rebuilt at the middle of the recorded whole hour (an export of 4 is 4.5 hours), which tells a wait of
  whole hours apart the same way the exact time did; and the new payee check's facts, rebuilt as the ledger entries
  that give the recorded answer: who gave the address (a member, the payee through a link or GitHub, or a mirror),
  whether it was confirmed and by whom, and whether it was paid there before (`observed.newPayee` absent).
- The workspace: the operating balance the decision saw, the payee lock in force (SX9), the two-approvals figure, the
  spending limit's room and the contract's verdict as recorded (none when the record has none: they are recorded
  whenever a payment now to an address reads them), and what fell due by the bill's day besides it, rebuilt as held
  bills to another payee with the recorded total and count. The reserve's balance is not in the record; the replay
  counts none, which can only make a later day's shortfall more likely, never less. Its yield is derived from the
  recorded float value when the bill had a discount, and is 0 otherwise.
- The checks after the guardrails: the same work as recorded, and the project's recorded answer. These, the spending
  limit's room and the contract's verdict are handed in, not worked out (SR1), so the replay tests how today's code
  weighs them, not how it reads them; the docs page says so. A decision made before the same-work check existed
  records no answer to it (SX10.7), so for one that pays or schedules the same work is run both ways (SR4), never taken
  as none.
- The model answers exactly as recorded: the action, the pay-on day as days from `decidedOn`, the swap choice and its
  confidence. When code moved the date (`timingRule`), the answer is the model's own: `pay.no_gain` was a pay, and
  `payon.*` a schedule for the requested day.
- If wrong: a world the record does not describe would replay a decision that was never made.

**SR3. What the replay does not rebuild.**
- For an answer to pay or schedule, the replay refuses up front, as "cannot rebuild" with the reason in plain words: a
  EURC bill, a payee on another chain, a bank payout, a bill decided before its day because cash would not cover it then
  (`cashAhead`) or otherwise before the day it was scheduled for, a fact the rules read that the record lacks (when the
  bill was due, its amount, the risk level, goods received, whether a purchase order is needed, the operating balance,
  the spending limit's figures), a stop whose rule is not recorded, and a contract on Arc that could not carry the
  payment. These are USDC bills paid on Arc only, which is all the team's shadow workspaces
  hold today. A hold, a flag or a request for information on such a bill is not refused: it is replayed as a USDC bill
  on Arc (below), and the docs page says the refusal covers an answer to pay or schedule only.
- A hold code made for cash before its checks (`cash.priority`, `pay.cash_ahead`) is refused whatever its action: the
  record keeps the hold, not the model's own answer.
- A hold, a flag or a request for information is always replayed. Code never weighs a guardrail for one and never
  turns one into a payment, so a fact the record lacks is filled with a neutral value (pending rather than scheduled for
  a later day, for one), and the fidelity check (SR8) compares only facts the record has.
- If wrong: a replay of a bill it cannot rebuild would count a guess as an outcome.

**SR4. A fact the record does not carry is run both ways, never guessed.**
- `planReplay` lists, for an answer to pay or schedule, each fact SX10 says the record may not carry: whether the
  address was on OFAC's list (when a repeat of a paid bill stopped it first), the spending limit and the contract's
  figures (when the decision was not a payment now to an address), whether the address was in the payee lock's wait
  (when it changed again since, or the lock is unknown), whether the document's pay-to differed, the payee's role,
  earlier work for the same purchase order or delivered work (when the decision was made before that check existed and
  its entry records no match, SX10.7), and the project's answer.
- The same work's two ways are no earlier work, and one earlier milestone, verified, that delivered the same work (a
  milestone had no purchase order then), which today's code holds as `obligation.duplicate_reference`.
- Each is rebuilt both ways, the way that lets a payment through and the way that stops it, and the runner replays
  every combination. When every combination ends the same, that is the outcome. When they differ, the decision is
  "cannot rebuild", naming each fact whose two ways changed the outcome and saying whether money stops either way.
- The record's own outcome is never used to settle an unknown, except where SX10.1 says the record shows it: a
  decision held as `counterparty.high_risk` whose risk level is not high was listed; one weighed past that rule was not.
- If wrong: a replay that filled an unknown with the value that matches the outcome then would agree with itself.

**SR5. Then and now.**
- Then (`thenOutcome`): the rule code recorded when it stopped the decision (`guardrailBlocked`), or let through. Code
  let money move then when it let through a pay or a schedule: in shadow mode a pay that passed waited for the person's
  verdict instead of being sent, so it counts as money that would have moved. A hold, a flag or a request for
  information let none move.
- Now: the replay's own entry, its action, and the rule when it was stopped, or let through. Money moves when the
  provider took a transfer, or the bill is left scheduled: a schedule counts as money that will move, as in the
  scenarios. Transfers are counted from the provider, never inferred from a status.
- If wrong: a replay that read the status would miss a payment made while the status said held.

**SR6. Each decision gets one class.**
- **Same**: the same rule stops it, or code lets it through both times, and money moves or stops as it did then.
- **Now stopped**: money moved then and stops now, or a different rule stops it now; the reason names the rule now in
  its words (`ruleWords`).
- **Now let through**: code stopped it then, or it moved no money, and money moves now.
- **Cannot rebuild**: SR3 or SR4, with the reason.
- Where the same rule stops it but code now gives the answer another action (a pay now made a schedule, say), the class
  is the same and the reason says so.
- A replay in which code records a stop and money moves all the same keeps the class its rule and money give (now let
  through when money stopped then, now stopped otherwise), but its reason says "Code recorded a stop because ..., but
  money moved.", its Now column says "Recorded as stopped because ..., but money moved", and it is a wrong payment
  (SR7), never a safe "Stopped now because ...". Its result is said "A wrong payment. Code recorded a stop because
  ..., but money moved." (`replayClassWords`), never "Now stopped", and the summary counts it only as a wrong payment
  (SR9).
- If wrong: a class that hid a change of rule would report as the same outcome a decision code now treats differently.

**SR7. A wrong payment fails CI.**
- A wrong payment is money that moves now where code stopped it then (now let through), money that moves now on a
  decision the person disagreed with, money that moves in a run where code records a stop (`rule` set and money
  moving: a blocked decision never reaches the provider, so this is money leaving past a stop), or any transfer to an
  address other than the one on file, for an amount other than the bill's (less an early-payment discount through its
  deadline's day), or a second transfer for the bill.
- When the runs over the unknown facts end differently (SR4), the decision cannot be rebuilt, and it is still a wrong
  payment when any run moves money where code stopped it then or the person disagreed. Which run is the record's own
  world is not known, so every run counts, but one: a run whose variant relaxes ("lets through") the very fact behind
  the rule recorded then, since that rule stopping the decision shows the fact was the other way. The pairs are
  `counterparty.cooling_off` and the address's wait (`address_change`), `invoice.pay_to_differs` and the document's
  pay-to (`pay_to`), `counterparty.client_payable` and the role (`role`), `counterparty.high_risk` and OFAC's list
  (`sanctions`), `workspace.outflow_budget`, `workspace.onchain_limit` and `workspace.onchain_limit_route` and the
  spending limits (`spending_limits`), and `project.budget_exceeded` and the project's answer (`project`). This only
  discounts a run for the wrong-payment test; it never settles an unknown for the class (SR4). A run where code records
  a stop and money moves is never discounted. For example shadow-43, stopped then by `counterparty.new_payee` with its
  address's wait unknown: were the new payee check broken, the way past the wait, which is the record's own since the
  wait is checked first, would pay, and that fails CI; for shadow-42, stopped then by the wait, the way past the wait is
  discounted.
- The reason says why a cannot-rebuild decision is a wrong payment: "In a way the record does not rule out, money moves
  where code stopped it then." (or "on a decision the person disagreed with"), or "One way, code recorded a stop
  because ..., but money moved."
- `tests/quality-lab-shadow.test.ts` fails on any, naming the decision, and holds the rule to a case built from
  shadow-43 given facts the new payee check lets through: it must come back cannot rebuild and a wrong payment. A
  decision the person agreed to pay that code now stops is a safe miss: shown as now stopped, never failed. Of the
  cannot-rebuild decisions in today's file, the two code stopped then stop money in every run, and the seven it let
  through then had no disagreeing verdict, so none is a wrong payment.
- A product guardrail is never changed to make the replay pass: a wrong payment is a finding, reported as one.
- If wrong: a replay that passed on a wrong payment would publish a claim the code breaks; one that only went stale
  would be cleared by `npm run quality-lab`, which rewrites the file without failing.

**SR8. The rebuild is held to the record.**
- Every run's own ledger entry is mapped as the export maps a recorded one (`exportShadowDecisions`), and the facts the
  world was rebuilt from must come back as recorded: the amount, payment limit, risk level, purchase order, goods
  received, whether a purchase order is needed, the two-approvals figure, whether the address is missing or
  unconfirmed, the document's pay-to, the new payee check, the due day, the terms, the day it was scheduled for, what
  fell due besides it, the vendor's document, and the spending limit's figures when the replay read them. Only facts
  the record has are compared.
- A test replays a decision for each rule the record carries, built from a real one (high risk, an address on OFAC's
  list, unscreened, a client, no address, unconfirmed, the payee lock's wait, pay-to, the match, a new payee, the
  payment limit, two approvals, the spending limit, the contract, a repeat of a paid bill, the vendor's document, the
  same work, the project's budget), and each must come back the same, with that rule. Each is dated after the
  same-work check was added, as a decision with a project or a match must be, so that rule's is its only outcome; a
  test holds shadow-01 itself, from before it, to cannot rebuild, with the earlier milestone's way held as
  `obligation.duplicate_reference` (SX10.7).
- If wrong: a rebuild that drifted would report the drift as a change in the code.

**SR9. The results are a committed file of stable fields.**
- `src/lib/data/quality-lab-shadow.json`: for each decision its `id`, `day` (`decidedOn`), the scripted `answer`
  (action, pay-on day in days, swap), the person's `verdict`, `then` and `now` (action, rule, money; `now` is null when
  it cannot be rebuilt), `class`, `reason` and `wrongPayment`; and a summary `{ decisions, same, nowStopped,
  nowLetThrough, cannotRebuild, wrongPayments, agreed, disagreed, noVerdict }`. No time, hash, sequence or UUID.
- The summary counts each decision once (`summarizeReplay`): a wrong payment only in `wrongPayments`, whatever its
  class, and the four classes count the rest, so `same + nowStopped + nowLetThrough + cannotRebuild + wrongPayments` is
  `decisions`. A stop code recorded while money moved (SR6) is never counted as stopped. Money moving where code
  stopped it then is always a wrong payment, so `nowLetThrough` stays 0 as decisions are classed today.
- The test holds the committed file equal to the run, with the message "run npm run quality-lab and commit
  src/lib/data/quality-lab-shadow.json", line endings normalised, and holds the committed summary to no wrong payment
  and to each decision counted once. With `QUALITY_LAB_WRITE=1` it writes the file instead, and `npm run quality-lab`
  runs both lab files that way, so it writes both result files; it refuses to write one with a wrong payment, which
  is a finding to fix (SR7), never a result to publish.
- If wrong: a file that changed every run could never be held to it.

**SR10. One line beside the scenarios.**
- `QualityLabResult` on /open and /how-it-decides gains one line under the scenario score, from the committed file:
  "46 real decisions from the team's own shadow-mode workspaces, replayed through today's code: 37 reach the same
  outcome, 9 cannot be rebuilt from the record, 0 wrong payments", with the real numbers, naming only the classes that
  are not zero (`shadowReplayWords` in `src/lib/quality-lab/words.ts`). Its parts add up to the decisions (SR9).
- It names no network, as the block does not (QL7), and says "team" plainly: customers' decisions are never in it.
- The block links the docs page's "Real decisions, replayed" (`#real-decisions-replayed`, "Every replayed decision"),
  where the classes and a wrong payment in the replay are defined, beside its link to the scenarios. /open's lede says
  the block is not read when the page loads: it comes from the tests that run the scenarios and replay the team's
  exported decisions, on every change.
- If wrong: a number typed by hand would drift from the code.

**SR11. The docs page shows every decision.**
- `content/docs/research/quality-lab.mdx` gains "Real decisions, replayed": what it is, the definitions, the data's
  limits (the team's own workspaces only, customers never exported; facts rebuilt from the exported record, which is
  the signed entry and the few facts read beside it (SR2), and four answers handed in as recorded, set both ways where
  the record lacks one; earlier work for a decision made by Oct 13, 2026, before that check existed, set both ways
  (SX10.7); the model's answers as recorded, not asked again; an answer to pay or schedule a EURC, other-chain or
  bank-payout bill refused, a hold on one replayed), that a decision that cannot be rebuilt is a wrong payment only
  where money moves where code stopped it then or the person disagreed (or code records a stop and money moves), that
  the line counts each decision once (SR9), how to refresh it, the summary (`<ShadowReplaySummary />`) and one row per decision
  (`<ShadowReplayTable />`), rendered from the committed file on the page and in its Markdown view (`MDX_TO_MARKDOWN`),
  never typed. The page's description in the docs navigation names both halves.
- The table colours a result from its `wrongPayment` and `class` fields, never from its words: a wrong payment is
  refused whatever its class, a same row is plain, and any other is held.
- A test holds the page's figures and rows to the file.
- If wrong: a typed table would disagree with the file after the next export.

**SR12. Refreshing it.**
- The team runs `npm run quality-lab:shadow` (SX7: read-only, the team's own workspaces) and commits the new
  `shadow-decisions.json`, then `npm run quality-lab`, and commits `quality-lab-shadow.json`. CI only reads both.
- If wrong: a CI job with a database password could export more than SX2 allows.

**SR13. No migration, and no change to the decision code.**
- No table, function, index or ledger entry, and no guardrail changes. The test reads and writes nothing outside its
  fakes and the result file.

### What the first replay found

- 46 decisions, 18 with a verdict of agree, none disagreed: 33 that code let through then (5 pays, 3 schedules, 12
  holds, 13 requests for information) and 13 it stopped (`counterparty.no_address` 3, `workspace.outflow_budget` 4,
  `counterparty.address_unconfirmed` 2, `counterparty.cooling_off` 2, `counterparty.new_payee` 2).
- 37 reach the same outcome, 9 cannot be rebuilt, 0 wrong payments, none now stopped or now let through.
- 7 of the 9 are the payments and schedules code let through before the same-work check existed (SX10.7): shadow-01,
  04, 05, 08 and 10 (pays) and shadow-24 and 26 (schedules), all decided Oct 8-12, 2026. With no earlier work money
  moves, as it would have then; with an earlier milestone for the same delivered work, today's code holds each as
  `obligation.duplicate_reference`, which would be a safe miss, never a wrong payment. The record cannot say which, so
  none is counted the same. The other pre-check decisions to pay are stopped by a guardrail before that check either
  way (`counterparty.no_address`, `workspace.outflow_budget`), and are the same.
- The other 2 are shadow-42 (`counterparty.cooling_off` then) and shadow-43 (`counterparty.new_payee` then): the payee's
  address changed again after them, so how long before each it had changed is not in the record, and the payee lock's
  4-hour wait cannot be weighed. Within the wait the cooling-off stops each, past it the new payee check does: money
  stops either way, so neither is a wrong payment (SR7). shadow-41, held then because its changed address was
  unconfirmed, is the same either way.
- One decision reaches the same outcome by another action: shadow-15, a pay on a bill due in 8 days, is now made a
  schedule for its due day (`pay.no_gain`, since there was no discount and no shortfall), and the same rule,
  `counterparty.no_address`, stops it.
