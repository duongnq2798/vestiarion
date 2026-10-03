# Slack (Integrations Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Slack app of docs/superpowers/specs/2026-10-03-slack-design.md: install from Settings, a decisions feed,
`/vestiarion`, member links, and deciding a held payable from the channel under an owner's limit.

**Architecture:** Five route handlers verify Slack and hand off to `src/lib/slack/*`; every action runs through
`src/lib/commands` with a `slack` surface; the feed is a cycle stage like Telegram's.

**Tech Stack:** Next.js 16 route handlers and server actions, supabase-js, PGlite migration tests, Vitest with
`fakeSupabase` and injected `fetch`/`defer`.

**Spec:** docs/superpowers/specs/2026-10-03-slack-design.md (S1–S14).

**Format ruling:** this plan is executed inline by its author. Each task names its files, interfaces and the tests it
writes first; the code is written test-first into the commits rather than copied twice. Cost if wrong: a later
executor reads the commits for the code.

## Global Constraints

- Migration number 0067. RLS on, no policy, service role only, as 0064.
- Scopes `commands` and `incoming-webhook` only. Public URLs under `${siteOrigin()}/api/slack/...`.
- Secrets (bot token, webhook URL) only as master-key envelopes, bound to `{ orgId, column }`; never logged.
- Every Slack request verified (S2) before its body is parsed; Slack is answered within 3 s, work runs in `after()`.
- Messages: names, amounts, reasons, links, tx hashes; addresses shortened; no email.
- Ledger entries: ids only.
- Repository wording neutral; commits plain with the Co-Authored-By trailer; `npm run verify` green at the end.

## Review Focus

1. A click by someone in the channel who is not linked, or linked to another workspace: told to connect; nothing runs.
2. A card posted before the payable was decided again: refused as stale, never applied to the new facts.
3. Approve on a payable whose counterparty's address changed and is unconfirmed: refused, never confirmed by the chat.
4. A Slack workspace that installs for a second Vestiarion workspace: refused, the first install untouched.
5. A webhook post that fails: the cursor stays, so the next cycle posts the same decisions.

---

### Task 1: Migration 0067
Files: `supabase/migrations/0067_slack.sql`; test `tests/slack-migration.test.ts`.
Tests first: tables and columns; `decisions_limit_usdc > 0` or null; `team_id` unique; links unique both ways; cascades
(membership delete removes the link; install delete removes links); RLS on and no grants to anon/authenticated/tenant;
`slack_link_member` claims once, refuses expired/used, refuses a code for another team, replaces both sides' old links,
is service-role only; the file runs twice.

### Task 2: Settings, request verification, signed tokens, manifest
Files: `src/lib/slack/settings.ts`, `src/lib/slack/verify.ts`, `src/lib/slack/state.ts`,
`integrations/slack/manifest.yaml`; tests `tests/slack-verify.test.ts`, `tests/slack-state.test.ts`.
Interfaces: `slackSettingsFromEnv(env?) → { clientId, clientSecret, signingSecret } | null`;
`verifySlackRequest({ signature, timestamp, body }, signingSecret, nowMs?) → boolean`;
`signToken(purpose, payload, keys, nowMs?)`, `verifyToken(purpose, token, keys, nowMs?) → payload | null` with
purposes `"oauth-state"` and `"card"`; `cardToken({ org, invoice, decidedAt, addressHash })`, `readCard(token)`;
`addressHash(address) → string | null` (first 16 hex of sha256 of the lowercased address).

### Task 3: Slack Web API and posting
Files: `src/lib/slack/api.ts`; test `tests/slack-api.test.ts`.
Interfaces (fetch injected): `exchangeCode(settings, code, redirectUri)` → parsed install facts or a coded failure;
`uninstallApp(settings, botToken)`; `postToWebhook(url, message)` → `{ ok, status, body }`;
`postToResponseUrl(url, message)`; each with a 10 s deadline and no secret in a log line.

