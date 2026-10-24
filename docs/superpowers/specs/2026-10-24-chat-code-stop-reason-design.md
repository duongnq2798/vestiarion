# Chat notices say why code stopped a bill (2026-10-24)

## Why

Telegram's waiting section (#511), Discord's notice (#508) and Telegram's `/waiting` give each waiting bill the first
sentence of the model's reasoning, stored on the invoice. When code refused the model's payment, or held it for cash,
that sentence often says the opposite of the bill's state. One bill in a live chat read "held: The invoice is due today,
so I am paying now." Code stopped it for one of several reasons:
- a guardrail rule: the payee lock, an invoice asking to be paid elsewhere, the cash floor, a cross-chain fee cap;
- the cash shortfall hold.

The Bills row (`stoppedWhy`, `src/components/vx/decision-signals.ts`) and Telegram's decision blocks before #511 say
"Code stopped it: *the rule in brief*." instead. When #511 moved stopped bills from their blocks into the waiting section,
Telegram lost that line.

## Rules

**CS1. One wording.** A pure helper in `src/lib/next-step.ts`, `codeStoppedLine(rule)`, returns
`Code stopped it: ${ruleInBrief(rule)}.` when the rule has words of its own (its brief does not start with "rule "), and
null otherwise. `stoppedWhy` uses it, and its output does not change.

**CS2. What stopped it.** For a payable, a pure helper in the same module, `stopRuleOf(detail)`, reads its latest AP
decision's detail (`latestDecision` in `src/lib/added-details.ts`, from the payable's ledger entries newest first):
- `guardrailRule`, when `guardrailBlocked` is true and the rule is a string;
- otherwise `CASH_SHORTFALL`, when `heldForCash(detail)`;
- otherwise null.

This mirrors what `listWaitingPayables` gives the approval card (`guardrailRule`, `heldForCash`).

**CS3. The notice.** `WaitingBill` (`src/lib/notifications/waiting-notice.ts`) gains `stopRule: string | null`.
- `waitingBills` (`src/lib/notifications/waiting-bills.ts`) reads the listed bills' ledger entries in one call
  (`listLedgerEntriesForTargets({ invoiceIds })`) and sets each bill's `stopRule` with `stopRuleOf`.
- `buildWaitingNotice` gives each bill the reason `codeStoppedLine(stopRule)`, or, when that is null, the first sentence
  of `presentReasoning(reasoning)`, as today.
- This applies to Discord and Telegram alike.
- If the entries cannot be read, the bills keep `stopRule: null`, the notice is still sent with the model's sentence, and
  one line is logged: `waiting bills: why code stopped them was not read`, with the workspace id and the error message.
- Discord's existing text, log lines and tests stay as they are for bills that code did not stop.

**CS4. `/waiting`.** `waitingFacts` (`src/lib/telegram/today.ts`) reads the shown payables' ledger entries the same way,
best effort as it reads verdicts, and gives a payable code stopped the reason `codeStoppedLine(rule)`. Held milestones
keep their reasoning's first sentence.

**CS5. Docs.**
- The Telegram guide and the Discord guide: what a bill's line says when code stopped it.
- CHANGELOG [Unreleased], under Fixed (or Changed, where this file keeps such fixes).
- ARCHITECTURE: the notifications paragraph.

No API, ledger or migration change.

## Tests

- `codeStoppedLine`:
  - a rule with words, including `counterparty.payment_limit` and `CASH_SHORTFALL`;
  - a rule without words of its own;
  - null.
- `stoppedWhy` is unchanged: its existing tests pass.
- `stopRuleOf`:
  - blocked with a rule;
  - blocked with no rule;
  - held for cash;
  - neither;
  - a missing detail.
- `waitingBills`:
  - one entries read;
  - the latest decision wins;
  - an entry without `observed` is skipped, as `latestDecision` does;
  - a read failure leaves `stopRule` null and logs once.
- `buildWaitingNotice`: the code line in place of the model's sentence; the fallback.
- Telegram's decisions message and Discord's message with a code-stopped bill.
- `/waiting` with a code-stopped payable, and with a read failure.
