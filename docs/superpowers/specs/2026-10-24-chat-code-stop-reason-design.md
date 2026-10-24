# Chat notices say why code stopped a bill (2026-10-24)

## Why

Telegram's waiting section (#511), Discord's notice (#508) and Telegram's `/waiting` give each waiting bill the first
sentence of the model's reasoning, stored on the invoice. When code refused the model's payment, or held it for cash,
that sentence often says the opposite of the bill's state. One bill in a live chat read "held: The invoice is due today,
so I am paying now." Code stopped it for one of several reasons:
- a guardrail rule: the payee lock, an invoice asking to be paid elsewhere, the cash floor, a cross-chain fee cap;
- the cash shortfall hold, over the agent's choice to pay.

The Bills row (`stoppedWhy`, `src/components/vx/decision-signals.ts`) and Telegram's decision blocks before #511 say
"Code stopped it: *the rule in brief*." instead. When #511 moved stopped bills from their blocks into the waiting section,
Telegram lost that line.

## Rules

**CS1. One wording.** A pure helper in `src/lib/next-step.ts`, `codeStoppedLine(rule)`, returns
`Code stopped it: ${ruleInBrief(rule)}.` when the rule has words of its own (its brief does not start with "rule "), and
null otherwise. `stoppedWhy` uses it.
- `ruleInBrief` gains words for `CASH_SHORTFALL`: "the operating wallet did not hold the cash it needs". Before, the
  cash hold read as its name, so a cash-held row on Bills gave the model's first sentence.
- So `stoppedWhy` now says "Code stopped it: the operating wallet did not hold the cash it needs." for a payable code
  held for want of cash. The Bills row's decision (`invoiceDecision` in `src/components/vx/map.ts`) carries
  `heldForCashByCode` for it, from `codeHeldForCash` (CS2). A hold the agent chose itself keeps the model's sentence.
- Its output is unchanged otherwise.
- The Bills row reads the guardrail from the latest decision with `observed` while the bill still waits (held, flagged or
  awaiting info), as it already reads `heldForCash`. Before, it read the newest entry of almost any kind, so once the
  follow-up escalated a guardrail-held bill, its `invoice_escalated` entry (which names no guardrail) left the row with
  no guardrail and the model's sentence, while the chats and the approval card still said what stopped it.

**CS2. What stopped it.** For a payable, a pure helper in the same module, `stopRuleOf(detail)`, reads its latest AP
decision's detail (`latestDecision` in `src/lib/added-details.ts`, from the payable's ledger entries newest first):
- `guardrailRule`, when `guardrailBlocked` is true and the rule is a string;
- otherwise `CASH_SHORTFALL`, when `codeHeldForCash(detail)`;
- otherwise null.

`codeHeldForCash(detail)` is `heldForCash(detail)` with code having made the hold:
- the decision's action is `pay`, and the cash was not there for it;
- or its `timingRule` is `cash.priority` (the cash priority plan made it wait, P4) or `pay.cash_ahead` (cash ahead, A2),
  which turned the agent's payment into a hold.

The AP stage also records `heldBecause: cash_shortfall` for a hold the agent chose itself while the cash was short, so
that cash coming in reopens it. Code did not stop that bill: its line gives the agent's own sentence.

This mirrors what `listWaitingPayables` gives the approval card (`guardrailRule`, `heldForCash`). The card gives every
cash hold the cash next step next to the full explanation, so it keeps `heldForCash`.

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
- `stoppedWhy`: its existing tests pass, plus a payable code held for want of cash, and one the agent held itself while
  the cash was short.
- `invoiceDecision`:
  - a guardrail-blocked decision under a newer `invoice_escalated` entry keeps its guardrail, and its row says code
    stopped it;
  - a cash hold code made sets `heldForCashByCode`, and the agent's own does not.
- `stopRuleOf`:
  - blocked with a rule;
  - blocked with no rule;
  - held for cash by code: a payment, `cash.priority`, `pay.cash_ahead`;
  - held for cash by the agent's own hold;
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
