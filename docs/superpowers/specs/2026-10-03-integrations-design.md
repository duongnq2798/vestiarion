# Integrations: where Vestiarion meets the tools a business already uses

Date: 2026-10-03. Status: review done; Phase 0 implemented on `feat/integrations`; Phase 1 designed, not started.
Decided under the standing autonomy grant.

## 1. The question

Which platforms Vestiarion should connect to, in what order, and whether its architecture can take them without a
second copy of its rules. The candidates: Slack, Microsoft Teams, Lark/Feishu, QuickBooks Online, Xero, NetSuite, SAP,
Workday, Microsoft Dynamics 365, email and Outlook, and anything that fits better.

Not only notices. Where it is safe, a person should be able to approve or reject a payment, approve and pay, see why
the agent decided, see a counterparty's screening, ask about the treasury, start a cycle, see what is payable, get
alerts, open the evidence, and see whether a payment settled, from the tool they already use.

The constraints: do not over-engineer; ship what can ship early and show real use; reuse what exists; no business logic
per integration; every action keeps going through the same policy, risk and audit controls; every action from an
integration lands in the signed ledger with who acted and from where.

## 2. What exists today

Read from the code on `main` at `3d5eac0`.

| Surface | Entry point | How the caller is authenticated | What it acts through |
|---|---|---|---|
| Console | server actions in `src/app/actions/` | Supabase session, then `authorize(slug, permission)` (`src/lib/auth/authorize.ts`) | domain functions in `src/lib/`, inside `inOrg` |
| Telegram bot | `POST /api/telegram`, then `handleUpdate` (`src/lib/telegram/updates.ts`) | Telegram's secret header; the chat's `telegram_links` row; the member's role read again on every update | `withOrg` and the shared `createInvoice`; it never approves (Telegram bot design R11) |
| Read API | `/api/v1`, nine `GET`s | a workspace API key with the `read` scope (`src/lib/api/guard.ts`) | read models inside `withOrg(key.orgId)` |
| Write API | `POST /api/v1/counterparties` and `POST /api/v1/invoices`, in progress on `feat/write-api` (migration 0066) | a key with the `write` scope, acting for the person who issued it; `Idempotency-Key` | `createInvoice` and a shared `createCounterparty`. It never moves money, and an address it sets waits for a person |
| MCP | `/api/mcp` | the same keys | tools generated from the API's operations, called in process |
| Webhooks | `ledger.appended`, HMAC-signed (`src/lib/webhooks/`) | outbound | every ledger entry |
| Email | the digest of waiting payables, payee notices, client reminders (Resend) | outbound | none |
| Cycles | the cron tick, the console's Run cycle, events (`runCycleSoon`, `src/lib/agent/cycle-soon.ts`) | the platform token, or a session | the orchestrator |

There is no product CLI. The npm scripts (`cycle`, `numbers`, `org:*`, `telegram:setup`) are operator tools. A
TypeScript SDK over the OpenAPI document is the planned second half of the write API; a CLI would sit on that SDK.

## 3. Review

### 3.1 What is ready

- **The domain does not know who is calling.** The decisions a person makes are functions that take `{ actorId, … }`
  and run inside a workspace's scope: `approveAndPay`, `rejectInvoice`, `returnInvoice` and `addInvoiceDetails`
  (`src/lib/agent/approvals.ts`), `payHeldMilestone` and `closeMilestone` (`src/lib/agent/milestone-decisions.ts`),
  `pauseAgent` and `resumeAgent` (`src/lib/platform/pause.ts`), `runAgentCycle`, and `createInvoice`
  (`src/lib/invoices/create.ts`). None of them reads a session, a form or a request.
- **Money leaves by one path.** A person's Approve and pay calls `payInvoice`, the same function the agent's AP stage
  calls. The claim (`claim_invoice_decision`, migration 0025) makes a decision exclusive and refuses self-approval. The
  payment intent's idempotency key keeps a transfer from being sent twice. A high-risk counterparty, an address that
  changed after the card was shown, and a short balance are refused before the claim. A new surface that calls these
  functions gets all of this without writing any of it.
- **Tenancy holds from any entry point**: `withOrg`, the Data Access Layer's `org_id` filter, row-level security as
  `vestiarion_tenant`, and composite foreign keys. The Telegram bot proved that an entry point without a session can
  use it.
- **The audit trail is signed per workspace** (Ed25519, hash-chained), and every entry reaches the workspace's
  webhooks.
