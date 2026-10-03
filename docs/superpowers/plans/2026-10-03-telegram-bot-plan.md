# Telegram bot: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** a member connects their own Telegram chat to a workspace. The chat then receives the agent's decisions,
answers `/today`, `/waiting` and `/ledger`, and turns an invoice sent to it into a payable with one tap.

**Architecture:**
- `src/lib/telegram/` holds small modules: settings, a fetch client for the Bot API, links (codes, links, cursor),
  messages (pure HTML text), reads for `/today` and `/waiting`, text routing, intake and the update handler.
- The webhook route `/api/telegram` authenticates the secret header and hands each update to `handleUpdate`.
- A new last cycle stage, `telegram`, pushes the agent's decisions to every linked chat of the workspace.
- The Members page gets a Telegram card, backed by two server actions.
- Migration 0064 holds three service-only tables and two functions that make claiming and switching atomic.

**Tech stack:** Next 16 route handlers and server actions, the Telegram Bot API over `fetch` (no new dependency), zod 4,
vitest with `fakeSupabase` and PGlite.

**Spec:** `docs/superpowers/specs/2026-10-03-telegram-bot-design.md`

## Global constraints

- No new runtime dependency.
- Copy says "Arc testnet" plainly, with no disclaimers that talk the product down. Commit messages are neutral.
- The bot never moves money and never approves (R11). Adding a payable is `records.write`, as in the console.
- Telegram receives no wallet address, email, key or file (R12). Every message is HTML with every value escaped.
- One Telegram message is at most 4,096 characters. Our messages are capped at 3,800.
- Limits:
  - documents of at most 4 MB (`MAX_DOCUMENT_BYTES`);
  - five reads a minute per workspace (`takeDocumentReadToken`);
  - 20 messages a minute per chat (`takeTelegramChatToken`, new);
  - drafts expire after 1 hour, link codes after 10 minutes.
- Ledger changes (`telegram_connected`, `telegram_disconnected`, `create_invoice.detail.via`, the `telegram` stage)
  get a `content/docs/changelog.mdx` entry. Every doc that the change makes stale is fixed in the same PR.

## Review focus

1. **A role lowered after the draft was shown.** An owner is made a viewer, then taps **Add** on yesterday's draft.
   It must be refused, because the role is read again at Add. Test in Task 8.
2. **A notice Telegram refuses.** A counterparty named `A&B <Ltd>`, or 30 decisions in one cycle, must not produce a
   message Telegram rejects with 400. A rejected send would hold the cursor and retry forever. Everything is escaped
   and capped. On a 400, the stage sends once as plain text, then moves on. Tests in Tasks 5 and 11.
3. **Messages that are not text or a document.** A sticker, a voice note, a photo, a location, or a message with no
   `from` must get a short reply or nothing. It must never throw. Test in Task 9.
4. **Buttons pressed from somewhere else.** A forwarded draft's **Add** button, pressed in another chat, must add
   nothing: the draft's link chat and the callback's chat and user must all match. Test in Task 8.
5. **A chat with no link left.** A member who left the workspace (cascade) or disconnected sends `/today`. The bot
   must explain how to connect, not fail. Test in Task 9.

---

### Task 1: migration 0064

**Files:**
- Create `supabase/migrations/0064_telegram.sql`.
- Test in `tests/telegram-migration.test.ts`.

**Produces:**
- Tables `telegram_link_codes`, `telegram_links` and `telegram_drafts`, shaped as in spec §5, with:
  - `code_hash` checked as `^[0-9a-f]{64}$`;
  - `chat_id` bigint, not null;
  - `notified_seq` bigint, not null, default 0;
  - `username` text, null, at most 64 characters;
  - `telegram_links unique (org_id, user_id)`;
  - a partial unique index `telegram_links_active_chat` on `chat_id` where `active`;
  - foreign key `(org_id, user_id)` to `memberships (org_id, user_id)` on delete cascade, on codes and links;
  - `telegram_drafts.link_id` to `telegram_links(id)` on delete cascade.
- RLS on all three. Revoke all from `anon`, `authenticated` and `vestiarion_tenant`; grant all to `service_role`.
- `public.telegram_claim_code(p_code_hash text, p_chat_id bigint, p_username text)` returns `setof telegram_links`
  (zero or one row). It is security definer with `search_path ''`, executable by `service_role` only. In one
  transaction it:
  - claims the code: `update … set used_at = now() where code_hash = p_code_hash and used_at is null and expires_at > now()`
    returning `org_id`, `user_id`; none means it returns no row;
  - deactivates every link of `p_chat_id`;
  - upserts the link for `(org_id, user_id)`: `chat_id = p_chat_id`, `username = p_username`, `active = true`,
    `linked_at = now()`, `notified_seq` = the org's `max(ledger_entries.seq)` (0 when none);
  - returns the link.
