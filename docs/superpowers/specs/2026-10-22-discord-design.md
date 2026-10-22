# Discord: bills waiting for approval (2026-10-22)

## Why

Many small studios, crypto ones especially, run their team in Discord, not Slack. A bill the agent held for a person
waits in Approvals until someone looks. Slack and Telegram already tell a workspace. Discord is the next channel, and the
simplest one to connect, since a channel webhook needs no app install.

## Rules

**DC1. Connect with a channel webhook.**
- **Who and where.** An owner or admin (`integrations.manage`) pastes a channel's webhook URL in Settings → Integrations
  → Discord. In Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
- **Parsing.** `parseDiscordWebhookUrl(raw)` (`src/lib/discord/webhook-url.ts`):
  - trims the input and parses it with `new URL`;
  - requires `https:`, with no credentials, port, query or hash (a bare `?` or `#` included);
  - accepts only the hosts `discord.com`, `discordapp.com`, `canary.discord.com` and `ptb.discord.com`;
  - requires the path to match `^/api(?:/v\d{1,2})?/webhooks/(\d{17,20})/([A-Za-z0-9_-]{60,100})/?$`;
  - returns `{ id, token, url }`, where `url` is always rebuilt as `https://discord.com/api/webhooks/{id}/{token}`.

  Only the rebuilt URL is stored and called, never the pasted string. That closes SSRF with no DNS check.
- **Saving.** `connectDiscordAction` (`src/app/actions/discord.ts`) first reads the webhook with a GET
  (`readDiscordWebhook`: its channel, server and name, and that its id is the one parsed), then posts a test message, and
  saves the connection only on a 2xx (`saveConnection`, an insert: a workspace already connected is told to disconnect
  first, and nothing is replaced). The test message says it checks the webhook and that bills are posted once Settings
  says Discord is connected, so it claims nothing a failed save would undo. Two people connecting at once: the second
  insert fails on the unique `org_id` (`DiscordAlreadyConnectedError`), and that person is told someone connected another
  channel at the same moment and the test message can be ignored. The URL is stored encrypted (the existing
  `encryptSecret` / `decryptSecret` envelope, column `discord_webhooks.webhook_url_enc`). It is never returned to the
  browser, logged or put in the ledger. The cursor starts at the ledger's head, so the channel is never sent the past.
- **Tries.** Connect and Send test message each call Discord, so each takes a token from `takeDiscordCallToken` first
  (five at once, then one every 12 seconds, per workspace and per person), after the URL is parsed and the connection
  read, so a typo or an already connected workspace spends none. Past that: "Too many tries at once. Try again in a
  minute.", and nothing is called. Discord blocks an IP after too many refused calls, which would stop every
  workspace's posts.
- **Signing.** `discord_connected { by, webhookId, channelId }` (actor `human`) and
  `discord_disconnected { by, webhookId, via }` (`via`: "settings" | "discord", the latter when Discord says the webhook
  is gone, actor `system` and `by: null`).
- **The webhook stays Discord's.** Disconnecting forgets the URL; it does not delete the webhook in Discord. Settings,
  the guide and the security page say to delete it in the channel's settings to revoke it.

**DC2. The table.** Migration `0140_discord.sql`, applied by the partner after merge: a platform table
`public.discord_webhooks`.
- **Columns:**
  - `id`, plus `org_id`, unique, cascading on delete;
  - `webhook_id` and `channel_id`, digits, 17–20 characters;
  - `guild_id`, nullable, the same form;
  - `name`, 1–80 characters;
  - `webhook_url_enc jsonb`;
  - `connected_by`, set null on delete;
  - `connected_at`;
  - `notified_seq bigint default 0`;
  - `last_error` (300 characters at most), `last_error_at` and `failures int default 0` (never negative).
- **Access.** RLS on with no policies; revoked from anon, authenticated and vestiarion_tenant; granted to service_role,
  following 0067's posture. Listed in the DAL's PLATFORM_TABLES and in the delete-org and account-deletion invariants
  and tests.
