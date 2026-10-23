# Telegram: bills waiting for approval, with a Review link (2026-10-23)

## Why

Discord (#508, #509) posts the bills the agent stopped for a person as one notice. Each bill's line says why it waits,
whether it needs two approvals (and that an accountant can co-sign), and gives a Review link that approves nothing.
Telegram, which most members link first, has no such notice. A held bill appears only as a three-line block inside the
cycle's decisions message, labelled "Decide in Approvals", with the model's raw first sentence. /waiting words
awaiting_info as "waiting for information" where Discord says "waiting for details".

## Rules

**TG1. One shared reader.** Move `waitingBills`, `noticePolicy` and `withUsdcValues` out of `src/lib/discord/notify.ts`
into `src/lib/notifications/waiting-bills.ts`, with a log label parameter, so Discord, Telegram and later Slack read the
same bills the same way.
- Discord's text, log lines and tests stay exactly as they are. `tests/discord-notify.test.ts` pins its log line
  "discord: the figure for two approvals was not read".
- The literal "Opening a link never approves anything." stays in `src/lib/discord/messages.ts`, because
  `tests/docs-guides.test.ts` reads it there.

**TG2. The waiting section.** In the `telegram` stage, `sendAgentDecisions` (`src/lib/telegram/notify.ts`):
- **Which bills.** It reads the same activity it reads today. It keeps the stopped payables with an `invoiceId`, re-read
  in one query, that are still held, flagged or awaiting_info. These are the same bills Discord posts. A shadow-mode
  verdict hold carries no `invoiceId` and keeps its own block.
- **The section.** It builds them with `buildWaitingNotice` and formats them as a section of the same decisions message,
  in place of those bills' blocks:
  - each bill on one line: amount and currency, payee, the status word ("held", "flagged", "waiting for details"), the
    reason (first sentence, through `presentReasoning` as the approval card says it), "needs two approvals" or "needs two
    approvals, an accountant can co-sign", then a link labelled **Review** to the bill's card on Approvals
    (`approvalAnchor`);
  - "Opening a link never approves anything." once.
- **Sending.** One send and one cursor move, as today. The 400 plain-text retry carries the same text without HTML,
  with link previews off as on the HTML send.

**TG3. /waiting agrees.** `waitingMessage` (`src/lib/telegram/messages.ts`):
- labels each payable's link **Review**, built with `approvalAnchor`, not a hand-written anchor;
- says "waiting for details" for awaiting_info;
- adds the never-approves line once.

Milestones and verdict holds keep their own labels ("Decide in Contractors", "Give your verdict").

**TG4. Safe text.** A `telegramText` helper for every value in the decisions message (the workspace's name, each
decision's text and reason, and the section's values) and in /waiting:
- removes invisible format characters (\p{Cf}), as `discordText` does;
- breaks up what Telegram would make tappable, since it finds web addresses, @names and /commands in every message a
  bot sends: a dot before a domain's ending, and each dot of an IP address, becomes `[.]`; every `@`, and every `/`
  that follows no letter or digit, takes its fullwidth form (U+FF20, U+FF0F). Discord's `discordText` escapes the same
  things;
- escapes HTML;
- clips without splitting a surrogate pair.

**TG5. Docs.**
- The Telegram guide (`content/docs/guides/telegram.mdx`): the new section, with an example, and /waiting.
- CHANGELOG [Unreleased].
- ARCHITECTURE.

No API, ledger or migration change.

## Tests

- The decisions message with a held bill, a flagged one, one waiting for details, one above the figure (with and without
  co-sign), and a verdict hold that keeps its block.
- The 400 retry.
- /waiting's labels and wording.
- `telegramText`: format characters removed, a web address, an @name and a /command broken up, HTML escaped,
  surrogate-safe clipping; a decision's own text and reason, and a payee or reason in the section and in /waiting,
  leave Telegram nothing to link.
- Discord's existing tests pass unchanged.
- The tests that pin Telegram's message text, updated.
