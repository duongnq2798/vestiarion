# Telegram bot: the agent's decisions in a chat, and invoices sent to it

Date: 2026-10-03. Status: merged in PR #166 and rolled out on 2026-10-03 (record in §9). Decided under the standing autonomy grant.

## 1. The problem

Vestiarion talks to its members in two places: the web console, and email (the digest of payables waiting for a
decision, and the payee's payment notice). A member who adds an invoice learns what the agent did only by keeping the
console open. The people Vestiarion serves (small businesses, agencies and freelancers paying in stablecoins) work in
chat apps, and Telegram is the one they use for crypto. Nothing reaches them there, and an invoice that arrives as a
PDF in a chat has to be carried to the console by hand.

## 2. What this builds

One Telegram bot for the whole platform. A member connects their own Telegram chat to their membership of a workspace.
The chat then:

- receives each decision the agent makes in that workspace, within the cycle that makes it: paid, scheduled,
  released, received, held, asked for information, flagged, or refused by code. Each decision has its reasons and links
  to the transaction and to the page where a person handles it;
- answers `/today` (safe to spend today, what waits for a person, what the agent pays next), `/waiting` and `/ledger`,
  and the same questions asked in plain words;
- takes an invoice sent as a PDF, an `.eml` or `.txt` file, or pasted text. The bot reads it the way **From a
  document** does and shows what it read. With one tap, an owner or admin adds it as a payable.

The bot never moves money and never approves anything. A held payment links to Approvals in the console.

## 3. Approaches considered

- **A. A webhook route inside the app (chosen).** Telegram posts each update to `/api/telegram`. It is one deployment
  and one database, and it reuses the workspace scope, the invoice reader, the activity reader and the cash outlook as
  they are.
- **B. A separate bot service, long-polling with a bot framework.** It is not bound by function time limits, but it is
  a second deployment with its own secrets and its own copy of the tenancy rules. It is too much for what the bot does.
- **C. Outbound notices only.** This is the smallest option, but it drops the two things a chat does better than
  email: asking a question, and forwarding an invoice.

## 4. Rulings

- **R1. One bot, configured by the platform.** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and
  `TELEGRAM_BOT_USERNAME` are read by `telegramSettingsFromEnv()`, like `emailSettingsFromEnv()`. With any of them
  missing, the feature is off: the route answers 404, the Members page shows no Telegram card, and the cycle's
  `telegram` stage does nothing. `npm run telegram:setup` registers the webhook (`setWebhook` with the secret,
  `message` and `callback_query` updates only) and the command menu. The partner runs it once per deployment.
- **R2. The webhook is authenticated by Telegram's secret header.** Every request must carry
  `X-Telegram-Bot-Api-Secret-Token` equal to `TELEGRAM_WEBHOOK_SECRET`, compared in constant time, or it gets 401 and
  nothing runs. Once authenticated, an update is handled in the request and the route answers 200 even when handling
  failed (the failure is logged without message text), so Telegram never redelivers an update in a loop. Every handler
  can run twice without harm: link codes and drafts are claimed by compare-and-set, and everything else only reads or
  replies.
- **R3. Private chats only.** An update from a group, a supergroup or a channel gets one reply saying the bot works in
  a private chat, and nothing else happens. A group would show a workspace's payments to people who are not its
  members.
- **R4. Connecting is per member, by a one-time code.** On the Members page, any member (`workspace.read`) can press
  **Connect Telegram**. The server makes a random code and stores only its SHA-256. The code is bound to that user and
  that workspace and expires after 10 minutes. The page shows a `https://t.me/<bot>?start=<code>` button. Telegram
  opens the bot and sends `/start <code>`. The bot claims the code (unused, unexpired), checks the membership still
  exists, and links the chat (`telegram_links`). The ledger records `telegram_connected` with the user and the masked
  Telegram username. A code works once, and the page shows which Telegram account is connected, so a code that leaked
  gives at most a link the member can see and remove.
- **R5. One chat, several workspaces.** A member connects each workspace separately. One chat can hold several links,
  and exactly one of them is active: the last one connected, or the one picked with `/workspaces`. Commands and
  invoices go to the active workspace. Decisions come from every linked workspace, each message named by its
  workspace. A membership has at most one chat. Connecting it again from another chat moves it there.
- **R6. Disconnecting.** A member disconnects from the Members page, or with `/disconnect` in the chat (the active
  workspace). A link goes away without anyone pressing anything when its membership is removed (a foreign key to
  `memberships`, cascading), or when Telegram answers 403 because the member blocked the bot. A disconnect by a person
  or by a 403 records `telegram_disconnected` with `via`: `members_page`, `telegram` or `blocked`. Removing a member
  is already recorded, and its link goes with it.
- **R7. Every update re-reads the membership.** The link names a user and a workspace, and the role is read from
  `memberships` on each update, never cached on the link. A role change takes effect on the next message.
- **R8. The agent's decisions are pushed by a cycle stage.** A new last stage, `telegram`, needs no other stage. For
  each link in the workspace, it reads the agent's decisions after the link's cursor (`notified_seq`, a ledger
  sequence) with the same reader the console's activity toasts use (`readAgentActivity`). It sends them as one message
  and then moves the cursor past everything it read. A link starts at the ledger's head when it connects, so it is
  never sent the past. A failed send leaves the cursor where it was, and the next cycle sends again. One stage sends to
  at most 25 links and stops after 20 s. Sandboxes are included: nothing in them is real money, and they are where a
  new member learns the bot. A person's own approvals are not sent in this version, because the reader reads the
  agent's decisions only.
- **R9. Questions are answered by code; the model only picks the question.** `/today`, `/waiting`, `/ledger`,
  `/workspaces`, `/disconnect` and `/help` are commands. Plain text is routed by `decide()` to one of `today`,
  `waiting`, `ledger`, `help` or `invoice`, with a keyword fallback in English and Vietnamese. The answer is always
  written by code from the workspace's rows. The model never writes a figure. `/ledger` runs the same verification as
  the console's **Verify hash chain**.
- **R10. Invoices sent to the bot.** A document (PDF, `.eml`, `.txt`, at most 4 MB) or pasted text routed to
  `invoice` is read only for a member who holds `records.write`, under the same five-a-minute limit per workspace. It is
  read by the same steps as **From a document**: `readDocument`, `extractInvoice`, `normalizeExtraction` and
  `matchCounterparty`, moved into one shared function. Photos are not read: the reader has no OCR, and the bot asks
  for the PDF or the text.
  - When the read gives a matched counterparty, an amount, a currency and a due date that the invoice form would
    accept, the bot stores a draft (`telegram_drafts`, one hour) and shows every field, the warnings and the model's
    note, with three buttons: **Add, goods received**, **Add, not received yet** and **Cancel**.
  - Otherwise it says what is missing and links to the console's Invoices page.
  - **Add** claims the draft once, checks the role again, and adds the payable through the same function the
    invoice form uses (`create_invoice`, with `detail.via: "telegram"` and the document's provenance, `changed: []`).
    It then raises the `invoice_added` event, so the agent decides within a minute, and the `telegram` stage sends the
    decision to the chat.
  - The file is never stored. Only its hash is, as with **From a document**.
- **R11. No approvals in the chat.** Approving, rejecting, pausing and changing limits stay in the console, behind
  sign-in, for the reason one-click email approval was dropped. A Telegram account can be lost or shared, and a button
  in a chat should not move money. A stopped decision's message links to the page that handles it (`ActivityItem.path`).
- **R12. What leaves for Telegram.** Messages carry workspace names, counterparty names, amounts, the agent's reasons
  and links. They never carry a wallet address in full (one named in a reason or a warning is shortened to its first and last four characters), an email, an API key or the file sent. The privacy page names Telegram as a
  recipient for members who connect it.

## 5. Data (migration 0064)

- `telegram_link_codes`: `id`, `org_id`, `user_id`, `code_hash` (unique), `created_at`, `expires_at`, `used_at`.
  The foreign key `(org_id, user_id)` points to `memberships` on delete cascade.
- `telegram_links`: `id`, `org_id`, `user_id`, `chat_id` (bigint), `username`, `active`, `notified_seq` (bigint),
  `linked_at`. `unique (org_id, user_id)`; a partial unique index on `chat_id` where `active`; the foreign key
  `(org_id, user_id)` points to `memberships` on delete cascade.
- `telegram_drafts`: `id`, `link_id` (on delete cascade), `draft` (jsonb), `document` (jsonb), `created_at`,
  `expires_at`, `used_at`.
- RLS on all three, with no policy and no grant to `anon` or `authenticated`. Only the service role reads or writes
  them, like `api_keys`.

## 6. Components

```
src/lib/telegram/settings.ts      telegramSettingsFromEnv()
src/lib/telegram/client.ts        Bot API calls over fetch: sendMessage, editMessageText, answerCallbackQuery, getFile, download, setWebhook, setMyCommands
src/lib/telegram/links.ts         codes (create, claim), links (read, activate, move cursor, disconnect)
src/lib/telegram/messages.ts      HTML-escaped text for decisions, /today, /waiting, /ledger, drafts, help
src/lib/telegram/today.ts         the /today and /waiting reads, in a workspace's scope
src/lib/telegram/route-text.ts    plain text -> intent (decide() + keyword fallback)
src/lib/telegram/intake.ts        document -> draft -> payable
src/lib/telegram/updates.ts       one update -> the handler for it (private-chat check, membership re-read)
src/lib/telegram/notify.ts        the cycle's telegram stage
src/lib/invoice-document/draft.ts the shared read (moved out of the server action)
src/lib/invoices/create.ts        the shared payable/receivable insert + ledger (moved out of createInvoiceAction)
src/app/api/telegram/route.ts     the webhook (R2)
src/app/actions/telegram.ts       connect / disconnect from the Members page
src/components/TelegramCard.tsx   the Members page card
scripts/telegram-setup.ts         npm run telegram:setup
```

## 7. Testing

- The route answers 401 without the secret header or with a wrong one, and 404 when the bot is not configured. It
  answers 200, and handles nothing, for an update from a group.
- A code links exactly once, within 10 minutes, and only for an existing membership. A second chat moves the link,
  and connecting a second workspace makes it the active one.
- The stage sends only decisions after the cursor. It moves the cursor past entries that make no item, keeps the
  cursor on a failed send, and removes the link on a 403.
- Plain text routes to the right intent through the fallback, and a model's answer outside the enum falls back.
- Intake refuses a viewer and an approver, refuses photos, and stores a draft only when the form would accept it. Add
  creates exactly one payable with `via: "telegram"`. A second Add, or one after an hour, adds nothing.
- The migration test covers the tables, RLS, no grants, the cascades, and running the migration again.
- The access-gates test covers the new server actions, which gate on `authorize` first.

## 8. Rollout

1. The partner creates the bot with @BotFather and sets the three variables in Vercel (Production and Preview) and
   `.env.local`. The partner applies migration 0064, then we merge.
2. The partner runs `npm run telegram:setup` against production.
3. In testnet-2: Members, then **Connect Telegram**, then open the bot. `telegram_connected` should appear. Add a
   payable in the console: the decision should arrive in the chat within a minute. Then send a PDF invoice to the bot,
   tap **Add, goods received**, and check that the payable is decided and the decision arrives in the chat.
4. Record the ledger entries and the transaction here.

## 9. Rollout record (2026-10-03, UTC)

- **Migration 0064** was applied by the partner and probed read-only: the three tables have RLS on, no policy, and no
  access for `anon`, `authenticated` or `vestiarion_tenant`; codes and links cascade with `memberships`, drafts with their
  link; `telegram_links_active_chat` is a partial unique index; both functions are security definer with
  `search_path ""`, executable by `service_role` only. The earlier redefinitions the replay could revert (0038, 0040,
  0043, 0061, 0062, 0063) were intact.
- **PR #166** merged as `bdb2796` at 07:31. The partner made @vestiarion_bot with @BotFather, set the three variables,
  and ran `npm run telegram:setup`: the webhook is `https://www.vestiarion.xyz/api/telegram`, with 6 commands in the
  menu. The route answers 401 without the secret header and with a wrong one.
- **testnet-2** (live):
  - 07:36:08 the partner connected a chat from **Members**: ledger #1049 `telegram_connected` (`@du***`); one code
    made and used.
  - 07:37:58 a payable added on AP / AR, Centronex 0.10 USDC (#1050). The agent brought 0.099999 USDC back from the
    reserve (#1053) and paid it (#1054): tx `0x49efd505030a614003b1e586f6c75999d88dc40a9b1c23484e87242ba4da6330`,
    confirmed 07:38:29.
  - 07:42:49 a second payable on AP / AR, Centronex 0.50 USDC (#1058), paid (#1062): tx
    `0x2ca1421b8306bfec79c03d0e8295ebf151d37312b68e1c3fb5ec6a2fe48692e5`, confirmed 07:43:22.
  - A PDF invoice (CX-TG-001, Centronex, 0.40 USDC, PO-TG-001) sent to the bot was read into a draft; the partner
    tapped **Add, goods received**: #1066 `create_invoice` with `via: "telegram"` at 07:44:25, paid by the agent
    (#1069): tx `0x5bdb8ded52127dc5f22a928b7b8daa7319b70fab052f6adfeeb06747aa3133ad`, confirmed 07:44:48, 23 s after
    the tap. One draft made and used.
  - Each of the three event cycles (07:38:05, 07:42:54, 07:44:29) recorded the `telegram` stage as completed, and the
    chat's cursor stood at #1071 afterwards: it moves past a decision only once Telegram has accepted the message.