- **Before the migration.** Every read tolerates the missing table (PGRST205/42P01) as "not available yet"
  (`readConnection` answers `{ ready: false }`). The Settings panel then says Discord is not set up on this deployment
  yet, and the cycle stage does nothing.

**DC3. What is posted.** A new cycle stage, `discord`, comes after `slack` in CYCLE_STAGES, the last, with no
requirement (`src/lib/discord/notify.ts`).
- **Which bills.** Like Slack's notifier, it reads the workspace's activity after `notified_seq`, page after page (a read
  returns 20 entries at most) up to the ledger's head while less than 8 of the stage's 20 seconds have gone, so the
  post's 10-second deadline still fits; the cursor then moves only past what was read. It keeps the payables
  the agent stopped for a person whose link is Approvals, re-read in one query, still held or flagged. A bill decided
  since, a request for details (decided with Add details) and a payment held for a verdict in shadow mode (which carries
  no `invoiceId`) are left out. Nothing waiting moves the cursor past what was read, posting nothing.
- **The message.** One message per cycle, at most 10 bills and as many as fit in 2,000 characters, then "…and N more in
  Approvals" with a link to Approvals. A bill that would pass the limit is counted among the more, never cut. Each bill
  takes one line:
  - amount and currency, payee, held or flagged, and the agent's reason (first sentence, as the approval card says it);
  - for a bill above the two-approvals figure, "needs two approvals", plus "an accountant can co-sign" while accountant
    co-sign is on. A EURC bill is weighed by its last decision's USDC value, and needs two approvals when that is not
    known (two approvals T2). A rule that cannot be read is left out of the notice rather than stop it;
  - then "Review: <absolute Approvals URL with the bill's anchor>".
- **The link.** It carries no token and opening it approves nothing. The message says so once: "Opening a link never
  approves anything."
- **Shared builder.** The bill list comes from `buildWaitingNotice(items, policy)`
  (`src/lib/notifications/waiting-notice.ts`), which returns structured entries. Discord formats them
  (`src/lib/discord/messages.ts`); Telegram's Review-link message (D10) will reuse them.

**DC4. Safe text.**
- **Escaping.** `discordText(value)` (`src/lib/discord/escape.ts`) first removes invisible format characters (Unicode's
  Cf: bidi embeddings, overrides and isolates, direction marks, zero-width spaces and joiners, the byte-order mark, the
  soft hyphen), so text from an invoice cannot show the rest of its line reversed or hide a word, and any half of an
  emoji an earlier cut left alone. Spaces and combining marks stay: real names carry them. It turns every newline,
  control character and whitespace run into one space, so no heading or quote can start. It backslash-escapes Discord
  markdown and mention characters (`\ * _ ~ \` | > # - [ ] ( ) < @ :`), then clips by UTF-16 units, never inside an
  escape and never between the two halves of an emoji. Every interpolated value goes through it: the workspace name,
  payee, reason and amount text. Only Vestiarion's own URL is added raw, inside `<…>`.
- **The post.** It sends:
  - `allowed_mentions: { parse: [] }`;
  - `flags: 4`, which suppresses embeds;
  - `username: "Vestiarion"`;
  - content of 2000 characters at most, clipped never between the two halves of an emoji.
- **Addresses.** Payee addresses are shortened, as in Telegram's messages.

**DC5. Delivery.** `postToDiscord` (`src/lib/discord/api.ts`) POSTs to `${url}?wait=true` with `redirect: "error"` and a
10 s timeout. It refuses any URL that does not start with `https://discord.com/api/webhooks/`. By response:

| Response | What happens |
| --- | --- |
| 2xx | The cursor moves to the activity read's end. The failure is cleared. |
| 429 | Wait once if `retry_after` (JSON, else the `Retry-After` header) is 2 s or less and the stage's 20 s budget allows. Otherwise keep the cursor. |
| 5xx, timeout, unreachable | Keep the cursor, and record the failure. |
| 400, and any other refusal of the message | Record it, and move past the cursor so one bad message cannot jam the channel. |
| 401, 403, 404, or Discord codes 10015 / 50027 | Remove the connection (`via: "discord"`), signed. |