- **There are precedents to copy.**
  - Telegram: one-time link codes stored as hashes; a webhook closed without the platform's secret; the role read again
    on every update; answers written by code; a decisions stage with a cursor; private chats only.
  - API keys: scopes, and only a hash stored.
  - Webhooks: HMAC with a timestamp, and delivery pinned to checked public addresses.
  - Per-workspace secrets under the master key, each bound to its organization and column (`src/lib/secrets.ts`).
  - Event-driven cycles, and one activity reader (`readAgentActivity`) shared by the console's toasts and the bot.

### 3.2 What is not ready

- **G1. The gate is written once per surface.** The console asks `authorize` (a session), the API asks
  `guardApiRequest` (a key), and the bot calls `can(role, …)` inline. A fourth surface would write a fourth gate.
- **G2. What follows an action lives in the surface.** The console's actions raise the cycle event
  (`raiseCycleEvent`) and send payee notices (`sendNoticesSoon`). The bot raises `invoice_added` itself in `addDraft`.
  An approval from a new surface would forget the payee notice unless it copied the console's action.
- **G3. Provenance is ad hoc.** `create_invoice` carries `via: "telegram"`, while `approval_paid`,
  `approval_rejected`, `approval_returned`, `milestone_approval_paid` and `agent_paused` carry `by` and nothing about
  where. An approval from a chat would read in the signed ledger exactly like one from the console.
- **G4. Nothing says what a surface may do.** "The bot never approves" holds because the bot has no such code. There
  is no table a reviewer can read, and nothing bounds an amount by surface.
- **G5. Some writes still live in server actions**: adding and verifying a milestone, and the CSV import. Adding a
  counterparty moves out on `feat/write-api`.
- **G6. Notifications are a Telegram stage.** A second chat platform would copy it.
- **G7. There is no store for a third party's connection**: an OAuth token and its refresh, per workspace. Slack's
  bot token, and Xero's and QuickBooks' tokens, all need one.
- **G8. Slack and Lark want an answer within 3 seconds, Teams within about 5**, and Approve and pay can wait tens of
  seconds for Circle. These need to answer first and work after (`after()`), then update the message.

### 3.3 Can one action serve the console, a CLI, Slack, Teams, Lark and the API without a copy of its logic?

The domain can (3.1). The layer above it cannot yet (G1 to G4): each surface would write its own gate, its own
follow-ups and its own provenance. Phase 0 adds that layer, and keeps it thin.

## 4. Three kinds of integration

| | Chat and control (Slack, Teams, Lark, Telegram) | Accounting (Xero, QuickBooks Online) | ERP (NetSuite, SAP, Workday, Dynamics 365) |
|---|---|---|---|
| What moves | a person's decisions in, the agent's decisions out | records: bills and contacts in, payments back | the same records at scale, inside the customer's own approval chains |
| Who acts | a member, whose chat account is linked to them | the workspace, through an OAuth connection | the company: SSO, provisioning, service accounts |
| Shape | events; seconds; small payloads | sync: idempotent upserts, external ids, conflicts, a sweeper | sync, plus configuration per customer, sandboxes, partner programmes |
| What can go wrong | someone else presses the button; a chat account is stolen | the books go wrong; a token can write to the record of truth | all of that, plus procurement: SOC 2, SSO/SAML, SCIM, a DPA |
| What Vestiarion needs | commands (Phase 0), links, signed action tokens, a notifier | a connection store, mappings, external ids, writing the tx hash back | everything accounting needs, plus enterprise identity and certification |
| Value now | high: decisions are made where the team already works | medium: real AP lives there, but only for customers already on it | low now; it is the later path to enterprise |

## 5. The platforms