### Task 4: The chat's rules in the command layer
Files: `src/lib/commands/actor.ts` (slack surface carries `decisionsLimitUsdc`), `src/lib/commands/policy.ts`
(`SURFACE_COMMANDS.slack` = approve, reject, return, pause; `decisions_off`), `src/lib/commands/chat-decisions.ts`,
`src/lib/commands/payables.ts` (`card` input; checked for any surface but the console); tests
`tests/commands-chat-decisions.test.ts`, updates to `tests/commands-policy.test.ts`.
Tests first: decisions off refuses; stale (status or decidedAt) refuses; Approve refuses EURC, another chain, above the
limit, unconfirmed address, another address, no card; Reject and Return need a fresh card only; console unchanged.

### Task 5: Installs and links
Files: `src/lib/slack/installs.ts`, `src/lib/slack/links.ts`; tests `tests/slack-installs.test.ts`,
`tests/slack-links.test.ts`.
Interfaces: `installFor(orgId)`, `installOfTeam(teamId)`, `saveInstall(...)` (envelopes, cursor at head,
`slack_installed`), `removeInstall(install, via, by)`, `setDecisionsLimit(orgId, limit, by)`, `moveCursor(id, seq)`,
`readWebhookUrl(install)`, `readBotToken(install)`; `createLinkRequest(team, slackUser, name)`, `readLinkRequest(code)`,
`linkMember(code, orgId, userId)`, `linkOf(team, slackUser)`, `linkFor(orgId, userId)`, `unlink(link, via, by)`,
`slackActor(install, link)`.

### Task 6: Block Kit
Files: `src/lib/slack/blocks.ts`; test `tests/slack-blocks.test.ts`.
Tests first: mrkdwn escaping and address shortening; the decisions message (header, items, tx and page links, at most
50 blocks); a stopped payable's actions with tokens when decisions are on, with the reason Approve is missing, and only
the link when off; confirmations name amount, payee and shortened address; outcome rewrites; answers to `today`,
`waiting`, `ledger`, `help`, connect and refusals.

### Task 7: The cycle's `slack` stage
Files: `src/lib/slack/notify.ts`, `src/lib/agent/journal.ts`, `src/lib/agent/orchestrator.ts`,
`src/lib/agent-activity.ts` (`invoiceId` on a stopped payable's item); test `tests/slack-notify.test.ts` and updated
stage-list tests.
Tests first: no install, nothing; items after the cursor posted, cursor moved on `ok`; kept on failure; nothing new
moves the cursor past quiet entries; the stopped payable gets its card facts read in one query.

### Task 8: `/vestiarion`
Files: `src/lib/slack/commands.ts`, `src/app/api/slack/commands/route.ts`; test `tests/slack-commands.test.ts`.
Tests first: 404 unconfigured, 401 unsigned, 200 at once with the work deferred; not installed; not linked; connect
makes a request and answers with its link; help; today/waiting/ledger answers; pause runs the command with
`via: "slack"` and answers in the channel; disconnect.

### Task 9: Clicks
Files: `src/lib/slack/interactions.ts`, `src/app/api/slack/interactions/route.ts`; test
`tests/slack-interactions.test.ts`.
Tests first: unsigned 401; a URL button acknowledged and ignored; not linked; bad card; another workspace's card; each
decision's command called with the actor and card; the message rewritten on success; a refusal sent to the clicker only.

### Task 10: Install, callback, events
Files: `src/app/api/slack/install/route.ts`, `src/app/api/slack/oauth/route.ts`, `src/app/api/slack/events/route.ts`,
`src/lib/auth/roles.ts` (`integrations.manage`); test `tests/slack-oauth.test.ts`, `tests/slack-events.test.ts`.
Tests first: S3's refusals and the happy path; events verify, answer the challenge, remove on uninstall.

### Task 11: Settings card, actions, connect page
Files: `src/components/SlackCard.tsx`, `src/app/actions/slack.ts`, `src/app/integrations/slack/connect/page.tsx`,
`src/app/o/[slug]/settings/page.tsx`; tests `tests/slack-actions.test.ts`, `tests/slack-card.test.tsx`; access gates.

### Task 12: Docs and the whole suite
Files: `content/docs/guides/slack.mdx`, `src/lib/docs/nav.ts`, `content/docs/changelog.mdx`, `ARCHITECTURE.md`,
`README.md`, privacy page, `.env.example`, a docs shot and its PNG, `tests/docs-guides.test.ts` quotes; `npm run verify`.