Send test message handles a gone webhook the same way. Logs carry the status and Discord's code, never the URL.

**DC6. Settings panel.** `DiscordPanel`, in the Integrations group after Slack.
- **What it shows.** Connected or not; the webhook's name and channel id; when it was connected, and "by you" when the
  viewer connected it (the page reads no other member's email for it); the last error and when. Never the URL.
- **Actions.**
  - **Connect**, with a field for the URL. It posts the test message and saves.
  - **Send test message.** When Discord says the webhook is gone, the connection is removed and the page swaps to
    Connect in the same render, so the panel keeps the answer and shows it beside Connect until Connect or Disconnect
    next answers.
  - **Disconnect**, behind a confirmation.
- **Who sees what.** A member without `integrations.manage` sees the status and "An owner or admin can connect
  Discord."

**DC7. Docs.**
- A guide: `content/docs/guides/discord.mdx`, in nav and content, with Slack's and Telegram's shape.
- Lists and pages:
  - the README integrations list and its "Works with" row, its cycle stage line, which tests/readme-facts holds to
    CYCLE_STAGES, and its trademark line;
  - the privacy page's services and the security page's subprocessors (Discord, only when a workspace connects it);
  - the security page's encrypted secrets, connected tools and workspace deletion;
  - the evidence page's ways out of the workspace;
  - the integrations guide's table.
- The landing page's tool cards are left as they are: they are nine, in three full rows, and a tenth would break the
  grid; Discord is listed on the integrations guide the landing links to.
- CHANGELOG, plus the API changelog for the two new ledger actions and the new journal stage.
- ARCHITECTURE.

**DC8. Not in this change.**
- Approving from Discord: no buttons, links only.
- A Discord bot or slash commands.
- Per-person DMs.
- Posting payment confirmations, or a stuck payment from the transfer watch.
- Several channels or threads per workspace (the parser refuses a `thread_id` query).

## Tests

- `parseDiscordWebhookUrl` (`tests/discord-webhook-url.test.ts`):
  - accepted hosts and paths, with every accepted form rebuilt as the canonical URL;
  - rejected: http, credentials, port, query, hash, other hosts, lookalike hosts such as `discord.com.evil.com`, short
    or long ids and tokens, and an extra path.
- `discordText` and the message (`tests/discord-messages.test.ts`): markdown, masked links, `@everyone`, `<@&id>`,
  `<t:…>`, newlines and clipping; the line format, the two-approvals and co-sign wording, ten bills and the more, and the
  2,000-character limit.
- `buildWaitingNotice` (`tests/waiting-notice.test.ts`).
- `postToDiscord` and `readDiscordWebhook` (`tests/discord-api.test.ts`): each response class in DC5,
  `redirect: "error"`, the URL never logged.
- The connection (`tests/discord-connections.test.ts`): envelope, cursor at the head, ledger entries with ids only,
  scope, before 0140, and the panel's view.
- The notifier (`tests/discord-notify.test.ts`):
  - only held or flagged payables are posted;
  - more than 10 bills collapse to "…and N more";
  - the two-approvals and co-sign wording;
  - the cursor on success and on each failure;
  - the connection is removed on 404 or 10015;
  - nothing happens before 0140.
- Actions (`tests/discord-actions.test.ts`): `integrations.manage`, a test post before saving, and nothing saved on
  failure.
- The migration (PGlite, `tests/discord-migration.test.ts`): the table's posture, and re-runnability.
- The panel's markup (`tests/discord-panel.test.tsx`).
- The tests that pin CYCLE_STAGES (slack-notify, telegram-notify, readme-facts), and the platform-tables and delete-org
  tests, updated; the docs, security and legal pages' tests updated.