| Platform | What a user does with it | Effort | Depends on | Security and compliance | Adoption | Vestiarion needs |
|---|---|---|---|---|---|---|
| **Slack** | sees the agent's decisions in a channel; decides a held payable; pauses the agent; asks what is safe to spend, what waits, whether the ledger verifies | medium (2–3 days) | a Slack app created from a manifest, three environment variables; public distribution works without the Marketplace, whose review comes later | Slack signs every request (HMAC with a timestamp). The scopes are only `commands` and `incoming-webhook`. Slack's 2025 limits on apps outside the Marketplace apply to reading history, which this never does | high in startups, agencies, crypto and fintech; once one team member installs it, the whole team sees the agent work | Phase 0 commands; links; signed action tokens; a notifier; a limit on decisions from Slack |
| **Microsoft Teams** | the same, in Microsoft shops | large (4–6 days, then a store review) | an Azure Bot: single-tenant, since creating multi-tenant bots ended on 31 July 2025, so serving other companies means publishing to the Teams Store, or each customer registering the bot; a Teams app package | a Bot Framework JWT on every activity (issuer, audience, `serviceUrl`); Entra identity; an invoke must be answered within about 5 s | low among crypto teams, high in enterprise | what Slack needs, plus JWT checks and stored conversation references |
| **Lark/Feishu** | the same, for teams on Lark | medium to large | a Lark (international) or Feishu (China) app; the two are separate platforms | card callbacks are checked with a verification token only, not a signature, so Vestiarion's own signed action tokens matter more; a 3 s answer | led by demand: China and parts of APAC | what Slack needs |
| **Telegram** (exists) | decisions out, questions, invoices in | done | none | approvals stay out (R11): a Telegram account is not one the company manages | crypto teams and freelancers | moves onto commands in Phase 0 |
| **Email in** (forwarding) | forwards an invoice, or the email carrying it, to the workspace's own address; a member adds the draft | small to medium (1–2 days) | inbound mail (Resend inbound or similar), an MX record, a webhook secret | a sender can be spoofed, so a forwarded invoice is only a draft and is never added or paid without a person; a secret address per workspace; a signed webhook | high: works with Outlook and Gmail, nothing to install | the invoice reader (exists), drafts, commands |
| **Outlook or Gmail API** | reads the AP mailbox | large | Microsoft Graph or Google app review, admin consent | mailbox-wide scopes are a large thing to ask for | low over forwarding | none: forwarding covers it |
| **Xero** | approved bills come in as payables; a payment goes back with its tx hash; contacts sync | large (5–8 days) | a Xero app. Tiers since 2 March 2026: Starter is free with 5 connections, Core is AUD 35 a month with 50. Certification to be listed in the Xero App Store | OAuth 2 with rotating refresh tokens, stored encrypted; HMAC-signed webhooks | medium; strong in the UK, Australia, New Zealand and Singapore, and with accountants who already handle crypto | a connection store, mappings, external ids, a sync sweeper |
| **QuickBooks Online** | the same; US-heavy | large | an Intuit app. Production keys need the app assessment (a security questionnaire that covers token storage). App Partner Program: writes are free, reads are metered (Builder: 500,000 credits a month, then blocked) | as Xero; `intuit-signature` webhooks | medium to high in the US | as Xero |
| **NetSuite** | AP sync for the mid-market | very large | SuiteTalk REST or SuiteScript, token-based auth, a sandbox account, the SDN programme for a SuiteApp | the customer's security review; SOC 2 | only with a paying customer | the enterprise prerequisites first |
| **SAP S/4HANA** | AP and payment runs | very large | OData or BTP, SAP Store certification, access to the customer's system | as NetSuite | long sales cycles | not before an enterprise contract |
| **Workday Financials** | supplier invoices | very large | a closed partner programme; integrations the customer builds (EIB, Studio) | as NetSuite | rarely self-serve | not before an enterprise contract |
| **Dynamics 365** (Finance, Business Central) | vendor payments | very large (Finance), large (Business Central) | Dataverse or OData, an Entra app, AppSource for Business Central | as NetSuite | after Teams, if ever | none now |
| **Zapier, Make, n8n** | "a new bill somewhere becomes a payable", "a confirmed payment adds a row somewhere" | small to medium, after the write API | the write API; an endpoint to subscribe and unsubscribe webhooks, for instant triggers. A private Zapier app needs no review | the same keys and scopes | medium, self-serve | the write API and webhook subscription endpoints |
| **GitHub** (exists, to verify milestones) | a merged PR is paid, and the payment is commented on the PR | small | a GitHub App (today a token reads PRs) | permissions per repository | medium among developers: every contributor sees the payment | later |

## 6. What a person can do, and from where

