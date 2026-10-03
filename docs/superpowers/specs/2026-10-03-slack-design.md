# Slack: the agent's decisions in a team channel, and a held payable decided there

Date: 2026-10-03. Status: designed on `feat/slack`, stacked on the command layer (`feat/integrations`, PR #172).
Phase 1 of docs/superpowers/specs/2026-10-03-integrations-design.md. Decided under the standing autonomy grant.

## 1. The problem

A payable the agent holds waits until someone opens the console. Telegram tells one member in a private chat; a team
that works in Slack hears nothing, and nobody can act on a hold from where the team already talks. The integrations
review chose Slack as the first new surface: it is where startups, agencies, crypto and fintech teams decide things,
and its pattern is the one Teams and Lark reuse.

## 2. What this builds

A Slack app any workspace's owner or admin connects from Settings. Then:

- a channel the installer picks gets each decision the agent makes, within the cycle that makes it;
- any member who connects their own Slack account can type `/vestiarion today`, `waiting`, `ledger` or `pause`;
- when an owner allows it, a payable the agent stopped can be approved and paid, rejected, or returned to the agent
  from the channel's message, within a USDC limit the owner sets, under every check the console applies and a few
  more.

## 3. Approaches considered

- **A. Our own routes, an incoming webhook and `response_url` (chosen).** The app asks for two scopes only:
  `commands` and `incoming-webhook`. It posts to the one channel picked at install, answers its slash command, and
  rewrites a message through the `response_url` each click carries. No message is ever read.
- **B. A bot that posts with `chat:write` and DMs people (`im:write`).** It could message approvers directly and edit
  any message at any time, but it needs broader scopes and an install review would ask why. Kept for later.
- **C. Slack's Bolt framework.** It brings its own HTTP receiver and state store; our routes already verify, scope and
  log the way the Telegram bot does. Too much for four routes.

## 4. Rulings

- **S1. On only when configured.** `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`
  (`slackSettingsFromEnv()`, like Telegram's R1). With any missing, the five routes answer 404, Settings shows no Slack
  card, and the cycle's `slack` stage does nothing. The app is created from `integrations/slack/manifest.yaml`.
- **S2. Every request from Slack is verified first.** `X-Slack-Signature` must equal `v0=` and the hex HMAC-SHA256 of
  `v0:{X-Slack-Request-Timestamp}:{raw body}` under the signing secret, compared in constant time, with the timestamp
  within 300 s of now; otherwise 401 and nothing runs. The body is parsed only after.
- **S3. One Slack workspace serves one Vestiarion workspace.** An owner or admin (`integrations.manage`, a new
  permission for owner and admin) presses **Add to Slack** on Settings. `GET /api/slack/install?org=<slug>` checks the
  session and the permission, signs a state `{ org, user, nonce, expires }` (HMAC under a key derived from the master
  key, ten minutes), sets the nonce in an HttpOnly cookie, and redirects to Slack. `GET /api/slack/oauth` checks the
  state's signature and age, the cookie, that the signed-in person is the one who started, and their permission again;
  then exchanges the code (`oauth.v2.access`). An enterprise-wide install, or a Slack workspace already serving another
  Vestiarion workspace, is refused. The install stores the bot token and the incoming webhook's URL encrypted under
  the master key (bound to the organization and column), the channel, and a cursor at the ledger's head, so the channel
  is never sent the past. The person who installed is linked to their Slack account at once: Slack authenticated them,
  and so did the session. `slack_installed` is recorded.
- **S4. A member links their own Slack account by proving both sides.** `/vestiarion connect` answers that person, and
  only them, with a one-time link (32 random bytes, only the SHA-256 kept, ten minutes, bound to their Slack account and
  team). The link opens `/integrations/slack/connect`, which needs a Vestiarion sign-in and shows which Slack account
  and team it is and which workspace and role it will act as. **Connect** (`workspace.read`) claims the code and links
  in one transaction (`slack_link_member`, 0067), replacing an earlier link of either side. `slack_member_connected` is
  recorded. A link goes with its membership and with the install (cascading foreign keys); `/vestiarion disconnect`
  or the card's **Disconnect** removes it (`slack_member_disconnected`).
- **S5. Every action re-reads the member.** The link names a membership; the role and the workspace's mode are read
  for each command or click (`memberActor`), and the actor's surface carries the install's decisions limit as read
  then.
- **S6. The slash command answers after the response.** `POST /api/slack/commands` verifies, answers 200 at once with
  nothing, and does the work after the response (`after()`), posting the answer to the command's `response_url`, so a
  cold start or a ledger check never runs into Slack's three seconds. Answers are private to the person who asked,
  except a pause, which the channel where it was typed sees. `today`, `waiting` and `ledger` reuse the bot's reads
  (`todayFacts`, `waitingFacts`, `verifyLedger`). `pause [reason]` runs `pauseWorkspaceAgent` with `via: "slack"`.
  Resuming stays in the console.
- **S7. Decisions reach the channel from a cycle stage.** A new last stage, `slack`, needing no other stage, reads the
  agent's decisions after the install's cursor with `readAgentActivity` and posts them as one message to the incoming
  webhook. The cursor moves only when Slack answers `ok`; a failed post is posted again by the next cycle. Each
  decision says what the agent did, why, and links its transaction or its page; a stopped payable also carries its
  buttons (S8).
- **S8. Deciding from Slack is off until an owner sets a limit.** Settings has "Allow deciding payments from Slack, up
  to [ ] USDC" (`org.administer`), recorded as `slack_decisions_limit_changed`. When off, a stopped payable links to
  Approvals and nothing else. When on, it gets **Approve and pay** (only when it is in USDC, paid on Arc, within the
  limit, and its counterparty's address is confirmed), **Reject**, **Return to the agent**, and the link. Approve and
  Reject ask Slack to confirm first; the confirmation names the amount, the payee and the address shortened.
- **S9. A button carries a signed card.** Its value is `vxa1.<payload>.<HMAC>`: `{ org, invoice, decidedAt, address
  hash, expires }`, keyed from the master key (HKDF, its own purpose), valid seven days, checked against every master
  key so a rotation does not break old cards. A changed or forged value, another workspace's card, or an expired one is
  refused before anything is read.
- **S10. A click is decided by the command layer, with the chat's rules.** `POST /api/slack/interactions` verifies,
  answers 200 at once, and after the response: finds the install by team and the link by Slack user (none: "Connect
  your Slack account first"), checks the card, and runs `approvePayable`, `rejectPayable` or `returnPayable` in the
  workspace's scope. For any surface but the console, those commands first check the card against the payable now:
  still waiting and decided at the same moment (else "it changed since this message"); and for Approve, USDC, on Arc,
  within the limit, an address that is confirmed and is the one the card was posted with. Then the console's own
  checks run: the claim (no self-approval except a sole approver, decided once), high risk refused, the funds, the
  payment's idempotency key. The message is rewritten through `response_url` to say who did what (and the transaction);
  a refusal is told only to the person who clicked.
- **S11. A chat never confirms an address.** The console's Approve and pay confirms a changed address it showed; a chat
  refuses one that is not confirmed and sends the person to Counterparties.
- **S12. The signed ledger says it came from Slack.** `approval_paid`, `approval_rejected`, `approval_returned` and
  `agent_paused` made from Slack carry `via: "slack"` and `linkId`. The install, links, the limit and removal have
  entries of their own: ids only, never a Slack name or a webhook URL.
- **S13. Removing.** **Remove** on Settings (`integrations.manage`) uninstalls the app from the Slack workspace
  (`apps.uninstall`, best effort) and deletes the install and its links (`slack_uninstalled`, `via: "settings"`).
  Slack's `app_uninstalled` and `tokens_revoked` events, at `POST /api/slack/events`, do the same with
  `via: "slack"`; the events URL also answers Slack's `url_verification`.
- **S14. What leaves for Slack.** Workspace and counterparty names, amounts, the agent's reasons, links, and a
  transaction hash. A wallet address only shortened to its first and last four characters; no email, no full address,
  no key. The privacy page names Slack as a recipient once a workspace connects it.

## 5. Data (migration 0067)

- `slack_installs`: `id`, `org_id` (unique, cascades with the org), `team_id` (unique), `team_name`, `app_id`,
  `bot_user_id`, `bot_token_enc` and `webhook_url_enc` (envelopes), `channel_id`, `channel_name`, `installed_by`,
  `installed_at`, `notified_seq`, `decisions_limit_usdc` (null: off; else above 0). Unique `(org_id, team_id)`.
- `slack_links`: `id`, `org_id`, `user_id`, `team_id`, `slack_user_id`, `linked_at`. Unique `(org_id, user_id)` and
  `(team_id, slack_user_id)`. Foreign keys `(org_id, user_id)` to `memberships` and `(org_id, team_id)` to
  `slack_installs`, both cascading.
- `slack_link_requests`: `id`, `team_id`, `slack_user_id`, `slack_user_name`, `code_hash` (unique, hex), `created_at`,
  `expires_at`, `used_at`.
- `slack_link_member(p_code_hash, p_org_id, p_user_id)`: security definer, `search_path ''`, service role only. Claims
  the code (unused, unexpired), requires the org's install to be for the code's team, removes the links either side
  already had, inserts the new one, returns it; no row otherwise.
- Row-level security on all three tables, no policy, no grant to `anon`, `authenticated` or `vestiarion_tenant`.

## 6. Components

```
integrations/slack/manifest.yaml    the app, created from it in Slack
src/lib/slack/settings.ts           slackSettingsFromEnv()
src/lib/slack/verify.ts             verifySlackRequest (S2)
src/lib/slack/state.ts              the OAuth state (S3) and the card token (S9): HKDF keys, sign, verify
src/lib/slack/api.ts                oauth.v2.access, apps.uninstall, posts to a webhook or a response_url, with deadlines
src/lib/slack/installs.ts           the install: read, save, remove, limit, cursor; its ledger entries
src/lib/slack/links.ts              link requests, linking, unlinking; the actor from a Slack user
src/lib/slack/blocks.ts             Block Kit for decisions, cards, outcomes and answers; mrkdwn escaping
src/lib/slack/commands.ts           /vestiarion
src/lib/slack/interactions.ts       a click
src/lib/slack/notify.ts             the cycle's slack stage
src/lib/commands/chat-decisions.ts  the chat's rules on a payable (S10, S11)
src/app/api/slack/{install,oauth,commands,interactions,events}/route.ts
src/app/integrations/slack/connect/page.tsx
src/app/actions/slack.ts            connect, disconnect, remove, limit
src/components/SlackCard.tsx        the Settings card
```

## 7. Testing

- Signature: valid; wrong secret; a timestamp older than 300 s; a changed body; a missing header.
- State and card tokens: round trip; a changed payload or signature; expired; another purpose's key; an old master key.
- OAuth: refused without a session, for another person, without the cookie, with an old state, for a role without
  `integrations.manage`; a team serving another workspace; an enterprise install; a stored install's secrets are
  envelopes and its cursor is the ledger head.
- Links: a code works once, for ten minutes, for the install's team; a new link replaces either side's old one.
- Commands: no install, no link, each subcommand, an unknown one; pause records `via: "slack"`.
- Clicks: not linked; a forged, expired or other-workspace card; decisions off; a stale card; Approve above the limit,
  in EURC, to another chain, to an unconfirmed or different address; a viewer; each command's outcome rewrites the
  message, a refusal goes to the clicker only.
- The stage: posts only what is after the cursor and moves it on `ok`; keeps it on failure; buttons only when decisions
  are on, and Approve only when the payable qualifies.
- The migration: tables, constraints, RLS and grants, cascades, `slack_link_member`, a second run.
- Access gates: the new server actions authorize first; every command still gates first.

## 8. Rollout

1. The partner created the app from the manifest and set the three variables (done 2026-10-03, before code).
2. The partner applies migration 0067, then we merge.
3. In the Slack app's settings, the partner adds Event Subscriptions (`https://www.vestiarion.xyz/api/slack/events`,
   events `app_uninstalled` and `tokens_revoked`). Slack checks the URL as it saves, so the code must be deployed.
4. In testnet-2: Settings, **Add to Slack**, pick a channel; `slack_installed` appears. In Slack, `/vestiarion today`.
   Settings: allow deciding up to 1 USDC. Add a 0.50 USDC payable with no purchase order: the agent holds it and the
   channel shows it with its buttons. A second member connects with `/vestiarion connect` and presses **Approve and
   pay**: `approval_paid` with `via: "slack"`, the transaction on Arc, the message rewritten.
5. Record the entries and the transaction here.
