# Quality Lab: replaying the shadow-mode decisions (2026-10-26)

Status: the export is accepted and built; the replay is the next change and gets its own section here.

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
     project never meets it, and the same work (`sameWork`, P9) is recorded whether or not the bill went ahead, so
     `obligation.duplicate_reference` can be rebuilt.
- Each counts only for a replayed payment or schedule that reaches the rule. A hold, a flag or a request for information
  meets no rule, and a rule ahead of it that stops the replayed decision settles the outcome whatever the unknown input.
- If wrong: a replay would count as a regression, or as agreement, an outcome that rests on an input it never had.