| Action | Console | API, MCP | Telegram | Slack (Phase 1) | Teams, Lark (Phase 2) | Email in (Phase 1b) | Accounting (Phase 3) |
|---|---|---|---|---|---|---|---|
| Reject or return a held payable | yes | no | no (R11) | yes, when the workspace allows decisions from Slack | as Slack | no | no |
| Approve and pay | yes | no: approvals stay a person's | no (R11) | yes: USDC on Arc, up to the workspace's limit, to a confirmed address | as Slack | no | no |
| See why the agent decided | yes, with the trail | the ledger | in each decision | in the card, with a link to the trail | yes | none | none |
| Screening (risk, sanctions) | yes | the counterparty | in the reasons | the risk level and the rule in the card; details in the console | yes | none | none |
| Treasury status | yes | yes | `/today` | `/vestiarion today` | yes | none | none |
| Start a cycle | yes | no | no: events start one | no: events start one | no | none | none |
| See what is payable | yes | yes | `/waiting` | `/vestiarion waiting` | yes | none | bills sync in |
| Alerts | toasts, the email digest | webhooks | yes | the channel feed | yes | none | none |
| Evidence | Audit, export, receipts | the ledger, verify | `/ledger` | `/vestiarion ledger`, receipt links | yes | none | the tx hash is written back |
| Whether a payment settled | yes | yes | in the decisions | the card is updated when Circle confirms | yes | none | the payment is written back |
| Add a payable | yes | yes (write API) | yes, from a document | later | later | a draft a member adds | bills sync in |
| Pause the agent | yes | no | no | yes: anyone who may approve | as Slack | none | none |

Never from a chat: confirming a changed address, resuming the agent, changing a limit, connecting Circle, rotating
the ledger key, managing members. Each of these changes who can be paid, or how much the agent may move.

## 7. Security model for an action from a chat

1. **The platform is authenticated.** Slack: `X-Slack-Signature` is `v0=` and the HMAC-SHA256 of
   `v0:{timestamp}:{raw body}` under the signing secret, compared in constant time, refused when the timestamp is more
   than 300 s from now. Teams: the Bot Framework JWT (RS256, issuer `https://api.botframework.com`, audience the app
   id, the `serviceUrl` claim matched). Lark: the verification token, since card callbacks are not signed. Telegram:
   the secret header (exists). Email: the inbound webhook's signature.
2. **The chat account is mapped to one member**, by a flow that proves both sides: the platform signs which account
   asked, and a Vestiarion session confirms who the member is. Slack: `/vestiarion connect` answers with a one-time
   link; the member signs in to Vestiarion and confirms the Slack account shown. One link per membership, one per chat
   account. A link goes with its membership (a cascading foreign key) and with the install.
3. **RBAC is the same map.** The permission map (`src/lib/auth/roles.ts`) is read again from `memberships` at every
   action and never cached on the link. Then the surface policy (`src/lib/commands/policy.ts`) says which commands a
   surface may run. Then, for money, the workspace's own limit: decisions from Slack are off until an owner sets a USDC
   limit. Approve and pay above it, in EURC, across chains, or to an address that changed and is not confirmed yet,
   answers "open it in Vestiarion".
4. **Replay protection.** The platform's timestamp window; action tokens that expire after 7 days and name one
   invoice in one workspace; and the claim, which lets a waiting payable be decided once.
5. **Idempotency.** The claim (a second Approve answers "already decided"); the payment intent's key (never a second
   transfer); events deduplicated by the platform's event id. Answering first and working after means a platform's
   retry finds the decision already claimed.
6. **Signed actions.** A button carries `vxa1.<payload>.<HMAC>`, keyed from the master key (HKDF, bound to its
   purpose), over `{ org, invoice, action, the address's hash, decided_at, expires }`. A changed field, another
   workspace, an expired token, or a payable decided again since the card was posted is refused before any claim. The
   decision itself is then a signed ledger entry.
7. **Audit.** A decision from a chat is the same ledger entry as from the console, plus `via` and `linkId`, signed
   with the workspace's key. Installing, linking, disconnecting and changing the limit are entries of their own. Ids
   only: no chat handle in clear, no email, no full wallet address.
8. **Little leaves for the chat.** Messages carry names, amounts, reasons and links. A wallet address is shortened to
   its first and last four characters. No email, and nothing of a screening beyond its level and rule.
9. **Kill switches.** An owner removes the install from Settings, which revokes the token. Anyone who may approve can
   pause the agent from Slack. Removing a member removes their link.

## 8. Proposed architecture