- `public.telegram_activate(p_chat_id bigint, p_link_id uuid)` returns `setof telegram_links`. It deactivates every
  link of the chat, then activates the one given if it belongs to that chat. Same security as above.
- Idempotent: `create table if not exists`, `create or replace`, `drop policy if exists`.

**Tests:**
- a link names an existing membership; one without a membership is refused (foreign key);
- deleting the membership deletes its codes and links; deleting a link deletes its drafts;
- a malformed `code_hash` is refused;
- two active links on one chat are refused by the index;
- `anon`, `authenticated` and the tenant cannot select any of the three tables;
- `telegram_claim_code`:
  - links with an unused, unexpired code and returns the row with `active` true and `notified_seq` equal to the
    org's ledger head;
  - a second claim of the same code returns nothing;
  - an expired code returns nothing;
  - claiming a second workspace's code from the same chat leaves exactly one active link, the new one;
  - claiming the same membership from another chat moves `chat_id`;
- `telegram_activate` switches the active link and ignores a link of another chat;
- the migration runs twice without error.

### Task 2: the shared invoice read and insert

**Files:**
- Create `src/lib/invoice-document/draft.ts` and `src/lib/invoices/create.ts`.
- Modify `src/app/actions/invoice-document.ts` and `src/app/actions/intake.ts` (`createInvoiceAction`) to call them.
- Tests: the existing suites for both actions must pass unchanged. Add `tests/invoice-create.test.ts`.

**Produces:**
- `readInvoiceDraft(input: DocumentInput, today: string): Promise<InvoiceDraftRead>`, in scope. It reads, extracts,
  normalizes, compares totals and matches counterparties, exactly as the action does today. It returns:
  ```ts
  interface InvoiceDraftRead {
    draft: InvoiceDraft & { counterpartyId: string | null };
    counterpartyName: string | null;
    warnings: string[];
    notFound: NotFoundField[];
    modelNote: string | null;
    reader: DecisionMode;
    document: { kind: "pdf" | "email" | "text"; sha256: string; truncated: boolean };
  }
  ```
  It throws `DocumentReadError` as before. The action keeps the auth, the rate limit, the size check and its messages.
- `createInvoice(input: { actorId: string; invoice: InvoiceInput; document: DocumentProvenance | null; via?: "telegram" }): Promise<{ id: string; counterpartyName: string } | null>`,
  in scope. It returns null when the counterparty is not in the workspace. It inserts the row and appends
  `create_invoice` with the same detail as today, plus `via` when given. `InvoiceInput` is `z.output<typeof invoiceInputSchema>`.

**Tests (`tests/invoice-create.test.ts`, `fakeSupabase`):**
- the insert and the ledger entry carry the org;
- `via: "telegram"` appears in the detail only when given;
- an unknown counterparty returns null and writes nothing.

### Task 3: settings and the Bot API client

**Files:**
- Create `src/lib/telegram/settings.ts` and `src/lib/telegram/client.ts`.
- Add `takeTelegramChatToken` to `src/lib/rate-limit.ts`.
- Test in `tests/telegram-client.test.ts`.

