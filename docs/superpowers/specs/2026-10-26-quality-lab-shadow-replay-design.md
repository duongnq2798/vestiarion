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
- A workspace is exported only when `orgs.created_by` is null (the founding workspace) or is in `platform_team`: the
  same split `open_verdicts` (0086) and `npm run research:model-vs-policy` make between "ours" and customers'.
  Customers' workspaces are never read into the file, whatever they hold.
- The read also selects each row's side with that same expression, and the mapping refuses the whole export if any row
  is a customer's: a broken filter fails loudly rather than writing.
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
    the document named a pay-to address and whether it differs from the one on file, the project's state and figures,
    the same work's kind, status and signal, and the duplicate check's counts with each match's status, confidence and
    signals;
  - the spending limit's figures (`outflowBudget`), the contract's coverage and verdict state and figures
    (`onChainLimit`), the payout route and fee, a EURC bill's USDC value, rate and balance, the timing figures, the
    terms' figures, cash ahead's figures, whether the cash priority plan made it wait, an FX reopen's trigger and the
    action it followed, what a payment sent and the discount it took;
  - `execution.resultingStatus` and `execution.heldBecause`, nothing else of the execution.
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
- Whether the document's pay-to address differs is computed against the payee's address on file when the export runs
  (`payToDiffers`), the one fact read beside the ledger; the address itself is not kept.
- Each decision's id is `shadow-01`, `shadow-02`… in time order (the ledger's order breaks a tie), and its time is kept to
  the minute.
- If wrong: an id or a hash would let anyone tie a public file to a private workspace's records.

**SX5. Dates as days from the decision.**
- Every date the decision names (its `payOn`, the due date, the policy's target day, the discount deadline, a late
  fee's first day, the day it was scheduled for earlier) is kept as whole UTC days from the decision's own day
  (`…InDays`, negative when before). The replay sets its clock to `decidedAt` and adds them back.
- If wrong: a replay at another day would see a bill already overdue, or a discount long gone.

**SX6. The output is refused, whole, if anything looks private.**
- `assertShareable(file)` walks every key and string in the decisions and `readAt`, and throws, naming the path of the
  first offending value and never the value, when one looks like an address or hash (`0x` and 40 hex digits or more),
  an email address, or a UUID, or is longer than 40 characters. The file's `source` must be the module's own sentence.
- The script runs it before writing; nothing is written when it throws.
- If wrong: one mistake in the allowlist would publish what SX4 forbids.

**SX7. The script reads once, read-only, and writes one file.**
- `npm run quality-lab:shadow` (`scripts/quality-lab-shadow.ts`) connects as `npm run research:replay` does (`.env.local`
  then `.env`, `SUPABASE_DB_URL`, or the project id and database password), opens `begin transaction read only`, makes
  one read of the entries (joined to `orgs`, `platform_team` and `counterparties` for SX1 and SX2) and one of their
  verdicts, commits and closes. It writes nothing to the database.
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