```
 Console      Telegram      Slack (P1)     Teams, Lark (P2)    API, MCP     Email in (P1b)    Xero, QBO (P3)
 server       webhook       4 routes       routes              v1 routes    inbound route     sync sweeper
 actions
    │            │             │                │                  │             │                 │
    └──── adapter: verify the platform, parse, resolve the Actor, render the outcome ──────────────┘
                                          │
                  src/lib/commands: gate (scope, permission, surface policy)
                                          │ → domain function, unchanged, with provenance
                                          │ → follow-ups (cycle event, payee notices)
                                          ▼
        src/lib/agent, src/lib/platform, src/lib/invoices … (one money path, claims, guardrails)
                                          │
                  Postgres with RLS · the signed ledger · Circle on Arc
                                          │
      ledger → readAgentActivity → notifiers (Telegram stage, Slack stage, email) · webhooks
```

- **An Actor** is a member acting through a surface: `{ orgId, userId, role, mode, surface }`, where `surface` is
  `{ kind: "console" }`, `{ kind: "telegram", linkId }`, `{ kind: "slack", linkId }` or `{ kind: "api", apiKeyId }`.
  `consoleActor(auth)` builds one from a successful `authorize`; `memberActor(orgId, userId, surface)` reads the role
  and the workspace's mode afresh. An API key's actor is the person who issued it (write API R4).
- **A command** is one exported function per action, `(actor, input) → CommandOutcome`, whose first statement is
  `gate(actor, "<command>")`. The outcome is `{ ok: true, message, … }` or `{ ok: false, code, message }`, with the
  messages the console shows today. The domain's errors (`ApprovalError`, `MilestoneDecisionError`, `PauseError`, the
  cycle's errors) are turned into outcomes in one place.
- **Provenance**: `provenanceOf(actor)` is `{}` for the console (its history has no `via`, and it stays so),
  `{ via: "telegram", linkId }`, `{ via: "slack", linkId }`, or `{ via: "api", apiKeyId }`. The domain functions take
  it as an optional field and spread it into their entry's `detail`.
- **A provider's folder** (`src/lib/telegram/`, then `src/lib/slack/`) holds only its transport: verifying requests,
  parsing, links, rendering, and its notifier.

## 9. Phases

### Phase 0: commands (this branch)

- **Goal.** The console and the bot act through one layer, so a new surface adds an adapter, not a gate. Nothing a
  person or an integrator can see changes.