**Produces:**
- `telegramSettingsFromEnv(env = process.env): TelegramSettings | null`, where
  `TelegramSettings = { token: string; webhookSecret: string; username: string }`. It returns null unless all three
  are set. The secret must match `^[A-Za-z0-9_-]{16,256}$` (Telegram's rule, plus a 16-character floor). The username
  is stored without `@`.
- `telegramLink(settings, code): string`, giving `https://t.me/<username>?start=<code>`.
- `TelegramClient`, built by `telegramClient(settings, fetchImpl = fetch)`, with:
  - `sendMessage(chatId, text, options?: { keyboard?: InlineButton[][]; plain?: boolean })`;
  - `editMessageText(chatId, messageId, text, options?)`;
  - `answerCallbackQuery(id, text?)`;
  - `getFile(fileId)`, returning `{ file_path?: string; file_size?: number }`;
  - `download(filePath)`, returning `Uint8Array`;
  - `setWebhook(url)`, which sends `secret_token`, `allowed_updates: ["message","callback_query"]` and
    `drop_pending_updates: true`;
  - `setMyCommands(commands)`.
- Every call resolves to `{ ok: true; result } | { ok: false; status: number; description: string }`. It never throws
  for an HTTP error, and has a 10-second timeout. Messages use `parse_mode: "HTML"` and
  `link_preview_options: { is_disabled: true }` unless `plain`.
- `InlineButton = { text: string; url: string } | { text: string; callback_data: string }`.
- `takeTelegramChatToken(chatId: string, now?)`: 20 per minute (a capacity of 20, refilled one every 3 s).

**Tests:**
- settings: null when any variable is missing; null for a short or ill-formed secret; `@` stripped from the username;
- the URL is `https://api.telegram.org/bot<token>/<method>`, and the token never appears in a returned error;
- `sendMessage` sends the HTML options, the keyboard as `reply_markup.inline_keyboard`, and none of them when `plain`;
- a 403 returns `{ ok: false, status: 403 }`, and so does a network error (`status: 0`);
- `download` uses `https://api.telegram.org/file/bot<token>/<path>`.

### Task 4: links

**Files:**
- Create `src/lib/telegram/links.ts`.
- Test in `tests/telegram-links.test.ts` (`fakeSupabase` for request shapes).

**Produces (platform client `platformDb()` unless noted):**
- `createLinkCode(orgId, userId, now = new Date()): Promise<{ code: string; expiresAt: string }>`. The code is 32
  random bytes in base64url (43 characters, inside Telegram's 64-character `start` limit). Only its SHA-256 hex is
  stored. Expiry is 10 minutes.
- `claimLinkCode(code, chatId, username): Promise<TelegramLink | null>`. It calls `telegram_claim_code` with the
  code's hash. A code that is not 43 base64url characters returns null without a query.
- `TelegramLink = { id; orgId; userId; chatId: number; username: string | null; active: boolean; notifiedSeq: number; linkedAt: string }`.
- `linksForChat(chatId): Promise<TelegramLink[]>`, with the active link first.
- `activeLink(chatId): Promise<TelegramLink | null>`.
- `activateLink(chatId, linkId): Promise<TelegramLink | null>`, through `telegram_activate`.
- `linksForOrg(orgId): Promise<TelegramLink[]>`, ordered by `linked_at`.
- `linkFor(orgId, userId): Promise<TelegramLink | null>`.
- `moveCursor(linkId, seq): Promise<void>`. The cursor only moves forward:
  `update … set notified_seq = seq where id = linkId and notified_seq < seq`.
- `disconnect(link, via: "members_page" | "telegram" | "blocked", by: string | null): Promise<boolean>`. It deletes
  the row by id and returns whether one was deleted. When it was, it appends `telegram_disconnected` inside the org's
  scope (`withOrg(link.orgId, …)`): actor `human` for a person, `system` for `blocked`, domain `system`, detail
  `{ by, via, username: masked }`.
- `recordConnected(link)`: appends `telegram_connected` in the org's scope, actor `human`, detail
  `{ by: userId, username: masked }`. A username is masked as `@ab***`, or `null` when there is none.
- `memberRole(orgId, userId): Promise<OrgRole | null>`, read from `memberships`.

**Tests:**
- the stored hash is the SHA-256 of the code; the code is never in a request;
- a malformed code makes no request;
- `moveCursor` filters `notified_seq=lt.<seq>`;
- `disconnect` deletes by id and writes the ledger entry only when a row went;
- usernames are masked.

### Task 5: messages

**Files:**
- Create `src/lib/telegram/messages.ts`.
- Test in `tests/telegram-messages.test.ts`.

**Produces (pure):**
- `escapeHtml` (reuse `src/lib/email/html.ts`'s, which escapes `&`, `<`, `>` and `"`).
- `MESSAGE_MAX = 3800`.
- `decisionsMessage(workspace: { name; slug }, items: ActivityItem[], origin): string`:
  - one line per item: `✅` for done, `⏸` for stopped, then the item's text;
  - then the detail, when there is one;
  - then links: "Arc testnet transaction" to `https://testnet.arcscan.app/tx/<hash>` when there is a hash, and the
    item's `pathLabel` to `origin + orgHref(slug, path)`;
  - a header with the workspace name;
  - items that would push the message past `MESSAGE_MAX` are left out, with a closing line "and n more in the
    console" linking the console.
- `todayMessage(...)` and `waitingMessage(...)`: their input types come from Task 6.
- `ledgerMessage(name, result: VerificationResult)`: intact, broken at entry n, or not checked.
- `draftMessage(read: InvoiceDraftRead)`: the counterparty, amount and currency, due date, PO, discount, memo, the
  warnings, and the model's note labelled as the model's.
- `missingMessage(read, link)`: which of counterparty, amount, currency and due date are missing, with a link to
  Invoices.
- `helpMessage(connected: boolean, workspaceName?)`.
- `clip(text, max)`.

**Tests:**
- `A&B <Ltd>` comes out escaped, in names and reasons;
- 40 long items stay under 3,800 characters and end with "and n more";
- the transaction link appears only with a hash;
- the deep link is absolute and goes under `/o/<slug>`;
- the model's note is labelled.

### Task 6: the reads for `/today` and `/waiting`

**Files:**
- Create `src/lib/telegram/today.ts`.
- Test in `tests/telegram-today.test.ts`.

**Produces:**
- `todayFacts(): Promise<TodayFacts>`, in scope. It reads `listAccounts`, `listInvoices`, `listMilestones`, and the
  last `cycle_complete` time. It computes `cashOutlook` the way the console does, and returns:
  ```ts
  interface TodayFacts {
    safeToSpend: number;
    cash: number;
    dueIn30d: number;
    eurcLeftOut: number;
    shortOn: string | null;
    waiting: number;
    scheduled: Array<{ name: string; amount: number; currency: string; on: string }>;
    lastCycleAt: string | null;
  }
  ```
  `scheduled` holds the next three scheduled payables. `waiting` counts payables held, flagged or awaiting
  information, plus milestones held.
- `waitingFacts(): Promise<WaitingFact[]>`, in scope. At most 10 payables held, flagged or awaiting information,
  soonest due first, each `{ id, name, amount, currency, status, reason: firstSentence(agent_reasoning) }`. Each links
  to `approvalAnchor(id)` on Approvals.
- `todayMessage(workspaceName, facts, consoleLink)` and `waitingMessage(workspaceName, facts, origin, slug)`, placed in
  `messages.ts`.

**Tests:**
- the message shows "Safe to spend today", the scheduled lines, and "Nothing waits for a person" when empty;
- an EURC payable is shown in EURC;
- a reason is cut to one sentence, and a bracketed guardrail note is dropped.

### Task 7: routing plain text

**Files:**
- Create `src/lib/telegram/route-text.ts`.
- Test in `tests/telegram-route-text.test.ts`.

**Produces:**
- `TextIntent = "today" | "waiting" | "ledger" | "help" | "invoice"`.
- `keywordIntent(text): TextIntent`, used by the fallback:
  - `invoice` when the text is at least 120 characters long and holds a number with a decimal or a currency word;
  - `waiting` for held, waiting, approve or stuck, and for "chờ", "duyệt" or "giữ";
  - `ledger` for ledger, intact or audit, and for "sổ";
  - `today` for safe, spend, balance, today, cash or "hôm nay", and for "số dư" or "tiền";
  - `help` otherwise.
- `routeText(text): Promise<{ intent: TextIntent; mode: DecisionMode }>`. It calls `decide()` with a short system
  prompt naming the five intents, the schema `z.object({ intent: z.enum([...]) })`, and `keywordIntent` as the
  fallback. Text longer than 4,000 characters is cut before the model sees it.

**Tests:**
- the fallback, with English and Vietnamese phrasings for each intent;
- a pasted invoice routes to `invoice`;
- a short "hi" routes to `help`;
- with no model configured, `routeText` returns the heuristic's answer.

### Task 8: intake

**Files:**
- Create `src/lib/telegram/intake.ts`.
- Test in `tests/telegram-intake.test.ts`.

**Produces:**
- `DRAFT_TTL_MS = 3_600_000`.
- `readDraftForChat(link, input: DocumentInput, client): Promise<void>`, in scope. It:
  - refuses without `records.write`, re-reading the role;
  - refuses when `takeDocumentReadToken(orgId)` is spent;
  - calls `readInvoiceDraft`;
  - checks the draft against `invoiceInputSchema` (direction `payable`, `goodsReceived` false);
  - when the schema accepts it, inserts `telegram_drafts` and replies with `draftMessage` and three buttons:
    `add:<id>:1`, `add:<id>:0` and `cancel:<id>`;
  - otherwise replies with `missingMessage`;
  - answers a `DocumentReadError` with its own message.
- `addDraft(link, callback: { chatId; fromId; messageId; draftId; goodsReceived }, client): Promise<void>`. It:
  - checks `fromId === chatId === link.chatId`;
  - claims the draft with `update telegram_drafts set used_at = now() where id = … and link_id = link.id and used_at is null and expires_at > now()`;
  - re-reads the role (`records.write`);
  - calls `createInvoice` with `via: "telegram"` and the document `{ ...document, changed: [] }`;
  - calls `runCycleSoon({ orgId, userId, sandbox, kind: "invoice_added" })`;
  - edits the message to "Added … The agent usually decides within a minute. Its decision will be sent here."
- When the claim matched nothing, it edits the message to "This draft was already used or has expired."
- `cancelDraft(link, draftId, client)` claims the draft the same way and edits the message to "Not added."

**Tests:**
- a viewer and an approver are refused before any read;
- a draft is stored only when the schema accepts it, and an unmatched counterparty gets `missingMessage`;
- a second `addDraft` adds nothing;
- an expired draft adds nothing (the claim filters `expires_at=gt.`);
- a role lowered to viewer between the draft and Add is refused, and the invoice is not created (Review focus 1);
- a callback from another chat or another user adds nothing and claims nothing (Review focus 4);
- the `create_invoice` detail carries `via: "telegram"` and `document.changed: []`.

### Task 9: handling an update

**Files:**
- Create `src/lib/telegram/updates.ts`.
- Test in `tests/telegram-updates.test.ts`.

**Produces:**
- `handleUpdate(update: unknown, deps: { settings; client; origin }): Promise<void>`. It parses with zod; an update
  it does not understand does nothing.
- Message rules:
  - a non-private chat gets the private-chat reply (R3);
  - a chat over its rate limit is ignored;
  - `/start <code>` claims the code (`claimLinkCode`). On success it writes `recordConnected` and replies "Connected
    to <workspace>…" with the help. On failure it replies that the link was used or has expired, and points to the
    Members page;
  - `/start` alone and `/help` reply with `helpMessage`;
  - `/today`, `/waiting` and `/ledger` run in the active link's workspace (`withOrg(orgId, …, { userId })`), after
    `memberRole` confirms the membership. A missing membership deletes the link and replies how to connect;
  - `/workspaces` lists the chat's links, each as a `use:<linkId>` button, the active one marked;
  - `/disconnect` disconnects the active link (`via: "telegram"`);
  - a document goes to `readDraftForChat`;
  - a photo is answered "Send the invoice as a PDF, or paste its text.";
  - text is routed by `routeText`; `invoice` goes to `readDraftForChat({ text })`;
  - anything else (a sticker, voice, a location) gets `helpMessage`;
  - a chat with no link gets `helpMessage(false)` for every command except `/start <code>`.
- Callback queries:
  - `add:`, `cancel:` and `use:` route to the handlers above;
  - every callback is answered with `answerCallbackQuery`;
  - a callback from a non-private chat does nothing.

**Tests:**
- a group message gets the private-chat reply and touches no table;
- `/start <code>` links and records `telegram_connected`;
- `/start` with a used code replies, and writes no ledger entry;
- a sticker, a voice note and a location each get the help (Review focus 3);
- a message with no `from` does nothing;
- `/today` from a chat whose link is gone gets the "how to connect" reply (Review focus 5);
- `/workspaces` marks the active link and offers `use:` buttons;
- a document over 4 MB (`file_size`) is refused before `getFile`.

### Task 10: the webhook route

**Files:**
- Create `src/app/api/telegram/route.ts`.
- Test in `tests/telegram-route.test.ts`.

**Produces:** `POST` only, `maxDuration = 60`, `dynamic = "force-dynamic"`.
- 404 when `telegramSettingsFromEnv()` is null.
- 401 unless `x-telegram-bot-api-secret-token` equals the secret (`timingSafeEqual` over equal-length buffers).
- Otherwise it reads the JSON (an invalid body gets 200 and nothing else), awaits `handleUpdate`, and logs any throw
  by update id only. It always answers 200 `{ ok: true }`.

**Tests:**
- 404 when unconfigured;
- 401 with no header and with a wrong one;
- 200 with the right header, with `handleUpdate` called once;
- 200 when `handleUpdate` throws, and the log holds no message text.

### Task 11: the `telegram` cycle stage

**Files:**
- Create `src/lib/telegram/notify.ts`.
- Modify `src/lib/agent-activity-read.ts` (`through`), `src/lib/agent/journal.ts` (the stage and `STAGE_REQUIRES`),
  and `src/lib/agent/orchestrator.ts` (the stage after `notices`).
- Test in `tests/telegram-notify.test.ts`. Update `tests/agent-activity-route.test.ts` and any test listing stages.

**Produces:**
- `AgentActivity.through: number`: the last entry's `seq` read, or `head` when nothing was read. The route's JSON
  gains the field, which the client ignores.
- `sendAgentDecisions(deps = { settings: telegramSettingsFromEnv(), client?, origin? }): Promise<NoticeLine[]>`, in
  scope:
  - no settings means `[]`;
  - it reads `linksForOrg(currentOrgId())` (at most 25) and the org's name and slug;
  - it groups links by `notifiedSeq`, and for each group calls `readAgentActivity(seq)` once;
  - for each link with items, it sends `decisionsMessage` and moves the cursor to `through` on success;
  - for each link with no items, it moves the cursor to `through` when that is greater;
  - a 403 disconnects the link (`via: "blocked"`);
  - a 400 is sent again as plain text once. If that is refused too, the cursor moves anyway and the failure is logged;
  - any other failure leaves the cursor and is logged;
  - it stops starting sends after 20 s;
  - it returns one line saying how many chats were told, when any were.

**Tests:**
- unconfigured makes no request;
- two links at the same cursor read activity once;
- the cursor moves to `through` after a send, and past entries that make no item;
- a failed send (500) keeps the cursor;
- a 403 deletes the link and writes `telegram_disconnected` with `via: "blocked"`;
- a 400 retries as plain text and then moves the cursor (Review focus 2);
- the journal lists `telegram` last, and it needs no stage.

### Task 12: the Members page card

**Files:**
- Create `src/app/actions/telegram.ts` and `src/components/TelegramCard.tsx`.
- Modify `src/app/o/[slug]/members/page.tsx` and `src/components/MembersPanel.tsx`.
- Test in `tests/telegram-actions.test.ts`; update `tests/access-gates.test.ts` only if its counts need it.

**Produces:**
- `connectTelegramAction(prev, formData)`: `authorize(orgSlug, "workspace.read")`, then `inOrg`. It refuses when
  Telegram is not configured, otherwise calls `createLinkCode` and returns `{ ok, message, url, expiresAt }`.
- `disconnectTelegramAction(prev, formData)`: the same gate. It disconnects the caller's own link
  (`linkFor(orgId, auth.user.id)`), never one named by the form.
- `TelegramCard` props: `{ orgSlug; link: { username: string | null; linkedAt: string } | null }`. It renders only
  when the page passes `telegram` (configured). Its states:
  - not connected: a sentence on what the chat receives, and **Connect Telegram**;
  - code made: an **Open Telegram** link button, "The link works once, for 10 minutes", and `AutoRefresh` at 5 s
    until connected;
  - connected: "Connected as @user since <date>", and **Disconnect**.
- The page reads `linkFor(orgId, user.id)` only when configured, and passes `telegram`.

**Tests:**
- both actions return the refusal for a non-member (mocked `authorize`);
- disconnect uses the session's user, never a form field;
- connect refuses when unconfigured.

### Task 13: the setup script and the docs

**Files:**
- Create `scripts/telegram-setup.ts`, plus `"telegram:setup": "tsx scripts/telegram-setup.ts"` in `package.json`.
  It reads the settings and the site origin, calls `setWebhook(origin + "/api/telegram")` and `setMyCommands`, and
  prints the result. It never prints the token or the secret.
- `.env.example`: the three variables, with one comment each.
- `content/docs/guides/telegram.mdx` and its nav entry in `src/lib/docs/nav.ts`. The guide covers connecting, what
  arrives, the commands, sending an invoice, what the bot never does, and disconnecting.
- `content/docs/changelog.mdx`: the new ledger actions, `create_invoice.detail.via`, and the `telegram` stage after
  `notices`.
- `README.md`: Telegram in "What it does" (point 7) and the scripts table.
- `ARCHITECTURE.md`: the webhook, the stage and the tables.
- `src/app/privacy/page.tsx`: Telegram as a recipient for members who connect it (R12).
- A screenshot of the Members card via `npm run docs:screenshots`, if the script can render it unauthenticated
  through the design page. Otherwise the guide says what the card shows, without an image.

**Tests:** the docs suite (nav ↔ content, links, changelog order) passes.

### Task 14: verify and ship

- `npm run verify`, `npx next build`, and a whole-branch review.
- Open the PR, then record the rollout steps for the partner (spec §8).
