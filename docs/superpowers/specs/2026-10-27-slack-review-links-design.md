# Slack: bills waiting for approval, with a Review button (2026-10-27)

## Why

Telegram (#511) and Discord (#508, #509) tell the bills the agent stopped for a person in one list. Each bill's line
says why it waits, whether it needs two approvals (and that an accountant can co-sign), and gives a Review link that
approves nothing. Slack, while deciding from Slack is off (the default), shows each stopped bill only as a decision
among the others, with "Decide in Approvals", or "Add details" to Bills for one waiting for details. It does not check
that a bill still waits, gives the model's raw sentence rather than what code stopped it on, and never says what a bill
needs. `/vestiarion waiting` still says "waiting for information" and "Decide in Approvals". Slack's `mrkdwn()` only
escapes `&`, `<` and `>`: a payee's hidden direction characters reach the channel, and Slack auto-links a web address,
a channel name or a mention inside a value. Telegram and Discord also turn link previews off; Slack does not.

## Rules

**SR1. The same reader, while deciding from Slack is off.** In the `slack` stage, `sendSlackDecisions`
(`src/lib/slack/notify.ts`):
- **Which bills.** While `install.decisionsLimitUsdc === null`, it reads the waiting bills among the activity it read
  with the shared `waitingBills`, `noticePolicy("slack")`, `withUsdcValues` and `buildWaitingNotice`
  (`src/lib/notifications/`), as Telegram's `waitingAmong` does: the stopped payables with an `invoiceId`, re-read in
  one query, still held, flagged or awaiting_info. A shadow-mode verdict hold carries no `invoiceId` and keeps its own
  block. The rules are read only once a bill waits.
- **A failed read.** When the bills cannot be read, it logs "slack: waiting bills not read, each told as a decision",
  and the message is posted as before, each stopped bill among the decisions. `noticePolicy` and `withUsdcValues`
  already catch their own failures. This also covers the transfer watch's post, which runs the same stage.
- **While deciding is on.** Nothing changes: every still-waiting payable already has its signed card, its buttons act,
  and `withOutcome` and `withApprovalGiven` rewrite those card blocks. No section is drawn, and no rules are read.
- One post and one cursor move, as today.

**SR2. The section.** `decisionsMessage(workspace, items, origin, cards, waiting)` (`src/lib/slack/blocks.ts`), only
while `cards` is null and a bill waits:
- the waiting bills' own decision blocks are dropped, and `ITEMS_SHOWN` applies to the decisions left, which are the
  only ones counted in "…and N more in the console";
- after the decisions, a section "N bills wait for approval:", then one section per listed bill: its amount and
  currency (bold), the payee, the status word ("held", "flagged", "waiting for details"), the reason (what code
  stopped it on, "Code stopped it: …", else the first sentence of the agent's reasoning), then "needs two approvals" or
  "needs two approvals, an accountant can co-sign". Its accessory is a URL button **Review** (`vx_review`) to the
  bill's card on Approvals, `origin + /o/<slug>/approvals#payable-<id>` (`approvalAnchor`), with no token. The link is
  never inside a value, so no cut can reach it;
- "…and N more in Approvals." with a link to Approvals, when more than ten wait;
- a context block with `NEVER_APPROVES`, "Opening a link never approves anything.", once. The literal is exported from
  `blocks.ts`, where the guide's test reads it, and a test holds it equal to Discord's and Telegram's.
- **Block ids.** `waiting`, `waiting-<invoiceId>`, `waiting-more` and `waiting-never`: never `payable-`, `why-` or
  `approved-`, which the card rewrites match.
- **Slack's limits.** Without a card a decision is at most 3 blocks, so the worst case is 1 + 10 x 3 + 1 + 1 + 10 + 1 + 1
  = 45 blocks, under 50. Each bill's values are clipped before they are escaped (amount 60, payee 100, reason 300
  characters), so a bill's text stays far under 3,000 characters, even when every character escapes to five.

**SR3. `/vestiarion waiting` agrees.** `waitingAnswer`:
- labels a payable's link **Review**, built with `approvalAnchor`, not a hand-written anchor;
- says "waiting for details" for awaiting_info;
- adds a context block with `NEVER_APPROVES` when a Review link is listed;
- counts a payment that would pass the section's room ("…and N more in the console."), never cut, so no link is cut
  in two.

A payment held for a verdict keeps **Give your verdict**, and a milestone **Contractors**.

**SR4. Safe text.**
- `mrkdwn()` removes invisible format characters (Unicode's Cf: bidi embeddings, overrides and isolates, zero-width
  characters) and lone surrogates before it shortens addresses and escapes `&`, `<` and `>`, as Telegram's
  `telegramText` (TG4) and Discord's `discordText` (DC4) do. Every value in every Slack message goes through it.
- `slackText(value, max)`, for the values of a bill's line and of `/vestiarion waiting`: also turns every newline,
  control character and run of whitespace into one space, and clips to `max` before escaping, so no cut falls inside an
  escape or between the two halves of a character.
- Every mrkdwn text object Vestiarion builds (sections, contexts, a confirmation's text, a decided card's line) sets
  `verbatim: true`, so Slack does not turn a web address, a channel name or a mention inside a value into a link. Every
  link in them is already explicit (`<url|label>`, `<@U…>`), which Slack still renders.
- The decisions message and the `/vestiarion waiting` answer are sent with `unfurl_links: false` and
  `unfurl_media: false` (new optional fields of `SlackMessage`), which Slack applies to incoming webhooks, so no link
  shows a preview.
- Markdown characters (`*`, `_`, `~`, `` ` ``) in a value still format: Slack offers no escape for them, and they make no
  link.

**SR5. A Review click does nothing.** Slack sends `block_actions` when a URL button is clicked. `handleInteraction`
checks the signature first, then answers 200 to any action id it does not act on; `vx_review` is one of them.

**SR6. Docs.**
- The Slack guide (`content/docs/guides/slack.mdx`): the section 3 example and its notes, a "Review a bill"
  subsection like Telegram's, the `/vestiarion waiting` row, and section 5's deciding-off sentence. Each quoted string
  is held to its source by `tests/docs-guides.test.ts`.
- CHANGELOG [Unreleased], ARCHITECTURE (the Slack paragraph), README's Slack row, the integrations guide's Slack row,
  the guide's nav description, and the Slack design's S8.

No API, ledger or migration change.

## Tests

- `tests/slack-blocks.test.ts`: the section with a held, a flagged and a waiting-for-details bill, in place of their
  blocks, each with its Review button; a bill decided since and a verdict hold keeping their blocks; two approvals with
  and without co-sign; a reason and none; no section while deciding is on, or when none waits; block ids unique and
  apart from the card ids; the worst case within 50 blocks and 3,000 characters a text; `NEVER_APPROVES` said once,
  equal to Discord's and Telegram's; `verbatim` on every mrkdwn text object; hidden characters removed, Slack's
  formatting marks left as they are, and a value on one line; previews off; `/vestiarion waiting`'s Review, wording,
  never-approves line (only when a Review link is listed: none for a verdict hold, for milestones alone, or for a
  payable only counted because it does not fit) and count.
- `tests/slack-notify.test.ts`: one waiting-bill read while deciding is off, no card read; the section in the post;
  the rules read once a bill waits; the fallback when the bills cannot be read; no section and no rules read while
  deciding is on.
- `tests/slack-interactions.test.ts`: a `vx_review` click is acknowledged, and nothing is read or answered.
- `tests/docs-guides.test.ts`: the guide's new quoted strings; that the guide no longer says a busy cycle's message
  ends with the console count (SR2), gives the waiting answer's never-approves line only when a Review link is listed
  (SR3), and, with the CHANGELOG entry, never calls a value plain text, since Slack's formatting marks still format
  (SR4).