- **Build.**
  - `src/lib/commands/`: `actor.ts` (Actor, `consoleActor`, `memberActor`, `provenanceOf`, `accessOf`), `policy.ts`
    (the command list, each command's permission, what each surface may run, `gate`), `outcome.ts`, `payables.ts`,
    `milestones.ts`, `agent.ts`, `invoices.ts`, `index.ts`.
  - An optional `provenance` argument on `approveAndPay`, `rejectInvoice`, `returnInvoice`, `addInvoiceDetails`,
    `payHeldMilestone`, `closeMilestone`, `pauseAgent` and `resumeAgent`, spread into their entry's `detail`.
  - The console's actions for approvals (`approvals.ts`), Pay now and Close (`milestones.ts`), and Run, Pause and
    Resume (`agent.ts`) call commands. The bot's **Add** calls `addInvoice`, and its role checks use `memberActor`.
- **Schema, API, webhooks**: none. The events (`invoice_added`, `payable_returned`, `details_added`, `agent_resumed`)
  and the payee notices are raised by the commands now, not by the actions.
- **Authentication**: the console is unchanged (`authorize` first, then the command's own gate, as defence in depth).
  The bot builds its actor with `memberActor` for every update.
- **Testing**: each command refuses a role without its permission, and a surface it is not open to, without calling
  the domain; passes provenance; raises its follow-ups; turns each domain error into its message. A structural test
  holds every exported command to calling `gate` first. The existing tests of the console's actions and the bot pass
  unchanged.
- **Migration strategy**: none. The invoice form, the CSV import and milestone intake move onto commands after
  `feat/write-api` merges, since it changes the same files; so does the write API's `POST /api/v1/invoices`, with
  `surface: { kind: "api", apiKeyId }`.
- **Accepted when** `npm run verify` is green, and in testnet-2 the console's Approve and pay, Reject, Return, Add
  details, Pay now, Close, Run cycle, Pause and Resume, and the bot's Add, behave exactly as before.

### Phase 1: Slack, the first new integration

- **Goal.** A team installs Vestiarion in Slack, sees the agent's decisions in a channel, asks the three questions,
  pauses the agent, and, if an owner allows it, decides a held payable without opening the console.
- **Setup by the platform's operator, once.** Create the Slack app from `integrations/slack/manifest.json` ("From an
  app manifest"), turn on public distribution, and set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and
  `SLACK_SIGNING_SECRET`. With any of them missing, the feature is off: the routes answer 404 and Settings shows
  nothing.
- **Manifest.** Bot scopes `commands` and `incoming-webhook`, nothing else: Vestiarion posts to the channel the
  installer picks, answers its own slash command, and updates a message through the `response_url` Slack gives each
  click (5 uses within 30 minutes). Slash command `/vestiarion`. Interactivity, and events `app_uninstalled` and
  `tokens_revoked`.
- **Build.**
  - `src/lib/slack/settings.ts`, `verify.ts` (signature, 300 s window), `oauth.ts` (state signed with HMAC and bound
    to a cookie and the session's user), `installs.ts`, `links.ts`, `action-token.ts` (`vxa1`, HKDF from the master
    key, 7 days), `blocks.ts` (Block Kit: decisions, the held card, `/vestiarion` answers), `commands.ts` (the slash
    command), `interactions.ts` (clicks), `notify.ts` (the cycle's `slack` stage).
  - Routes: `GET /api/slack/oauth` (the install's callback), `POST /api/slack/commands`, `POST /api/slack/interactions`,
    `POST /api/slack/events`.
  - Settings, **Slack** card: Add to Slack (`integrations.manage`: owner, admin), the channel, Remove, and "Allow
    decisions from Slack up to [ ] USDC" (owner only, `org.administer`; empty means off).
  - `/integrations/slack/connect?t=…`: signed in, shows the Slack account and team, and Connect; a server action
    gated on `workspace.read`.
  - Commands opened to the Slack surface: `payable.approve`, `payable.reject` and `payable.return` (when decisions
    are on), and `agent.pause`. The three questions are read models any connected member may ask.
- **Schema (migration 0067).**
  - `slack_installs`: `org_id` (unique, cascading with the org), `team_id` (unique: one Slack workspace serves one
    Vestiarion workspace in this version), `team_name`, `enterprise_id`, `app_id`, `bot_user_id`, `bot_token_enc` and
    `webhook_url_enc` (envelopes under the master key, bound to the org and column), `channel_id`, `channel_name`,
    `installed_by`, `installed_at`, `notified_seq`, `decisions_limit_usdc` (null means off).
  - `slack_links`: `org_id`, `user_id` (a composite foreign key to `memberships`, cascading), `team_id`,
    `slack_user_id`, `linked_at`; unique `(org_id, user_id)` and `(team_id, slack_user_id)`.
  - `slack_link_requests`: `team_id`, `slack_user_id`, `code_hash` (unique), `expires_at` (10 minutes), `used_at`.
  - Row-level security on all three, no policy, and no grant to `anon`, `authenticated` or the tenant role: only the
    service role, as for Telegram's tables.
- **Flows.**
  - Install: Add to Slack → Slack → `GET /api/slack/oauth` checks the state, the cookie and the session's user
    against the workspace again, exchanges the code (`oauth.v2.access`), stores the install, links the installer, and
    records `slack_installed`. A Slack workspace already serving another Vestiarion workspace is refused.
  - Connect: `/vestiarion connect` answers privately with a one-time link; the member signs in, sees the Slack account
    and team, and connects (`slack_member_connected`).
  - Decisions: a cycle's last stage, `slack`, reads the agent's decisions after the install's cursor with
    `readAgentActivity` and posts one message to the channel's webhook; the cursor moves only when Slack answers `ok`.
    A held, flagged or awaiting-information payable gets Approve and pay, Reject, Return to the agent, and Open in
    Vestiarion when decisions are on, and only Open in Vestiarion when they are off.
  - A click: `POST /api/slack/interactions` checks the signature, answers 200 at once, and in `after()`: finds the
    install by team, the link by Slack user, builds the actor with `memberActor`, checks the action token, runs the
    command in the workspace's scope, and rewrites the message through `response_url` ("Approved and paid by @…", the
    tx link). A refusal is said only to the person who clicked.
  - Approve and pay from Slack adds to the console's checks: decisions on; USDC; paid on Arc; an amount within the
    limit; the counterparty's address confirmed (a chat never confirms an address change) and equal to the one the
    card was posted with. Then `approveAndPay` with the address the card showed, `via: "slack"` and `linkId`.
  - Uninstall: `app_uninstalled` or `tokens_revoked`, or Remove in Settings (which also calls `auth.revoke`), deletes
    the install and its links and records `slack_uninstalled`.
- **Ledger.** New actions `slack_installed`, `slack_uninstalled`, `slack_member_connected`,
  `slack_member_disconnected`, `slack_decisions_limit_changed`. `approval_paid`, `approval_rejected`,
  `approval_returned` and `agent_paused` gain `via: "slack"` and `linkId` when decided from Slack. A new journal stage,
  `slack`, after `telegram`. All of it goes in the changelog.
- **Testing.** Signatures (valid, wrong secret, a stale timestamp, a changed body); the URL check; the OAuth state
  (bad signature, another user, expired, no cookie); one install per Slack workspace; a connect code works once, for
  10 minutes, for the install's team; action tokens (changed, expired, another workspace); each refusal (not
  connected, viewer, decisions off, over the limit, EURC, another chain, unconfirmed address, changed address, already
  decided, self-approval); the stage moves its cursor only on `ok` and shows buttons only when decisions are on; the
  migration (RLS, no grants, cascades, a second run); the access gates of the new server actions.
- **Migration strategy.** 0067 is additive. The partner applies it before the merge; with the variables unset nothing
  is exposed.
- **Accepted when**, in testnet-2, a held payable is approved from Slack and paid, its `approval_paid` entry carries
  `via: "slack"`, the card shows the transaction, and a payable over the limit answers "open it in Vestiarion".

### Phase 1b: invoices by email

- **Goal.** Any business forwards an invoice from Outlook, Gmail or anything else, and a member adds it.
- **Build.** A per-workspace address `<slug>-<8 random characters>@in.vestiarion.xyz`, shown on AP / AR and
  replaceable by an owner or admin. `POST /api/email/inbound` checks the provider's signature, finds the workspace by
  the address, reads a PDF attachment or the body with `readInvoiceDraft`, and keeps a draft for 7 days. The draft
  appears on AP / AR, and in a connected Telegram chat or Slack channel, with Add. Add runs `addInvoice` with
  `via: "email"`.
- **Schema (migration 0068).** `inbound_addresses` (`org_id` unique, `local_hash`, `created_by`, `created_at`);
  `invoice_drafts` (`org_id`, `source`, `sender` with most of it hidden, `subject`, `draft`, `document`, `expires_at`,
  `used_at`, `used_by`). Telegram's drafts can move into it in Phase 2.
- **Security.** Nothing is added or paid without a person: a spoofed sender makes a draft, and the draft carries the
  invoice reader's address-change warning. Attachments are never stored, only their hash. Ten drafts a minute per
  workspace.
- **Accepted when** a forwarded PDF becomes a draft, a member adds it, and the agent pays it in testnet-2.

### Phase 2: a connector framework, then Teams or Lark when a customer asks

- **Goal.** A second chat platform costs an adapter, nothing more.
- **Build.** `src/lib/chat/`: a `ChatProvider` interface (`verify`, `parseAction`, `render`, `post`, `update`); one
  `chat` stage over every provider, replacing the `telegram` and `slack` stages (the journal keeps the old names
  readable); `chat_installs` and `chat_links` with a `provider` column, Telegram's and Slack's rows copied into them in
  the same migration.
- **Teams**: an Azure Bot registration in Vestiarion's tenant; the Teams app package; publishing to the Teams Store
  for other companies; JWT checks; Adaptive Cards with `Action.Execute`; conversation references stored for
  proactive messages.
- **Lark**: a Lark app; the verification token and the encryption key; interactive cards; the separate Feishu
  endpoints for China.
- **Accepted when** the second provider ships with no change under `src/lib/commands/` or in the domain.

### Phase 3: accounting, Xero first, then QuickBooks Online

- **Goal.** The customer's books show what Vestiarion paid, without retyping.
- **Why Xero first**: a free tier for the first five connections; a clean bills and payments API; signed webhooks;
  strong where crypto-friendly accountants are. QuickBooks next, for the US: its production keys need Intuit's app
  assessment, which takes weeks.
- **Build.** `accounting_connections` (`org_id`, `provider`, `tenant_id`, `access_token_enc`, `refresh_token_enc`,
  `expires_at`, `scopes`, `connected_by`, `status`, `last_synced_at`) and `external_refs` (`org_id`, `provider`,
  `object_type`, `local_id`, `external_id`, `external_version`, unique per provider and external id). A sync that
  pulls approved bills (Xero `ACCPAY` invoices that are `AUTHORISED`; QuickBooks `Bill`s with a balance) into payables
  as the person who connected (`via: "xero"`), matched to counterparties by external id; a counterparty with no
  address gets a payee link. When a payable is paid on Arc, a payment is written back against the bill from a "USDC
  on Arc" account the customer maps, with the tx hash as its reference. Xero's and Intuit's webhooks, plus a sweeper
  every 15 minutes.
- **Rules.** USDC is booked as USD, and EURC as EUR. The network fee is a bank fee. Vestiarion never edits or deletes a
  bill. The bill's own approval in the accounting tool counts as its purchase order, never as Vestiarion's approval:
  the agent and its guardrails still decide.
- **Accepted when** a Xero bill becomes a payable, the agent pays it, and the bill shows the payment and the tx hash.

### Phase 4: enterprise and ERP

- **Goal.** Pass an enterprise's review before writing any ERP connector.
- **Build first**: SAML SSO and SCIM provisioning; approval chains (more than one approver above an amount); a key
  service for ledger keys and Circle secrets; rate limits per key; SOC 2 Type I, then Type II.
- **Then**: integrate through the API, the webhooks, the ledger export and an iPaaS (Workato, Boomi, MuleSoft). Write
  a NetSuite SuiteApp, an SAP BTP flow or a Dynamics 365 connector only for a customer who pays for it.

## 10. Order, and what not to build

**Order.** Phase 0 now. Slack next: it reaches crypto and fintech teams, turns the commonest stop seen with real
users (a held payment waiting for someone to open the console) into one tap, and is the pattern Teams and Lark
reuse. Then email in, which every business can use with nothing to install. Then Zapier on the write API. Then Xero,
then QuickBooks. Teams or Lark only when a customer asks. ERP only behind a contract.

**Not now.**
- Teams and Lark before a customer asks: Teams needs a store listing to serve other companies; Lark is a regional
  bet.
- Any ERP connector: NetSuite, SAP, Workday, Dynamics 365.
- The Outlook or Gmail APIs: forwarding covers them.
- Approvals in Telegram (R11 stands) or by a link in an email (dropped before: a forwarded link would move money).
- A plugin marketplace, a workflow builder, a two-way sync engine.
- A Slack Marketplace listing until installs justify its review.
- Discord, WhatsApp or Zalo bots.
- A CLI before the SDK.

## 11. Rulings

- **R1. Commands, not a framework.** One function per action and one gate. No registry of strings, no plugins. A
  table in `policy.ts` names each command's permission and which surfaces may run it, so a reviewer reads one file.
- **R2. The command enters no scope.** The surface enters the workspace's scope (`inOrg`, `withOrg`); `gate` checks
  that the scope in force is the actor's workspace and throws when it is not. An actor of one workspace can never run
  in another's scope, and the console does not read its organization twice.
- **R3. The console's history stays as it is.** `provenanceOf` gives the console nothing, so its entries look exactly
  as they do today, and the absence of `via` keeps meaning the console. Every other surface names itself.
- **R4. What a surface may run.** Console: everything. Telegram: adding an invoice (R11 of its design stands). API:
  adding an invoice (and a counterparty, with the write API). Slack: nothing in Phase 0; Phase 1 opens decisions,
  under its own limit, and Pause.
- **R5. Follow-ups belong to the command.** The cycle event and the payee notices are raised by the command, so every
  surface gets them. Refreshing the console's cached pages stays in the console's action.
- **R6. The gate refuses with a code.** `forbidden` (the role), `surface` (the surface), with the console's wording
  for the role. A domain refusal keeps its own code (`self_approval`, `already_decided`, …), so a chat can say it in
  its own words.
- **R7. Nothing moves that is not read from the database again.** A member's role and the workspace's mode are read
  for each action, never carried in a token, a link or a button.

## 12. Phase 0 rollout

1. Merge on green with the partner's word. No migration, no variable.
2. In testnet-2: Approve and pay a held payable, Reject one, Return one, Add details to one; Pay now and Close on
   held milestones; Run cycle, Pause, Resume; send the bot a PDF and tap Add. Each behaves as before, and the ledger
   entries look as before.
3. Record the entries here.
