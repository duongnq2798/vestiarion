# Vestiarion architecture

Vestiarion is a Next.js 16 App Router application backed by Supabase. Server
components and route handlers reach tenant data only through the Data Access
Layer (`src/lib/dal`): `db()` scopes every query to the organization in scope,
and ESLint forbids importing the raw service-role client anywhere outside it.
Circle provides Arc testnet payment execution, while simulation modes remain
available for screening and reserve operations.

## Isolation: two lines

No request for one organization reads or changes another's records, by two
independent mechanisms (spec §5.6). The answers that do cross organizations are
aggregates or the team's own: /open's counts and USDC totals and the team's own
payments, the landing's latest team decisions, and payee history over x402,
which carries no amount.

**Line 1 — the Data Access Layer.** `db()` adds `.eq('org_id', ...)` to every
query and sets `org_id` on every insert; `no-restricted-imports` forbids
importing the raw Supabase client outside `src/lib/dal/`.

**Line 2 — row-level security as a dedicated role.** Tenant requests run as
the Postgres role `vestiarion_tenant`, never as `authenticated` — the role a
signed-in browser session carries keeps no table or RPC privileges at all
(as since migration `0003`), so a mistaken policy can never expose rows to
it. `mintRequestToken` (`src/lib/dal/request-token.ts`) signs a fresh HS256
token per request with `SUPABASE_JWT_SECRET`, naming the role, the
organization (`org_id`), and the caller (`sub`: the signed-in user, or
`system` for the cron and scripts), with a 5-minute expiry. `tenantClient`
(`src/lib/dal/tenant-client.ts`) hands that token to supabase-js through the
`accessToken` option — a fresh mint per call, so a long cycle never outlives
its token, and there is no fallback to the service role. `db()` uses this
client; `platformDb()` keeps the service role for platform operations
(creating organizations, migrations, the commands in `npm run org:*`).

On the database side, migration `0018` enables row level security on every
tenant table and adds a permissive `tenant_isolation` policy plus a
restrictive `tenant_isolation_guard`, both testing
`org_id = request_org_id()` — a function reading the claim out of
`request.jwt.claims`, because a custom role cannot use Supabase's `auth`
schema. `ledger_entries` and `cycle_snapshots` grant only `select, insert` to
the tenant role, so the audit trail and its snapshots are append-only even
for a compromised or buggy request. Since `0077` a trigger, `ledger_entries_linked`,
checks every insert by the tenant role against the chain: under the
workspace's ledger lock it refuses a row whose previous hash is not the last
entry's, or whose hash is not the chain step, and stamps the time. So no
request can put an entry in the ledger that no chain step links, whether it
calls `append_ledger_entry` or not
(`docs/superpowers/specs/2026-10-05-payment-integrity-design.md` I3). `anon` and `authenticated` keep no
privileges, as since `0003`. Row-level security does not constrain
foreign-key checks, so migration `0019` makes every tenant-to-tenant foreign
key composite (`org_id, ...`) and widens `cycle_snapshots`'s unique key to
`(org_id, cycle_run_id)`, so the database itself refuses a link into another
organization's row.

The public `/security` page (`src/app/security/page.tsx`) sets these lines out
for security reviewers, with encryption, approvals, connector tokens, webhook
signing, the ledger, retention and the subprocessors, and says what is not
claimed. `tests/security-page.test.tsx` reads the figures it quotes from the
code, and holds its subprocessors (`src/lib/subprocessors.ts`) to the privacy
page's services, name for name. `SECURITY.md` is the policy for reporting a
vulnerability.

## Where it runs

The app is one Next.js deployment on Vercel. Its functions run in Vercel's Tokyo region, `hnd1`, which `vercel.json` sets
for the whole project, beside the Supabase project in `ap-northeast-1`. A page or an action makes its database calls one
after another, so the distance between the two counts once per call. From Vercel's default, `iad1`, each call crossed
the Pacific, and a payee's **Keep this address** took about 4.4 seconds
(`docs/superpowers/specs/2026-10-20-functions-beside-database-design.md`). The route-level `preferredRegion` is
deprecated in this Next.js version, so the setting is not per route. `tests/vercel-region.test.ts` pins it, and
`vercel.json` holds nothing else (no header: see the security page's test). The scheduled routes are called by Supabase
Cron from the database itself (`supabase/cron/watches.sql`), and GitHub's schedule calls only the sandbox cleanup, so
none is a Vercel cron. Calls to services in the US now leave from Tokyo: Circle (Wallets, Iris, Gateway), the Arc RPC,
the model providers, Resend, BlindPay, the accounting and CRM connectors, and customers' webhook endpoints. Their time
limits (the tick's start cutoff, Circle waits, the connector sweep's budget) are wall-clock, so a slower call means
less work in a run, never a run past its limit.

## Content Security Policy

`next.config.ts` sends `cspHeaders` on every response, with `Reporting-Endpoints`
(`docs/superpowers/specs/2026-10-21-csp-report-only-design.md`, `docs/superpowers/specs/2026-10-22-csp-enforce-design.md`).
A production build enforces the policy as `Content-Security-Policy`, but for `form-action`, sent beside it as
`Content-Security-Policy-Report-Only` (`REPORT_ONLY_DIRECTIVES`). Development, and a deployment with
`DOCS_SCREENSHOTS=1`, whose screenshot pages a local file frames, send all of it report-only.
- The policy is `contentSecurityPolicy` (`src/lib/security/csp.ts`). The config imports it, so it imports only the
  network profiles and the site's links, which import nothing; Iris's origins and Product Hunt's badge come from them.
- Scripts and styles may be inline, since Next.js inlines its own and a nonce would end static rendering.
- `connect-src` names Circle's Iris and modular wallets client, which the browser calls, Google Analytics, and the
  deployment's Supabase, where a vendor's browser puts the document a request asked for (document requests ER5).
- `img-src` names Product Hunt's badge in the site footer.
- `form-action` names every connect form's consent screen (each Zoho data center's), Google sign-in and the
  deployment's Supabase, since Chrome checks a form submission's redirects too.
- A Vercel preview also allows Vercel's toolbar.
- `tests/csp.test.ts` holds each origin to the code that reaches it, and fails on a connect route whose consent screen
  is not named.
- `POST /api/csp-report` logs each violation as one line, `csp report {"directive","blocked","page","disposition"}`: the blocked
  origin or keyword, bounded in length, and the page's first path segment, nothing else from the report. A browser
  extension's violations are dropped. It reads at most 64 KB of body, is rate-limited per client and per instance
  (`takeCspReportToken`, a dropped report still answered 204 so the browser does not resend it) and stores nothing.
- The extension sign-in page keeps its own enforced `frame-ancestors 'none'`.

## Workspaces, roles and the cron

A person creates their own workspace at `/onboarding` (`createWorkspaceAction` ->
`createWorkspace`, `src/lib/platform/workspace.ts`, spec §6). The server generates the
organization's id and a fresh Ed25519 ledger key before calling `create_org(p_org_id, p_user_id,
p_name, p_slug, p_ledger_key_enc, p_network)` (migrations `0020`, `0081`) — the key's ciphertext is
bound to the id, so the id has to exist first. `create_org` is `service_role`-only (`anon`,
`authenticated`, and `vestiarion_tenant` cannot call it); in one transaction, under an advisory lock
keyed to the caller so two concurrent requests cannot both slip past the limit, it enforces at most 3
organizations per `created_by` on each network, inserts the organization in `sandbox` mode on that
network, and makes the caller its `owner`. The limit bounds what one person can spend of the
platform's model calls; counted per network, three workspaces on Arc testnet never keep a person off
Arc mainnet. The five-argument `create_org` from `0020` stays as it was for code from before `0081`,
counting every network, since that code moves a new row to Arc mainnet after creating it on Arc
testnet; no other count would hold it. `createWorkspace` then seeds two accounts — `Operating (simulated)` at 10,000 USDC and
an empty `Reserve (simulated)` — and appends the first ledger entry, `org_created`, signed with the
new key; a failure at this stage is rolled back (accounts deleted, then the organization row) —
unless its first ledger entry already committed, in which case the chain, and the workspace, stay.
The form also offers shadow mode for an Arc testnet workspace (ticked from `/onboarding?shadow=1`, the landing's "Try it
on your bills"): once the workspace exists, the action turns it on as Settings does, `authorize(slug, "approval.policy")`
then `startShadowMode` in USDC with the creator as actor (`startShadowModeAtCreation`,
`src/lib/shadow-mode-at-creation.ts`). A refusal leaves the workspace created and sends the console
`?shadow=not-started`, where it says so until shadow mode is on. A client opening a workspace from an accountant's client
link goes through the same `createWorkspace`, always on Arc testnet and always in shadow mode, and `org_created` carries
`via: "accountant_link"`: see [The accountant console](#the-accountant-console).

`0020` also adds a trigger, `memberships_keep_an_owner`, that fires before every membership update
or delete: removing or demoting an organization's last `owner` raises rather than commits, checked
under a row lock on `orgs` so two concurrent demotions of different owners cannot both see one
owner remaining and leave zero — the same write-skew shape `create_org`'s advisory lock avoids on
the count side. Because memberships cascade from `auth.users`, deleting the account of a person who
is an organization's sole owner is refused. To delete them, first give that organization another
owner, or delete the organization. Any other account can be deleted, and deleting it keeps the
workspaces it created and the members it invited: migration `0023` gives every foreign key to
`auth.users` a delete action, so `orgs.created_by`, `memberships.invited_by`, `invoices.created_by`
and `milestones.created_by` become null, and the invitations the person sent are deleted with them.

**The permission map** (spec §7) lives as data in `src/lib/auth/roles.ts` — five roles, `owner`, `admin`, `approver`,
`accountant` (since `0112`, see [The accountant console](#the-accountant-console)) and `viewer`, and `PERMISSIONS` maps each
of `workspace.read`, `agent.pause`, `approval.decide`, `records.write`, `receivables.reconcile`, `accounting.book`, `agent.run_cycle`,
`agent.resume`, `members.manage`, `api_keys.manage`, `webhooks.manage`, `integrations.manage`, and `org.administer` to the roles that hold it
— and is enforced at the boundary through `authorize(slug, permission)` (`src/lib/auth/authorize.ts`),
which re-derives the caller's membership and role from the session rather than trusting anything the
form claims; a page can call the read-only `viewerCan` to decide whether to render a control at all.
Actions call it for `records.write` (`src/app/actions/intake.ts`, `src/app/actions/milestones.ts`),
`agent.run_cycle`, `agent.pause` and `agent.resume` (`src/app/actions/agent.ts`), `approval.decide`
(`src/app/actions/approvals.ts`), `members.manage` (`src/app/actions/members.ts`, for inviting,
changing a role, revoking an invitation, and removing someone other than yourself — `owner` and
`admin` hold it; leaving a workspace yourself needs only `workspace.read`, since it is open to every
member), `api_keys.manage` (`src/app/actions/api-keys.ts`, for creating and revoking a
workspace's own API keys — `owner` and `admin` hold it; every other member sees the list on
`/o/[slug]/settings` without the controls), and `webhooks.manage` (`src/app/actions/webhooks.ts`,
for adding, testing and removing a workspace's own webhook endpoints — `owner` and `admin` hold it;
every other member sees the endpoint list with each URL reduced to its host — see
[Webhooks security](https://www.vestiarion.xyz/docs/webhooks/security#who-sees-what)), and `integrations.manage` (`src/app/actions/slack.ts`,
`/api/slack/install`, `src/app/actions/github.ts` and `/api/github/install`, `src/app/actions/xero.ts` and
`/api/integrations/xero/*`, `src/app/actions/asana.ts` and `/api/integrations/asana/*`, and `src/app/actions/discord.ts`, for connecting and removing the workspace's Slack, GitHub, Xero, Asana and Discord — `owner` and `admin` hold it; the
limit on deciding payments from Slack takes `org.administer`, an owner's). The remaining permissions — `workspace.read` (beyond
the leaving case above) and `org.administer` — and `canAssignRole`'s rule that an admin may grant
`approver`, `accountant` or `viewer` but nothing at its own rank or above while only an owner assigns `admin` or
`owner`, are defined in `roles.ts` ahead of the feature that will call `org.administer`.

**Members and invitations** (spec §7, §10 step 5b) go through service-role-only functions in
migration `0021`, each told who is acting and re-deriving that person's role inside its own
transaction — `src/lib/platform/members.ts` wraps them, adds the signed ledger entry, and never
passes an email address into it (`detail.by` and `detail.member` carry user ids only). `owner` may
grant or change any role; `admin` may grant or change only `approver`, `accountant` and `viewer`; no one else may
do either — enforced identically by `can_assign_role` in the database and `canAssignRole` in
`roles.ts`. **Bring in a second person** (`docs/superpowers/specs/2026-10-19-invite-nudge-design.md`): Treasury shows
`InviteNudge` to whoever holds `members.manage` when `inviteNudgeShown` (`src/lib/invite-nudge.ts`) says the workspace
has one member, no open invitation, at least one real bill the agent decided, and no `vx_invite_later` cookie on the
workspace's path (Not now, 30 days). Its two forms post to `inviteMemberAction` with `via: "console_nudge"`; the weekly
brief of a one-person workspace links `/o/<slug>/members?invite=approver&via=weekly_brief`, and Members passes that
`via` on. `inviteMember` records a valid `via` on `member_invited`. Inviting (`invite_member`) generates 32 random bytes, base64url-encoded, for the link,
and stores only the `sha256` hex of that token (`invitations.token_hash`); the raw token never
reaches the database. An invitation expires 7 days after creation, and an organization holds at most
20 open invitations at a time. Inviting the same address again withdraws the older invitation, and
revoking one withdraws it too: a withdrawn invitation is kept as a row with `revoked_at` set, never
deleted, and its link reads as unknown. Every invitation created counts toward a limit of 50 per
organization per day, withdrawn ones included (`invitation_rate_limited`), which bounds the email a
workspace can send. With `RESEND_API_KEY` set, `sendEmail` (`src/lib/email/send.ts`)
sends the link through Resend; without it, `inviteMemberAction` returns the link to the inviter to
share directly, shown once. Opening `/invite/<token>` (`src/app/invite/[token]/page.tsx`) has no
side effect — it only previews the invitation; accepting is a separate submit (`accept_invitation`)
that requires signing in with the invited address first, and fails with `invitation_email_mismatch`
otherwise. Once accepted, the person lands on their role's first step (`firstStepHref`, see
[Onboarding by role](#onboarding-by-role)): an approver on Approvals, an accountant on `/accountant`, anyone else on the
console. The members page (`/o/[slug]/members`) lists members and open invitations through
`org_members`, and lets `owner`/`admin` change a role, revoke an invitation, or remove a member; any
member can leave. Both go through `remove_member_revoking_keys` (migration `0069`), which calls
`remove_member` (`p_actor = p_user_id` to leave) and, in the same transaction, revokes the API keys
the person created in the workspace, returning their ids so `removeMember` appends one
`api_key_revoked` per key after the member's own entry. Triggers from the same migration hold that
rule whatever ends a membership: deleting a membership row revokes its person's keys there, a key
whose `created_by` is cleared (its creator's account was deleted) is revoked in the same update, and
a key cannot be inserted for someone who is not a member of its workspace. The
`memberships_keep_an_owner` trigger (`0020`) still refuses to remove or demote a workspace's last
owner, so the last owner's keys stay with them.

**Abandoned sandboxes** are cleaned up daily. A sandbox organization's `last_active_at` is touched
(at most once an hour) on membership-gated page views; one whose `last_active_at` is more than 60
days old is deleted — `delete_sandbox_org` (migration `0022`) refuses outright if the organization is
not a sandbox, and re-checks `last_active_at` against the cutoff before deleting, so an organization
that became active between the listing and the delete survives. A `live` organization is never
deleted automatically. `POST /api/platform/cleanup`, bearer-guarded the same way as the cron, lists
and deletes candidates; `.github/workflows/sandbox-cleanup.yml` calls it once a day and on manual
dispatch. The same run deletes webhook deliveries past their 30 days and the write API's idempotency
outcomes past their 24 hours, across workspaces, and reports how many.

**Deleting a workspace** is an owner's call from the danger zone at the bottom of Settings
(`deleteWorkspaceAction`, `org.administer`, after typing the slug): `delete_org(p_org_id, p_by)`
(migration `0031`, service role only) refuses the founding workspace, anyone `member_role` does not
name an owner, a live workspace whose agent is not paused, a cycle run started in the last 15
minutes still `running`, and a payment in progress (an invoice `processing` under a review from the
last 10 minutes, or a payment intent `submitting` since the last 2 minutes: the claim functions' own
windows); otherwise, in one transaction, it writes a tombstone to the service-role-only
`deleted_orgs` (slug, name, who, when, the ledger's entry count and its head's `hash` and
`signing_key_id`), deletes every tenant table in `delete_sandbox_org`'s order, and deletes the org
row, which cascades to memberships, invitations, API keys and webhooks.

**Deleting your account** (spec §6) is `DeleteAccountPanel`, under Danger zone at the end of Settings, for every
member, and of `/account`, which the account menu's **Account settings** opens with or without a workspace
(`docs/superpowers/specs/2026-10-21-delete-account-in-settings-design.md`; the menu holds no danger row). It is gated by the
session alone (`src/app/account/actions.ts`, never a user id from the form). `accountDeletionPlan`
(`src/lib/platform/delete-account.ts`) blocks it while the person is the last owner of a workspace
with other members or of the founding workspace; `deleteAccount` then runs `delete_org` on each
workspace they are the only member of, stopping at the first refusal, and only then deletes the auth
user through `platformAuth().deleteUser` (the service role's admin API), after which `0023`'s
foreign keys remove memberships and sent invitations and null `created_by`.

**The cron** (`POST /api/agent/tick`) no longer runs one configured business.
`runLiveOrganizations` (`src/lib/agent/cron.ts`) lists every organization in `mode = 'live'` and,
for each, enters its scope with `withOrg` and runs a cycle; one organization's failure is caught,
recorded as that organization's own result, and does not stop the rest (spec §4.4 — the stage
isolation the cycle already had, lifted one level). Up to `CRON_CONCURRENCY` (4) organizations run at
once, each in its own scope: one after another, twelve live workspaces at 20 to 40 seconds each outran the
route's 300 seconds, and the last ones in slug order got no scheduled cycle (Oct 17). No cycle starts later
than 180 seconds into the tick (`startBy`); one not started by then is reported as skipped,
`out_of_time`, and logged, and the next tick runs it. The endpoint reports
`{ organizations: [{ slug, ok, lines } | { slug, ok, skipped } | { slug, ok: false, error }] }`, `200` when every
organization succeeded or was skipped and `500` when any failed. Sandbox organizations are never in this list: a
member runs their own cycles from the console instead, capped at `SANDBOX_DAILY_CYCLES` (20) per
organization per UTC day. The cap is enforced inside `begin_cycle_run` (migration 0022), which
opens the `cycle_runs` row under a per-organization lock and counts the day's runs in the same
transaction, so it holds across serverless instances rather than resetting per cold start.

Supabase Cron calls the tick at 17 minutes past every sixth hour (`supabase/cron/watches.sql`), with
the agent's bearer token from Vault, and `.github/workflows/agent-cycle.yml` stays for a manual run.
GitHub's schedule called it until 2026-10-07, 2 to 4 times a day at uneven hours. A daily recurring
payment's invoice is made by the first cycle of its due day (`leadDays` is 0 for it), so a skipped
tick left the day's invoices waiting for the next cycle, or for an event to start one.

**The due-work watch** (`POST /api/agent/due-watch`, `src/lib/agent/due-watch.ts`,
`docs/superpowers/specs/2026-10-21-due-work-watch-design.md`) runs every 5 minutes from Supabase Cron, with the same bearer
token, and by hand from `.github/workflows/due-watch.yml`. It covers work that becomes due only because time passed,
which no event starts a cycle for. It goes through `runLiveOrganizations`, so live workspaces only, four at once, the
pause, the payments switch, a running cycle and a 180-second start budget behave as in the tick. In each workspace it
compares due times with the start of the latest cycle (`cycle_runs.started_at`, any trigger), so a cycle that started
after a due time has covered it and the watch never repeats one:
- **a missed tick** (DW4): no cycle since the latest tick (`lastScheduledTick`, 17 past hour 0, 6, 12 or 18 UTC) once
  15 minutes have passed, which leaves the tick its own start window. It runs `runScheduledCycle`, the digest and
  escalations included, exactly as the tick would. Inside those 15 minutes a workspace the tick has not reached gets
  nothing at all, so no event cycle takes the scheduled one's place. The tick's time is `src/lib/agent/tick-schedule.ts`,
  which `tests/supabase-cron.test.ts` holds equal to the job;
- **a payee lock wait that ended** (DW5): the lock on with hours above 0, a confirmed address change whose wait ended
  after that start and by now, and a payable `held`, `flagged` or `awaiting_info` or a verified milestone unsent for
  that counterparty. It runs one cycle with the event `payee_lock_wait_ended`; the follow-up stage reopens the held
  payables (`coolingOff`). An owner turning the lock off or shortening its wait starts a cycle at once instead
  (`payee_lock_eased`, `lockEased`), since a wait that ends in the past under the new hours never counts as newly ended.

One cycle per workspace per run, the scheduled one first. With nothing due it runs no cycle, writes nothing and calls
no model. The response names each workspace's outcome and only that a workspace failed, never the error.

**The transfer watch** (`POST /api/agent/transfer-watch`, `src/lib/agent/transfer-watch.ts`,
`docs/superpowers/specs/2026-10-06-stuck-transfer-alert-design.md`) runs every 5 minutes from Supabase Cron, with the
same bearer token, and by hand from `.github/workflows/transfer-watch.yml`. It tells a workspace's people about a live
payment not confirmed after its network's `stuckAfterMinutes` (15):
- in every workspace that can hold a live payment (a hosted wallet, or Circle credentials stored), live or not, it
  reads the live payment intents still in flight by `submitted_at`, which migration
  0080's trigger stamps whenever a row becomes `submitting`, and those recorded `failed` in the last week that
  `paymentWasSent` says may have moved (a send whose answer was lost, a transfer whose last read failed);
- it asks Circle again, read-only (`reconcileTransfer`); one Circle now shows settled is left to the next cycle;
- it signs a `payment_stuck` entry once per attempt, keyed by the attempt's idempotency key, then posts it to the
  workspace's Telegram chats and Slack channel at once (their cursors, as the cycle's stages) and emails each deciding
  member one message listing the payments; the console's toasts and webhooks carry the entry too. A payment whose entry
  cannot be written is logged and the rest are still told;
- a run that failed in any workspace answers 500 without naming it, and the workflow logs only the status code, because
  the repository is public;
- a run ends within 120 seconds, half the schedule's period: Supabase Cron posts without waiting for the last answer,
  and the watch reads which attempts were told before telling the rest, so two runs must never overlap;
- it runs whatever the pause and the stop switch say, tells from the age alone where Circle cannot be asked, and never
  sends, retries, settles or holds a payment.

**Circle notifications** (`POST /api/circle/notifications`, `src/lib/circle/notify.ts`,
`docs/superpowers/specs/2026-10-06-circle-notifications-design.md`) start a payment's settling within seconds of Circle,
instead of at the next cycle, on a subscribed account while the agent runs:
- Circle posts a signed notification when a transfer's state changes. The route answers 401 without a valid ECDSA P-256
  signature (`X-Circle-Signature`, against the key `X-Circle-Key-Id` names), and 503 when that key cannot be fetched, so
  Circle sends it again; 413 over 64 KB, and 429 past 300 a minute from one client. It allows 300 seconds, because the
  event cycle it starts runs after the answer in the same invocation, bounded by the route's duration.
- It looks in every workspace that can hold a live payment, as the transfer watch lists them, for a payment intent in
  flight, or recorded failed while it may still move, whose `provider_tx_id` is an outbound transfer now `COMPLETE`,
  `FAILED`, `DENIED` or `CANCELLED`; or for the operating account whose `circle_wallet_id` received an inbound transfer
  now `COMPLETE`. It verifies the signature in that workspace's scope, with the key fetched from its own Circle account
  (`getNotificationSignature`, cached by key id). A workspace that cannot be read is skipped; when none matched, 503.
- An outbound one raises the event cycle `payment_settled` through `runCycleSoon`, with no person behind it; the cycle's
  reconcile reads Circle back, as on the schedule. An inbound one reads the workspace's inbound transfers at once
  (`recordIncomingTransfers`, as the pay page's check does), at most once in 15 seconds per workspace, and raises
  `payment_received` only when a receivable was paid: dust, a funding transfer and the agent's own moves start no
  cycle. Nothing from the body is recorded. A payment confirmed inside its own sending cycle's 45-second wait is no
  longer in flight, so its notification starts nothing.
- Each Circle account has one subscription to that endpoint, found or made (`ensureNotificationSubscription`). Connect
  Circle makes it for a workspace's own account from the production deployment only, best effort, within 10 seconds,
  logging only a label of a failure. `npm run circle:subscribe` makes it for the platform's hosted account and for
  accounts connected before; the operator runs it once the deployment is live, as Circle tests the endpoint first.

**Where a payment is** (`src/lib/settlement.ts`, `src/lib/settlement-facts.ts`, `src/lib/settlement-read.ts`,
`docs/superpowers/specs/2026-10-11-settlement-lifecycle-design.md`) is a read model over what the rows above already
record; it writes nothing and nothing that moves money imports it (`tests/settlement.test.ts` pins that):
- `settlement-facts` turns a payment intent (its status, Circle's `provider_state`, `submitted_at`, `confirmed_at`,
  `previous_attempts`), the signed entries about its bill (the decision, a person's approval, `payment_stuck`, the
  recording entries) and the bill's own status and `tx_ref` into facts, each with its source and time;
- `reduceSettlement` replays them into seven stages, proposed, authorized, submitted, pending, confirmed, in the payee's
  wallet and reconciled, with failed, cancelled, not sent and outcome unknown kept apart. Facts are ordered by time, then
  stage, then ledger sequence, so the answer is the same in any order and with duplicates; confirmed is never undone, a
  pending read never undoes Circle's end, and only a new attempt (`begin_payment_retry`) moves on from an ended one.
  Gateway's `GATEWAY_FAILED` is its own status, neither in flight nor an end: nothing watches it, and Treasury does not
  count it. Proposed and Authorized are shown by the send at the latest, since their entry is signed after it. Pending
  is reached at the send, when Circle took the transfer; Circle's latest word keeps its own time (`stateAt`, the
  `executed_at` every reconcile rewrites), said beside it ("as of"), never as the stage's. A CCTP payout pending with
  its burn's (or approve's) `CONFIRMED` is told by its Circle id as that step confirmed on Arc, never as the payout. Not
  sent says it stopped before Circle took the transfer, with the recorded reason: the row does not say whether Circle
  refused the request or never had it. "In the payee's wallet" is the confirmation itself on Arc, the recorded mint for
  a payout to another chain, and never for a simulated payment, told by the mode of its last result (`provider_mode`),
  as the receipt tells it; no stage names a bank, a refund or a chargeback, which this rail does not have;
- reconciled means the bill is `paid` with one of the transfer's references and a signed entry names it; anything else
  after a confirmation, or a bill marked paid without one, is the payment's one mismatch. The entries come from
  `ledger_entries_for_targets` in one request, newest first: a read cut at `max_rows` (`ledgerReadMayBeCut`) makes a
  missing entry unknown, never a mismatch;
- who comes back to the bill (`followUpOf`, by its status) decides what an unknown send and a confirmed transfer the
  books miss promise: the agent's cycle for a `matched` payable or a `verified` milestone ("checking with Circle", "the
  agent's next cycle marks it"), a person in Approvals or on Contractors for a bill held for them, no one otherwise;
- Bills & receivables reads the workspace's invoice payment intents, a page at a time, when its Bills tab shows a
  payable, and folds the stages into the cards of the bills shown; Treasury reads every intent not confirmed and the confirmed ones of the bills someone comes back to,
  and lists them as **Payments in flight**, aged against the network's `stuckAfterMinutes`. Both reads are best effort, in
  the page's organization scope: one that fails hides only these parts. The shared receipt says Reconciled only when its
  own three checks pass, and Confirmed with the reason otherwise (`src/lib/receipts/status.ts`).
- A shared receipt (`docs/superpowers/specs/2026-10-22-receipt-v2-design.md`) states, beside the payment's own facts
  (`intentFacts`, which the evidence chain shares), what `buildReceipt` adds: the invoice's number (`invoiceNumberOf`,
  from its `create_invoice` entry: `invoiceNumber`, or an accounting connector's under its provider's name), the
  invoice's amount when a discount took something off, and `feesPaidBy: "sender"`. Arc's network fee is never stated: Gas
  Station pays it on testnet, and `fee_usd` is a batch's share or a bridge's burn alone. The on-chain check returns what
  the matched transfer moved (`received`), and `receiptAmounts` (`src/lib/receipts/amounts.ts`) turns both into the
  page's Amounts list, adding "and the network fee" to what left the sender only where the network's wallets are EOAs
  that pay their own gas (`walletAccountType`), never for Gateway. **Save
  as PDF** is the browser's print: the page marks the site's chrome, the button and the disclosure `print:hidden`, and
  prints the entry's seq and hash. An API key reads what a receipt states, shared or not, as `vestiarion-receipt/1`
  from `GET /api/v1/invoices/{id}/receipt` (`receiptDocument`, `src/lib/receipts/document.ts`), never its link.

**Payments that do not settle** (`src/lib/payment-exceptions.ts`,
`docs/superpowers/specs/2026-10-14-payment-exceptions-design.md`) are words over the read model and the payment intent,
and decide nothing:
- `payActionOf` (a payable's `paymentSent` and `lastAttempt`) and `milestonePayAction` (a held milestone's reason) name
  what a person's pay action does with an earlier attempt: send, send again after Circle ended it, check a transfer
  that exists, or look for a send Circle never answered first. For the last two, Approve and pay and Pay now never
  ask "Pay … now?": the confirmation's title and button, the notice raised while it runs and Slack's confirmation (its
  title, text and button, the text clipped to Slack's 300 characters) say it checks first;
- `approveAndPay` and `payHeldMilestone` look for a send Circle never answered (`lookForUnknownSend`) before any other
  check, as Reject, Return and Close do: found, it is only recorded; not listed yet, or Circle could not be asked, they
  refuse before any claim (`payment_unknown`, with when to try again); never taken, what follows is a new payment and
  every check applies, the shadow verdict gate and the funds included. A payout to another chain, which cannot be
  looked up by its reference (`settleUnknownSend` answers `unlookable`), is asked for again under its key, as before,
  and Reject and Return say so. `releaseHeldMilestone` takes `retryTerminalFailure`: only a Pay now that ran a new
  payment's checks sends Circle's terminal failure again; one that only checked a transfer already sent records it and
  holds the milestone again, as `approveAndPay` does;
- `transferUnknown` reads a row left `submitting` past its 2-minute claim as an unknown send, as `unknownSend` and the
  track already did, when the row's `updated_at` was read with it (Approvals, Approve and pay, Reject, Return, Add
  details, Pay now and Close select it), and a first attempt sent in a batch with no Circle id as one whatever its
  status or error (`batch_key`, `transfer_attempt`). Reject, Return and Close then look for it first (payment safety R6)
  rather than refuse it as sent; the cycle's own reads, which do not select these columns, keep their answer.
  `settleUnknownSend` looks a batch member up by the batch's refId (`resolveLostBatch`), as `executePayment` does, never
  by the member's memo, so nothing concludes a batch member was never sent while Circle may have the batch. "Never
  sent" (`NO_EARLIER_SEND`) is written by `recordNotSent`, a compare-and-set on the row's status and `updated_at` as the
  lookup read them: a request that lost it, because another one concluded first and claimed the payment, answers
  undecided and sends nothing. With no operating account, a pay action refuses with `no_operating_account`;
- `paymentException` maps a lifecycle to the runbook's states, slow to confirm (in flight for the network's
  `stuckAfterMinutes`), outcome unknown, failed or cancelled, not sent, and Gateway's failure, and `whatToDo` gives who
  acts and the next step by who comes back to the bill (`followUpOf`). The track's **What to do** block, Treasury's
  **What to do:** line, the transfer watch's email and the guide `content/docs/guides/payment-exceptions.mdx` use the
  same words, which `tests/payment-exceptions.test.ts` holds the guide to. An end shows only while a person comes back
  to its bill. `Settlement.circleId` carries the current attempt's Circle id for the trail;
- the evidence page reads `provider_tx_id`, `provider_state`, `failure_reason` and `last_error`, so its payment step
  tells an unknown outcome, a failed read and Gateway's failure apart from Circle's end, as the track does.

**Money received applied to invoices** (`src/lib/allocations/`, migration 0103,
`docs/superpowers/specs/2026-10-12-allocations-design.md`) lets a person apply an incoming payment on Arc to one or more
open receivables, settle one from several payments, keep an overpayment as the client's credit, record a difference as a
fee, and reverse either:
- **The rows.** `receivable_allocations` holds a `payment` row (part or all of one `incoming_transfers` row applied to
  one receivable, with its `basis`: `person`, or `sender`/`amount` for the agent), a `fee` row (a difference on one
  receivable, with a reason, never paid by the client) or a `reversal` row (naming the row it reverses, with a reason).
  The tenant role reads and inserts only; composite foreign keys keep every link in the workspace, and
  `incoming_transfers` gains `unique (org_id, id)` for them. Amounts are `numeric(20,6)`; the code works in whole
  millionths (`src/lib/allocations/model.ts`), so sums never drift, and never adds across currencies.
- **The invariants, in the database.** `receivable_allocations_check`, before each insert as the inserting role, locks the
  payment's row, then the receivable's (`for update`, one order everywhere), and refuses: a receivable not open or not
  one; a payment or receivable a whole match claimed; another currency than both the payment's and the receivable's; a
  payment already applied to another client; more from a payment than it brought; more on a receivable than its amount;
  a fee with no payment beside it; a reversal that does not mirror its row, names a reversal or would leave a fee alone;
  and a stale `payment_seq`. `payment_seq` numbers one payment's rows 1, 2, 3, ...: a person's application names the
  next one as they read the payment, so of two people applying the same payment at once one is refused (the second waits
  on the lock, then sees the number taken; the unique index on `(org_id, transfer_id, payment_seq)` holds it even past
  the trigger, which `tests/allocations-migration.test.ts` shows with triggers off). One reversal per row is a unique
  index. `receivable_allocations_settle`, after each insert, makes a receivable `received` once nothing is owed, with
  the latest applied payment's `received_at` and `tx_hash`, and a reversal that leaves something owed makes a `received`
  one `pending` again, with neither: in the same transaction. `incoming_transfers_whole_match`, before a whole match's
  claim of `invoice_id`, locks the receivable and refuses a transfer or receivable with allocations in force.
- **The whole match is unchanged.** `matchTransfer` and the claim on `incoming_transfers.invoice_id` stay as they were,
  with `ar_received`; a whole match is all of one transfer for one receivable, and is not reversed here. The receipts
  stage leaves out of it every transfer and receivable with an allocation row, and applies by itself a transfer that is
  exactly what is still owed on a part-paid receivable, by the same two rules (`matchTransfer` over the outstanding
  amounts), as an agent `payment` row and `ar_payment_applied`; a refusal of the trigger leaves it to a person.
- **Suggestions** (`src/lib/allocations/suggest.ts`) are pure, bounded and deterministic: a payment's reference (Arc
  transfers carry none); for the client its applications name, or whose address on file sent it, the receivable it pays
  exactly, 2 to 4 of its 12 oldest due that add up to it, one it is short of by at most 1% and 5.00 (a possible fee), and
  oldest due first with any rest as credit; with no client known, an exact amount (saying how many share it), sets of one
  client's receivables, and one within the fee margin. At most 3 per payment, each with why.
- **Commands.** `receivable.apply_payment` and `receivable.reverse_allocation`, `records.write`, console only
  (`src/lib/commands/allocations.ts`). `src/lib/allocations/apply.ts` reads what it needs, plans with the pure model so a
  refusal reads in plain words, checks the signing key, writes every row in one insert (payment rows by receivable id,
  then fees), maps a trigger's refusal to the same words, then signs one entry per row, best effort:
  `ar_payment_applied`, `ar_fee_recorded`, `ar_allocation_reversed`, each with `invoiceId`, so the receivable's trail
  shows it, and a `group` for the rows one press wrote.
- **Where it shows.** Bills & receivables reads the rows and payments (`readAllocationBook`, best effort): a receivable's
  card says part paid, what was received and is still owed, and lists each payment and fee, with Reverse and Record a fee
  (`AllocationLines`); **Apply payments** (`ApplyPayments`, from `applyPaymentsView`) lists each payment not applied in
  full, its credit, the suggestions and Apply by hand, leaving out test USDC from the float. The pay link's page asks for
  what is still owed (`payLinkBalance`); the collections stage asks for it too, says what arrived, and sends nothing on
  a receivable with nothing owed. Treasury's cash outlook and scenarios, and the payment plan's money expected in,
  expect a part-paid receivable for what is still owed (`stillOwed`), a deal's released line among them, counted once;
  a deal line not released yet is no receivable and stays apart. Where a payment is and receipts cover payments the workspace makes, so they are
  unchanged. `GET /api/v1/invoices` keeps its shape: part paid stays `pending`.
- **A search** (`src/lib/invoice-search.ts`, `?q=` on Bills & receivables) finds an invoice by id, any part of its memo,
  purchase order, counterparty, amount or what is still owed, and a payment applied to it by its hash, Circle id or
  sender.
- **Before 0103 runs** a read answers `available: false` (`PGRST205`, `42P01`), the commands refuse `not_ready`, the
  receipts and collections stages read no rows and behave as before, and Receivables says applying payments is not set
  up yet. Bank statement money-in lines are not applied: a statement's currency is a bank's, receivables are USDC or EURC.

**The FX watch** (`POST /api/agent/fx-watch`, `src/lib/agent/fx-watch.ts`,
`docs/superpowers/specs/2026-10-05-fx-reevaluation-design.md`) runs every 5 minutes from Supabase Cron, with the same
bearer token, and by hand from `.github/workflows/fx-watch.yml`. It decides again, without a person, a EURC payable a
decision held for FX:
- what held it is read from that decision's own entry (`fxHoldOf`, `src/lib/fx/recheck.ts`): no rate, no swap,
  a swap above the 3% cap, or a value above the limit;
- in each live, unpaused workspace it asks one quote, once, for at most three such payables not reopened for FX in the
  last 30 minutes (`probeFx`, `src/lib/fx/probe.ts`);
- it runs a cycle with the event `fx_changed` only when a quote crossed the threshold that held one. With nothing
  waiting or nothing cleared, it runs no cycle, writes nothing and calls no model.

The cycle's follow-up stage makes the same re-check for at most five payables, with its own quote. It reopens the
payable, recording `reevaluation` (the trigger, the decision it reopens, and the quote before and after) in
`invoice_reopened`. The AP stage then decides it in the same cycle and records the reopen it follows. A reopen is the
follow-up's compare-and-set on `held`, so a person acting at the same moment wins; one cycle per workspace runs at a
time, and payments keep their idempotent intents.

**The new payee check** (`docs/superpowers/specs/2026-10-05-new-payee-check-design.md`) puts two people before the first
payment to an address.
- **What a first payment is** (`newPayeeCheck`, `src/lib/new-payee.ts`): one to a payee at an address no confirmed
  `payment_intents` row has paid for that payee. `loadNewPayeeFacts` reads each confirmed payment's payee through its
  invoice (`counterparty_id`) or milestone (`contractor_id`), so `paidTo` is per counterparty, lowercase: an address
  the workspace paid for someone else is still a first payment here. `newPayeeCheckFor` asks it for one counterparty.
  A payment counts only on the chain the payee is paid on now (`chainKey`, payee invoice link P3): the intent's
  `destination_chain`, or the network's own without one, against the counterparty's `chain`, read with the facts, or
  the network's own without one. A first payment on Base to an address paid on Arc is still a first payment.
  A payment counts at the address its transfer went to: the intent is inserted once per source, so `executePayment`
  writes the address a send pays (`markDestination`) before sending it whenever it is not the one recorded. A bill
  sent again to the payee's new address, by the agent or by a person after a hold, is paid there, and its first
  address stays a first payment.
- **Who stands behind the address:** read from the counterparty's ledger entries, newest first. The entry that set the
  address (`create_counterparty`, `counterparty_address_changed`) names who gave it: a member, or the payee for a payee
  link or GitHub. `counterparty_address_confirmed` entries after it name who confirmed it.
- **A payee's address counts as the asking member's:** an address the payee sent, through a payee link or with
  `/payto`, has `by: null`, so the check names the member who asked for it, from signed entries read in the same query
  (`compliance` and `contractor` domains): the link's `payee_link_created` (`by`, matched on `linkId`), or the
  `github_bounty_attached` of the pull request the `/payto` comment was posted on (its `commentUrl` starts with the
  bounty's `pullRequest`), whose `by` is the member the bounty acts as. Only when a link's entry is missing is its
  `payee_links` row read (`created_by`, migration 0039, through `platformDb`), and set beside the entry as
  `linkCreatedBy`; the ledger's detail is left as written. The signed entry outlives the member's account, which
  empties `created_by`. `newPayeeCheck` keeps `addressBy: "payee"` and adds `linkCreatedBy` or `bountyBy`, and for a
  payee link a confirmation counts as a second party only when it is by someone other than its creator. Without this,
  one admin could ask for an address, send their own wallet through it, confirm it, and the agent would make the first
  payment alone.
- **Addresses no member answers for alone:** one sent with `/payto` (a GitHub login is tied to no member, and every
  `/bounty` acts as the member who connected GitHub, whoever typed it), and one whose giver no entry names
  (`addressGiver` null), set by a change, or with a counterparty added through the API or GitHub, so a person can
  confirm it (`unanswered`; one typed in as its counterparty was added, by an old entry naming no one, cannot be
  confirmed, so it is held for a person as an unrecorded address is). For these, no confirmation counts as a
  second party, so the agent holds the first payment, and it rests on exactly two different members: one confirms the
  address, and another approves it. The members who confirmed it are carried as `confirmersLeftOut`, and
  `membersLeftOut` is exactly them (for any other address, the giver): who Approve and pay, Pay now and both
  two-approvals lists leave out. `firstPaymentRefusal` also refuses one approver alone while no member's confirmation is
  on record, read before the approval, whose own confirmation of the address never counts. The member a bounty acts as
  is not left out. A bounty whose `login` (who typed it) is its pull request's `author` names no member. An address no
  entry records at all is held for a person, and no one is left out for it.
- **Where it applies:** wherever payments are real, meaning the chain provider is live. Real payments follow readable
  Circle credentials, not `orgs.mode`.
- **The agent's side:** the cycle passes the AP and contractor stages the facts (`loadNewPayeeFacts`,
  `src/lib/new-payee-facts.ts`; `firstPaymentFrom` for a release). Code holds a first payment one party alone stands
  behind as `counterparty.new_payee`. The stages hand the same check to `reconcileApInvoice` and `reconcileMilestone`
  (`newPayee`). The reconcile's send-again path only ever sees a `submitting` intent with no Circle id: a send whose
  outcome was never recorded (a stale claim, or a lost batch). It looks that send up at Circle first, sending nothing
  (`earlierSend`, below), and asks only once Circle is known never to have taken it, or, for a payout to another chain,
  which cannot be looked up by its reference, before it is asked for again under its key. Sent again, it goes to the address
  as it stands now, so a member who changed it to their own wallet and confirmed it alone while the payment was stuck
  would not have put a second person behind it. When that would be a first payment with `twoParties` false, the
  reconcile holds it (`newPayeeResendBlocker`), after the high risk and unconfirmed address checks and before two
  approvals, as the stages order them. Its `ap_reconcile` or `milestone_reconcile` entry records
  `notResubmittedBecause: "counterparty.new_payee"` with `guardrailBlocked`, `guardrailRule` and `newPayee`, and the
  reasoning gains "[not resubmitted: this is the first payment to this address, …]". The entry carries no `observed`.
  For a payable, the follow-up keeps the facts of the decision before it, but held as a new payee and for nothing else
  (`payableDecisionFacts`), and reopens it as **Afterwards** says; a milestone waits for a person. A transfer recorded
  with its Circle id is only read, and asks nothing.
- **A person's side:** Approve and pay, and Pay now on a milestone, refuse whoever `firstPaymentRefusal` names unless
  they are the sole approver, in words that say why: they gave it or asked for it with a link (`newPayeeSelfMessage`),
  they confirmed an address no member answers for alone, or no one has confirmed it yet. The Approvals card
  (`firstPaymentConfirmers`, `firstPaymentUnanswered`) and the milestone's two approvals (`leftOutWhy`) say the same,
  and "Who can act" (`whoCanAct`, on Approvals, Bills and the overdue email) leaves out `membersLeftOut`. The sole
  approver's payment records `addressGiverApproved: true` and says so in its summary (`ADDRESS_GIVER_NOTE`). Recording
  a transfer already sent asks no first-payment question. A GitHub bounty's milestone (`addedByBounty`: its signed
  `github_bounty_attached` names it and its creator, the member who connected GitHub) held as `counterparty.new_payee`
  is not refused to that creator once another member confirmed its address; a milestone a person added keeps the
  creator rule for every hold, since the agent stops checking at the first rule that holds it. `confirmCounterpartyAddress` writes
  its `counterparty_address_confirmed` entry strictly, undoing the confirmation when the entry cannot be written. Confirmed payments and address entries are read a page at a
  time (`PAYMENT_PAGE`), and the invoices and milestones paid by id in chunks (`ID_CHUNK`), so PostgREST's row cap
  never drops one.
- **Recorded:** a decision on a first payment records `observed.newPayee` through `newPayeeObserved`:
  `{ addressBy, linkCreatedBy?, bountyBy?, confirmedBy, unanswered?, twoParties }`. The decision trail and the evidence page say
  when a payee link brought the address in, and the evidence page names who created the link.
- **Afterwards:** the follow-up (`newPayeeFollowUp`) reopens a payable held this way once that payee has been paid at
  its address, or two parties stand behind it.

**The payee lock** (`docs/superpowers/specs/2026-10-20-payee-lock-design.md`, `src/lib/payee-lock.ts`). Migration `0135`
adds two columns to `approval_policies`: `payee_lock` (off by default) and `payee_lock_cooling_hours` (0 to 168).
- **Setting:** an owner changes it on Settings (`changePayeeLock`), signed as `payee_lock_changed`, and refused while a
  cycle runs. `readPayeeLockStatus` reads missing columns, before 0135, as off and not ready. Any other failure throws.
- **Confirming:** Confirm address posts a record, `{ method, contact, contactOnFileBefore, note }`. `parseVerification`
  makes it optional with the lock off and required with it on (a call or a message names a contact that was on file
  before the change). `confirmCounterpartyAddress` reads the lock itself and, with it on:
  - refuses `via: "approval"` (`lock_requires_confirm`);
  - refuses a record that falls short (`verification_required`);
  - refuses the member `addressGiver` names while `approversBesides([giver]) > 0` (`giver_confirms`). Otherwise it
    records `soloConfirmation`.

  With the lock off it records `byGiver`. Either way it records `lookalikeOf`, best effort.
- **Paying:** `approveAndPay` and `payHeldMilestone` ask `payeeLockRefusal` before any claim (`payee_locked`): an
  unconfirmed address, or a confirmed one inside its wait, is refused with the time it can be paid. The AP stage reads
  the lock once and passes it to `enforceApGuardrails`, which holds a payment inside the wait as
  `counterparty.cooling_off`, right after `counterparty.address_unconfirmed`. The follow-up (`coolingOffHeld`,
  `coolingOff`) reopens it once the wait ends. The milestone stage leaves a verified milestone waiting, as it does for a
  confirmation.
- **Resubmission:** a payment that never reached the network is not sent again inside the wait. `resubmissionBlocker`
  returns `counterparty.cooling_off`: a payable is held (`notResubmittedBecause`), and a milestone waits, still
  verified. The follow-up reads that entry as `coolingOffHeld` (`payableDecisionFacts`) and reopens the payable once the
  wait ends, as it does one the guardrail held, unless its earlier send could not be looked up
  (`earlierSendNotLookedUp`, payment safety below).
- **Lookalikes:** `lookalikes` buckets the payees' addresses by chain and by their first 6 and last 4 hex digits.
  `earlierLookalike` compares a changed address with the same payee's earlier addresses and the ones it was paid at,
  which is the usual address poisoning. Counterparties shows the matches and Confirm address repeats them; they never
  refuse anything. The confirmation records `lookalikeOf`, `looksLikeEarlier` and, when no giver can be named,
  `giverUnknown`.
- **Fails closed:** only the codes 42703 and PGRST204 read as "before 0135"; any other failure throws.
- **Evidence pack** (`docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md`): `GET /api/evidence/payee-lock`
  answers any member with `vestiarion-payee-lock-evidence/1`, gated as the payment evidence is, six a minute per member
  (`takeEvidencePackToken`). It writes no entry. An API key reads it from `GET /api/v1/payee-lock/evidence?from=&to=`,
  each member as `{ kind: "member", userId, email: null }`; the download names both.
  - `readPayeeLockEvidence` reads, a page at a time and a hundred ids at a time:
    - the `counterparty_address_changed` and `payee_lock_changed` entries in the period;
    - every entry of the counterparties those changes name.

    It checks only the cited entries with the workspace's keys (`verifyEntry`).
  - `payeeLockEvidence` (pure) makes one row per change that sets an address, leaving out shadow-mode mirrors. Each row
    carries:
    - who entered it;
    - the first confirmation of that address before the counterparty's next change, with its record and whether a
      second person gave it (`secondPersonOf`: true only when known);
    - the holds for its address (`counterparty.address_unconfirmed`, `cooling_off`, `new_payee`, by `guardrailRule` or
      `notResubmittedBecause`);
    - the first entry with a transaction, leaving out a bank payout and a transaction the counterparty's earlier
      entries already named;
    - the checks that follow.
  - Every fact cites its entries by `seq`, and the file carries those entries in full with the keys and
    `CHECK_AN_ENTRY`. Settings links it from the payee lock panel.
  - The page, `/o/<slug>/evidence/payee-lock` (`PayeeLockEvidenceView`), reads the same pack for a period (the last 30
    days unless asked, `evidencePeriodFrom`; twenty reads at once per member, then one every 3 seconds,
    `takeEvidencePageToken`), with the answers `payeeLockQuestions` (`src/lib/payee-lock-evidence-report.ts`) gives to
    seven controls insurers ask about, counted from the rows' own records, never the lock's setting today. `format=csv` on the route answers `payeeLockEvidenceCsv`, one row per change, cells guarded
    by the audit export's `csvCell`.
  - Its PDF is the browser's print: the shell's sidebar, headers, banners and footer carry `print:hidden!`, and the
    frame drops its padding (`print:pl-0!`), so any workspace page prints its content alone.

**The invoice pay-to hold** (`docs/superpowers/specs/2026-10-21-invoice-pay-to-hold-design.md`). An invoice read from a
document keeps the 0x address the document asked to be paid to in `invoices.document_pay_to` (migration 0136).
- `DocumentProvenance.payTo` carries it from each path:
  - the invoice form's `documentRead` (`documentPayToOf`);
  - the chats' and email's stored draft (`chatDraftOf`), and the inbox's reading for an email finished by hand;
  - a Chrome extension draft's `read.payTo`. A payee link's draft reads no document, so it carries none.
- `createInvoice` writes it and records it in the `create_invoice` entry's `document`. Before 0136 the insert is
  retried without it, as before.
- The AP stage reads the payables' addresses once (`readDocumentPayTo`, none before 0136; any other failure stops the
  stage). `enforceApGuardrails` holds a payment whose document asked for another address than the one on file as
  `invoice.pay_to_differs`, after the address checks and before the three-way match, except for a payee paid to a
  bank account. The decision's `observed` records `documentPayTo`.
- `reconcileApInvoice` does not resend a payment never sent while they differ (`notResubmittedBecause:
  "invoice.pay_to_differs"`, `payToHeld` in its facts).
- The follow-up (`payToHeld`, `payToDiffers`) reopens it once the address on file is the one asked for.
- Approvals' card shows the address the invoice asked for beside the one Approve and pay sends to
  (`invoice-pay-to-rules.ts`, pure, for the browser). `approveRefusal` refuses Approve and pay from Slack or Telegram
  for it (`open_in_console`). The agent never pays the document's address.

**Names in an address field** (`docs/superpowers/specs/2026-10-22-ens-address-names-design.md`). `AddressNameHint`, under
the add form's and **Edit address**'s field, asks `lookupAddressNameAction` (records.write, `takeAddressNameToken`:
thirty at once, then one every 2 seconds per member) about what the field holds: an ENS name or Basename
(`isAddressName`) resolves through `resolveAddressName`, an address through `primaryName`, both in `src/lib/ens.ts` on
Ethereum mainnet through PublicNode or `ENS_RPC_URL` (one try, 5 seconds a call, 10 seconds a lookup), cached ten
minutes. `primaryName` drops a reverse record that is not plain ASCII in ENS's normal form, since its owner writes it
freely and a hidden character would read as the payee's name. **Use this address** puts the address in the field;
`parseAddressInput` refuses a name, so only an address is ever saved, and **Edit address** reads the address on file
again each time it opens. `nameMatchesPayee` turns a name unlike the payee's into a warning, never a refusal: whole words
between hyphens, or the payee's name run together, with words every business uses left out. A resolver's CCIP-read
gateway goes through `gatewayRequest`, which fetches only https on `ENS_GATEWAY_HOSTS` (Coinbase's, for Basenames),
with `redirect: "error"` and a 5-second signal, so a crafted name cannot make the server fetch an address of its
choosing.

**Was this you?** (`docs/superpowers/specs/2026-10-22-address-change-check-design.md`, `src/lib/address-change-check.ts`).
`changeCounterpartyAddress` asks the payee's notice email after any change to a new address
(`askContactAboutAddressChange`, never throws, deferred with `after` by the console and the payee link):
- a live workspace only, not in shadow mode, with a notice email;
- with no address on file, the one before is read from the payee's signed entries (`earlierAddress`), so clearing and
  then setting still asks;
- `create_address_change_check` (migration `0137`) keeps one open check per payee and only the `vxw_` token's SHA-256,
  and makes nothing for an ask that runs after the address changed again;
- the email goes out, then `mark_address_change_check_sent` and `address_change_check_sent`.

`/address-change/[token]` previews by token and answers on a POST only. `answer_address_change_check` takes the answer
once. On "not me", while the address in question is still on file, it sets `counterparties.frozen_at` and withdraws
`address_confirmed_at` in the same statement. The `counterparties_frozen_guard` trigger then refuses any confirmation
while frozen. `confirmCounterpartyAddress` refuses `frozen` before writing, and maps the trigger's error to it.
`payeeLockRefusal` refuses a frozen payee lock or not. Approve and pay checks a bank-paid one too, and both it and Pay
now check again after their claim, so no approval pays one; the agent holds it as unconfirmed. The trigger also refuses
the tenant role any change to the freeze. `unfreeze_counterparty` runs for an owner or admin with a note, not for the
member whose edit was disputed while another can; its `counterparty_unfrozen` entry is strict, and
`restore_counterparty_freeze` puts the freeze back when it is not written.
`readAddressChecks` feeds Counterparties (`AddressCheckNote`) and Approvals (`payeeFrozen`). Every read of 0137's
columns treats their absence as none.

**Ask every payee at once** (`docs/superpowers/specs/2026-10-18-ask-every-payee-design.md`). `askablePayees`
(`src/lib/address-requests.ts`) lists, for an owner or admin on Counterparties, the vendors and contractors with no
address of their own (a mirror address counts as none), no unused link out and no sample flag, 25 at most by name.
`askPayeesForAddresses` re-reads the ones the page listed, makes each link through `issuePayeeLink` (the same gate,
client refusal and `payee_link_created`), then emails them five at a time to the payees' notice emails
(`addressRequestEmail`, metered as `address_request`; a shadow workspace's email names no network). A workspace that
simulates its payments emails none, and past `ADDRESS_EMAILS_PER_DAY` (100 in 24 hours, read from `usage_events`) the
rest are shown to copy. It returns the links not emailed to show once, and signs `payee_addresses_requested { by,
links: [{ counterpartyId, linkId, emailed }], notMade }` best effort. The panel stays mounted for a writer with no payee
left, so its dialog keeps the links on screen after the page re-reads; the page allows 300 seconds.

**A payee sends its invoice, and picks where it is paid, through its link**
(`docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md`). Migration `0133` adds two options to `payee_links`,
`asks_invoice` and `offers_chain`, both false unless a member ticks them in **Ask for address**, `invoice_at` and
`invoice_closed_at`. `createPayeeLink` makes a link with an option through `create_payee_link_with_options` (the payee's
unused link revoked, its earlier used links' invoice closed, the new link inserted with its options, one transaction
under 0039's advisory lock), and one without through 0039's `create_payee_link`, which is re-run by every migrate and
left as it is, after `close_payee_invoice_intake`. `payee_link_created` records the options. `issuePayeeLink` takes them
from the console only; every other surface makes links with both off. 0133 redefines `revoke_payee_link`: an unused
link is revoked as before, and a used link still waiting for its invoice gets `invoice_closed_at` and keeps its status
page; `revokePayeeLink` answers which (`payee_link_revoked` carries `invoiceOnly`), and Counterparties lists such links
(`listWaitingInvoiceLinks`) with Revoke.
- **Choosing the chain:** `choosablePayeeChains` (`src/lib/payee-chain-choice.ts`), in the workspace's scope, is the
  network's payee chains when there are more than one, and none for a workspace paying from the owner's wallet without
  an enforced version 2 contract (the same rule Approve and pay refuses by). Counterparties offers the box for a vendor
  with no address that no open milestone and no open bill in another currency than USDC holds to its chain
  (`payeesHeldToTheirChain`, `chainChoiceFits`); `issuePayeeLink` checks the same. `payee_link_status` says
  `chainOpen` when the link offers it, is unused, and its payee is a vendor with no address, no `payment_intents` row
  for any of its invoices or milestones, no milestone not yet paid or closed and no open payable not in USDC.
  `payeeLinkStatus` turns that into `chainChoices`, read in the paying workspace's scope, with `chainFees`: `bridgeFee`
  for each chain but the first, quoted for the USDC owed and not paid, each within 3 seconds and null when not read
  (docs/superpowers/specs/2026-10-22-payee-link-chain-fees-design.md); `chainFeeNote` words each choice. `submitPayeeAddress(token, raw,
  { chain })` reads `chainOpen` before claiming the link, checks the chain against `choosablePayeeChains` after
  (releasing the link when it is not one), and `changeCounterpartyAddress` writes `address` and, when it is another
  than the effective one (none recorded is the network's own), `chain`, in one compare-and-set guarded on the chain
  read. `counterparty_address_changed` records the effective `chain` and, for a real change, `fromChain`;
  `counterparty_address_confirmed` records `chain`. Counterparties shows the chain beside the address, and
  `confirmCounterpartyAddress` refuses a `shownChain` that is no longer the payee's as stale.
- **The invoice:** `submitPayeeInvoice` (`src/lib/platform/payee-invoices.ts`) checks the fields (`readPayeeInvoice`,
  `src/lib/payee-invoice.ts`: an invoice number on one line with no control character and no link, a note whose only
  control character is a line break), looks the link up with `payee_link_status` so a page with no live link asking
  for an invoice reads no file, only then takes a per-link token (`takePayeeInvoiceToken`: three, then one every 20
  seconds; made-up tokens never get a bucket), reads an optional file with `readDocument` (text and SHA-256 only, no
  model, the file dropped), and calls `submit_payee_invoice`, which locks the link, checks it is unrevoked, its invoice
  not closed, and unexpired or used within 30 days, asks for an invoice and has none, checks the fields again, inserts an
  `invoice_drafts` row (source `payee_link`, state `sent`, `connection_id` null, `payee_link_id` unique, the note and
  the payee's name in `read`) and stamps `invoice_at`, in one transaction. It signs `payee_invoice_submitted`
  (`by: null`) and emails the members with `records.write`, who add or discard it (`payeeInvoiceEmail`, a member email
  with no loop, metered as `payee_invoice`), both best effort. The payee's actions pass `defer: after`, so this email,
  and the address one from `submitPayeeAddress`, go out after the payee's answer (`tellMembers`); other callers await
  them. Bills lists it among the captured drafts
  (`capturedCountLabel`, `capturedTitle`) with the note shown as the payee's own words; the bill's memo starts from the
  invoice number alone. `confirmInvoiceDraft` adds it through `addInvoice` as the member's bill, its `create_invoice`
  naming `via: "payee_link"` and `payeeLinkId`, and `discardInvoiceDraft` names its source too.
- **The page:** the steps gain **Your invoice** after the address when the link asks for one (`payeeStage` `invoice`),
  which refreshes itself like the steps that wait on the business. Once the address is confirmed and a payment is on
  its way or paid, that comes first and the invoice it can still take second (`invoiceOpen`). A payee with an address
  of its own on file can keep it on a link that asks for an invoice (`keepPayeeAddress` claims the link, changes nothing
  and signs `counterparty_address_kept`; a mirror address made in shadow mode, `addressMirror`, is not offered). The
  address form puts the chain first when `chainChoices` has more than one, and a fourth box names it. Every refusal is
  a fixed sentence, and the page keeps `SiteFooter loop="payee_link"`.

**No address, nothing sent.** Wherever payments are real, a pay or schedule decision for a counterparty with no
payment address is held by `counterparty.no_address` (`enforceApGuardrails`) before any limit is read or transfer tried,
as a milestone already is (`payeeNotReady`). The entry records `observed.addressMissing`, and the follow-up reopens the
payable once the counterparty has an address and a person confirmed it (a payee link's address waits for that
confirmation first). Approve and pay refuses such a payable before any claim (`no_address`), as the chat commands do.
A sandbox still simulates the payee's address (`payoutAddress`).

**A person's payout to another chain takes the agent's route** (`docs/superpowers/specs/2026-10-05-approval-payout-route-design.md`).
`choosePayoutRoute` (`src/lib/payout-route.ts`) is the one rule for the AP stage and Approve and pay: Gateway when its
balance covers the amount and its fee and it costs no more than CCTP, CCTP otherwise, and a route an earlier attempt took
is kept. `payoutFundsShort` counts what leaves from where it leaves: a CCTP payout's amount and fee from the operating
wallet, a Gateway payout's from the Gateway balance. The Approvals card names the route and its fee, and its cost box
(`approvalCost`, `src/lib/approval-cost.ts`, docs/superpowers/specs/2026-10-22-approval-total-cost-design.md) adds them
up as Approve and pay would pay now: the invoice, a discount `amountToPay` still applies, the route's fee as read for the
listing, what leaves the balance that pays it, and what the payee receives ("at least" for CCTP). Arc's network fee is a
note at `ARC_FEE_USD`, never added (it is not read before the transfer), only where the network's wallets are EOAs
that pay their own gas (`walletAccountType`), and never for Gateway. The box is not shown for a payment already
sent, in flight or processing. A bank payout's is `bankPayoutCost` (docs/superpowers/specs/2026-10-22-bank-route-comparison-design.md):
the invoice, BlindPay's `feesSender` (its quote takes them from what the vendor receives) and what leaves, with what
USDC to a wallet would give the vendor; none without the listing's quote, or while a discount applies, since the quote
is read for the full amount. Both end with a bill's late fee (`lateFeeLine`: "Late after" the day before it starts, and
a month's fee), never added to what leaves.

**A payee with no wallet creates one with a passkey** (`docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md`).
- **On a payee link:** the address field stays the primary path. On Arc testnet, when
  `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_KEY` and `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL` are set, a secondary button
  creates a Circle Modular Wallets smart account owned by a WebAuthn passkey. Its counterfactual address is sent like a
  typed one and confirmed by a person.
- **At `/wallet`:** the payee opens it with the passkey and sends USDC as a user operation whose gas Circle Gas Station
  pays.
- **Code:** `src/lib/passkey-wallet.ts` holds the order, the failures and the passkey's name, with the SDK injected,
  and imports viem's types only, since a payee link loads it. The name keeps to Circle's rule (5 to 50 letters,
  digits and _@.:+-, never asked twice), which `tests/passkey-wallet-sdk.test.ts` holds its faked Circle to. `src/lib/passkey-wallet-send.ts` holds the balance, the send checks and the
  send's outcome (sent, reverted, or taken with no receipt yet), for `/wallet`. `src/lib/passkey-wallet-sdk.ts` binds
  `@circle-fin/modular-wallets-core`, signs under the passkey's own rpId, and is imported dynamically, so the address
  path never loads it. The chain's Modular Wallets path lives in the network profile (`modularWallets`). Nothing about a
  passkey is stored server-side.

**A person's payment draws on the reserve, and a person's cash back stays**
(`docs/superpowers/specs/2026-10-05-approval-cash-from-reserve-design.md`).
- **Approve and pay, and Pay now on a milestone:** a new USDC payment from the operating wallet that the wallet cannot
  cover brings the difference back from the reserve first (`reserveCover`, `bringCashForApproval` in
  `src/lib/agent/liquidity.ts`). It runs after the decision is claimed and before approvals are used. It is recorded as
  `cash_brought_back` with reason `approval`.
- **The treasury stage:** for 24 hours after a person's own Bring cash back it sweeps nothing (`recentPersonCashBack`,
  `keepPersonCashBack`, and `noSweepUntil` in `treasuryBounds`).

**Two approvals above a figure** (`docs/superpowers/specs/2026-10-05-two-approvals-design.md`, phase 2 of the mainnet
plan, on Arc testnet).
- **The figure:** `approval_policies.two_approvals_above`, one per workspace, an owner's to set (`approval.policy`),
  off by default (migration 0076). Turning it on or lowering it needs two people who can approve payments. Each change is
  signed as `approval_policy_changed`.
- **The rule** (`src/lib/two-approvals.ts`): strictly above the figure, weighing a EURC payment at its USDC value, and
  one with none as above.
- **The agent's side:** the AP and contractor stages read the figure once and hold a payment above it as
  `workspace.two_approvals`, after the payment's own checks and before the spending limit, the contract on Arc and any
  swap. The follow-up reopens it once the figure no longer covers it.
- **A person's side** (`src/lib/agent/second-approval.ts`):
  - Approve and pay and Pay now record a first approval in `payment_approvals`, bound to the amount, currency and address,
    and send nothing (`approval_given`).
  - A second approval by another person pays it, and the open approvals are marked used. The paying approval is never
    stored before the claim, and approvals that cannot be marked used send nothing.
  - An approval stops counting once the payment changes, or its giver can no longer approve (`approvers_among`).
  - As many of the two as can must come from people who neither entered the payment nor gave a first payment's
    address; those two give the rest only when no one else can (`approvers_besides`, `mayApproveNow`).
    `claim_invoice_decision` lets whoever entered it claim the second approval when another person's is on file. With
    fewer than two approvers in all, no approval is taken.
  - Reject, Return and Close clear the approvals; a transfer already sent is recorded on one approval.
- **An accountant's co-sign** (`docs/superpowers/specs/2026-10-22-accountant-cosign-design.md`):
  - **The setting:** `approval_policies.accountant_cosigns`, an owner's, off by default (migration 0138), signed as
    `accountant_cosign_changed`. `readAccountantCosign` reads it off before 0138.
  - **Who:** `cosignsNow(role)` holds for the accountant (`approval.cosign`) while it is on.
    `cosignInvoiceAction` calls `approveAndPay({ cosign: true })`, which:
    - runs every check an approval does;
    - refuses a bill one approval pays (`cosign_not_needed`);
    - records the co-sign in `payment_approvals` as `approval_given` with `cosign: true`, even when another approval
      stands;
    - throws before any fee, claim or send if a co-sign ever got past that point.
  - **Counting:** migration 0138 redefines `approvers_among` to count accountants while the setting is on, so a co-sign
    stands for the approval that pays and for `claim_invoice_decision`. The new `cosigners_besides` adds them, for
    bills only, through `billApproversBesides`, to:
    - the second-approver check;
    - `mayGiveApproval` and `twoApprovalsFacts`;
    - the figure's `too_few_approvers`;
    - the payee lock's `giver_confirms`.

    It counts one accountant at most, since a co-sign never pays. Milestones keep `approversBesides`, and read their
    approvals with `deciders_among` (owners, admins and approvers; `approvers_among` before 0138).
  - **Addresses:** `confirmCounterpartyAddressAction` takes whoever decides payments or a co-signing accountant.
  - **What can be co-signed now** (`docs/superpowers/specs/2026-10-22-accountant-queue-design.md`,
    `src/lib/cosign-state.ts`): one answer for the accountant console and the approval card, so neither offers a co-sign
    `approveAndPay` would refuse.
    - `cosignState`, pure (`cosign-state-rules.ts`), answers `can_cosign`, `cosigned`, `not_needed` (below the figure, a
      transfer exists, two approvals stand, or another accountant's co-sign does) or `blocked`, with the server's first
      refusal in words: a verdict waited for or disagreed with, a claim in progress, high risk, a payee with no address
      where payments are real (`no_address`), a frozen payee, an address to confirm or its wait under the payee lock.
    - `readCosignStates` reads its facts in the workspace in scope, a handful of requests however many bills: the figure
      with the lock, a EURC bill's recorded USDC value, payment intents, `twoApprovalsFacts`, `deciders_among` for which
      lone approval is a co-sign, `verdictHolds` for every bill still to be decided (a verdict comes first in the
      server's order), then, for the bills nothing else blocks, frozen payees, the payees paid to a bank account (while
      the lock is on, or where `chainModes` says payments are real and a payee has no address) and the payees' address
      state while the lock is on. No quote, balance or Circle call.
    - Approvals reads it for a co-signing accountant: Co-sign shows only for `can_cosign`, a `blocked` reason shows in
      its place. Unread, the card offers Co-sign as before and the server refuses what it must. A first payment that
      leaves the accountant out, a bill they entered and a commission's partner are left to the card's refusal when
      Co-sign is clicked.

**Trying a limit on past decisions** (`docs/superpowers/specs/2026-10-10-policy-replay-design.md`).
- **What it replays** (`replayDecisions`, `src/lib/policy-replay.ts`, pure): the agent's `ap_*` and `milestone_*`
  decisions in the window, by ledger sequence, twice: under the figures in force (each counterparty's
  `baseline_payment_limit`, `approval_policies`, `agent_budgets`) and with one candidate swapped in. No model is asked.
- **The checks:** the stages of `enforceApGuardrails`, and of the contractor stage for a release, in their order. The
  three figure checks are run again: the payment limit for the risk the decision recorded (`paymentLimitForRisk`), two
  approvals, and the spending limit against running UTC-day and 7-day totals carried from decision to decision, with the
  six days before the window counted as recorded. Every other check is read from the recorded `guardrailRule`: passed
  before it, fired at it, and settled past it only from the facts (no `payout`, a USDC bill, `observed.newPayee`, a
  bill's recorded `onChainLimit`, a bill's recorded `vendorDocument`, which fires `invoice.vendor_document` after every
  other rule of `enforceApGuardrails`); anything else is can't tell. A bill paid earlier in the replay counts once: a later
  decision on it, paid in either column, is unchanged.
- **Running totals:** a decision let through counts what it paid, or its full USDC value if a rule stopped it then; a
  schedule a rule stopped then counts from nothing to its value on its `payOn` day, when the agent decides it again.
  The contractor stage writes a milestone it holds at once and a release it planned (and counted against the limit at
  once) only after the batch is sent, so within one stage, between `cycle_complete` entries, a held milestone and a
  planned release weigh each other at the high end only. Shadow mode spends nothing: a bill's entry says so, and a
  milestone's only when held for a verdict; for one a rule stopped, `readShadowMode` and the network (never on Arc
  mainnet) settle it where they can, and otherwise it counts from nothing to its value.
- **Can't tell** is counted, never guessed: an entry without an amount, decision or known rule, a missing risk level,
  an unsettled check, a spending-limit check whose low and high running totals disagree, or a contract refusal for want
  of room under other figures.
- **Reading and the action:** `ruleReplay` (`src/lib/policy-replay-read.ts`) parses the candidate with the setting's own
  parser and reads the window's decisions and cycle ends in pages (at most 20 of 1,000 each), and shadow mode's start.
  `tryRuleAction` authorizes the permission that changes the setting (`records.write`, `approval.policy`,
  `agent.budget`) and changes nothing.
- **Applying it** posts the setting's own form to its own action. `policy-replay-apply.ts` reads the figure tried
  and replays again on the server; `changeCounterpartyLimit`, `changeTwoApprovals` and `changeAgentBudget` refuse
  with `stale` when the figure in force is no longer the one tried, and add `detail.replay` (window and counts) to
  their signed entry. The contract on Arc, maker and checker and every other protection are unchanged by it.

**A network for every workspace** (`docs/superpowers/specs/2026-10-05-network-foundation-design.md`, phase 1 of the
mainnet plan).
- **The column:** `orgs.network` is `arc-testnet` or `arc-mainnet`, Arc testnet by default (migration 0075).
  - A trigger locks it once the workspace went live or holds a Circle wallet, so mainnet is always a workspace of its
    own. Since 0078, any account locks it: the network is chosen when the workspace is created.
  - `payment_intents.network` is filled from the workspace when an intent is inserted, so no caller can mislabel one.
- **The profile:** `src/lib/network.ts` holds each network's facts.
  - Its name in copy, Circle's blockchain name, chain id, RPC, explorer and tokens.
  - The chains a payee can be paid on, its own first (each with its CCTP domain, USDC, RPC and explorer).
  - CCTP (domain, Iris, TokenMessenger), Gateway (API, facilitator, wallet, minter), USYC, and the swap's chain and
    Adapter.
  - Where USDC can be brought from into it (`inbound`): Arc's CCTP domain, Iris, and the source chains with their USDC
    and TokenMessengerV2, checked against App Kit's chain table in tests. `cctp` is for paying out of it.
  - Whether hosted wallets and passkey wallets are offered.
- **Mainnet pays nothing unless a deployment opens it** (phase 2a, below):
  - `orgConfig` carries the network. While Arc mainnet is off, a workspace on it gets no Circle credentials, with the
    reason, so its provider refuses.
  - Go live refuses a Circle key whose prefix names another network.
- **`/open`:** one section per network. A network where a payment settled in the period gets the full section, Arc
  mainnet first, and the first one's headline figures sit under the page's heading, named as that network's. One with no
  payment yet, or whose numbers cannot be read, is a compact card after them.
  - `open_numbers`, `open_first_payments` and `open_outcomes` take `(p_since, p_network)` and count one network.
  - `open_verdicts(p_since, p_network)` (0086) counts the shadow mode verdicts given on payables, never a sample payee's,
    and how many agreed; /open shows customers' share beneath the agent's cards once one is given, and a row in Every
    figure. Read like `open_outcomes`: until it can be read, its figures are dashes and the rest of /open shows.
  - Their one-argument versions stay for older code.
  - `open_funnel(p_since, p_network)` (0089, `docs/superpowers/specs/2026-10-09-activation-funnel-design.md`) counts
    the workspaces opened in the period and how many reached each step: a real bill, the agent's decision on one, a
    confirmed live payment, payments on two UTC days, a verdict, two people. `npm run numbers` prints it per network
    (`src/lib/platform/funnel.ts`); /open does not show it.
- **The landing, the bill's journey** (`docs/superpowers/specs/2026-10-19-bill-journey-design.md`): the sole h1 is
  "Your AI agent for bills and payments", with "Every bill. A clear way through." as a large display paragraph. The
  hero has an application frame (workspace sidebar, bill status and verification actions), followed by a five-stage
  process explanation and the same actual team bill's recorded evidence. How to start, small-business examples, safety,
  public figures, integrations, developer entry, questions and the close retain their actions and claims.
  - One call to action everywhere (`src/components/landing/cta.ts`): `/onboarding?shadow=1`, which opens a workspace
    with shadow mode ticked; the sign-in page says what follows the link when that is where it leads.
  - Each call to action carries `data-cta`; Google Analytics, where it runs, sends `cta_click` with that name and the
    redacted path, nothing else. Activation itself is read from the database (`/admin/growth`).
  - Safety and control (`src/components/landing/Safety.tsx`): three principles, each saying what holds it (the team,
    rules in code and Arc mainnet's spending-limit contract, the signed ledger), then two past cases step by step, each
    labelled with its network and its own mode in the team's workspace. A past decision's facts do not change, so they
    are written there rather than read, and the page makes no read for either case:
    - a refusal (`safety-example.ts`: historical ledger entry #3710 in a team workspace in shadow mode on Arc testnet,
      refused by `workspace.outflow_budget`);
    - the payee lock, named and explained apart from the steps, with how it is set and why a wait helps
      (`payee-lock-example.ts`, spec `2026-10-26-landing-payee-lock-design.md`): in the team's live workspace on Arc
      testnet on Oct 20, 2026, a vendor's address changed (#4839), the agent's payment was held as
      `counterparty.address_unconfirmed` (#4843), the member who entered the address could not confirm it and a second
      member did (#4863), it was held again as `counterparty.cooling_off` for the 4-hour wait (#4866), then paid
      (#4919). Each step shows the time its entry was recorded and says only what happened in that workspace, never how
      the lock works in general: what its ledger recorded, the refused confirmation (from the lock's rollout record,
      not a ledger entry, as the page says) and the new wallet's balance on chain. On a wide screen the explanation
      keeps its own height in the left column, the proof right under it, and the steps run down the right.
      The proof links transaction `0x49787501…0551` and tells its block time (15:16:04 UTC, block 68200055)
      from the ledger's (15:16:07 UTC). It says the lock is held by code and people, not by a contract: the transaction
      shows only that the payment settled after both holds ended, to the confirmed address, for the bill's amount. Its
      links open the committed source and `/docs/guides/first-payment#payee-lock`, unprefetched.
  - Integrations (`src/components/landing/Integrations.tsx`): Xero and QuickBooks Online first, each with what comes in
    and what goes back; Xero's loop in four steps, labelled as the supported workflow rather than one payment; the nine
    other tools in three rows of three, each linking to its guide; then Arc and Circle as what the payments run on. Each
    sentence is held to the tool's guide by `tests/brand-marks.test.tsx`. "Explore all integrations" leads to
    `/docs/guides/integrations`, one table of what each tool brings in, writes back and never does.
  - For developers (`src/components/landing/BuildOnIt.tsx`): for builders, where the integrations are for business
    teams. Three short benefits, the quickstart as the one primary action and the repository beside it, then
    `CodeShowcase`: tabs for the API, the SDK and MCP, each the snippet its guide gives (`build/snippets.ts`),
    highlighted by `build/highlight.ts` without changing a character, with a copy button for exactly that code.
    `tests/landing-build-on-it.test.tsx` holds each snippet to the OpenAPI operations, the SDK guide and the MCP guide.
  - The technical showcase is `/how-it-decides`: the decision receipt replayed in its arch beside the live ledger's
    head, the decision loop step by step, and the claims with the receipts behind them.
  - The questions' answer about Arc mainnet says it is open to anyone only while `MAINNET_ALLOWLIST` holds `*`
    (`mainnetOpenToEveryone`).
  - `LandingPage` remains synchronous. It starts both networks' open numbers, latest/recent decisions and one shared
    team-journey read; Hero and BillJourney consume that same promise inside evidence-only Suspense boundaries.
    Positioning, calls to action, application frame and process explanations arrive in the first HTML. Unavailable
    evidence is labelled, never substituted with the historical featured payment. `EvidencePending` offers a noscript
    link to `/open`, whose page awaits its reads on the server, and hides permanent loading placeholders without
    JavaScript. The static story remains visible; live landing facts and browser signature checks require JavaScript.
- **The landing's latest decision** (`docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md`): the newest
  decision the agent made in one of the team's own live workspaces, in the landing's proof (a band of its own on
  /studios).
  - `latest_team_decision()` (0087), the service role's alone, looks only where `/open` lists payments from: the
    founding workspace and those a team member created, never a sample payee's decision. It returns facts that name no
    one (action, amount, network, model, policy agreement, code's verdict, why a hold held, a person's verdict, the
    transaction) and the entry's signed chain fields; never its summary, reasoning, names or ids. Since 0088 the
    transaction includes the payment a person sent after the agent held it (a shadow mode verdict, an approval): the
    bill's or milestone's confirmed payment intent.
  - `src/lib/platform/latest-decision.ts` reads it at most once a minute and adds the signing workspace's public keys;
    the workspace's id stays there. `src/lib/latest-decision.ts` says it in words.
  - The reader's browser checks the signature and the link to the entry before it with `verifySignedLink`, the
    receipt verifier's half that needs no body. Until 0087 runs, or when the read fails, there is no band.
  - The landing shows it as a line under the agent's decisions (`LatestLine`, in the proof), with an independently
    read list of earlier decisions. `LatestPanel` also remains available for pages that show the full card: (`docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md`):
    `recent_team_decisions()` (0100), the service role's alone, reads the same workspaces on the same terms (and never
    a simulated payment's decision), one decision per bill (its newest) out of the newest 500, and counts each
    network's decisions in the past 7 days apart.
    Its rows carry no signature and no workspace id. `src/lib/platform/recent-decisions.ts` reads it at most once a
    minute; `recentDecisionView` says what came of each (paid, held, refused by code...) and why, and links a
    transaction only when one went out. The list shows rows strictly older than the latest decision. Until 0100 runs,
    or when the read fails, the latest decision stands alone.
- **The landing's team journey**: `landing_team_journeys()` (0134) is a stable, read-only, service-role-only
  function. It selects the newest eligible direct and Base payments independently from live Arc mainnet workspaces
  created by the platform team or the founding workspace; customer/sample bills, simulated/failed/pending payments,
  Gateway routes and unconfirmed Base mints are excluded. Joins use both workspace and target identities.
  - `src/lib/platform/team-journeys.ts` caches successful reads for about one minute and discards failures. The private
    workspace identity is used only inside `withOrg` to fetch signing public keys and, for a schedule, the selected
    entry's detail matched by sequence, action, actor and signed body hash, then stripped. No landing read
    writes, creates a receipt link, sends a payment or changes a workspace.
  - Before the additive function is released, only a missing-function error may use the existing
    `latest_team_decision()` eligible-team selector, recheck its live/mainnet workspace and read payment/bill/ledger
    facts through `withOrg`/`db()`. This narrower selection may leave a route unavailable. Other errors resolve null.
  - `src/lib/team-journey.ts` validates the public projection and constructs explorer links from recorded chains.
    Amount/currency come from confirmed intents; Base requires both an Arc burn and a Base mint. Dates are recording
    instants, never invented execution/block times or elapsed durations. Missing intake, checks, hold, approval and
    recording entries remain unknown, including capped reads. `teamJourneyDecision` condenses a recorded schedule to
    its validated day and a known no-discount reason only when the recorded timing sentence and facts agree; otherwise
    its reason stays unknown. Missing detail cannot hide an otherwise confirmed payment. No private names, raw
    reasoning, purchase-order references, person ids or source/workspace ids reach the rendered view; known rule codes
    and boolean observations are allowed.
  - Hero and BillJourney share `selectTeamJourneys`, ranking the two validated RPC candidates by a complete story:
    a supported decision (a schedule needs its day), a hold with known wording, approval, payment entry and recorded
    confirmation. Missing intake and nullable schedule reasons do not disqualify it. Complete Base wins a tie, then
    complete direct; only with neither complete does direct take precedence over Base. The hero's entry links always
    resolve to that same bill's detailed evidence. The remaining payment appears in the dark “Another team payment”
    panel, using its own route, confirmation, fee and explorer links. They explicitly identify the team workspace.
    Each available ledger event has the existing browser signature check; it verifies the signed hash link, not the
    public description or payment settlement. Arc/Base explorer links verify the respective transactions separately.
  - The hero shows the recorded agent decision, the code's hold in plain words and a human approval followed by the
    confirmed destination/time, each linked to its own entry. Its fee comes from the confirmed intent, rounded to three
    decimals with exact precision in the title and full journey. Preview labels come from the app's shared navigation;
    hero text is at least 12px and the three steps stack in narrow panes. Card links leave 5rem of scroll margin so
    keyboard focus stays below the sticky site header. The desktop columns align at the top so streamed card growth
    does not recenter the positioning copy. The frame is HTML, not a screenshot.
- **The landing's proof**: independently streamed latest/recent team decisions and public measurements from every
  workspace, never the founding workspace alone. Historical `featured-proof.ts` is no longer imported by the landing.
  - The measurements are the open numbers, all time (`readAllTimeOrNull`), in three groups. Customer activity is
    customers' own figures alone, on Arc testnet, with where customers stand on Arc mainnet. Agent decisions gives
    each network's model decisions and code refusals beside their sum, and customers' shadow-mode verdicts; a verdict
    count that cannot be read says so, never "None yet". Payments settled gives each network on its own, real USDC
    never added to test USDC, saying whose payments they are and linking the team's latest one on its explorer. A
    network whose numbers cannot be read says so, and the others still show.
  - The live legs (`src/components/landing/provenance.ts`, `ProvenanceBar` and `ProvenanceList`) are no longer on the
    landing; the components stay, with their tests.
- **Motion** (`docs/superpowers/specs/2026-10-08-landing-motion-design.md`): reduced motion removes movement, not every
  change. Under `prefers-reduced-motion: reduce`, `globals.css` keeps transitions for opacity and colours only and cuts
  keyframe animations, except on an element marked `data-calm-motion`; `Reveal` fades without lifting. Each moving
  piece has a designed reduced state. On /how-it-decides, "How a decision becomes an action"
  (`src/components/landing/pipeline/`) lights the step crossing the middle of the viewport and its part of a sticky
  diagram; the server's HTML lights every step. That page's receipt prints as calm motion under reduce, and publishes a beat (`hero/replay-beat.ts`) with the time
  its first line started; `ArchLights` climbs the arch's stones on that clock and rings the keystone in the outcome.
  The open numbers count up once when first seen (`CountUp`). "For developers" no longer types its snippets: they are
  static, so nothing there moves but the tab marker.
  - The landing's budget (M4): each piece plays once and is done within 2.5 s, hides nothing in the server's HTML, and
    nothing on / repeats forever at rest (`tests/motion-policy.test.ts` renders every section to check). `Reveal`
    counts content the reader jumped past as seen and shows it at once, and `<Reveal sequence>` brings in children
    marked `seq` one by one. The landing's tab marker glides in CSS (`useTabGlide`,
    `src/components/landing/tab-glide.ts`) rather than through `MotionProvider`, which would add about 31 KB for it.
    Its links into the docs are not prefetched (`landingPrefetch`). A counted figure holds its final width, and one
    under 10 fades in. The hero's sample bill (`hero/BillPreview.tsx`, a server component) prints itself once, each part
    at its moment in `BILL_PRINT_AT` (`hero/scenarios.ts`), done by 2.5 s and calm motion under reduce: in CSS from the
    page's first paint where it sits beside the headline (from 1024 px), and below that only through
    `hero/PrintOnView.tsx`, which holds each line still out of sight when the page hydrates and prints it once it is in
    view, in the order of the work.

**Every module on its workspace's network** (`docs/superpowers/specs/2026-10-05-network-threading-design.md`,
phase 1b).
- **Where the network comes from:**
  - Code acting for a workspace reads `workspaceNetwork()` (`src/lib/workspace-network.ts`). It throws outside a
    workspace's scope; there is no default.
  - Code holding a record reads the record's network: a payment intent's `network`, or the network a chain id
    belongs to (`networkOfChain`).
  - Pages read it in scope and pass it down: `Decision.network`, and a `network` prop on the panels that link.
- **One provider per network:** `getChainProvider()` builds the live and simulated providers for the workspace's
  profile (`provider.network`). Every chain fact they use comes from it: transfers, batches, fees, CCTP, Gateway,
  USYC and the swap.
- **Payee chains** (`src/lib/payee-chains.ts`):
  - `homeChain`, `chainsOn` and `chainOn` read a network's list. No chain is the network's own chain, and a chain
    from another network is refused in plain words.
  - `paidAcrossChains` is true for any network's other chains.
  - Links are `txUrl(network, hash)` and `addressUrl(network, address)`.
- **Wallets** (escrow, the spending limit, Gateway funding, a new workspace's accounts) are created on the profile's
  blockchain.
- **Arc mainnet pays Base and Arbitrum across chains** (docs/superpowers/specs/2026-10-19-mainnet-base-payouts-design.md,
  2026-10-22-arbitrum-mainnet-design.md): its payee chains are `ARC` (domain 26), `BASE` (domain 6) and `ARB` (domain 3), and its `cctp` is domain 26, `iris-api.circle.com` and
  TokenMessengerV2 `0x28b5…cf5d`. The CCTP payout code is the testnet one, unchanged: from the operating EOA of a
  workspace on its own Circle account (`wallet_host = 'own'`). A workspace paying through its spending-limit contract
  (`'external'`) pays it through version 2 of the contract (below); with version 1 it still holds the agent's payout
  (`workspace.onchain_limit_route`) and refuses a person's (`ContractRefusal`), since version 1 only does `transferFrom`
  on Arc.
  `counterparties_chain_check` allows `BASE` and `ARB` for a vendor; each is added in both 0044's rewrite list and 0078's constraint,
  since `db:migrate` re-runs both. 0044's rewrite now runs only before the check exists. A milestone is never paid
  across chains: `createMilestone` refuses a payee on another chain (`another_chain`), Contractors does not offer one, and
  `releaseMilestone` and the batch in `releaseMilestones` hold a release whose payee's chain is not the home chain
  (`milestonePayeeOnAnotherChain`; unreadable counts as another), and Pay now refuses one before its claim. The live slice carries a `BASE-SEPOLIA` vendor as `BASE`, and an `ARB-SEPOLIA` one as `ARB`, with no address (`MAINNET_CHAIN_OF`). A version 2 contract's `allowedDomains` are fixed at its deployment from the payee chains then (`spendingLimitTerms`), so one deployed before `ARB` joined pays Base only: `choosablePayeeChains` reads them from the contract (`contractAllowedDomains`, cached per contract, none offered while unreadable), and a payout it refuses is held by the agent ("it was not deployed to pay that chain") and refused by Approve and pay by name.
- **A feature a network lacks** refuses by name (`FeatureOffError`: "… does not run on Arc mainnet yet") and never
  falls back to testnet values. This covers Gateway, the USYC reserve, the EURC swap and hosted wallets, which
  the Go live panel leaves out there too. The agent's x402 buying is left out where Gateway does not run, without a
  line, so a mainnet cycle's log does not repeat it. Passkey wallets are simply not offered off Arc testnet.
- **Display reads the record's chain; decisions read the workspace's.** A row, a list or a receipt labels a payee by its
  own stored chain and never fails for one off the network. Approve and pay, and a chat's Approve, refuse such a chain
  in plain words before any claim.
- **Two ratchets:**
  - `tests/network-ratchet.test.ts` counts hard-coded testnet identifiers.
  - `tests/network-constants-ratchet.test.ts` counts readers of the testnet profile.
  - Both end at the files kept on Arc testnet on purpose, each with its reason: demo data, `/open`, the platform's
    x402 offer and the passkey wallet.
- **Copy names the workspace's network** (phase 2c, `docs/superpowers/specs/2026-10-06-mainnet-copy-design.md`).
  - Every message and page that belongs to a workspace, or to a link, record or receipt of one, takes the network's
    name from its profile's `label`: from `workspaceNetwork()` in scope, from `membership.network` on a page's client
    parts, from a payment's own `network`, from `provider.network`, or from a public link's chain.
  - Where Arc mainnet differs in substance, the text branches on the profile: `faucet` (Circle's on Arc testnet, none on
    Arc mainnet) and `hostedWallets`. A panel for a feature the network lacks (USYC, escrow, Gateway) is not drawn.
  - Signed ledger text is fixed forward; reasoning rebuilt on every view names the viewed workspace's network.
  - `tests/network-copy-ratchet.test.ts` counts "Arc testnet", "testnet USDC" and Circle's faucet in code, and allows
    them only in the files where they are true wherever they show, each with its count and reason: the platform's own
    pages, demo data, features only Arc testnet has, and branches that run only there.
- **`tests/network-mainnet-dry-run.test.ts`** builds the modules with Arc mainnet's profile and checks each asks for
  mainnet's facts or refuses by name.
- **Moved since:** the database's chain check, the two link functions and the API's chain enum in phase 2a; the copy
  that named Arc testnet whatever the network in phase 2c (below).

**Arc mainnet behind a switch** (`docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md`, phase 2a).
- **Two settings:** `MAINNET_ENABLED` (only `1`, `true` or `yes`) and `MAINNET_ALLOWLIST` (email addresses, or `*`
  for everyone), read into the config. `mayUseMainnet(email)` (`src/lib/mainnet.ts`) is both: on, and listed, or `*`
  listed. `*` is never implied, so a deployment that forgets the allowlist opens Arc mainnet to no one.
- **Created on mainnet, never moved there.** The onboarding form offers Arc mainnet only to an allowed person, and the
  action checks again. `createWorkspace({ network })` has `create_org` write the row's network on insert (0081),
  before the first account; 0078's lock then refuses any change once an account exists.
  - A mainnet workspace starts with one empty "Operating" account on `ARC`, no reserve, and an agent spending limit
    of 50 USDC a day and 150 USDC in 7 days (`MAINNET_STARTING_BUDGET`, `src/lib/mainnet.ts`). `changeAgentBudget`
    keeps a figure there, and `readOutflowBudget` reads the starting limit for a mainnet workspace whose
    `agent_budgets` row is missing or holds neither figure, since the tenant role can delete that row: the agent
    never pays on Arc mainnet without a limit, as `readTwoApprovalsAbove` never reads no figure there.
  - It also starts with two approvals above 100 USDC (`approval_policies`, phase 2b), which `changeTwoApprovals` keeps
    on there, and the payee lock on with no wait (`MAINNET_STARTING_PAYEE_LOCK`, in the same row; the figure alone before
    0135). `org_created` records the starting limits, the lock among them. The owner's checklist adds
    `payee_lock` after the payee (`readPayeeLockUsed`: done once a confirmation carried `payeeLock` or the lock changed).
- **Held until live.** `orgConfig` sets `chain.networkHold`: `MAINNET_OFF` while the deployment has it off (and the
  credentials are withheld), `MAINNET_NOT_LIVE` until the workspace is live.
  - `paymentsHold()` (`src/lib/payments-switch.ts`) reads the hold before the platform's switch, and
    `PaymentsDisabledError` carries the reason. Every gate the stop switch built refuses with it: the live provider's
    money methods, the direct Circle writers, the agent's cycle, and a person's payments.
  - Approve and pay, and Pay now, refuse a network hold first, before the provider is built.
- **Never simulated.** `getChainProvider` refuses a mainnet workspace with no Circle credentials
  (`MAINNET_NOT_CONNECTED`) rather than hand it the simulator, and `chainModes` reads it as a page safely. Sample
  data is refused there. The hybrid provider's simulated reserve refuses where the network has no USYC.
- **EOA wallets.** The profile's `walletAccountType` is `EOA` on mainnet, which pays its own gas.
  - `createTreasuryWallets` asks for that type, on a chain the network pays on; an account on another network's
    chain is refused.
  - The operating balance keeps `gasReserveUsdc` (0.10) aside.
  - A batch is never tried on an EOA network, and the provider refuses one.
  - Escrow and enforcing the spending limit in a contract are off there (`escrow`, `spendingLimitContract`), by name.
- **Stablecoins by contract** (`src/lib/circle/stablecoins.ts`): on the network's own chain, USDC is Arc's native
  token or the ERC-20 at the profile's address, and EURC the ERC-20 at its address. On another payee chain, USDC is
  only that chain's own USDC. This applies to the token a transfer sends, the balance and money in. Circle lists both
  USDC entries for an Arc wallet, with one balance; the ERC-20 is the one sent, whichever comes first, since its
  `transfer()` never calls the recipient and a payee that is a contract is paid. The platform's
  `CIRCLE_USDC_TOKEN_ID` is Arc testnet's alone, and where it is set it names the token sent there instead.
- **Receipts** read a native USDC transfer from Arc's system emitter `0xffff…fffE` (EIP-7708) on both networks.
- **Going live:** each step needs `mayUseMainnet` for the person. A test key is refused on mainnet, naming both
  networks. Go live needs the word `mainnet` typed, and the profile's `goLiveOpen`. Arc mainnet's opened with the copy
  that names it (phase 2c); the check stays, so a network added later goes live only once it is opened by name.
  `workspace_went_live` and `org_created` record the network.
- **Elsewhere:**
  - Chats refuse a mainnet payment ("approved in Vestiarion").
  - The API's `chain` enum is every network's chains, and SDK 0.3.0 types it.
  - The workspace layout reads `MainnetBanner`, drawn under each page's header.
  - 0078 accepts `ARC` in `counterparties_chain_check` (0044's rewrite keeps it) and names the home chain in both
    link functions.

**Payment safety** (`docs/superpowers/specs/2026-10-05-payment-safety-design.md`) closes four gaps that real money
would find.
- **A stop switch for the platform** (`src/lib/payments-switch.ts`), with two halves; either one stops payments.
  - `PAYMENTS_DISABLED` on the deployment becomes `paymentsDisabled` in the config.
  - `platform_controls.payments_disabled_at` (migration 0074) is set and cleared with `npm run payments`. Every
    check reads it, cached for 10 seconds, so every running deployment stops at once, with no redeploy. That
    includes one a console tab is pinned to by skew protection.
  - A read that fails stops money, never a page, and a table not yet created reads as on.
  - The live provider's money methods refuse before reading an account; `getChainProvider` hands it the switch.
  - So do the direct Circle writers: escrow holds and setup, Gateway funding, and enforcing or changing the spending
    limit. Turning the limit off stays allowed, since it only takes the agent's power to pay away.
  - `runAgentCycle` refuses first. The schedule and the FX watcher skip every workspace as `payments_off`, and
    event cycles drop quietly.
  - Approve and pay, Pay now and Bring cash back refuse before any claim, and the workspace layout reads
    `PaymentsOffBanner`, with the recorded reason, which each page draws under its header.
  - Approve and pay, and Pay now, still record a transfer already sent; that only reads Circle.
  - The agent's purchases from its service budget check the switch too.
- **Addresses checked where they enter:** the console's forms and `POST /api/v1/counterparties` refuse an address
  that mixes cases against its EIP-55 checksum (`src/lib/address-checksum.ts`).
- **No rejection over an unknown transfer:**
  - A send can end without Circle saying what became of it: the deadline, a connection dropped after the request
    left, a 5xx, or an answer with no id. The live provider's `sendToCircle` then writes "may or may not have been
    accepted" into the error, and Gateway's transfer the same (`src/lib/circle/gateway.ts`).
  - `unknownSend` (`src/lib/payments.ts`) reads that on a failed intent with no provider id. It also reads a send
    left `submitting` for more than 2 minutes. The execution of such an intent is pending, never failed.
  - `executePayment` looks for it before sending anything again. `findTransferByRef` searches by the payment's
    memo (`paymentMemo`), in the wallet it went from (`payment_intents.sent_wallet_id`, written before each
    send), around the send, and leaves out earlier attempts.
    - Found: recorded.
    - Not listed 15 minutes after the send: recorded as never taken (`NO_EARLIER_SEND`), and sent as new.
    - Otherwise: nothing is sent, and the payment stays in flight.
  - Gateway and CCTP are not looked up. They keep their own safety, and their marker survives a later failure.
  - Reject, Return, Add details and a milestone's Close run the same lookup first (`settleUnknownSend`). A held
    milestone shows an `unknown` state.
  - So do the cycle's reconciles (`earlierSend` in `reconcileApInvoice` and `reconcileMilestone`), before any check
    that would hold the payment or decision that would pay it again. They see a `submitting` intent with no Circle id,
    and a `failed` one Circle never answered (`transferUnknown`), which `paymentIntentsFor` hands them as `unanswered`
    rather than leaving its source to be decided again unlooked:
    - Found: reconciled as a transfer that exists, so it is recorded paid, never held or flagged over a check a resend
      or a new decision would fail. So is one another lookup recorded since the stage read it (`known` with
      `recorded`): a lost batch's other members, which the batch's lookup recorded while looking for the first, are
      reconciled in the same cycle. A release that exists is only read (`releaseMilestone`'s `onlyRead`, which Pay now
      passes too when it only checks a transfer already sent): an escrow hold's checks are for a new release, so one
      already sent from a hold for the contractor's old address is recorded paid, and the hold marked released once
      confirmed (`lockedInEscrow`). Only a new release from such a hold waits for a person.
    - Never taken: a `submitting` one goes on to the resend checks (high risk, unconfirmed address, new payee, two
      approvals) and is sent again; an `unanswered` one is handed back (`decideAgain`), writing nothing, and the stage
      decides it again through the model and every guardrail, cash check included.
    - A payable a resend check held (`notResubmittedBecause`) is reopened by the follow-up once what held it ends:
      the payee lock's wait, a person's confirmation of the address, or a second person behind it.
      `payableDecisionFacts` keeps the facts of the decision before the reconcile, with only that hold; a payment
      agreed to in shadow mode keeps its verdict hold, which only a person ends. `fxRecheckCandidates` reads the
      reconcile as the latest word too, so no quote is asked for it. The AP stage then decides it with every
      guardrail and pays it on the same intent: `failed` with `NO_EARLIER_SEND`, claimed and sent under the payment's
      own key, never in a batch, which takes only `created` intents. A payment decided again after that finds its
      intent confirmed and sends nothing.
    - A payout to another chain cannot be looked up (`unlookable`) and is taken as never taken: checked, or decided
      again, before it is asked for again under its key, so it can be held while Circle may hold the transfer. Held
      that way, its entry records `earlierSendNotLookedUp: true` and the follow-up does not reopen it: its intent is
      still `submitting`, and asked for again under that key at a changed address it would be refused (review M1), so
      a person checks it with Circle first.
    - Not listed yet, not asked, or settled by another request right now (`settling`): the invoice stays `matched`
      (the milestone `verified`), nothing is written to it, and `ap_reconcile` (`milestone_reconcile`) records
      `reconciled: false` with the reason. With no operating account nothing is looked for, and it stays as it is.
  - A send asked for again under a key Circle may hold (an unknown send no lookup could settle) is refused when it
    names another address than the one recorded: Circle would answer with the first transfer (review M1).
  - A bridge's approve, and a Gateway connection never made, are not marked.
- **Screening that fails closed:** `orgConfig` marks a live workspace on a deployment with no screening service
  (`compliance.serviceRequired`). `screenName` then gives no verdict rather than the bundled list's, so its
  counterparties stay `unscreened`.
- **Screening providers** (`docs/superpowers/specs/2026-10-21-screening-providers-design.md`,
  `src/lib/screening/providers.ts`): `screenName` screens through the provider the deployment names.
  - `screeningSettingsFromEnv` (`src/lib/config.ts`) reads `SCREENING_PROVIDER`, `SCREENING_API_URL` and
    `SCREENING_API_KEY`; only when none is set does it read `OPENSANCTIONS_API_URL` and `OPENSANCTIONS_API_KEY` (a
    URL alone is `opensanctions`), so a key never reaches an address set apart from it. `opensanctions` without a key,
    `yente` without a URL, an address or key with no provider, or an unknown name is a `ConfigError` at start. The
    address stays in `compliance.openSanctionsUrl`, the provider in `compliance.screeningProvider`; a sandbox's
    `orgConfig` drops all three.
  - Both providers send yente's match query and classify with `classifyYenteCandidate` (a sanctions match at 0.85
    or more is high, any other match medium); each records its own `source` (`opensanctions:yente`,
    `yente:self-hosted`), as do a failed check and the sweep's `compliance_sweep` entry. `providerOfSource` and
    `PROVIDER_NAMES` name it in `screeningSourceLabel` and the evidence chain. Another service is one more entry in
    the registry.
  - `checkScreening` (`src/lib/screening/check.ts`, `npm run screening:check`) screens one name with the
    environment's provider, printing the address's origin and never the key. It prints from `runScreeningCheck`,
    which returns the same check structured (setup, ms, HTTP status, verdict); a provider's own error comes back
    with the key and every address but its origin taken out (`redactScreeningSecrets`).
- **Screening health** (`docs/superpowers/specs/2026-10-22-screening-health-design.md`): configured is not working.
  - A provider's HTTP error is a `ScreeningHttpError` (`providers.ts`) with its status and kind (`key_refused` for
    401/403, `over_quota` for 429, `provider_down` for 5xx), and the message failed checks always recorded.
    `applyScreening` keeps it as its wrapper's `cause`; `screeningHttpFailure` finds it.
  - `shellStatus` reads the workspace's newest live check (`readNewestLiveCheck`, `src/lib/screening/health.ts`)
    beside shadow mode, only where screening is live: one `limit 1` query on migration 0139's partial index
    `compliance_checks_live_newest`. When it failed, the header's Screening row says "Live, last lookup failed" in
    the held tone. Compliance shows owners and admins "Last successful live screening" (`lastLiveSuccessLine`).
  - Live means a lookup of the provider. A verdict on a payout address on OFAC's list (source `ofac-sdn`,
    `OFAC_ADDRESS_SOURCE` in `src/lib/sanctioned-wallets.ts`) is written as live but calls no provider, so both reads
    and `screening_health()` leave it out by its source; its `live` mode still decides when a counterparty is due.
  - Check now writes no check, so after a key change a workspace's header and Compliance line move only with its next
    live lookup, its next agent cycle (`docs/self-hosting.md`, "Changing the screening key").
  - `/admin/screening`, for the platform team: see the founder dashboard below.
- **Sanctioned payout addresses** (`docs/superpowers/specs/2026-10-21-sanctioned-wallets-design.md`,
  `src/lib/sanctioned-wallets.ts`): `parseSdnWallets` reads the EVM "Digital Currency Address" entries from OFAC's
  `SDN.CSV` and `SDN_COMMENTS.CSV` together, since remarks overflow into the second file.
  - `loadSanctionedWallets` reads them live when `compliance.sanctionedWalletsLive` (production, or
    `SANCTIONED_WALLETS=live`), keeping them 12 hours per instance. A failed or thin read keeps the last list, else the
    dated snapshot `src/lib/data/ofac-sdn-evm-wallets.json` (`scripts/ofac-sdn-wallets.mjs`).
  - `runComplianceSweep` screens every counterparty whose address is on it and whose verdict does not name it yet
    (`walletVerdictDue`), due or not. `applyScreening` then takes `walletScreening`'s verdict (high, `ofac-sdn`,
    `ofac-sdn-<entry>`) over the name's, and ignores dismissals. The sweep entry records `sanctionedWallets`.
  - One read runs at a time per instance, a failed one waits 30 minutes before the next, and a read counts only with
    comment rows and at least half the snapshot's addresses.
  - `screenCounterparty` uses `cachedSanctionedWallets` without the network. Only a live list clears a verdict an
    address gave (`risk_entity_id` `ofac-sdn-…`): with the snapshot it keeps it and writes nothing.
  - `approveAndPay` and `payHeldMilestone` refuse such an address before any claim (`sanctioned_address`), since an
    approval can confirm and pay a changed address before a sweep reads it. They load the list live where the
    deployment does.
  - The AP stage's guardrail input and the contractor stage take such an address as high risk at the moment they would
    pay, from the list this cycle's sweep read.

**Settings** (`/o/[slug]/settings`) is one page in six groups: You, Workspace, Developers, Integrations,
Security and Danger zone (`docs/superpowers/specs/2026-10-04-settings-structure-design.md`). The page lists every
section once, each with its heading's id and `null` where this viewer or deployment does not get it, and
`SettingsSections` (`src/components/SettingsSections.tsx`) draws the groups and their contents from that one list: a
column beside the sections from `xl`, marking the one being read, and a list above them on a narrower screen. Links
into Settings use a section heading's id, such as `#go-live-title` or `#usyc-reserve-title`.

**Going live** is self-serve, owner only (`docs/superpowers/specs/2026-09-29-go-live-design.md`).
The **Go live** section of Settings, first under Workspace (`src/components/GoLivePanel.tsx`), renders
`goLiveStatus` (`src/lib/platform/go-live.ts`) — the step, whether credentials are stored, the
wallet addresses and when the workspace went live, never a credential or a wallet id — and drives
the three actions in `src/app/actions/go-live.ts`, each gated on `org.administer`:
`connectCircleAction` checks the pasted API key with Circle and stores both credentials as
envelopes bound to the organization and column (`circle_connected`, or `circle_reconnected`; once any account has a wallet, in any mode, only if they read every such
wallet back at its stored address in the treasury set); `createWalletsAction` fills in the treasury
wallet set and a wallet for each account that has none, in the owner's own entity, under a
per-account idempotency key and a write conditional on `circle_wallet_id is null` that also zeroes
the simulated balance (`treasury_wallets_created`); and `goLiveAction` proves the stored
credentials against every wallet again, then makes one conditional
`mode = 'live' where mode = 'sandbox'` update, bound to the API key envelope it proved
(`workspace_went_live`). The ledger records ids only,
every error an action returns is a fixed string, and a sandbox holding Circle credentials is never
deleted by the cleanup (migration `0029`). The step between wallets and going live reads the
operating wallet's on-chain balance through `refreshBalanceAction`, which returns the number alone.

**Hosted testnet wallets** (`docs/superpowers/specs/2026-09-30-hosted-wallets-design.md`) are an
explicit choice, never a fallback: `orgConfig` hands a workspace the platform's hosted pair
(`HOSTED_CIRCLE_API_KEY`, `HOSTED_CIRCLE_ENTITY_SECRET`, read only in `src/lib/config.ts`) only when
its own row says `wallet_host = 'hosted'`, which an owner sets through `chooseHostedWalletAction`
(`choose_hosted_wallet`, migration `0030`, under the platform limit and only while the workspace
has no credentials and no wallets). An own-account workspace whose credentials are missing or
unreadable never gets the hosted pair, and a hosted workspace on a deployment without the pair
reports `credentialsUnreadable` and pays nothing. Inside the shared hosted entity each workspace has
a wallet set of its own, `vestiarion-<orgId>`, and it can pay only from its own `accounts` rows,
which RLS scopes to the organization, so one hosted workspace cannot spend another's wallet.

The hosted pair has one other use: Vestiarion's test USDC float for shadow mode (`SHADOW_FLOAT_WALLET_ID`,
`src/lib/test-usdc.ts`, `docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md`), a wallet of the platform's own
in the hosted entity, in the wallet set `vestiarion-shadow-float` that `npm run shadow-float -- setup` makes. Only the
float's wallet id and the pair leave the platform's configuration, through `currentShadowFloat()` (`src/lib/context.ts`),
which reads them from the configuration the workspace's scope was built from, guarded as `currentOrgConfig()` is; they
are never put into a workspace's configuration, which still carries only `hostedAvailable`. The float only sends from
that one wallet to a shadow workspace's operating wallet on Arc testnet, whichever account the workspace itself pays
from.

**Paying from the owner's own wallet** (`docs/superpowers/specs/2026-10-07-wallet-treasury-design.md`) is a
third `wallet_host`, `'external'`, on Arc mainnet only (the profile's `walletTreasury`). The treasury is an EOA
the owner holds, and Vestiarion holds none of its USDC. `orgConfig` hands such a workspace the platform's agent
pair (`MAINNET_AGENT_CIRCLE_API_KEY`, `MAINNET_AGENT_CIRCLE_ENTITY_SECRET`, read only in `src/lib/config.ts` and
stripped from every other workspace's config) and nothing else; `walletTreasuryAvailable` offers the choice only
where that pair is a live key. The setup (`src/lib/treasury/wallet-treasury.ts`, owner only through
`src/app/actions/wallet-treasury.ts`) runs from Go live in five steps:

- the owner's browser wallet signs a dated proof naming the workspace, the network and its address
  (`treasury_wallet_proven`, message and signature kept);
- Vestiarion creates the workspace's agent wallet, an EOA in the agent account's `vestiarion-agents` wallet set
  (`agent_wallet_created`);
- the owner's wallet deploys `VestiarionSpendingLimit` with itself as treasury and owner and the agent as the only
  payer, recorded only once the deployed code equals a creation call with the same immutables
  (`spending_limit_deployed`, and `agent_budget_changed` when its figures differ);
- the owner's wallet approves it on USDC (`spending_limit_enforced`, `walletHost: "external"`);
- the owner's wallet sends the agent 0.50 USDC of gas.

The browser sends only what the server built (`src/lib/browser-wallet.ts`), and keeps a sent hash until the server
records it (`src/lib/treasury/sent-transaction.ts`); the server reads every result back from the chain through
`treasuryChain` (`src/lib/treasury/chain.ts`, `ARC_MAINNET_RPC_URL` or the profile's RPC). `goLive` takes such a
workspace live once its setup is ready, with no Circle credentials of its own (`workspace_went_live`,
`walletHost: "external"`). From then on `WalletTreasuryProvider` moves money only through the contract, from the
agent's wallet: the agent's payments through the on-chain limit path, and a person's approval or release through
`personPaymentThroughContract`, which asks the contract first and refuses by name. For this host alone that
replaces the rule that a person's payment never goes through the contract. Its balance is the wallet's USDC or the
allowance, whichever is less, with no gas or reserve set aside; EURC and other chains are refused. Migration `0082`
adds the host, `treasury_kind`, `treasury_address` and `approve_tx_hash` on `spending_limit_contracts`,
`accounts.inbound_from_block` for reading money in later, and makes `delete_sandbox_org` refuse a workspace whose
wallet has approved its contract.

**A passkey wallet as the treasury** (`docs/superpowers/specs/2026-10-07-passkey-treasury-design.md`) is
the same host with `treasury_signer = 'passkey'` on its contract row (migration `0083`), for an owner
with no browser wallet:

- **The wallet.** It is a Circle smart account on Arc mainnet (Modular Wallets, chain `arc`) owned by
  the owner's passkey. The browser keeps only the passkey's public part, and Vestiarion holds no key.
- **The choice.** It records the address with no signed message (`treasury_wallet_chosen`); control
  is proven on chain by the wallet's own approval.
- **The agent's wallet.** It is created in the same action as the choice, on both routes, in a scope
  of its own read after the choice.
- **The setup.** It is one user operation the wallet pays for:
  - the contract, deployed through the deterministic deployment proxy at a CREATE2 address salted by
    the workspace, with fixed figures, so the address follows the wallet and the agent alone;
  - `setLimits` with the owner's figures;
  - its approval;
  - the agent's gas, left out where the agent holds its own.
  - The server builds it (`preparePasskeySetup`). The browser rebuilds it with the same
    `passkeySetupCalls` (`src/lib/passkey-treasury.ts`) from the figures its form shows, and refuses any
    difference before the passkey signs.
  - `recordPasskeySetup` reads the result back: EntryPoint v0.7's `UserOperationEvent` for this wallet
    with `success`, the code at the address (`verifyDeployedAt`), and the allowance. It records the wallet
    route's entries once, with `signer: "passkey"`.
  - A setup sent is kept in the browser until it is recorded and checked first on the next load
    (`settlePasskeySetup`, `passkeyStepView`); a retry reuses the contract and never pays the agent's gas
    twice. A record call that fails after a send counts as not yet read (`pollRecord`), so the page never says
    nothing was sent once the passkey sent it.
  - Every user operation is priced as Circle's bundler asks: `circle_getUserOperationGasPrice`, its medium tier, with
    at least 1 gwei of priority (`circleUserOperationFees` in `src/lib/passkey-wallet-sdk.ts`). On 2026-10-07 Arc
    mainnet's own priority fee was 4,049 wei, Circle's bundler asked at least 3 gwei, and it refused the first setup
    priced the chain's way. A failure nothing else names shows the reason the bundler or browser gave.
  - Under the passkey card and each step the passkey signs, **Use your phone instead** shows a QR code of the page
    (`src/components/treasury/PhoneHandoff.tsx`, `src/lib/passkey-handoff.ts`, drawn with `uqr`): folded on a computer,
    open where `isUserVerifyingPlatformAuthenticatorAvailable` says the device keeps no passkey, absent on a phone. A
    computer reaching a phone's passkey goes over the browser's Bluetooth link, which stayed on "Connecting to your
    device" on the partner's Windows PC on 2026-10-07.
- **The controls, once live** (`docs/superpowers/specs/2026-10-07-treasury-wallet-controls-design.md`). Go live
  lets an owner or admin change the contract's figures (`setLimits`), stop the agent's payments (`approve(contract,
  0)`) and resume them, each built in the browser from what the panel shows (`src/lib/treasury/wallet-controls.ts`) and
  sent by the treasury's own signer. `recordWalletControl` records each from the chain once, by its transaction, whatever
  it is asked as, and only when the receipt's own logs show that change (`LimitsSet` from the contract, or USDC's
  `Approval` of it); it reads the state it acts on at a block at or after the receipt's, so a node behind it answers
  `pending`. The contract's figures become `agent_budgets`; a stop the approval still shows pauses the agent and a
  resume lifts only that pause, each before the entry is written; a loosened figure or a resume starts a cycle. The
  browser keeps a sent control until it is recorded (`src/lib/treasury/pending-control.ts`) and sends no other until
  then. Figures are read like every typed USDC figure (`src/lib/usdc-figure.ts`): never 0, and an empty field never
  removes one the contract holds.
- **Version 2 of the contract** (`docs/superpowers/specs/2026-10-19-spending-limit-v2-cross-chain-design.md`).
  `contracts/VestiarionSpendingLimitV2.sol` is version 1 plus `payAcrossChains(amount, maxFee, domain, recipient,
  ref)`. The agent calls it to pay a vendor on another chain: the contract counts `amount + maxFee` against both figures
  and the shared `paid` refs, draws the total from the treasury, approves the TokenMessengerV2 it was deployed with, and
  burns it with `depositForBurnWithHook` (fast finality, the `cctp-forward` hook). It refuses a domain outside its
  deployed bitmask (`DomainNotAllowed`) and a fee above 10% of the amount or 2 USDC (`FeeTooHigh`). It reverts if it
  would keep any USDC or allowance (`BalanceLeft`). Version 1's source and bytecode never change, since deployed
  contracts are checked against them.
  - **Artifacts.** `src/lib/spending-limit/artifact.json` holds both under `v1` and `v2`
    (`npm run spending-limit:compile`).
  - **Deployment.** `deploymentData` builds either version: v2 with `spendingLimitTerms(network)`, the network's
    messenger and its CCTP payee domains. Every path C setup deploys v2 where the network has CCTP, on both routes.
    `verifyDeployedAt` asks a creation call for each version it accepts and says which one the code matched.
  - **The row.** `spending_limit_contracts.version` records it (migration `0132`, default 1). The row is read with
    `select('*')`, so code deployed before the migration still reads every row as version 1.
  - **Paying.** `enforcedSpendingLimit` and `SpendingLimitPayment` carry the version.
    - `onChainLimitGate` covers a payout to another chain for v2, and asks `spendingLimitCrossChainVerdict` (an
      `eth_call` of the same `payAcrossChains` from the agent) with the fee the decision read.
    - `personPaymentThroughContract`, and the early refusal in `approveAndPay`, refuse it only for v1.
    - `executePayment` lets a contract payment take the `cctp` route only for v2.
    - `LiveProvider.spendingLimitPay` sends v2's `payAcrossChains` from the agent's wallet under the attempt's key,
      after reading the fee again and checking it against the payment's ceiling and the contract's cap. It is recorded
      as a bridge's burn (`cctp:` id), so reconciliation reads the mint from Iris.
  - **The upgrade** (`src/lib/treasury/contract-upgrade.ts`, `src/components/treasury/ContractUpgrade.tsx`) is open to
    an owner or admin, live or not, while the row is v1 on a network with CCTP.
    - A browser wallet deploys v2 with v1's figures, recorded as `next_address`. It then approves v2, which is the
      switch: `address`, `version` 2 and `previous_address`, signed as `spending_limit_upgraded`. Last it revokes v1,
      `approve(v1, 0)`, recorded from USDC's own `Approval` and a zero allowance (`previous_revoke_tx_hash`,
      `spending_limit_revoked`).
    - A passkey does all four calls in one user operation (`passkeyUpgradeCalls`), rebuilt and checked in the browser.
    - The switch is refused while any payment intent is `submitting` or `pending` (`in_flight`), since v2's `paid` starts
      empty. The page keeps what was sent and asks again. The panel stays mounted whatever the status, so its result
      line outlives the revalidation that moves the status on.
- **The recovery.** A recovery phrase made in the browser is registered as a recovery owner with
  Circle's `registerRecoveryAddress` (`treasury_recovery_registered`), or skipped knowingly
  (`treasury_recovery_skipped`). `goLive` refuses until one is recorded (`wallet_recovery_undecided`).
- **The choice's order.** Go live's choice leads with what the browser has (`choiceLead`). The mainnet
  client key, `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY`, is public by design and bound to the
  site's domain.

**Adding USDC from another chain** (`docs/superpowers/specs/2026-10-08-add-usdc-from-another-chain-design.md`) runs
in the browser alone. `AddUsdcFromChain` (`src/components/treasury/AddUsdcFromChain.tsx`), folded wherever Go live
asks for USDC, has the person's browser wallet approve TokenMessengerV2 on a source chain and call
`depositForBurnWithHook` with the forwarding hook to the workspace's wallet on Arc (`src/lib/inbound-usdc.ts`).
Circle's Forwarding Service mints there, so a new passkey wallet needs no gas to receive it. Iris quotes the fee before
anything is signed (the forwarding fee's high estimate plus the fast fee, rounded up, as `maxFee`), and reports the mint
(`forwardedMintFrom`); the burn's hash is kept in `localStorage` until then. The hook, the fee rows and the mint lookup
are shared with CCTP payouts through `src/lib/circle/cctp-forward.ts`, which imports no Node module. Nothing is
recorded on the ledger: the wallet's balance is read from the chain as before.

## The workspace frame

Every page under `/o/[slug]` sits in one frame (spec `2026-10-10-workspace-shell-design.md`).

- **Layout, platform data only.** `src/app/o/[slug]/layout.tsx` reads the membership, the viewer's other memberships,
  the pause (`pausedBanner`) and the payments switch (`paymentsSwitchForPages`), never an organization's own rows. It
  hands `AppFrame` the workspace, a `PlatformStatus` (network, mode, the deployment's mainnet switch, payments off with
  its reason, the pause with since, by and why), the three banners as one node, and the `vx_sidebar` cookie.
- **`AppFrame`** (`src/components/vx/AppFrame.tsx`) wraps everything in `FrameProvider`
  (`src/components/vx/FrameContext.tsx`): the workspace, the platform status, the banners and the sidebar's state. The
  sidebar (`Sidebar` and `NavPanel` in `AppNav.tsx`) is 14.5rem from `lg`, or a 4rem icon rail when folded; the
  drawer below `lg` is the same panel, never folded. The state lives in the cookie (`sidebar-preference.ts`): the
  layout reads it so the server draws the first paint at the right width, and the client reads `document.cookie` through
  `useSyncExternalStore`, so a layout served from the router's cache never undoes a toggle. `[` toggles it outside text
  fields; so does the header's button and the command palette.
- **Sections** are `NAV_GROUPS` in `nav.ts`: Treasury and Approvals, then Operations, Controls, Analytics and Workspace.
  The sidebar, the drawer, the palette and each page's title read that one list.
- **Header, drawn by the page.** `ProductShell` (`src/components/vx/Shell.tsx`) draws `WorkspaceHeader`: the toggle,
  the breadcrumb, the agent's last cycle (`AgentActivity`, mounted once at every width so its toasts always come) and
  three chips, network, payments and agent, which open a "Workspace status" panel. The chips combine the
  layout's `PlatformStatus` with the page's `PageStatus`, which only the page can read, inside `inOrg`:
  `chainModes={shellModes()}` and `status={await shellStatus()}` (`src/lib/shell-status.ts`: shadow mode, and the
  workspace's own screening, which read out of scope would be the deployment's, with whether its newest live lookup
  failed). `workspace-status.ts` turns both into
  chips and rows, pure and tested; payments off wins, then held, shadow mode, simulated, live. A fact the layout or the
  page could not read (the switch, the pause, shadow mode) shows as not known, never as its healthy value, since the
  payment gates refuse on the same failure; the agent shows as stopped while payments are off or held.
- **Breadcrumb.** The workspace (linking home), then the section; on a page inside a section, the section links back
  and the page is the current crumb (`aria-current="page"`, the only one). `SUBPAGES` in `nav.ts` lists those pages
  (Commissions and a deal under Bills & receivables, a project under Projects, a payment's evidence under its record's
  section) with each one's name, which is also its tab title: `navItemForPathname` files each under its section,
  `insideSection` has the sidebar mark the section `aria-current="true"`, and `subpageLabel` names it. A page showing
  one record passes its name as `ProductShell`'s `crumb` (a deal's title, a project's name, the evidence's bill or
  milestone); the loading and error states, and the phone bar, which the layout draws, name it by its kind (Deal).
  Where the row is short (`lg` beside the open sidebar) the workspace's name gives way first (`shrink-3`), the
  section's and a page's kind stay whole, and a record's name is cut at 10rem, 16rem from `xl`, whole in its `title`;
  the agent's activity takes what is left. `tests/navigation.test.ts` fails on a page below a section's own page that
  `SUBPAGES` does not list.
- **One capability state** (spec `2026-10-14-capability-and-reasons-design.md`, R1-R8). `src/lib/capability.ts` turns
  the facts (the platform switch, the hold, shadow mode, the chain mode) into one of five situations, `live-mainnet`,
  `live-testnet`, `simulated`, `shadow` (with what an agreement pays) and `unavailable` (with its cause and why), in the
  payment gates' order, and holds every word and tone for them. The header's `headerCapability` builds it from
  `PlatformStatus` and `PageStatus` (`shellModes()` now carries the hold's words, `paymentsHoldReason()`); every other
  surface reads `readCapability()` (`src/lib/capability-read.ts`) inside the workspace's scope: Settings (Go live's
  badge, the shadow mode panel), the console (balance tile, shadow summary), Approvals and verdicts (`verdictFacts`
  carries it to `VerdictControl`), contractors, and `GET /api/v1/status` (`apiPayments`). Pages that need only whether
  the workspace makes simulated payments (the report and the shared report, which count a sandbox's simulated payments,
  the payee's page and email) call `simulatesPayments(mode)`, which reads nothing: the chain mode, the switch and shadow
  mode aside; a held workspace's chain mode cannot be told, so its mode says, as the report always read it; Arc mainnet
  never simulates. `tests/capability-surfaces.test.tsx` checks
  every surface against each situation, and that none can be told apart wrongly.
- **Banners** (Arc mainnet, payments switched off, agent paused) are read by the layout and drawn by each page under its
  header (`FrameBanners`). The loading and error states draw the same header with the layout's facts alone, and the
  same `CONTENT_FRAME` width (`frame.ts`, 90rem).
- Inside a workspace a bar sticks to the top at every width (the phone bar below `lg`, `WorkspaceHeader` from `lg`), so
  `html:has([data-workspace-frame])` sets a `scroll-padding-top` that every anchor lands below.

## Reasons people give

When a person goes against the agent, the surface asks why in the same step, optionally (spec
`2026-10-14-capability-and-reasons-design.md`, R9-R14): Disagree in shadow mode (`VerdictControl`), and Reject, Return
to agent and, on a payable the agent flagged or held on a rule (`overridesHold`) whose Approve and pay sends something
new (not `checksFirst`; `approvePayable` keeps none where `approveAndPay` reports `checkedFirst`), Approve and pay
(`ApprovalCard`, whose `ConfirmDialog` takes the field as children and hands it to its form through a hidden input). The
command layer keeps it: `src/lib/commands/payables.ts` calls `recordDecisionReason` (`src/lib/decision-reasons.ts`)
after the decision, for the console only, the surface whose hint says Vestiarion's team reads it, and unless a verdict
settles it; `giveVerdict` keeps a disagreement's. A reason from another surface goes only into the decision's ledger
entry. A row in `decision_reasons` (migration 0120, a tenant table: select and insert only) names the feature and
decision, the surface, the subject, who gave it and `appVersion()` (`src/lib/app-version.ts`: `VERCEL_GIT_COMMIT_SHA`
cut to 12, or the package version). Best effort throughout: before 0120 runs (42P01 / PGRST205) or on a failed write
nothing is kept and the decision is unchanged. Owners and admins read the workspace's latest 20 on Insights
(`DecisionReasons`); the team reads the latest 200 across workspaces on `/admin/growth` through
`growth_decision_reasons(p_since)`, a definer for the service role only, by workspace slug and side, with no person. The
privacy page's "Reasons you give" entry says all of it, and what deleting an account does (`given_by` set null; the
ledger keeps the id). `tests/approval-card-reasons.test.tsx` runs in happy-dom (a dev dependency, for that file only):
it opens each dialog, types a reason and presses the confirmation.

## Shadow mode

Shadow mode (`docs/superpowers/specs/2026-10-07-shadow-mode-design.md`) runs an Arc testnet workspace alongside how
a business pays today: it keeps paying its bills itself, the agent decides on the same bills, and a person agrees or
disagrees with every decision.

- **The switch** is one row in `shadow_modes` (migration 0084), with the business's currency. An owner turns it on or
  off in Settings (`src/lib/shadow-mode.ts`), or on when creating the workspace, through the same library, never on Arc mainnet and never while a cycle runs; each change is signed.
- **The hold.** The AP stage reads it once, like the figure for two approvals. A `pay` that passes every guardrail is
  then held, not sent, with `execution.heldBecause: "shadow_verdict"` (`src/lib/agent/shadow-hold.ts`). It is no
  guardrail block, so the public count of code refusals is not inflated. A milestone release is held the same way. The
  follow-up never reopens such a hold: only a person ends it.
- **Verdicts** (`src/lib/verdicts.ts`) are rows in `decision_verdicts`, one per agent decision entry (unique on
  `entry_seq`, append-only for the tenant role), each with a signed `decision_verdict` entry naming the payable as its
  `subjectId`, so the card keeps showing the decision. Agree and pay goes through `approvePayable`, the command Approvals
  uses, and only while the payable still waits for that verdict. Disagree can return or reject it.
- **Which payments await a verdict.** `awaitsVerdict` (`src/lib/next-step.ts`): the agent decided to pay and either
  shadow mode held it (`heldBecause: "shadow_verdict"`) or, on a decision marked `shadow: true` (every AP decision the
  orchestrator writes in shadow mode), a check in code held it. The gate, the approvals list, the payable's card on
  Bills & receivables and the chat words below all read it, so a solo owner's first payment to an address they typed has
  a verdict too.
- **Settled through a verdict.** `verdictGate` (`src/lib/verdicts.ts`): while a verdict can be given on a payable held
  for one (shadow mode on, and the decision made since it started), `approveAndPay`, `rejectInvoice` and
  `returnInvoice` refuse it before any verdict (`verdict_needed`), and a payment after a disagreement is refused
  (`verdict_disagreed`) unless its transfer already left, which is recorded. The verdict's own settling passes
  `forVerdict`; once a verdict is given, or none can be, they settle it as any hold. A claim that never finished (a
  `processing` row past `RECLAIM_AFTER_MS`, `src/lib/agent/claim-age.ts`) still waits for a verdict, and the card
  offers one again. Slack and Telegram decision messages and waiting lists (`awaitingVerdicts`) word it as waiting
  for a verdict, and Slack draws no buttons for it.
- **Mirror addresses** (`src/lib/mirror-address.ts`). A payee with no Arc address gets a wallet Vestiarion makes in
  the workspace's own Circle wallet set, keyed by the payee so a retry finds it, written only where the payee still has
  no address, and recorded as an address change `via: "mirror"`. The new payee check reads that as `MIRROR`: no
  outsider could have given it, so it stands as two parties behind its first payment. An address a person enters over
  it clears `mirror_wallet_id` and is confirmed like any change. Never a mirror the ledger does not record: when its
  entry cannot be written the payee is put back as it was, and a mirror found without one is recorded when asked again.
- **Bills in the business's own currency.** `usdRate` (`src/lib/fx/usd-rates.ts`) reads how many of a currency make
  one dollar from ExchangeRate-API's open endpoint, at most once an hour, naming only the dollar. `shadowBill`
  (`src/lib/shadow-bills.ts`) reads the amount as the bill writes it (`src/lib/bill-amount.ts`) and gives its USDC to
  the cent, only in shadow mode; the invoice keeps the bill in `original_*` and its card shows it, linked to the source.
  Settings offers USDC first (`SHADOW_CURRENCIES`, 0085): a workspace in USDC converts nothing. VND is not offered,
  since crypto is no means of payment in Vietnam. An imported bill list's rows in that currency take the same path,
  with the shadow mode read once for the list (`shadowBill`'s `shadowOn`).
- **Proof out.** `npm run traction-digest -- <org-slug> --since YYYY-MM-DD` (`src/lib/traction-digest.ts`) prints a
  workspace's shadow decisions since the day, each with its verdict, what it paid and the transaction on the payable's
  newest decision ("Paid later by a person" when that decision was not to pay), and the agreement rate, in ASCII with no blank line for `arc-canteen update-traction`.
- **Getting started in shadow mode.** While shadow mode is on, the console's checklist (`gettingStarted`,
  `src/lib/getting-started.ts`) asks for suppliers, real bills (`ownBillCount`, paid or not) and a first verdict, from
  rows the console already reads, beside its three setup steps: after them in a live workspace or one with a wallet,
  before them, which are then listed under "To pay on Arc", in an Arc testnet sandbox with no wallet, since it simulates
  its payments. Outside shadow mode such a sandbox likewise starts with a supplier, a bill and the agent's decision
  (`ownDecidedCount`). It hides once every step is done. In shadow mode, Add counterparty asks whether a vendor or
  contractor sends purchase orders, and its answer is stored as `purchase_order_required` with the row. Every variant
  also opens with the workspace created and asks for the agent's limits (see [Onboarding by role](#onboarding-by-role)).
- **Test USDC from Vestiarion's float** (`src/lib/test-usdc.ts`, rules in `src/lib/test-usdc-rules.ts`). A bill is
  paid at its real amount and the faucet gives 20 USDC every two hours, so the console offers an owner or admin the
  shortfall **Safe to spend today** shows, from one float wallet in the hosted entity (`SHADOW_FLOAT_WALLET_ID`, filled
  from TestMint or the faucet outside the code). Shadow mode, Arc testnet, a live workspace, the platform's stop switch
  and a readable ledger signing key (`assertLedgerCanSign`) are checked before Circle is asked anything. Circle is the
  record of what the float sent: `addTestUsdc` lists the float's transfers to the operating wallet, every page. One
  still confirming refuses the press (`in_flight`); one that arrived but that no entry names (its request died before
  the ledger was written) is recorded first from Circle's figures, `by: null`, `recovered: true`. The amount is worked
  out again with the operating wallet's USDC read from the chain: at least 1 USDC, within `SHADOW_FLOAT_WEEKLY_LIMIT`
  (5,000) of what Circle lists sent in any 7 days (failed transfers aside), and within the float's USDC. The transfer's
  idempotency key is the number of transfers Circle listed plus one, so two presses that listed the same ones make one
  transfer, and the second writes no entry: Circle answers with a transfer it listed, or the ledger names it already
  when checked right before writing. The entry records the amount Circle's transaction reports, written while it still
  settles, and refuses one naming another destination. Each raises a `test_usdc_added` cycle event. The receipts stage
  never matches to a receivable money from an address such an entry names as `from`, nor from the float's own address
  (`floatAddress`, read once per process, null when it cannot be read).
- **What people see.** `verdictView` (`src/lib/verdict-view.ts`) gives each card the verdict on the agent's newest
  decision, given or to give, and `VerdictControl` offers it. The console's `ShadowModeSummary` shows how often people
  agreed (`readShadowSummary`).
- **Before a live slice.** The workspace report (below) lists, while shadow mode is on, what we suggest before a slice
  of bills moves to Arc mainnet: verdicts on five decisions, none waiting, and no supplier paid at a mirror address.
  Suggestions only; it moves nothing.
- **Start the live slice** (`docs/superpowers/specs/2026-10-18-live-slice-design.md`). Under those steps an owner
  (`org.administer`, with Arc mainnet open to them) ticks vendors. `startLiveSlice` (`src/lib/live-slice.ts`) refuses
  outside shadow mode, on Arc mainnet, when a slice was opened already, with no vendor or more than 25, then makes a
  workspace on Arc mainnet with the usual `createWorkspace` (allowlist, three per person, starting limits) and carries
  each vendor with a payment limit through `createCounterparty` with `via: "live_slice"`. Only a vendor's own
  confirmed address on the home chain is carried, and it waits for a person's confirmation there
  (`address_changed_at`); a mirror address, one on another chain and one not confirmed are not. Every vendor is
  parsed before the workspace is made (`not_valid` stays behind), one that fails to be added stays behind
  (`not_added`), and a failure to sign at the end returns the workspace's slug (`unrecorded`) rather than inviting a
  second. The shadow workspace signs `live_slice_started { by, liveOrgId, liveSlug, vendors: [{ counterpartyId, name,
  address }], skipped: [{ counterpartyId, name, reason }] }`. `readLiveSlice` reads it back with whether the new
  workspace is live; the report's last step names it, links it for its opener (`by`, its owner; accountants brought
  along are members too) and ticks once it is live. No bill, history or verdict moves, and no money. Opening it needs
  no migration; bringing an accountant along needs migration `0143`. Going live keeps the accountant (accountant client
  links AC4): the report lists the workspace's accountants (`sliceAccountants`, best effort) as "Bring your accountant
  ... along", ticked, and `startLiveSlice` gets the ones left ticked as `accountantIds`. Before `0143` runs, the report
  offers no accountant (`sliceAccountants` reads `clientLinksAvailable` first), rather than one that always fails. For
  each, migration `0143`'s `add_live_slice_accountant(p_from_org_id, p_org_id, p_actor, p_user_id)` checks the actor owns
  both workspaces, that the new one is the slice (on Arc mainnet, made by the actor within the hour from one on Arc
  testnet, and holding no one but them and accountants already brought along), so no other workspace of theirs takes
  an accountant this way, and that the person is an accountant of the shadow one, and adds them as `accountant`; the
  new workspace signs `member_joined { by, role: "accountant", via: "live_slice", grantedBy }`. One that fails is named
  in the result by the email this workspace's members give (`listMembers`, best effort; one no longer a member is
  counted), and the slice opens all the same.
- **What the business really paid** (`docs/superpowers/specs/2026-10-10-actual-payments-design.md`). An owner or admin
  (`records.write`, as for adding an invoice) records how the business paid a payable outside Vestiarion: the day, the
  amount and currency as paid (the bill's own by default), the method (bank transfer, card, cash, other), a reference and
  a note; or **Not paid**, with a reason. Each is a row in `payment_actuals` (migration 0090), which the tenant role can
  only read and add to: a change appends a correction naming the record it `replaces`, and unique indexes keep one
  first record per bill and one correction per record, so the history is one line. Composite foreign keys keep a record
  in its bill's workspace and a correction on the same bill. `recordActual` (`src/lib/actual-payments.ts`) checks the
  signing key before writing the row, then appends `actual_payment_recorded` or `actual_payment_corrected`
  `{ by, actualId, subject, subjectId, outcome, paidOn, amount, currency, method, reference, note, reason }` (`replaces` on
  a correction, `via: "csv"` from a CSV), naming the payable as `subjectId` so its card on Bills & receivables keeps
  showing the agent's decision. The commands `payable.record_actual` and `payable.import_actuals` run from the console
  only. A CSV (`src/lib/actual-payments-csv.ts`) names each bill by its Vestiarion id, or by an invoice number its memo
  carries as a whole word, and is previewed before it is saved, then matched again on the server. Until migration 0090
  runs, reading answers `available: false` (`PGRST205` or `42P01`) and recording refuses with `not_ready`, so the report
  never fails for it.
- **From a bank statement** (`docs/superpowers/specs/2026-10-10-bank-statement-design.md`). The same people fill in
  those records from the business's own bank statement, a CSV or cells pasted from a spreadsheet. `src/lib/bank-statement/`
  is pure and browser-safe: `table.ts` finds the delimiter (or a `sep=` line) and reads quoted fields with their line of
  the file; `columns.ts` finds the header row below the bank's own lines and suggests each column's role from its words;
  `values.ts` decides the date order and the decimal mark from every value of the file together, and asks when the values
  read two ways rather than guess; `lines.ts` reads each line, signed and in its currency's minor units (`billDigits`), the
  rows it skips with why, the period, and the statement against its own running balance, per currency; `match.ts` pairs
  each money-out line with a bill one to one, in rounds (same currency, a date window, the same amount, or within 5% with
  the payee's name or an invoice number in the line), leaving ties to the person. The browser decodes the file (UTF-8, else
  Windows-1252, with the bill list import's `decodeList`) and reads the statement at once as it is mapped
  (`BankStatementImport`); what crosses to the server is the text and the person's choices, never the browser's lines, and `src/lib/bank-statements.ts` reads and matches it again against the payables the report counts
  before it previews or saves. The command `payable.import_statement` (`records.write`, console only) saves only the
  ticked pairs still among their line's candidates, each through `recordActual` with source `statement`, adding
  `via: "statement"` and `statementLine` to the entry. Only the lines used are kept, in `bank_statement_lines`
  (migration 0094: the tenant role reads and adds, never changes), with a `line_hash` unique per workspace (SHA-256 of the
  account, the day, the amount, the currency, the text, the balance and the line's place among identical ones), so a
  re-import finds them; `payment_actuals.statement_line_id` names a record's line, one record per line, and a check
  ties it to the source `statement`. A line kept whose record failed is used again by the next save. Until 0094 runs,
  the report's card says so (`PGRST205`, `PGRST204`, `42P01`, `42703`) and the command refuses with `not_ready`.

**A vendor's statement** (`docs/superpowers/specs/2026-10-22-vendor-statement-design.md`) reuses the bank statement's
reader: `readVendorStatement` (`src/lib/vendor-statement/read.ts`) suggests a vendor's columns (`suggestVendorColumns`:
the invoice number as `reference`, charges as `moneyOut`, payments as `moneyIn`) and reads a single amount column's
charges positive by default; `vendorLines` turns money out into charges. `readStatement` takes a `StatementReading` for it: no description column required,
and a DR balance read as owed. `matchStatement` (`match.ts`, pure) matches charges in passes over the whole statement:
`sameNumber` against a bill's own number, then `memoNumber` (a memo's first word), then a rejected bill's number (its
own group), and only then, for a line or a bill with no number, by amount and the closest pairs within `CHARGE_DAYS`
(45). Listed payments are matched within `PAYMENT_DAYS` (10), in the statement's currency (USD as USDC, EUR as EURC, or
a shadow bill's original figure). `checkVendorStatement` (`check.ts`):
- reads the text again with the person's choices;
- refuses a non-vendor and a statement in two currencies;
- reads the vendor's payables in pages, each bill's `create_invoice` detail (`invoiceNumberInDetail`), its confirmed
  intents, and the newest `payment_actuals` records, all in scope, 100 ids a read;
- prefers a recorded payment, drops a simulated one, and links only an Arc mainnet transfer;
- signs `vendor_statement_checked` best effort, with counts only. `checkVendorStatementAction` needs `payables.reconcile`
(owner, admin, accountant); the dialog is `VendorStatementCheck` on Counterparties, whose missing lines embed
`InvoiceIntake` for `records.write`.

## The workspace report

`/o/[slug]/report` (spec `2026-10-09-workspace-report-design.md`) tells every member what the agent did with the
workspace's real bills since it opened. `readReportFacts` (`src/lib/workspace-report-read.ts`) reads, inside the
organization scope and a page at a time: payables with their counterparty (sample data flagged), the agent's AP
decisions with only the `detail` fields the report uses (PostgREST JSON paths, never the whole detail), people's
`approval_paid` / `approval_rejected` / `approval_returned`, verdicts, and each payable's confirmed live Circle
payment. `buildReport` (`src/lib/workspace-report.ts`) is pure and counts them: bills handled, the median minutes to a
bill's first decision, payments and on-time payments, bills stopped (waited for cash, a pause or the spending limit,
refused by code, the agent's own call, or a payment it decided whose transfer failed; a hold for a verdict is not a
stop), people stepping in, verdicts on real bills, and discounts: captured measured as a bill's amount less its
`paid_amount` (the intent's amount is a first try's, which a resend after the deadline does not change), on offer
estimated from the terms. A
payment is a shadow mirror when its decision was made in shadow mode, carries a verdict, or came while shadow mode was
on. A live workspace counts its live Circle payments; a sandbox counts its simulated ones, labelled, with no transaction
link. While a workspace has no real bill, the report counts its sample data and says so, so a workspace being tried with
sample data shows what the report is. These figures need no migration and write nothing; a failed read shows the section's error state rather than a report with rows missing.

**Agent vs what really happened** (`docs/superpowers/specs/2026-10-10-actual-payments-design.md`) is the report's
comparison with what the business recorded paying (above). `compareActuals` (`src/lib/actual-payments-compare.ts`) is
pure and takes the report's own facts through `reportScope`, so it counts the same bills and payments, and each bill's
newest record (`currentActuals`). The agent's side is its newest decision and the bill's confirmed payment: paid on
Arc, would pay, scheduled, held (its own call or a check in code), waited (cash, a pause, the spending limit) or no
decision. The business's side is the record, or **Not recorded**: nothing is inferred from a payment on Arc, a verdict or
a status. Days apart are the business's paid day less the earliest day the agent decided to pay (or a schedule's day,
or the Arc payment's day when a person paid it after a hold). Flags: held but paid, paid on Arc or decided to pay but
not paid, and an amount that differs by the currency's smallest unit from what Arc carried or the bill. Discounts are
measured from recorded facts and the offer is labelled estimated. Two currencies are never compared or summed, USD and
USDC included. Each figure links to its source: the decision and the verdict to their ledger entries
(`/audit?before=<seq + 1>#seq-<seq>`), the payment to the explorer, the record to its entry with who recorded it and
when. `npm run traction-digest` adds one line from the same totals.

**Value** (`docs/superpowers/specs/2026-10-10-shared-report-design.md` S8, S9) keeps three kinds of figures apart and
never sums across them. `reportValue` (`src/lib/report-value.ts`) is pure and takes the built report, the newest answer
and the bills the business recorded paying outside Vestiarion (`paidOutside`, from 0090's newest records): measured
(bills handled and decided, the median minutes to a first decision, paid on or before the due day, discounts taken as
the bill less what its transfer carried); estimated from the owner's answer (the bills the agent took to payment on its
own, with nothing stopping it, no person stepping in and no verdict disagreeing, times the minutes one bill took
before, in hours, with the people who touched a bill as context only; over the bills decided in shadow mode, where the
business paid itself, it is what the agent would have saved); and not counted (bills still to pay, leaving out rejected
bills, repeats and bills paid outside; bills flagged or refused as a repeat of a paid one; discounts missed, on a bill
paid without one or past its last day, and apart, discounts still on offer, both from the terms and never a rejected
bill's or a repeat's). `buildReport` measures a discount's last day against `ReportFacts.now`, when the facts were read.
The answer is a
row of `report_baselines` (migration 0095), which the tenant role can only read and add to, and a signed
`report_baseline_answered` entry; the newest row is read (`src/lib/report-baseline.ts`). The agreement rate the report,
the console's shadow mode panel and the shared copy show is one function, `agreementRate` (`src/lib/verdict-rate.ts`).

**A shared report** (same spec, S1-S6, S10-S14) is a public, revocable, live copy of the report. A share is a row of
`report_shares` (0095) holding the SHA-256 of its link's secret (`vxs_` and 43 base64url characters,
`src/lib/report-share-token.ts`) and what it shows: supplier names or stable labels (A, B, ... in the order each
supplier's first bill arrived), amounts or not, the workspace's name or a neutral title. The tenant role may insert a
share and set `revoked_at` and `revoked_by` alone (column grants); a trigger refuses to clear or move a revocation, and
nothing deletes a share. `shareReport` (`src/lib/report-shares.ts`) checks the signing key, writes the row, then signs
`report_shared`, and revokes the row at once if the entry fails, so no link stays live without its record; stopping
revokes first and signs `report_unshared` best effort. At most 10 links are live per workspace. The commands
`report.share` and `report.unshare` need the `report.share` permission (owners and admins), `report.baseline` needs
`org.administer`, and all three run from the console only. `/report/[token]` has no session: a malformed token is never
looked up; a well-formed one is hashed and looked up by the service role's `report_share_by_token` (0095), which
answers the live share's workspace id, options, mode and network, and the workspace's name only when the share shows
it. `readSharedReport` (`src/lib/platform/shared-report.ts`) then enters that workspace's own scope (`withOrg`, as the
API does after a key lookup) and reads the report's facts, the comparison's records, the answer, the supplier names it
knows and its payables' memos and purchase order references, the chain fields of the decisions shown and the public
halves of its signing keys; the workspace id goes no further. `buildSharedReport` (`src/lib/shared-report.ts`) is
pure: it relabels suppliers, hides amounts everywhere when asked (and with them the transaction hashes, since the
public explorer shows what each transfer carried), and scrubs the agent's reasoning on its whole text before cutting it
to its first sentence of at most 200 characters, so a name with a full stop in it is replaced whole: names replaced,
and any email, `0x` address, UUID, quoted purchase order reference or memo, or code from a memo hidden
(`scrubReasoning`, `referenceWords`). It gives the comparison as totals only and never a person, a memo, a reference or
an id. Each decision
carries **Check its signature**, the receipt verifier's half that needs no body, run in the reader's browser. A dead
link, stopped, unknown or of a deleted workspace, reads one sentence and names no one; the page is `noindex`, has its own
card, and analytics sees `/report/:token`. Before 0095 runs, reading either table answers `available: false`
(`PGRST205`, `42P01`), a missing lookup function (`PGRST202`, `42883`) reads as no share, and the commands refuse with
`not_ready`.

## Cash outlook and scenarios

Treasury's **Safe to spend today** and **Next 30 days** (spec `2026-10-02-safe-to-spend-design.md`) and its folded
**What if clients pay late?** section (spec `2026-10-11-cash-scenarios-design.md`) are worked out from rows the console
already reads, with no query or write of their own beyond the recurring schedules.

- **One set of rules.** `outlookMoves(input, windowDays)` (`src/lib/cash-outlook.ts`) dates what is counted: open USDC
  payables (`OPEN_PAYABLE_STATUSES`, a held one included) on `scheduled_for` or their due day, an overdue one today;
  open milestones today unless escrowed; open USDC receivables (`pending`, `matched`) on their due day; EURC apart.
  `cashOutlook` reads it over 30 days; `scenarioBasis` (`src/lib/cash-scenario-basis.ts`) over 90, adding each active
  recurring payment's periods with no invoice yet (`dueOn` from `next_period`, a billed period found by
  `recurring_id` and `recurring_period`) and each expected client's record from its received receivables, by the rule
  the collections stage uses (counts and an average, never a likelihood). `listRecurringPayables` is read best effort:
  when it fails the basis says so and projects none.
- **In the browser.** The page hands the basis to `CashScenarios` (`src/components/vx/CashScenarios.tsx`), a client
  component that runs `cashScenario` (`src/lib/cash-scenarios.ts`, pure) on every render from the basis and the levers
  a person sets: a 30, 60 or 90 day horizon, days late (0 to 90), each receivable late, on time or never, and a change
  in bill costs (-50% to 100%) on every bill or on bills written in another currency (`original_currency`). It gives the
  balance day by day for the base case (every receivable on its due day, named "If clients pay on time", since Next 30
  days counts none) and the scenario, the first day below zero and below the cushion (15% of what leaves in the 7 days
  from that day), the bills due while short, up to three suggestions in words (a scheduled bill paid on its due day only
  when the scenario, worked out again with it moved, runs short later or by less), the three biggest drivers by the
  short day (a client's receivables grouped by its counterparty id), and the coverage (the weeks of the horizon with a
  bill on record, what is projected, what is left out). Cash is the
  operating wallet and the USYC reserve; a receivable adds to the balance only on the day it arrives in that case; bank
  balances are never counted, and neither are a deal's lines not released yet: `outlookMoves` takes them as `planned`
  (`OutlookInput.planned`), Next 30 days names what they come to apart (`plannedIn30d`, other currencies apart) and the
  scenarios' coverage names them, in no balance (below, Deals). A released line is a receivable and counts as one.
- **Nothing that pays reads it.** The levers live in component state and are gone with the page, unless an owner or
  admin saves them as a version (below, Currencies). Safe to spend today, the treasury's buffer, cash holds and every
  guardrail still count no receivable; `tests/cash-scenarios-ui.test.tsx` fails if a file under `src/lib/agent`,
  `src/lib/commands`, `src/app/actions` or `src/app/api` imports a cash-scenario module: the save goes through
  `src/lib/scenario-versions.ts`, which imports none.
- **Exchange rates** (`docs/superpowers/specs/2026-10-13-currency-provenance-design.md` M7). `outlookMoves` carries a
  converted bill's `original` (its amount as written and its `fx_rate`, as decimal strings) into the basis;
  `ScenarioLevers.rates` values each open bill of a typed currency at that rate (the bill's own amount over the rate,
  exactly, to the cent) before the cost lever, and `ScenarioResult` says what each rate did (`rateEffects`, `rateDelta`)
  apart from the cost lever (`costDelta`). Empty keeps every bill at its own conversion, so the base case never moves.

## Currencies: provenance, a reporting currency and FX variance

`docs/superpowers/specs/2026-10-13-currency-provenance-design.md`. Reporting and planning only: payments still settle in
USDC (or EURC on Arc testnet), the executable amount is what the agent pays, and nothing that decides or pays imports
any of it. `/api/v1` keeps USDC and EURC.

- **One money shape** (`src/lib/money/`, pure and browser-safe). `Money` is `{ minor: bigint, currency }`: 0 digits for
  the yen, the won and the other zero-decimal codes `billDigits` knows, 6 for USDC and EURC (the tokens' own, since what
  a transfer carried can hold a discount's micro-units), 2 otherwise. `moneyOf` parses a decimal exactly,
  `roundedMoney` reads a database value through its shortest decimal text, rounding half away from zero once;
  `totalsByCurrency` never adds two currencies and `addMoney` throws when asked to. `tests/money.test.ts` runs the round
  trips and totals of the six currencies (USD, SGD, JPY, KRW, PHP, MYR) thousands of times with a seeded generator.
- **Rates say their kind** (`rate.ts`): `reference` (ExchangeRate-API's daily rates, through `usdRate`), `quote` (the
  provider's executable quote: Circle's on a EURC decision), `accounting` (the books'; named, not read yet), `peg` (1 USDC
  = 1 USD, 1 EURC = 1 EUR, named as the redemption peg and never a market rate) and `manual` (typed into a scenario).
  `convertMoney` multiplies a chain of rates as fractions and rounds once; `rateWords` says a rate with its kind, source
  and time wherever a figure used it, and its age (`rateAge`) where a page shows a stored rate. A total that counted
  USDC in US dollars says "USDC counted at its 1:1 redemption peg" (`tests/currency-report-ui.test.tsx`).
- **Reporting currency** (`reporting.ts`, `src/lib/reporting-currency.ts`): one row of `reporting_currencies` (0113), USD,
  EUR, SGD, JPY, KRW, PHP or MYR, set by an owner or admin in Settings (`workspace.reporting_currency`, permission
  `reporting.manage`, signed `reporting_currency_changed`). `reportingTotals` totals per currency, then converts each
  total through the US dollar, the token's peg first; a currency whose reference rate is missing, or older than 3 days,
  makes its row and the total unknown, with the reason and what is known apart. Never a 1:1 fallback.
- **Stored rates** (`src/lib/fx/rates-store.ts`): `fx_rates` (0113, append-only for the tenant role; one row per kind,
  source, pair and publication, an upsert that ignores duplicates). `reportingRateBook` reads the newest stored rate
  published within 3 days, and only reads: no page reads the feed or writes a rate while it renders (Next's data-security
  guide: no mutation as a side effect of rendering), so a page never waits on ExchangeRate-API. `POST
  /api/platform/fx-rates` (`src/lib/fx/rates-job.ts`, Supabase Cron hourly, `.github/workflows/fx-rates.yml` by hand) is
  the only reader of the feed and the only writer of reference rates: for each workspace with a reporting currency,
  shadow mode in a currency of its own or a converted bill, each in its own scope; a feed that does not answer is asked
  once a run, not once a workspace; its answer is counts only. `tests/currency-render-path.test.ts` holds the pages to
  reads only.
- **FX variance** (`variance.ts`, `src/lib/fx/variances.ts`): for a paid payable converted at a rate from a currency other
  than the dollar, what the transfer carried less the same part of the bill at the reference rate in force at the
  payment (the newest stored one published at most 36 hours before it, `rateAtPayment`), to the cent, or to the
  micro-unit a discounted transfer carried, so an unmoved rate is no variance. Recorded once per bill in `fx_variances`
  (0113, append-only; a check holds `variance = paid_amount - value_at_payment` and the rate's window), with every input
  copied, by the hourly rates job alone (`recordFxVariances`); the report and Bills & receivables read them
  (`readFxVarianceState`), and a paid bill without one reads unknown, with why. None is recorded without a stored rate.
  It never reads the feed.
- **The report** (`src/lib/currency-report.ts`, `-read.ts`, `CurrencyReport`): **Currencies and rates**, from the report's
  own scope (`reportScope`): bills as written, paid on Arc, paid by the business (the newest records of 0090), each per
  currency and in the reporting currency; the variances; every rate used; and two KPIs, the share of amounts with full
  provenance (`fullProvenance`: the amount as written and its source, the `create_invoice` entry's `via`; the
  conversion's rates with source and time; a known reporting value; the rate at payment once a converted bill is paid)
  and the manual FX adjustments (manual rows of `fx_rates`). Each part is best effort on its own.
- **Bill cards** (`map.ts`): a bill as written in its currency's digits, "converted at" its reference rate with source
  and day; a EURC payable's **USDC value** naming Circle's quote; a paid bill's **FX variance**, or unknown.
- **Saved scenarios** (`src/lib/scenario-versions.ts`): `cash_scenario_versions` (0113, append-only; a trigger takes a
  version only one after its scenario's last, and the unique key refuses two saves of one number), each typed rate a
  `manual` row of `fx_rates` naming its version, signed `cash_scenario_saved` (domain `treasury`). Command
  `cash_scenario.save` (`reporting.manage`), console only.
- **Before 0113 runs** each read answers not set up (`42P01`, `PGRST205`, `42703`, `PGRST204`): Settings says so, the
  report shows each currency apart, no rate and no variance, saving refuses with `not_ready`, and the rates job has
  nothing to do.

## Deals: a signed deal as a collection schedule

A deal (`docs/superpowers/specs/2026-10-12-deal-schedule-design.md`) is the agreement on the receivables side: a
customer, a total, a currency, a start date, payment terms, an optional external reference, and a schedule of lines that
add up to the total exactly.

- **Pure, then written.** `src/lib/deals/` holds the browser-safe modules the form, the page, the server and the cycle
  share: `money.ts` (minor units: cents for USDC, EURC and two-decimal currencies, whole units for `billDigits`'s
  zero-decimal ones; the deal currencies, USDC or EURC anywhere, another three-letter code in shadow mode only, never
  VND), `schedule.ts` (the four templates, deposit and balance, equal milestones, a monthly retainer with month-end
  days, custom lines; each line the floor of its share in `BigInt`, the remainder on the last line as
  `roundingMinor`; due day = invoice day + terms), `input.ts` (both forms, read the same in the browser and on the
  server), `revision.ts` (`proposeCorrection`, `planRevision`, `planCancel`), `lines.ts` (each line's state,
  `releaseRefusal`, `dueForRelease`, `dealSummary`) and `collection.ts` (`dealCollection`: what a deal collected, the one
  figure behind its page's Paid and Outstanding, the Deals list and the receipts written back to a CRM). `read.ts`,
  `write.ts` and `collection-read.ts` are the server's.
- **Migration 0104.** `deals`, `deal_versions` and `deal_lines` are tenant tables with row level security as 0090 and
  every foreign key composite with `org_id`. A line not released yet is a `planned` deal line, never an invoice, so no
  reader of receivables sees it. `create_deal` and `revise_deal` (security invoker, for the tenant role) write a version
  whole: `create_deal` answers the deal already made for the same `idempotency_key` (unique per workspace), and
  `revise_deal` locks the deal and refuses a change from a version that is no longer current (`deal_changed`) or that
  ends a line released since (`deal_line_not_planned`). A deferred constraint trigger checks at commit that the lines in
  force at every version add up to its total and that the deal names its latest version. The tenant role may update a
  line's status and release only (column grants), and `deal_lines_guard` allows `planned` to `released`, `superseded` or
  `cancelled`, and `released` back to `planned` only while no receivable names the line: a released line never changes.
  `invoices.deal_id` and `deal_line_id` link a receivable to its line, both or neither, a receivable only, one invoice
  per line, never moved once set.
- **Versions.** A change ends planned lines and adds new ones (a moved or changed line `replaces` the old one); a
  higher price adds a correcting line, a lower one reduces planned lines from the last and turns what released lines
  already exceed into a credit line owed to the customer, never released or counted as money. Cancel ends the planned
  charges; reopen adds lines to a cancelled deal. Each version is a signed `deal_signed`, `deal_revised` or
  `deal_cancelled` entry, built from the stored deal (`versionEntry`), written best effort after `assertLedgerCanSign`,
  and written by the same confirm or change when it comes again a minute later without one.
- **Release.** `releaseDealLine` claims the line (compare-and-set on `planned`), then adds the receivable through
  `createInvoice` with `deal: { dealId, lineId, version, title, line, releasedBy }`, which its `create_invoice` entry
  carries with `via: "deal"`; a line in another currency goes through `shadowBill` first. A failed insert undoes the
  claim; a line left released without a receivable is released again, and the unique index makes the second insert
  find the first. With a deal's `auto_release` on (an owner or admin's switch, signed `deal_auto_release_changed`), the
  cycle's recurring stage calls `releaseDueDealLines`, which releases each line whose invoice day came as the agent;
  a failure there is a log line and the next cycle tries again.
- **Commands.** `deal.create`, `deal.change`, `deal.release` and `deal.auto_release` need `records.write`, as
  `invoice.add` does, and run from the console only (`src/lib/commands/deals.ts`, `src/app/actions/deals.ts`).
- **Where it shows.** Bills & receivables has **Deals** on its Receivables tab (`DealsSection`; New ▾ › Deal opens `DealForm`),
  `/o/[slug]/invoices/deals/[id]` each deal's schedule, controls and versions, and each receivable a line became names
  its deal (`dealLinksOf`). Treasury and the payment plan read the planned lines best effort (`readPlannedDealLines`,
  `plannedLinesOf`). Before 0104 runs every read answers not set up (`dealsNotReady`), the section says so, the
  commands refuse with `not_ready` and the cycle releases nothing.
- **Costs and cash readiness** (`docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md`). Migration 0108's
  `deal_costs` holds a deal's planned costs: a label, an optional vendor or contractor, `amount_minor` in the deal's
  currency, `expected_on`, `no_document`, and the payable (`invoice_id`) or milestone (`milestone_id`) it became, every
  foreign key composite with `org_id` (`set null` for the counterparty, the payable and the milestone, so a deleted bill
  leaves the cost planned). The tenant role inserts and reads, and updates only the link and the removal (column
  grants); `deal_costs_guard` keeps a cost's terms, sets a link once and never moves it (nor clears it while the row it
  names exists: only the foreign key's `set null` does), keeps who linked it, and never undoes a removal;
  `deal_costs_link_payable` refuses a receivable; partial unique indexes let a payable or a milestone back one live cost
  of any deal, so its money is counted once. `src/lib/deals/costs.ts` (pure) reads the form and says what a cost counts
  as (`costCount`: planned on its day, `due` as the bill or milestone it became, `paid`, or planned again when that bill
  was rejected or that milestone closed); `costs-read.ts` reads costs with their links in the deal's minor units
  (`payableMinor`: the bill's own amount in USDC or EURC, its `original_amount` for a shadow deal's currency) and the
  candidates to link; `costs-write.ts` adds (once per `idempotency_key`), removes and links, each a signed
  `deal_cost_added`, `deal_cost_removed` or `deal_cost_linked` entry (domain `ar`), through `deal.add_cost`,
  `deal.remove_cost` and `deal.link_cost` (`records.write`, console only). `src/lib/deals/cash.ts` (pure, browser-safe)
  works out `dealCashReadiness`: collected and paid out to date, then each day from today with money moving (charges
  in force on their due days, planned or expected, an overdue one today; a released line's collected part and what it
  still owes come from `Collection.byReceivable`, the per-receivable figures `dealCollection` adds up into the deal's
  Paid and Outstanding (`src/lib/deals/collection.ts`), so a part payment counts as what arrived, a fee settles the
  rest, and a line marked received with no payment on Arc is neither and is said; with no collection read, each line
  counts by its receivable's status; costs as `costCount` says), the end-of-day
  position, the first short day and the deepest gap, and the estimated margin (`not_enough_data` with no cost);
  `tryDeposit` moves the deposit's invoice day or sets its percent (`depositLever`: the first charge in force, still
  planned, of a deposit-and-balance deal or one whose first line is named a deposit), taking the difference from the other
  planned charges from the last, for a preview that is never saved; `cashBadge` is the deals list's badge. The deal page
  renders `DealCashReadiness` (a client component that recomputes as the levers move) and `DealCosts`; the Receivables
  tab reads every deal's costs once for the badges. Nothing that pays, decides or answers the API imports `cash.ts`
  (`tests/deal-cash.test.ts`). Before 0108 runs the reads answer not set up (`costsNotReady`): the page says so and the
  margin says not enough data.

## Projects: budgets and the money set aside

A project (`docs/superpowers/specs/2026-10-13-project-budgets-design.md`) gives a job, a client or a launch its own budget
in USDC, so several projects sharing one treasury never promise the same balance twice. It is an earmark in the
application: nothing is escrowed or locked on chain, the treasury stays one pool, the spending limit contract on Arc still
enforces only the workspace-wide caps, and every payment still needs its cash when it is sent.

- **Migration 0111.** `projects` (a name, `budget_minor` and `buffer_minor` in USDC cents, the buffer within the
  budget, `active` or `archived`, one active name per workspace, once per `idempotency_key`) and
  `project_reservations` are tenant tables with row level security as 0108 and every foreign key composite with
  `org_id`. `invoices.project_id`, `milestones.project_id` and `deals.project_id` say what belongs to a project
  (`on delete set null`); `project_assignment_check` takes a payable in USDC or a milestone into an active project only,
  never a receivable, and keeps the project of a bill `paid`, `matched` or `processing`, or of a paid milestone.
  `milestones.po_reference` holds the purchase order a milestone was agreed under. The tenant role reads and adds
  projects and changes only their name, figures and status (column grants; `projects_guard` keeps the rest, and refuses
  archiving while anything open is left in it), may set `deals.project_id` alone, and reads and adds reservations and
  sets only their release.
- **A reservation never spends the same money twice.** `reserve_project_budget(p_org_id, p_invoice_id, p_milestone_id,
  p_via, p_by)` (invoker rights, for the tenant role) locks the bill or milestone (`for update`), then the project's row,
  counts what is reserved and paid in one statement (one snapshot, so a bill being paid counts once, as reserved or as
  paid), and sets the amount aside, to the cent above (`project_minor`), only when the budget less its buffer holds it;
  it answers `reserved` (with `already`), `over`, `archived`, `settled`, `no_project` or `not_found`, with the
  figures it weighed. `project_reservations_within_budget`, before every insert however it is made, takes the same locks
  in the same order (the bill or milestone, then the project, so the two paths never deadlock) and refuses a reservation
  past the budget (`project_budget_exceeded`) or for a bill or milestone not open in the project at that amount; a partial unique index keeps one live reservation per bill and per milestone. Two decisions at
  once therefore wait on the project's row, one after the other: `npm run fixture:project-budget` shows it on a real
  Postgres with ten concurrent transactions (exactly the reservations the budget holds go through, and the same race
  with no lock overspends), which a single-connection test database cannot.
- **Released with what changes it.** `project_reservations_release`, after an update of a bill's status, amount,
  currency or project, or a milestone's status, amount or project, releases its live reservation in the same
  transaction, with its reason: `paid` (its money now counts as paid: a bill at `paid_amount` when its transfer carried
  a discount), `rejected`, `closed`, `changed` or `moved`. `project_reservations_guard` keeps a reservation's terms and
  a release once made. `project_figures(p_org_id)` gives each project's reserved, paid and open money, and what of it is
  not set aside, as the reservation counts it.
- **The agent's side** (`src/lib/agent/obligation-checks.ts`, `obligation-gate.ts`). After `enforceApGuardrails` in the
  AP stage, and after the release's own checks in the contractor stage, two checks run for a payment or a schedule the
  others let through, and only hold (`afterGuardrails`: a payment another check stopped is returned as it was, and
  `tests/obligation-checks.test.ts` holds that over every guardrail's trigger). `obligation.duplicate_reference` holds
  the second of a bill and a milestone for the same purchase order and payee (a purchase order written as none, such as
  N/A, names none), or the same delivered work (`sameWorkMatches`, `src/lib/projects/same-work.ts`: a URL equal but for
  its scheme, `www.`, a trailing slash and tracking parameters, its query and anchor kept; a GitHub pull request by
  number; the milestones a bill may repeat, or the bills a milestone may, read once per stage). `project.budget_exceeded` then reserves the bill's or milestone's money through the function,
  and holds it with the project's figures when the answer is `over` (`execution.heldBecause: "project_budget"`) or
  `archived`, or when the call failed (`observed.project.state: "unreadable"`). A bill or milestone in no project is
  never asked about, and a read before 0111 sees no `project_id`. The reservation is made before the shadow mode hold,
  the cash check and the transfer: a bill the budget holds still waits for cash exactly as before, a hold the model
  decides reserves nothing, and a release then held for want of cash keeps what it set aside, found again when it is
  decided. The entry records `observed.projectId`, `observed.project` and
  `observed.sameWork`. The follow-up reopens a payment held for its project once `projectRoomsFor` (`src/lib/projects/
  rooms.ts`) says the project has room for it, or it left the project (`projectRoomChange`). Policy replay runs both
  checks last (`BILL_STAGES`, `MILESTONE_STAGES`): the same work fires from the recorded matches; a project's budget,
  read at the moment of the decision, is can't tell for a bill in a project and passes for one in none.
- **A person's side.** Approve and pay, Pay now, Reject and Close work as before: a person's payment is not held by a
  project's budget, counts as paid in it, and releases its reservation through the trigger; so does a rejection.
- **Commands.** `project.create` and `project.change` (`addProject`, `changeProjectCommand`) need `agent.budget`, as the
  agent's spending limit does; `project.assign` (`assignToProjectCommand`) needs `records.write`, and reserves the
  money of a bill or milestone put in a project (`via: "assignment"`, or `"entry"` from Bill to pay and Add milestone,
  whose console actions take a project and, for a milestone, a purchase order). Each is signed (`src/lib/projects/
  write.ts`): `project_created`, `project_changed` and `project_assigned`, domain `ap`, naming a bill as `subjectId`
  so its card keeps showing the agent's decision. The console only; the write API is unchanged. Both permissions are an
  owner's or admin's: an approver, an accountant or a viewer reads projects and changes none
  (`tests/commands-projects.test.ts`).
- **Where it shows.** `/o/[slug]/projects` lists every project with its figures (`readProjects`,
  `src/lib/projects/read.ts`; `projectFigures` in `model.ts` is pure): budget, set aside, paid, available, the share of
  its open bills and milestones set aside (commitments covered), payments held for its budget now and in 30 days (from
  the agent's entries), and what its deals collected (`readDealCollections`, the figure behind a deal's Paid; USDC only,
  another currency apart). `/o/[slug]/projects/[id]` adds its bills and milestones, its lines of the payment plan (the
  whole treasury's plan, `readPaymentPlan`, with the project's lines listed), the treasury it shares, its deals, and the
  forms. Treasury's **Projects** card lists each active project's money set aside. Every such page says the budget is an
  earmark. `/docs-shots/projects/<state>` renders the screens with sample data, behind `DOCS_SCREENSHOTS=1`. Before
  0111 runs, every read answers not set up, the forms show no project and no milestone purchase order, and the agent
  asks nothing.

## Commissions on money received

A commission (`docs/superpowers/specs/2026-10-14-commissions-design.md`) is earned by a partner on file, a vendor or
contractor, on customer money applied to the invoices of the deals the partner's plan covers, and paid as an ordinary
payable the agent decides.

- **Migration 0118.** `commission_plans` (one row per version of a partner's plan: `rate_bps`, `basis` net or gross,
  `scope` all deals or those in `commission_plan_deals`, `hold_days`, `reference`, the `beneficiary_member` who is this
  partner, `started_at`, `ended_at`, `replaces`), `commission_lines` (accruals, `amount > 0`, and adjustments, `amount <
  0`) and `commission_payouts` (one per payable a review made, `invoice_id` unique, with its `CS-` statement number) are
  tenant tables with row level security as 0108 and every foreign key composite with `org_id`. The tenant role only
  reads them: every write goes through the four functions below, definers for that reason, each refusing another
  workspace than the request's token (`commission_other_workspace`) and filtering every read by the workspace itself.
  `commission_plans_guard` keeps a version's terms and ends it once, at the moment it is ended, and
  `commission_lines_guard` keeps a line's terms and lets `payout_id` move only from none, or from a payout whose payable
  is `rejected`, into a payout of the same partner and currency whose payable is `pending`, once the line is due. A line's
  receivable, deal, allocation row and transfer are `on delete set null`, so paid history outlives a deleted customer,
  deal or invoice (sample data removed, say). A partial unique index keeps one version in force per partner.
- **Functions.** `set_commission_plan` takes a lock per partner
  (`pg_advisory_xact_lock` on the workspace and partner), refuses a client, a change from a version no longer in force
  (`commission_plan_changed`), a member who is not one (`commission_member_not_found`) and the partner's own member
  (`commission_beneficiary`), ends the version in force and starts the next at the same instant; `end_commission_plan`
  ends one. `record_commissions` inserts every accrual not recorded yet, on `payment` rows of `receivable_allocations`
  (and `fee` rows under the gross basis) still in force and on whole matches (`incoming_transfers.invoice_id`, once the
  receivable is `received`), for receivables with a `deal_id`, under the version in force when the money arrived on Arc
  (the transfer's `received_at`; a fee's, the latest payment in force beside it), at `floor(amount × rate_bps × 100) /
  10^6`; then an adjustment of exactly minus each accrual whose row was reversed or whose transfer no longer names its
  invoice, due with the accrual while it is in no live payout, else at once. Partial unique indexes (one accrual per
  partner and allocation row, one per partner, transfer, invoice and `occurrence` for whole matches, one adjustment per
  accrual) and `on conflict do nothing` make every call idempotent; it answers only the rows it inserted, at most 300
  per insert so an answer stays under `max_rows`, and `recordCommissions` calls again while one has 300 or more. `create_commission_payout`, under the same lock, takes exactly the open lines due that the person reviewed
  (`commission_changed` otherwise), refuses a net of zero or less (`commission_nothing_due`) and the partner's member,
  and inserts the payable (the partner, the net, due now, its statement number as `po_reference`, goods received,
  `created_by` the reviewer), the payout and the lines' link in one transaction.
- **The partner never approves their own payout.** `commission_partner_members(p_org_id, p_invoice_id)` names every
  member a plan of the payout's partner ever named. 0118 redefines `claim_invoice_decision` as 0077's with two changes,
  each a no-op for a payable that pays no commission: such a member's approval is refused (`beneficiary_approval`), sole
  approver or not, and their open approval is not another person's. `payment_approvals_not_beneficiary` refuses their
  approval row, inserted or updated; a later redefinition of the claim keeps both. `approveAndPay` reads the partners
  first (`commissionPartnersOf`, `src/lib/commissions/beneficiary.ts`), refuses one before any claim or first approval,
  and drops their standing approvals; an unreadable answer is none there, since the database refuses either way.
  Whoever created a payout is treated as whoever created any payable, partners counted as approvers: naming a partner
  asks nothing of them, so it never lifts the separation. When the creator and a partner are the only approvers, a
  held payout waits for another one, and the review says so beside Create payable (`NO_OTHER_APPROVER`).
- **Recording** (`src/lib/commissions/record.ts`). `recordCommissions` checks the signing key, calls
  `record_commissions` and signs each row it was answered as `commission_accrued` or `commission_adjusted` (domain `ap`,
  actor `agent`, the receivable as `receivableId` so no reader takes it for a decision on it). The cycle calls it in its
  receipts stage, in every mode, best effort (a failure is a cycle line); `applyReceivedPayment` and
  `reverseAppliedPayment` call it right after, best effort.
- **Model and writes** (`src/lib/commissions/`). `model.ts` is pure and browser-safe: the plan form, the rate in basis
  points, `commissionMicros` (the SQL's rounding, in `BigInt`), the formula in words and `reviewCommissions` (per partner
  and currency: due now, held, in payables, carried forward; a line in a payout not read is never due). `read.ts` reads
  every payout (its payable's status embedded) and only the open lines, a page of 1,000 at a time (`everyPage`), and by
  id at most 100 ids to a request (`byIds`). `write.ts` sets and ends plans and creates the payable, signing
  `commission_plan_set`, `commission_plan_ended`, then the payable's `create_invoice` (`via: "commission"`) and
  `commission_payable_created`, with the totals the database answered.
- **Commands.** `commission.set_plan`, `commission.end_plan` and `commission.create_payable` need `records.write`, from
  the console only (`src/lib/commands/commissions.ts`, `src/app/actions/commissions.ts`); a payable made starts the
  agent's next look, as an invoice added does.
- **Where it shows.** `/o/[slug]/invoices/commissions` (nested in Bills & receivables, linked under Deals on the
  Receivables tab) renders `CommissionsScreen`: the plans in force with New plan, Change plan and End plan, the ended
  versions, and each partner's review with every line's formula and Create payable; a member named as the partner reads
  theirs and changes none. `/docs-shots/commissions/<state>` renders it with sample data behind `DOCS_SCREENSHOTS=1`.
  Before 0118 runs the page says commissions are not set up, the commands refuse `not_ready`, recording records nothing
  and Approvals reads no payout. `tests/commissions-flow.test.ts` runs the whole path on PGlite, then hands the payable
  the database wrote to the AP stage, which pays it.

## Why it was paid: the evidence chain

`/o/[slug]/evidence/invoice|milestone/<id>` (spec `2026-10-10-evidence-chain-design.md`) gives every member one page
per payable or contractor milestone: what was agreed, what was delivered, the bill, the payee, the decision, the people,
the payment, the receipt and the signatures. `navItemForPathname` files it under its record's section (Bills &
receivables, or Contractors), and the header's breadcrumb links back there, then names the bill or milestone. Every
payable's and milestone's card footer links it (`Decision.chain`, set by `invoiceDecision` and `milestoneDecision`;
`src/lib/evidence-paths.ts`), and so does the decision trail's last line.

- **Pure, then read.** `buildEvidenceChain` (`src/lib/evidence-chain.ts`) is pure: it takes the record, its
  counterparty, the entries, the screening check, the payment intent, the receipt, the members' emails and the checks'
  results, and labels each fact by where it came from (Checked by code, Verified outside, Stated by a person, Inferred,
  Missing, Could not open, Does not match); a step reads as its weakest fact, and a signed entry never upgrades a fact
  a person stated. `chainAnchors` names the decision the chain rests on, so `readEvidence`
  (`src/lib/evidence-read.ts`) asks for the newest complete screening check at that time. The reader goes through
  `db()` in the organization's scope only: the record (a receivable, a malformed or an unknown id is null, and the page
  is the workspace's not-found), `ledger_entries_for_targets`, verdicts by `subjectId`, the counterparty's compliance
  entries, the intent, the receipt and its entries (by its seq and by `receiptId`), and the members, best effort.
- **Checks.** Each entry alone with `verifyEntry` (`src/lib/receipts/verify.ts`) on the server, and again in the
  reader's browser (`EvidenceBrowserCheck`); the transaction with `readOnChain` against the chain's public RPC. A URL a
  person, a payee or GitHub gave (`EvidenceLink.given`: a pull request, a bounty's comment, a hand verification's
  evidence) is never fetched by its own address: `readEvidence` builds the chain once, takes its given links
  (`givenLinks`), checks them on the allow-list (see [Evidence links people can open](#evidence-links-people-can-open)) and
  builds it again with `checks.links`, so a link that can't be opened is never counted as verified. `intentFacts` and `recordingEntry`
  (`src/lib/receipts/facts.ts`) are shared with the payment receipts, so both read the same transaction and the same
  recording entry, and the receipt's named entry is matched with `recordsTransaction`, as the public receipt page
  matches it: the payee's transaction or a CCTP payout's burn. `decisionChecks` is shared with the decision trail.
- **What was paid.** The subject carries `simulated` (marked paid by a simulated transfer; the page says so above the
  chain) and `paidAmount` (`invoices.paid_amount`, when the early-payment discount made it less than the bill; the
  payment step cites the entry whose `discountTaken` recorded it). A bill taken in another currency in shadow mode
  states its own figure as the person's fact and its conversion (`create_invoice`'s `bill`) as code's.
- **Download.** `GET /api/evidence?org=&kind=&id=` answers `vestiarion-evidence/1` (`src/lib/evidence-export.ts`):
  every step and fact with its label, every entry in full with the server's check, and the workspace's public keys.
  The audit export's gate: a session (401), membership (404), cross-site refused (403), a bad kind or id 400. It writes
  nothing, the ledger included. An API key reads the same document, members named by user id, from
  `GET /api/v1/invoices/{id}/evidence` and `GET /api/v1/milestones/{id}/evidence` (see "API").
- **Who can see it** (`EvidenceAccess`) says the existing permissions in words: every member reads and downloads it;
  from the page, only a shared receipt leaves the workspace, shared by an owner or admin (`records.write`), and the
  panel names the workspace's other ways out for the same entries: webhooks and API keys (owner or admin, in
  Settings), and the Slack and Telegram notices of the agent's decisions. `readEvidence` gives the receipt's state:
  shared, stopped, not shared, or `unavailable` for a bill with no payment on chain, which has no receipt to share. No
  migration.

## Approvals and the pause switch

**The approval inbox** (`/o/[slug]/approvals`, spec §5) lists every payable a
cycle has held, flagged, or left awaiting more information, plus one that is
`processing` — being decided right now, or claimed by a request that died
more than 10 minutes ago. `listWaitingPayables` marks the second kind
`reclaimable`, and the card offers the three decisions again for it.
`src/lib/agent/approvals.ts` reads that list and carries out each of the
three decisions:

- **Approve and pay** calls `payInvoice` (`src/lib/agent/pay.ts`) — the same
  function the agent's own AP stage calls, so a person and the agent cannot
  record two different outcomes for one transfer. It refuses a high-risk
  counterparty outright (only Compliance clears that, not a click) and checks
  the operating balance first, reading it from the chain in live mode.
- **Reject** sets the invoice `rejected`, with an optional reason kept in the
  ledger, not on the invoice.
- **Return to the agent** sets it back to `pending` for the next cycle to
  decide again.

Every decision first claims the row through `claim_invoice_decision`
(migration `0025`), a compare-and-set that moves the invoice to `processing`
only while it is still waiting. This covers two races: two people deciding
the same invoice at once, and a person and the follow-up stage reopening it
in the same moment — the follow-up stage's own write is conditional on the
status it read (`applyFollowUp` in `src/lib/agent/orchestrator.ts`), so it
never overwrites a claimed row. The claim also refuses an approval when the
deciding person created the invoice (`invoices.created_by`), so no one
approves their own payable, and (since 0118) when it pays the commission of a
partner a plan named the deciding person as, sole approver or not (see
Commissions on money received). The claim makes a decision exclusive; it is the
payment intent's idempotency key (`paymentIdempotencyKey("invoice", id)` in
`src/lib/payments.ts` for the first transfer attempt, one more key per later
attempt) that keeps an invoice from being paid twice. A
`processing` invoice a crashed request never finished can be reclaimed ten
minutes after `reviewed_at`, and a failed update after a claim is logged by
invoice id. All three server actions (`src/app/actions/approvals.ts`)
require `approval.decide`. An invoice whose payment may already have moved —
its intent confirmed, pending or submitting, or holding a provider id whose
transfer Circle has not reported in a terminal failure state (`CANCELLED`,
`DENIED`, `FAILED`; `STUCK` is still in flight) — can only be approved: Reject
and Return are refused with `payment_in_flight` before the claim, the card
offers only Approve and pay, and Approve skips its funds check only when a
transfer exists with a provider id that is not terminally failed, or the
payment is confirmed — a `submitting` row with no provider id yet still runs
it — since skipping the check means Approve only reconciles rather than pays
again. A payment already recorded as ended by Circle in a terminal failure
moved nothing, so Reject and
Return are allowed, and Approve and pay, after its funds check, reads Circle
once more and only on a terminal state sends it again under the next
attempt's key (`retryTerminalFailure` in `executePayment`, `begin_payment_retry`
in migration `0036`). An approval that finds a sent transfer has since failed
only records it: the invoice is held again, and the next approval, with its
funds check, sends it. The agent's cycle never sends a failed transfer again.

**A payment still in flight is reconciled, not decided again.** An approval
whose transfer is still pending leaves the invoice `matched`, which the AP
stage selects. For a `matched` invoice that already has a payment intent, the
stage skips the model and the guardrails and calls `payInvoice`, which
reconciles the existing intent through its idempotency key and records
`ap_reconcile` with `detail.reconciled: true`; otherwise a guardrail the
person deliberately overrode could hold the invoice over a real transfer.
A reconcile that did not complete — no operating account, a provider that
could not be read, an error before any result, or an earlier send Circle
has not listed yet — leaves the invoice `matched` for the next cycle rather
than demoting it. When no transfer is recorded, the send may still have
reached Circle, so it is looked for there first, sending nothing: found, it
is reconciled as a transfer that exists. Only when Circle never took it can
it be resubmitted (a payout to another chain, which cannot be looked up this
way, is resubmitted under its key), and then the counterparty's risk level
is read again first, and a counterparty now screened high risk is not paid.
Nor is a resubmission that would be the first payment to the counterparty's
current address with two different people not behind it: it is held as
`counterparty.new_payee`, as the stage holds a decision (the new payee check
above). Nor one to a changed address no one has confirmed, or one inside the
payee lock's wait. The follow-up stage reopens a payable held for one of
these three once that ends, and the AP stage decides it again.
The contractor stage does the same for a `verified` milestone whose release is
already in flight. It records `milestone_reconcile` rather than asking the
model again, so a change of mind cannot record a released payment as held.
Only a payment with something to reconcile is reconciled. An intent with no
provider id that was never claimed, or whose submission failed before the
provider returned an id, has no transfer to look up. So its invoice or
milestone is decided again, through the model and the guardrails. One whose
send failed with Circle's answer lost (it may or may not have been accepted)
is reconciled first, so it is looked up before anything decides it, and is
decided again only once Circle never took it. A resubmission reuses the same
idempotency key.

**Waiting for Circle never guesses.** Every Circle request made by the live
provider carries a deadline, because the SDK has no HTTP timeout: transfer
submission gets 20 seconds, and balance reads and reconciliation get 15
seconds. The manually run operator scripts are outside this guarantee and do
not add per-request deadlines. A submission deadline says the outcome is
unknown; the intent keeps no provider id, and a later decision reuses the same
idempotency key so Circle can deduplicate a request it accepted. After Circle
accepts a transfer, it holds a transaction id, and the money may have moved.
The live provider waits for confirmation, and the wait and its second read each
carry their own deadline. On any rejection of that wait, whether a timeout, a
dropped connection or a terminal state, it reads the transaction once more and
takes Circle's answer. Only a state Circle reports as terminal makes a transfer
failed. One it cannot read stays pending, and the next cycle reconciles it by id
(`src/lib/circle/settlement.ts`).

**The pause switch** stops one workspace's agent without touching
credentials. `pause_agent` and `resume_agent` (migration `0025`) are
service-role functions that re-check the acting person's role themselves:
pausing takes `owner`, `admin` or `approver`; resuming takes only `owner` or
`admin` — anyone who can approve money leaving can stop the agent, but
starting it again is deliberate. The pause lives on `orgs`
(`agent_paused_at`, `agent_paused_by`, `agent_pause_reason`) — platform data,
read before any tenant scope opens — and `agent_paused(org_id)`
(migration `0025`) exposes it to the tenant role as one boolean. While a
workspace is paused:

- the cron (`src/lib/agent/cron.ts`) skips it outright, reporting
  `skipped: "paused"` and writing nothing to its ledger;
- `begin_cycle_run` (migration `0025`) refuses to open a cycle, and the
  console's Run cycle action surfaces that refusal; a pause that lands
  between the cron's listing and that refusal is reported as
  `skipped: "paused"` too, not as a failure;
- a cycle already running stops moving money mid-cycle: the AP and
  contractor stages (`src/lib/agent/orchestrator.ts`) re-read the flag
  before each payment, and the treasury stage and the liquidity stage
  before AP (`src/lib/agent/liquidity.ts`) re-read it before each reserve
  deposit or withdrawal, holding instead of calling the payment provider
  and marking the ledger entry's detail with `heldBecause: "agent_paused"`
  (`src/lib/agent/pause.ts`). All three reserve moves share one call,
  `moveTreasuryIfNotPaused` (`src/lib/agent/treasury-moves.ts`).

A person's own decisions in Approvals continue while the agent is paused —
pausing is how the automation is stopped, and an approval is a deliberate
human act, not the agent's own move. So does a person's **Bring cash back**
from the reserve, which passes `byPerson` to that call.

**Ledger actions** `approval_paid`, `approval_rejected`, `approval_returned`,
`agent_paused`, and `agent_resumed` record every decision, pause, and resume,
each carrying the acting person's user id, never an address.

**Each waiting payable is an exception someone owns**
(`docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md` E1-E5). `exceptionFacts` (`src/lib/exceptions.ts`,
pure) gives its decide-by day (the due date, or the early-payment discount's deadline while it is still ahead and
earlier; a late fee never moves it: a bill past its due date with one keeps its due date, with reason `late_fee` and
the fee for `decideByWords` only), its priority (`overdue`, `today`, `week`, `later`) and who can act: the members whose role holds
`approval.decide`, less whoever entered it unless nobody else may. The Approvals page and the Bills rows read the members
once (`listMembers`) and show it through `ExceptionLine`; someone who cannot decide reads whom to ask.

## Commands: one action from every surface

A person's actions reach the domain through `src/lib/commands/`
(docs/superpowers/specs/2026-10-03-integrations-design.md), so a new surface adds
an adapter rather than a second gate. An **actor** is one member acting through
one surface: `consoleActor(auth)` after the console's `authorize`, or
`memberActor(orgId, userId, surface)`, which reads the member's role and the
workspace's mode for that action, never from a link, a key or a button. A
**command** is one function per action — `approvePayable`, `rejectPayable`,
`returnPayable`, `addPayableDetails`, `payMilestoneNow`, `closeMilestoneUnpaid`,
`pauseWorkspaceAgent`, `resumeWorkspaceAgent`, `runWorkspaceCycle`,
`addInvoice`, `importInvoices`, `addAccountingBills`, `dismissAccountingBills`, `recordActualPayment`,
`importActualPayments`, `approvePlanLines`,
`shareWorkspaceReport`, `stopSharingWorkspaceReport`, `answerReportBaseline`, `applyReceivedPayment`,
`reverseAppliedPayment`, `addDeal`, `changeDeal`, `releaseDealLine`,
`setDealAutoRelease`, `planCrmDeal`, `keepCrmChange`, `fillCrmEmail`, `setCrmReceiptWrites`, `overwriteCrmReceipt`,
`addProject`, `changeProjectCommand`, `assignToProjectCommand`,
`shareCustomerStatement`, `stopCustomerStatement`, `replyToCustomerRequest`, `closeCustomerRequestCommand`,
`setCollectionPolicy`, `resolveCollectionTaskCommand`, `setCommissionPlan`, `endCommissionPlan`,
`createCommissionPayable`, `captureInvoiceDraft`, `editInvoiceDraft`, `sendInvoiceDraft`, `confirmInvoiceDraft`,
`discardInvoiceDraft` — whose
first statement is
`gate(actor, "<command>")`:

- the scope in force must be the actor's workspace, or it throws
  (`ActorScopeError`): a surface that entered one workspace cannot act for
  another's member;
- the role must hold the command's permission (`COMMAND_PERMISSIONS`, drawn from
  the permission map);
- the surface must be one that may run it (`SURFACE_COMMANDS`): the console runs
  everything; Telegram adds invoices and decides nothing; Slack approves, rejects
  or returns a payable, pauses the agent and adds invoices; the API adds records; the Chrome extension captures, edits
  and sends a draft for review, and nothing else;
- a chat's decisions are off until an owner sets that chat's limit
  (`decisions_off`).

A decision from a chat answers a card the chat showed: the payable commands run
`checkChatDecision` (`src/lib/commands/chat-decisions.ts`) for every surface but
the console, before the console's own approval. It refuses a card that is no
longer true of the payable (still waiting, decided by the agent at the same
moment), and lets Approve and pay through only for USDC paid on Arc, within the
limit, to a confirmed address whose hash is the one the card was posted with: a
chat never confirms a changed address.

The command then calls the domain function as the console always has, raises
what follows (the agent's next look through `runCycleSoon`, a paid payee's
notice through `sendNoticesSoon`), and returns the console's own words as
`{ ok, message, … }` or `{ ok: false, code, message, changed? }`. A decision
made anywhere but the console names its surface in its signed entry
(`provenance`: `via`, with `linkId` or `apiKeyId`); the console's entries carry
no `via`, as before. The console's server actions keep `authorize` first and
refresh their pages through `consoleAnswer`
(`src/app/actions/command-result.ts`); the Telegram bot's **Add** and every
Slack command and click build theirs with `memberActor`. `tests/commands-gates.test.ts` holds every command to
its gate. The console's Add milestone and Create link, and the write API's
milestones and payee links, run `addMilestone` and `issuePayeeLink`; a bill
list's import runs `importInvoices` (`invoice.import`, the console only), which
adds each row through `addInvoice`; the invoice form and the write API's
invoices move onto `addInvoice` next.

**A bill list is imported in its own format**
(docs/superpowers/specs/2026-10-10-import-wizard-design.md). Pure, browser-safe
modules under `src/lib/bill-import/` read it: `table.ts` (the delimiter, quotes,
which open a field only as its first character so an inch mark never joins rows,
and row numbers), `columns.ts` (each field's column, from the names businesses
give it), `dates.ts` (day, month or a two-digit year first, decided from the
whole list, or asked, never guessed), `amounts.ts` (the list's decimal mark,
symbols, thousands or lakh grouping, and decimals by currency, kept as exact
decimal strings) and `rows.ts` (the person's answers, which count only while
their question is asked, and each row's fate: added,
already in the workspace, or why not, and the failed rows as a CSV with the
reason). The panel New ▾ › Import a list opens on Bills & receivables (`src/components/intake/BillImport.tsx`) asks the
person to confirm the columns and answer what the list cannot say; the server
(`checkBillListAction` and `importBillListAction`, `src/app/actions/bill-import.ts`)
reads the list's text again with `checkBillList` (`src/lib/bill-import/check.ts`),
which reads the counterparties, the invoices a row could repeat (same
counterparty, due day, bill amount and invoice number or purchase order, from
columns invoices already have), shadow mode and each day's rate once. A bill in
the business's own currency goes through `shadowBill`. Each added row's
`create_invoice` entry carries `via: "import"`, `importFile` (the list's SHA-256)
and `importRow`; the invoice number starts the memo. The list itself is not kept.

## Bills & receivables: a summary, three tabs and one New menu

`/o/[slug]/invoices` (docs/superpowers/specs/2026-10-12-bills-tabs-design.md) keeps four figures above three tabs:
Needs you, Due in 7 days, Overdue and Receivables (what customers still owe, never called cash), each a link to the tab
and filter behind it; **Waiting for review** only when something does (bills from Xero, QuickBooks or Zoho Books,
payments to book, invoices by email, invoices captured with the Chrome extension, HubSpot, Pipedrive or Zoho CRM won
deals); then **Bills**,
**Payment plan** and **Receivables**.

- **The address holds the view** (`src/lib/bills-view.ts`). `tab`, `filter`, `q`, `sort`, `page`, `open` (a bill's
  detail), `review` (a review list over the page) and `new` are read by `readBillsQuery` and resolved against the
  workspace by `resolveBillsView`; every link on the page is written by `billsHref`. Addresses from before the tabs land
  where they meant: `?history=all`, `?status=…`, `?add`, `?hubspot=…`, `?q=…` on the server, and fragments
  (`#trail-<id>`, `#settlement-<id>`, `#from-xero`, `#deals`, …) by `legacyHashHref` in the page, since a fragment never
  reaches the server. The app's own links use the new form (`invoiceHref`).
- **Only the tab shown is built.** The figures, the strip and the New forms read on every tab, with one
  `ledger_entries_for_targets` call for every invoice as before; the plan (and the chain balance it reads) only on its
  tab; payment intents, shared receipts and pay links only for the 25 rows on the page and an open detail.
- **Reads at once** (docs/superpowers/specs/2026-10-22-bills-page-parallel-reads-design.md). Every read that needs only
  the workspace and the address starts together, and a read that needs another's answer starts when that one answers
  (the entries after the invoices, the verdicts after the entries, a deal's costs and collections after the deals). Once
  the decisions say which tab, page and cards are shown, the cards' reads and the tab's own run together; only the shared
  receipts wait, on the payment intents. The members and each accounting tool's connection are read once per page, by a
  promise the page keeps rather than React `cache()`, since the same functions serve server actions and jobs.
  `offersView`, `verdictFacts` and `readCollections` read their independent parts at once too.
  `tests/bills-page-parallel.test.ts` counts the page's rounds of reads against a database that answers in waves.
- **Rows and cards** (`src/components/bills/`, `build.tsx`). The tabs are WAI-ARIA tabs that are links, with manual
  activation. A list has quick filters (`billFilterMatches`, `receivableFilterMatches`, which the figures count with
  too), the search, an order and 25 rows a page (`pageOf`). A row names what stands in a bill's way and the next
  action (`bill-next-step.ts`, in the order `WaitingPayableAction` offers them); its name opens the existing
  `DecisionCard`, with the footer it always had, in a panel (`BillsPanels.tsx`, `open=` pushed onto the history).
- **New ▾** (`NewMenu.tsx`) opens each existing form in a sheet: Bill to pay, Invoice to a customer, From a document,
  Import a list, Recurring and Deal, with their own actions and checks; closing with something typed asks first.
- `/docs-shots/bills/<state>` renders the page's states with sample data through the same builders, behind
  `DOCS_SCREENSHOTS=1` as /docs-shots is.

## Customer statements

A customer's statement link (`src/lib/customer-portal/`, migration 0109,
`docs/superpowers/specs/2026-10-13-customer-portal-design.md`) gives one client counterparty a public page of what it owes
the workspace, and a way to answer each open invoice, with no account and no wallet:

- **The link.** A row of `customer_portal_links` holds the SHA-256 of the link's secret (`vxc_` and 43 base64url
  characters, `src/lib/customer-portal/token.ts`), the customer, who made it and when it expires (7, 30 or 90 days; the
  database refuses more than 91). A trigger refuses a counterparty that is not a client. One link per customer is live
  (a partial unique index): `createPortalLink` stops the customer's live link, expired or not, then inserts the new one,
  then signs `customer_statement_shared`; a link whose entry cannot be written is stopped at once. Stopping sets
  `revoked_at` first, then signs `customer_statement_unshared` best effort. The tenant role inserts a link's `org_id`,
  `counterparty_id`, `token_hash`, `created_by` and `expires_at` only (so `created_at`, which bounds the expiry, is
  always now) and may set `revoked_at` and `revoked_by` alone (column grants); a trigger refuses to clear or move a
  revocation; nothing deletes one. No browser role may execute the 0109 trigger functions.
- **The page.** `/statement/[token]` has no session. A malformed token is never looked up; a well-formed one is hashed
  and looked up by the service role's `customer_portal_by_token`, which answers null for a stopped or unknown link (or a
  deleted workspace or customer), only `{ expired, expiresAt }` for an expired one, and otherwise the link's workspace and
  customer ids, names, mode and network. `readStatement` (`public.ts`) then enters that workspace's scope (`withOrg`) and
  reads, filtered by the link's customer: its receivables but rejected ones, the payments applied to the open ones (what
  is still owed), their kept pay links (`receivable_links.token_enc`, read back with the master keys), and its requests
  with their threads, open ones and those closed in the last 90 days. `buildStatement` (`model.ts`) is pure: open invoices
  by due day with what is still owed and the days overdue, totals per currency never summed across, and paid invoices of
  the last 90 days, at most 10. The page names the workspace and the customer only; a member's reply reaches it under the
  workspace's name, with its author's id dropped before rendering. It is `noindex`, has its own preview card
  (`linkSocialMetadata("statement")`), and analytics sees `/statement/:token`. The pay page it links to keeps the amount,
  with its currency, beside its own Copy, and 44 px buttons, for a phone.
- **What the customer sends.** `submitStatementRequestAction` and `replyOnStatementAction`
  (`src/app/statement/[token]/actions.ts`) await `submitCustomerRequest` and `replyAsCustomer` first and enter no workspace
  themselves. A per-instance bucket (`takePortalActionToken`: 5, then one every 12 s per link) slows a burst; the form is
  read by `readSubmission`; then the service role's `customer_portal_submit` or `customer_portal_reply`, in one
  transaction, locks the link's row, refuses a stopped or expired link, counts what the link sent in the last day (at most
  30 requests and messages, across instances), checks that the invoice is an open receivable of the link's customer, and
  checks each kind's fields. A request is `paid` (a day not after tomorrow and at most a year back, an optional reference
  and amount), `promise` (today up to 90 days ahead), `dispute` (its words) or `pay_link`; a new claim or promise closes
  the open one of its kind on that invoice as `superseded`, and a second dispute or pay link request adds to the open one.
  The customer's words go to `customer_request_messages` with the link they came by. Each is then signed in the
  workspace's ledger, best effort, with `via: "customer_portal"`, the ids, days and amount, and `textSha256` of the words
  rather than the words: `customer_said_paid`, `customer_promised_payment`, `customer_disputed_invoice`,
  `customer_asked_pay_link`, `customer_wrote`. A pay link asked again with no words adds no row, so the function answers
  `written: false` and nothing is signed or emailed for it (it would otherwise be free under the cap). Nothing here
  changes an invoice: a claim of payment is the customer's word.
- **Telling the members.** Each write also answers `notify`: the function stamps `customer_requests.notified_at` in the
  same transaction when the request was not emailed about in the last hour (a claim or promise replacing one emailed
  within the hour keeps its stamp), so a long thread sends one email an hour at most, across instances.
  `notifyCustomerWrote` (`src/lib/notifications/customer-portal.ts`) then emails the owners and admins
  (`records.write`) whose `memberships.notify_email` is on, at most ten, each their own message
  (`src/lib/email/customer-wrote.ts`): who wrote, the kind, at most 140 characters of the words with links replaced,
  and a link to From customers; never a reference, an amount or a day. The statement's Server Actions run it with
  `after`, once the customer has its answer; it never throws.
- **The tenant role** reads `customer_requests` and may close an open one (`status`, `outcome`, `closed_at`, `closed_by`;
  a trigger refuses to reopen or change a closed one, and a check needs an outcome and a day). It inserts into
  `customer_request_messages` only `org_id`, `request_id`, `body` and `by`, so `author` keeps its default, `business`, and
  `link_id` stays null: it can write a reply, never the customer's words. A closed request takes no message. Composite
  foreign keys keep every link, request and message in the workspace of the customer and the invoice they name.
- **Finance.** Bills & receivables reads the open requests on every tab (one read, best effort): Waiting for review says
  how many came from customers, and a receivable's row says "Customer says paid", "Customer promised by" or "Disputed by
  the customer". The Receivables tab lists them under **From customers** (`fromCustomerItems`, `view.ts`), each with its
  next step (`financeNextStep`): find a claimed payment and apply it, wait for a promise's day, reply and resolve a
  dispute, make the pay link asked for. **Customer statements** below it makes and stops links. The commands
  (`src/lib/commands/customer-portal.ts`: `customer_portal.share` and `customer_portal.unshare` need `records.write`;
  `customer_request.reply` and `customer_request.close` need `receivables.reconcile`, an accountant's too), from the
  console only; a reply and a close are signed
  `customer_request_replied` (with `textSha256`) and `customer_request_closed`. Each entry shows in the invoice's trail.
- **Reminders.** The collections stage reads what the customers of its open receivables said (`readSaid`, open
  requests and those closed in the last 90 days): an open dispute holds an invoice's reminders until it is closed, an
  open claim of payment until it is closed (finance is asked to check one still open after 7 days), an open promise
  through its day, and a promise whose day passed until finance reviews it (`reminderPause`; see Collections that
  follow the customer's context).
- **Before 0109 runs** the lookups answer no link, the reads answer `available: false` (`PGRST205`, `42P01`), the
  commands refuse `not_ready`, the Receivables tab says statements are not set up, and reminders go as before.

## Supplier payment status

docs/superpowers/specs/2026-10-18-supplier-status-design.md, migration 0131. The payables mirror of customer statements,
read only.

- **The link** (`src/lib/supplier-status/links.ts`, `token.ts`). `vxv_` and 43 base64url characters, kept as the SHA-256
  of its secret in `supplier_status_links`, for a vendor only (a trigger refuses a client or a contractor; refused too in
  shadow mode, where Arc testnet only mirrors the bills paid outside), expiring after 7, 30
  or 90 days (the database refuses more than 91), one live per supplier (a partial unique index), revoked once, never
  deleted. `createSupplierLink` stops the supplier's live link, inserts the new one and signs `supplier_status_shared`
  (domain `ap`); a link whose entry fails is stopped at once (`not_recorded`), and the links it replaced are signed as
  stopped, as they are when the new one cannot be stored. `stopSupplierLink` revokes first, then
  signs `supplier_status_unshared` best effort. The commands `supplier_status.share` and `supplier_status.unshare`
  (`records.write`, console only) wrap them; the Bills tab's **Supplier payment status** (`SupplierStatusLinks`) calls
  them through `src/app/actions/supplier-status.ts`.
- **The page** (`/supplier/[token]`, `src/lib/supplier-status/public.ts`). No session: a malformed token is never looked
  up; `supplier_status_by_token` (service role only) answers null for a stopped or unknown link and only the day for an
  expired one. A live link's bills are read inside the workspace's scope (`withOrg`), filtered to the link's
  counterparty and `direction = 'payable'`: none while the workspace is in shadow mode (`unavailable`), else the open
  ones (`OPEN_PAYABLE_STATUSES`, never `rejected`) and those paid in the last 90 days (at most 10), with their
  `payment_intents`, read 100 bills at a time (a confirmed one's `tx_hash`, linked on the home chain's explorer only when
  it is an Arc transaction hash; one created, submitting or pending marks the bill on its way). A sandbox's page says its
  payments are simulated. Nothing is written or signed.
- **The words** (`src/lib/supplier-status/model.ts`, pure). `standingOf` maps a status to received (pending), being
  reviewed (held, flagged, awaiting info, `processing`, which is a person's claim in Approvals, or anything new), to be
  paid on its `scheduled_for`, on its way (`matched`, a payable's submitted payment, or a payment in flight), or paid on
  its `settled_at`. The page never says why a bill is held. Open bills
  are ordered by what happens next, and totalled per currency, never across currencies.
- **Privacy.** `noindex`, a fixed title and preview card (`linkSocialMetadata("supplier")`), and analytics sees
  `/supplier/:token`.
- **Before 0131 runs** the lookup answers no link, the list answers `available: false`, the commands refuse
  `not_ready`, and the Bills tab says supplier payment status is not set up.

## Collections that follow the customer's context

Each open receivable gets one next step from what is known about its customer
(`src/lib/collection-context/`, migration 0110,
`docs/superpowers/specs/2026-10-13-collections-context-design.md`):

- **The proposal.** `proposeNextAction` (`model.ts`, pure) takes a receivable's facts (what is still owed and what
  arrived, its reminders and their link, what its customer said on its statement, its customer's rules, the HubSpot
  deal it was sold through, its tasks) and answers nothing, wait, ask the account owner, remind with a tone, or escalate
  to finance, with the facts it rests on as sentences, the reminder it would send, and the task it needs. A dispute, an
  open claim of payment (through the 7 days after the day it was made, `CLAIM_REVIEW_DAYS`), a promise not yet due and
  a person's hold wait; a broken promise and a claim still open after those 7 days escalate to finance, so a claim alone
  never holds reminders for good. The collections stage and the Receivables tab call the same function (`page.ts`
  builds the tab's views from what the page read).
- **Rules.** `collection_policies`: one row per version of a customer's rules (ask first or not, the strongest tone,
  the days between reminders, 3 to 30, the channel, email only, and the account owner), the last plus one, never
  changed, for a client only (triggers). `saveCollectionPolicy` (`write.ts`) writes the next version over the one the
  person saw and signs `collection_policy_set`. `reminderAllowed` and `allowedTones` (`src/lib/collections.ts`) take
  the spacing and the tone cap; code's own bounds stay the floor.
- **Tasks.** `collection_tasks`: what the stage asks a person, once per receivable and subject (`subject_key`), with the
  proposal it was opened for; a person resolves it once (approved with a tone and the reminder's number, held until a
  day, no reminders, reminders resumed, done), and the stage closes one no longer needed as obsolete. Triggers keep a
  task on a receivable of its customer, opened open, resolved once. `openTask`, `closeObsolete` and `notifyTasks`
  (`tasks.ts`) are the stage's; `resolveCollectionTask` (`write.ts`) a person's, which first closes a broken promise as
  resolved or an unchecked claim as not received (`closeCustomerRequest`), or turns the invoice's reminders off
  (`setReminders`), then signs `collection_task_resolved`. An approved reminder goes without the model, at its tone,
  while the rules' version is the one it was approved under. `notifyTasks` reads who may be asked once a cycle and
  emails each member at most once a cycle, the task waiting longest first.
- **When tasks began.** `collection_task_starts`: the day the stage first ran in a workspace (`taskStart`, set once,
  as `approval_escalation_starts` is). A need about a day before it (a promise's day, a claim's last day of waiting,
  the day reminders were done, a due day) opens no task and emails nobody, and the card says so (`before_tasks`); a
  HubSpot receivable already overdue then is reminded as before. The tab reads the day and never sets it.
- **HubSpot's owner.** `crm_deals.owner_external_id`, from the deal's `hubspot_owner_id` (read with
  `crm.objects.deals.read`), written apart from the deal's facts so a sync before 0110 still writes them. A receivable
  whose deal was planned from a HubSpot deal with an owner asks before its first overdue reminder. A deal planned from
  Pipedrive or Zoho CRM has no owner here: the ask is HubSpot's only for now.
- **Each email once (I11).** `src/lib/notifications/deliveries.ts`: a key per kind, event and recipient (hashed), the
  rules' version recorded beside it and never in it, so a retry after the rules changed keeps the key Resend knows;
  `notification_deliveries` claims it before the send (unique per workspace and key), a trigger keeps a sent row, and
  the same key goes to Resend as `Idempotency-Key` (`sendEmail`). `sendOnce` reads the opt-out again right before the
  send (the receivable's reminders and its link, and the rules' version; a member's `memberships.notify_email` and role)
  and releases the claim when it stops or the send fails. Resend's 409 `invalid_idempotent_request` (the key went with
  an email already) is kept as sent, never retried. A claim left unsent for 15 minutes by a run that stopped is taken
  over, under the same key, while Resend keeps it (23 hours). Each email is metered once when it is handed to Resend
  (`reminder`, `collection_task`).
- **Load.** The stage reads up to 500 open receivables a cycle by due day (`invoices_open_receivables_idx`), and their
  context 100 at a time, the same requests for each batch, so no `.in()` address grows too long and nothing is read per
  receivable but the task it opens and the reminder it sends.
- **Commands.** `collection_policy.set` and `collection_task.resolve` (`src/lib/commands/collections.ts`) need
  `records.write`, from the console only: they decide what the agent sends a customer, so owners and admins, never an
  accountant's `receivables.reconcile`; `resolveCollectionTaskAction` raises `reminder_approved` for an approval or
  reminders resumed.
- **Before 0110 runs** rules and tasks read as none (`notThereYet`: `PGRST205`, `42P01`, `42703`, `PGRST204`),
  deliveries are not recorded, the owner is left out, and the card says rules are not set up.

## Late fees

docs/superpowers/specs/2026-10-23-late-fees-design.md. A payable's late-payment term is three nullable columns on
`invoices` (migration 0141): `late_fee_kind` (`percent_month` or `fixed`), `late_fee_value` (a percent a month,
more than 0 and at most 10, or an amount in the invoice's currency up to its amount) and `late_fee_starts_on`, the first
day it applies, on or after the due date's UTC day. Checks keep all three or none, the value's range, the start and
payables only. A trigger (`invoices_late_fee_start`, 0141's own function) sets a missing start to the day after the due
date, and moves the start by as many days as the due date moves when the due date alone changes (`accept_term_request`,
`answer_term_counter`), so a supplier's extra days keep the term's grace and the after-due check.

- **Entry.** `invoiceInputSchema` takes `lateFee { kind, value, startsOn? }`, checked by `checkLateFee` and given back
  with its start set; every path builds it: the invoice form (`lateFeeFields`), `POST /api/v1/invoices`, CSV import
  (`lateFeePercent`, `lateFeeAmount`, `lateFeeStartsOn`), the email and Chrome drafts and the chats' drafts (the read
  fields `lateFeeKind`, `lateFeeValue`, `lateFeeStartsOn`, named only when one was read), and the accounting imports
  (`lateFee: null`). Document capture asks the model for `lateFeePercentPerMonth`, `lateFeeAmount` and
  `lateFeeStartsOn`; the rule-based reader takes "x% per month" or "x% monthly" on a line about paying late, and "late
  fee of N". `normalizeExtraction` keeps a percent the text states (`statesPercent`), at most 10, or an amount it
  contains other than as a percent and at most the read amount, never both; "late fee of 2%" or "of $25 per day" is no
  fixed fee. A start the document does not give is left null, so the form's blank-start rule applies to the due date
  submitted, and DOCUMENT_FIELDS counts a changed fee, a null start read as the day after the submitted due date. The
  invoice form refuses a fixed fee on a bill taken at its USDC amount in shadow mode, as CSV import does; a CSV header
  that writes a percent ("Late fee (%)") maps to `lateFeePercent`, and a bare "Late fee" to nothing. `createInvoice`
  writes the columns and signs `lateFee` on `create_invoice` when it kept them.
- **Reading.** `invoiceLateFee` and `lateFeeOf` (`src/lib/agent/late-fee.ts`, pure): a term the database would refuse
  is no fee; `lateFeeOf(invoice, on)` is what waiting costs in the coming month (`COMING_MONTH_DAYS`, 30): a month of
  the percent of the amount, or a fixed fee while it is still ahead (one already started is owed, so 0), and 0 for a fee
  that starts after that month. It moves with the day, so it orders bills but never tells plans apart. `mapInvoice`
  reports the term as `lateFee`.
- **Never paid.** No amount, payment limit, transfer or on-chain limit reads it: a bill paid late is paid at its amount.
- **What it changes.** The approval card's cost box and the Bills list's terms line name it; Slack's Approve confirmation
  names it; `decideByOf` names it beside the unchanged decide-by day (`late_fee`, above) and the escalations tell
  it once more on its eve (below); the AP prompt's `terms.lateFee` (`lateFeeTerms`, with `aMonth`)
  and the ledger's `ap_*` `terms` carry it, and `buildReason` names it when the bill is paid before its start, whose
  day is late already; the cash step's written order (`referenceOrder`) puts first, among the bills due or overdue, the
  heaviest `lateFeeOf` in USDC, its facts carry each fee, and `planFingerprint`, the signed order items' `lateFee` and
  `carriedOrder` count the term (`sameLateFee`: kind, value, start), so a fixed fee reaching its first day changes
  nothing.
- **Before 0141 runs.** `createInvoice` drops each later column the database lacks in turn (`LATER_COLUMNS`:
  `document_pay_to`, then the late fee's); every explicit read of the columns goes through `readWithLateFee`, which
  reads again without them on `42703` or `PGRST204`; the AP stage's `select("*")` and `listInvoices` need nothing;
  sample data loads without its fee.

## The payment plan

**A payment now that gains nothing waits for its day** (`noGainInPayingNow`, `src/lib/agent/payment-timing.ts`). The AP
stage's `boundApDecision` turns the model's `pay` into a `schedule` for the policy's day (its due date) when no
early-payment discount is available today, there is no shortfall, the due date is ahead, and the bill is not already set
for today or an earlier day (a person's move from this plan, or a day chosen before). The ledger records
`timingRule: "pay.no_gain"`, and the reasoning ends with a note. Without it, the model once paid a 0.20 USDC bill 28 days
early while its own reasoning argued for the due date, which also left the bill outside the agent's early-payment offers.

**A scheduled payment the cash will no longer cover is decided before its day**
(docs/superpowers/specs/2026-10-17-cash-ahead-design.md, `src/lib/agent/cash-ahead.ts`). `dueForDecision` leaves a
scheduled payable to its day; `runApStage` first passes those still waiting to `cashAheadOf`, which reads the open book,
the verified milestones, the bank-paid vendors and each bill's latest `ap_schedule` or `payment_rescheduled` entry, and
`shortAhead` measures each USDC bill as `planPaymentTiming` does for a later day: operating plus reserve, less
`obligationsDueBy` its day, against `amountToPay` on its day. A short one joins the stage's payables and is decided with
every check; the model sees `scheduledEarlier.decidedBeforeItsDay`, the ledger entry records `cashAhead` (`scheduledFor`,
`cashCounted`, `dueBefore`, `needed`), and a hold is `heldBecause: cash_shortfall`, so the follow-up reopens it and the
customer discount and more-time stages act on it. A model `pay` on such a bill is held by code (`timingRule:
"pay.cash_ahead"`): paid now, it would take the cash the bills before it count on. No treadmill: a person's move keeps
its day, a decision that scheduled knowing `timing.shortfall` stands, and a bill already decided early is measured again
only when what is left for it (cash counted less what falls due before it) fell by more than a cent; at most 5 a cycle,
earliest first. A read that fails leaves every bill to its day. The follow-up's cash rule (`cashChangeSince`) now takes
a bill's `amountDueAtTarget` and `targetOn` from its hold and `dueBeforeHeldBills` from the book now, so a bill held
behind one that was paid since reopens once what is left for it grew and covers it, rather than waiting for the whole
figure it saw when held. The customer discount stage's `cashShortfall` adds USDC payables scheduled on or before the
last held bill's due day, and takes off the reserve with the operating USDC.

Bills & receivables' Payment plan tab shows the next 14 UTC days of payments
(docs/superpowers/specs/2026-10-11-payment-plan-design.md), read only when that tab is shown. `planPayments`
(`src/lib/payment-plan.ts`) is pure: from the operating wallet, the USYC
reserve and its yield, Safe to spend's cushion (`cashOutlook(...).cushion`, so
the two figures never disagree), the open payables and milestones, the agent's
spending limit with what it paid, and the figure for two approvals, it gives
each counted line a day (today when overdue, the due date otherwise or the
agent's own earlier day, never later than the agent chose; a discount's last
day only when the discount is worth at least the reserve's yield to the due
date, the cash covers the bill then, no other line falls short, the spending
limit has room for the billed amount and the balance stays at or above the
cushion until the bill would otherwise pay (not weighed when the cash would not
cover the bill on that later day at all), each check holding against the plan
and against the schedule with only that bill moved, the bill itself within the
limit on its new day; bills the agent scheduled after their due dates are
brought back one at a time, whatever the cushion; a discount day the agent
chose itself is kept whatever it holds, and a scheduled bill whose day has come
goes where the agent's own rule puts it at its next cycle, unmovable), walks
the days in the cash's order, marks a line the balance cannot cover as short
without spending it, counting it in full as still owed, and previews each
line's checks (payment limit, two approvals, screening, the daily and 7-day
limit on the billed amount), a verified milestone's included. A move is only
ever to an earlier day inside the 14 days. `paymentPlanInput` (`src/lib/payment-plan-input.ts`) turns the
rows into that input, and `readPaymentPlanInput` (`src/lib/payment-plan-read.ts`)
reads them in the workspace's scope; the page builds the plan from it
(`readPaymentPlan`) and so does the command, so they build the same plan. The
page reads it best effort: a plan that cannot be read says so in its section
and nothing else on the page changes.

**Fingerprints and freshness.** The plan carries a fingerprint over today, the
cash, the reserve's rate, the cushion, the limits and every line's own
fingerprint (the bill's status, amount, currency, payee and its address, due
day, scheduled day, discount, creator, the payee's payment limit and screening,
and the plan's day for it). `planFreshness`
turns approving off while a live workspace's chain balance
(`accounts.balance_synced_at`) is older than 10 minutes or was never read, or a
limit or the milestones could not be read; the section keeps the plan on screen
and offers the console's own balance read (`refreshOnChainBalanceAction`).

**Approving a line moves a day, never money.** `approvePlanAction`
(`src/app/actions/payment-plan.ts`) authorizes `approval.decide`, then runs
`approvePlanLines` (`src/lib/commands/payment-plan.ts`, `payment_plan.approve`,
the console only). The command refuses while a cycle runs (the AP stage writes a
decided bill without a compare-and-set), reads the plan again, and refuses a
stale balance or a plan fingerprint other than the one shown, with `changed` so
the console refreshes the page to the plan as it is now. Each line is then
checked on its own: its fingerprint, a move to offer, its blocking flags, and
maker-checker (whoever created the bill approves its day only as the
workspace's only approver, `isSoleApprover`). In the plan's order, each move is
then weighed by `moveObjection` (`src/lib/payment-plan.ts`, the planner's own
checks) against the schedule as it stands with the moves the same request made
before it, so the moves made hold together whichever lines pass; a write that
throws stops the request there, since it may or may not have landed.
`moveScheduledPayment` (`src/lib/payment-plan-apply.ts`) writes `scheduled_for`
with a compare-and-set on the status, the day shown, the counterparty, the
amount and the due day, and
appends a signed `payment_rescheduled` entry (actor `human`, domain `ap`) with
who moved it, the days, the line's facts and both fingerprints. The AP stage
then decides the bill again on its new day like any scheduled bill
(`dueForDecision`), with every guardrail; a move to today raises a
`plan_approved` cycle event. The decision card skips `payment_rescheduled`
when it looks for the agent's decision (`matchingEntry` in
`src/components/vx/map.ts`), and the decision trail shows it as a person's step.

**Money expected in, apart.** `PaymentPlanInput.incoming` carries the open receivables (a deal's released lines among
them, a part-paid one for what is still owed from `PlanRows.owed`) and the deal lines planned (`PlanRows.planned`;
both read by the page only), and the plan lists those due in its
window as `incoming.expected` and `incoming.planned`, each on its due day (today when past). Neither enters a day's
balance, a flag or a fingerprint, so approving a line never depends on money expected
(`docs/superpowers/specs/2026-10-12-deal-schedule-design.md` D14).

**Measured, not projected.** `planOutcomes` (`src/lib/payment-plan-outcomes.ts`)
counts the last 30 days from what happened: bills paid by their due day,
discounts the transfers carried (amount less `paid_amount`), and
`payment_rescheduled` entries. The plan's own discounts are labelled an
estimate.

## Notifications

**A digest tells the members who can decide a payable that it is waiting for
them**, once per workspace per scheduled cycle. `notifyWaitingDecisions`
(`src/lib/notifications/waiting.ts`) runs after `runScheduledCycle`
(`src/lib/agent/cron.ts`), in the same workspace scope, for every `live`
organization the cron did not skip — a cycle started from the console has a
person watching it already, so only the unattended cron notifies.
`waitingToNotify` selects the payables that are `held`, `flagged`, or
`awaiting_info` and either have never been told (`invoices.notified_at` is
null) or were escalated by the follow-up stage since they last were
(`escalated_at > notified_at`, recorded as `invoice_escalated` by
`applyFollowUp`) — so an escalation is news again. Recipients are the
members with `approval.decide` (`owner`, `admin`, `approver`) whose own
`memberships.notify_email` switch is on, at most 25 per workspace, the rest
logged rather than emailed. Each recipient gets a message of their own —
addresses are never shared between them — built by `waitingDigestEmail`
(`src/lib/email/waiting-digest.ts`): the workspace name, up to 10 invoices
(then "and N more"), each with the counterparty's name, amount, status, and
the first sentence of the agent's reasoning (at most 140 characters), all HTML-escaped, with no
counterparty address, wallet, or email. It is sent through the same
`sendEmail` (Resend, `no-reply@vestiarion.xyz`) invitations use. Needs
`RESEND_API_KEY`; without it, nothing is sent and nothing is marked, and the
next scheduled cycle tries again. The invoices are marked `notified_at = now()`
only once at least one recipient's send has succeeded — so a digest nobody
received is retried, never lost — and the ledger records `notification_sent`,
with `detail: { invoiceIds, escalatedIds, recipients: <count>, failed:
<count> }`: ids and counts, never an address. A failure anywhere in this path
is logged with the workspace id and never fails the cycle or the tick.

**A waiting payable past its decide-by day is escalated once for that day.** After the digest,
`escalateOverdueDecisions` (`src/lib/notifications/escalations.ts`, also from `runScheduledCycle`, in its own `try`)
reads the waiting payables (`held`, `flagged`, `awaiting_info`) whose decide-by day (`decideByOf`) is before today,
or, past the due date, whose late fee starts tomorrow (the fee's eve: its last day without the fee, after the due date,
is today; the item's day is that day, a new key, so it is told once more even when escalated past its due date; the
item carries the payable as past its due date beside it, `passed`, when that day counts, claimed with the eve and sent
in its place when that claim is new, the first day past the due date or the first day it waits, so an eve never delays
the escalation it gets without the fee; at most one item a payable a run), each by its own day on or after the day
escalations started in the workspace (`approval_escalation_starts`, 0108: one row per workspace,
set by its first run, insert-only for the tenant role, so a payable already past its day then is never emailed for that
day and turning escalations on sends no backlog; one with a late fee is still told on its eve, whose day is today),
reads the recipients, the workspace and the members before anything is
claimed, claims each in `approval_escalations` (migration 0108: unique per payable and decide-by day, an
`ignoreDuplicates` upsert, so only the rows it inserted are news; an eve is claimed on its own day and a passed day only
after it, so a passed day of a payable with a late fee found taken by a claim made on that very day is a spent eve's,
when the due date moved onto a day an eve was told on, and `retakeSpentEves` releases it and claims the day again,
logging and leaving it on any failure), and emails the digest's recipients, with the same
switch and cap, deduplicated by member and address, each one message a run about the payables they may act on (`whoCanAct` over every member, as the card names them;
`decisionEscalationEmail`, `src/lib/email/decision-escalation.ts`: names, amounts, statuses and days, escaped, each
item worded on its own: a late fee as `lateFeeDayWords` names it, or, on its eve, that it starts tomorrow, with eves
listed first; a batch with no eve reads as before; no address). A payable someone received keeps its claims with `sent_at` and the counts, and the ledger records
`decision_escalated` (`detail: { invoiceIds, decideBy, recipients, failed }`); a payable nobody received has its claims
deleted, even when a send throws, so the next scheduled cycle tries again. Without email configured, or nobody to tell, nothing is claimed.
Before 0108 runs nothing is escalated.

**The switch** is the member's own: `memberships.notify_email` (migration
`0026`), on by default. It changes only from the Notifications section at
the top of Settings (`/o/[slug]/settings`, `NotificationsPanel`), which shows
it — "Email me when payments need a decision" — only to a member who holds
`approval.decide`; a viewer sees nothing, because a viewer cannot decide and
so receives nothing. The same section holds the member's own Telegram card;
Members keeps a link to it.

**Emails to counterparties** go to one address per counterparty, its billing
email (`counterparties.notice_email`, migration `0063`), and only from `live`
workspaces; the ledger keeps the address with most of its name hidden.

- **Payment notices** (`src/lib/payment-notices.ts`: the cycle's `notices`
  stage, and after a person's approval): a payee is told once each payment to
  it is confirmed on Arc testnet. The payment intent is claimed
  (`notice_sent_at`) before the send and released if it fails; each notice is
  `payment_notice_sent`.
- **Reminders** (`src/lib/agent/collections.ts`: the `collections` stage,
  which needs `receipts`, so no one who may just have paid is reminded): only
  for a receivable whose reminders an owner or admin turned on
  (`receivable_links.reminders_on_at`, migration `0065`). Code decides whether a
  reminder is allowed now and which tones are (`src/lib/collections.ts`); the
  model decides between sending and waiting, beside the written policy's
  answer. A reminder is claimed as an `ar_reminders` row, unique per receivable
  and number, before the send, and deleted if it fails. The email is a fixed
  template that carries the pay link, whose token is kept encrypted under the
  platform master key (`receivable_links.token_enc`). Each reminder is
  `ar_reminder_sent`, each wait `ar_reminder_deferred`. A part-paid receivable
  is reminded of what is still owed, saying what arrived (`partPaid` in the
  entry), and one with nothing owed is not reminded (migration 0103). Each
  receivable is first proposed a next step from its customer's context, and only
  a proposed reminder is weighed (see Collections that follow the customer's
  context, below). Each reminder carries an idempotency key, claimed in
  `notification_deliveries` and sent to Resend, and its opt-out is read again
  right before the send.
`setNotifyEmailAction` (`src/app/actions/notifications.ts`) is gated on
`workspace.read`, and writes only the row named by the session's own user id
— a `userId` field in the form is never read.

**A member can also connect their own Telegram chat**
(docs/superpowers/specs/2026-10-03-telegram-bot-design.md). One bot serves the
whole deployment; it is on only when `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_USERNAME` are all set
(`src/lib/telegram/settings.ts`), and `npm run telegram:setup` registers its
webhook and command menu. The Telegram card in Settings' Notifications section
(`connectTelegramAction`, gated on `workspace.read`) makes a one-time code,
stores only its SHA-256 (`telegram_link_codes`, migration `0064`, ten
minutes), and links `https://t.me/<bot>?start=<code>`. Telegram then posts
`/start <code>` to `POST /api/telegram`, which answers 401 unless the request
carries `X-Telegram-Bot-Api-Secret-Token`, and 200 to everything it
accepted, so Telegram never redelivers in a loop. `telegram_claim_code` claims
the code and links the chat to the membership in one transaction
(`telegram_links`: one chat per membership, one active workspace per chat,
both tables cascading with the membership; service role only). Each update
reads the member's role again (`src/lib/telegram/updates.ts`); only private
chats are served. `/today`, `/waiting` and `/ledger`, or the same questions
in plain words, are answered by code from the workspace's rows: the model
only picks which question was asked (`src/lib/telegram/route-text.ts`). An
invoice sent to the bot is read by the same `readInvoiceDraft` as **From a
document**, held for an hour (`telegram_drafts`), and added only when an owner
or admin taps **Add** in their own chat, through the same `createInvoice` the
invoice form uses, with `via: "telegram"`. The bot never approves or pays.
The cycle's `telegram` stage (`src/lib/telegram/notify.ts`) tells each
linked chat the agent's decisions after its cursor (`telegram_links.notified_seq`),
read by the same `readAgentActivity` as the console's toasts (which tells, beside
the agent's decisions, the early payment it negotiates: `EARLY_PAYMENT_ACTIONS`
in `src/lib/agent-activity.ts`, with a supplier's answers the system records,
`SUPPLIER_ANSWERS`, and never a person's own offer), and then moves
the cursor past everything read: a failed send keeps it for the next cycle,
a 403 disconnects the chat, and a message Telegram refuses to parse is sent
once as plain text, link previews off as on every send, and then passed. The stopped payables among what was read
that are still held, flagged or awaiting_info, read again in one query per
cursor through the same `src/lib/notifications/waiting-bills.ts` as Discord's
stage (the rules for two approvals and co-sign once per stage, and only once a
bill waits), end the same message as one section built from
`buildWaitingNotice`, in place of those bills' blocks
(docs/superpowers/specs/2026-10-23-telegram-review-links-design.md): a line
each with its amount, payee, status, why it waits, "needs two
approvals" (and that an accountant can co-sign) and a Review link to
`/approvals#payable-<id>` that carries no token, as many of ten as fit, the
section taking the room first, then "Opening a link never approves anything."
once. Why it waits is what code stopped it on, when code did
(docs/superpowers/specs/2026-10-24-chat-code-stop-reason-design.md):
`waitingBills` reads the listed bills' ledger entries in one
`listLedgerEntriesForTargets` call, and `stopRuleOf` takes the latest AP
decision's (`latestDecision`) `guardrailRule` when `guardrailBlocked`, else
`CASH_SHORTFALL` when `codeHeldForCash` (held for cash, and code made the
hold: the agent's `pay`, or the `cash.priority` or `pay.cash_ahead` timing
rule; a hold the agent chose itself while cash was short is its own), as
`listWaitingPayables` gives the approval card; `codeStoppedLine`
(`src/lib/next-step.ts`) says it as "Code stopped it: *the rule in brief*.",
the same line as the row's `stoppedWhy` on Bills & receivables, whose
`invoiceDecision` reads the guardrail and `heldForCashByCode` from the same
decision while the bill waits, past a newer escalation entry. Otherwise, or
when a rule has no words of its own, it is
the first sentence of the reasoning, as when the entries cannot be read (logged
once, the notice still sent). `/waiting` (`waitingFacts`) reads its payables'
entries the same way, best effort as it reads verdicts, and a held milestone
keeps its reasoning's first sentence. A shadow-mode verdict hold has no
`invoiceId` and keeps its block; bills that cannot be read leave every block
as it was. Every value in the message
(the workspace's name, each decision's text and reason, and the section's) and
in `/waiting` goes through `telegramText` (Unicode's Cf and half of an emoji
removed, whitespace to one space, addresses shortened, then what Telegram
would make tappable broken up: a dot before a domain's ending or in an IP
address written `[.]`, every `@` and every `/` that follows no letter or digit
in its fullwidth form; then clipped by UTF-16 units without splitting a
character, and HTML-escaped), and `/waiting` counts what does not fit rather
than cut its HTML. The transfer watch's post to the chats
is this same send, so a chat whose cursor lags is told its waiting bills there.

**A workspace can also connect Slack**
(docs/superpowers/specs/2026-10-03-slack-design.md). One Slack app serves the
deployment (`integrations/slack/manifest.yaml`), asking only for `commands` and
`incoming-webhook`; it is on only when `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
and `SLACK_SIGNING_SECRET` are all set (`src/lib/slack/settings.ts`), and every
`/api/slack/*` route answers 404 otherwise. An owner's or admin's **Add to
Slack** (`/api/slack/install`, `integrations.manage`) goes to Slack's OAuth with
a state signed under a key derived from the master keys (ten minutes) and bound
to an HttpOnly nonce cookie; `/api/slack/oauth` checks both, exchanges the code,
and `saveInstall` keeps the bot token and the channel's webhook URL as envelopes
(`slack_installs`, migration `0067`: one Slack team per workspace), starts the
channel's cursor at the ledger's head, and links the installer's own Slack
account. Every request from Slack (`/api/slack/commands`, `/interactions`,
`/events`) is checked against the signing secret (v0 HMAC, five minutes) before
anything is read, answered at once, and worked in `after()`; answers go to the
request's `response_url`, only ever under `https://hooks.slack.com/`. A member
links their own Slack account with `/vestiarion connect`: a one-time code
(SHA-256 only, `slack_link_requests`, ten minutes) opens
`/integrations/slack/connect`, where the signed-in member confirms it, and
`slack_link_member` uses the code up and links it in one transaction
(`slack_links`: one link per membership and per Slack user, cascading with the
membership and with the install). Each command and click reads the member's
role and the install's limit again (`slackActor`). The cycle's `slack` stage
(`src/lib/slack/notify.ts`), just before `discord`, posts the agent's decisions after the
install's cursor (`slack_installs.notified_seq`) to the channel, read by the
same `readAgentActivity`, and moves the cursor only once Slack took the message.
While an owner has set a limit (`decisions_limit_usdc`), a stopped payable's
message carries Approve and pay, Reject and Return, each holding a signed card
(`vx1.…`, seven days) naming the payable, when the agent decided it, and its
payee's address hash; a click runs the payable command with that card, so the
chat's rules and every check of the console's approval run, and rewrites the
message to say who decided. Removing Slack from Settings uninstalls the app and
deletes the install with its links; Slack's `app_uninstalled` and
`tokens_revoked` events do the same.

**An invoice can be added from Slack** (Slack design S15): the message shortcut
**Add invoice** sends the chosen message to the interactions
route, and `src/lib/slack/intake.ts` reads its file, fetched only from
`https://files.slack.com/` with the install's token under `files:read`
(`slack_installs.scopes`, migration `0070`; an install made before asks for
**Reconnect Slack**), or its text, with the same `readInvoiceDraft` as **From
a document**. Whether a read may become a draft is the one rule every chat
shares (`src/lib/invoice-document/chat-draft.ts`, which the Telegram bot uses
too); a draft is held for an hour (`slack_drafts`, gone with its link) and
answered to that member alone, and its **Add** runs `addInvoice` as them, for
an owner or admin, whose entry names `via: "slack"` and the link.

**A workspace can post the bills waiting for approval to Discord**
(docs/superpowers/specs/2026-10-22-discord-design.md). There is no app and no
deployment setting: an owner or admin (`integrations.manage`,
`src/app/actions/discord.ts`) pastes a channel webhook's URL in Settings, and
`parseDiscordWebhookUrl` (`src/lib/discord/webhook-url.ts`) accepts only
`https:` on `discord.com`, `discordapp.com`, `canary.discord.com` or
`ptb.discord.com`, with no credentials, port, query or hash and nothing but
`/api[/vN]/webhooks/{id}/{token}`, and rebuilds it as
`https://discord.com/api/webhooks/{id}/{token}`: only that string is stored and
called, so no DNS check is needed. Connecting reads the webhook (its channel,
server and name), posts a test message that says it is checking the webhook (so
it claims nothing a failed save would undo), and only then `saveConnection`
stores the URL as an envelope (`discord_webhooks.webhook_url_enc`, migration
`0140`: a platform table, one row per workspace) with the cursor at the ledger's
head, and signs `discord_connected { by, webhookId, channelId }`; a second
channel connected at the same moment fails on the unique key as
`DiscordAlreadyConnectedError`, and its person is told so. Connect and **Send
test message** each take a token from `takeDiscordCallToken`
(`src/lib/rate-limit.ts`: five at once, then one every 12 seconds, per workspace
and per person) before calling Discord, so no one can make the server send
Discord a stream of refused calls. Every call
(`src/lib/discord/api.ts`) goes only under that prefix, with `redirect: "error"`
and ten seconds; a post sends `allowed_mentions: { parse: [] }`, flag 4 (no
embeds), the username Vestiarion and at most 2,000 characters. The cycle's last
stage, `discord` (`src/lib/discord/notify.ts`), reads the agent's activity after
`discord_webhooks.notified_seq`, page after page up to the ledger's head while
less than 8 of its 20 seconds have gone (`READ_BUDGET_MS`, so the post's own
deadline still fits), keeps the stopped payables with an `invoiceId`
(none for a shadow-mode verdict hold), reads them again in one query and keeps those still held, flagged or
awaiting_info, as Slack's notifier does (`src/lib/notifications/waiting-bills.ts`, which Telegram's stage
reads too),
and posts one message (`src/lib/discord/messages.ts`) built from
`buildWaitingNotice` (`src/lib/notifications/waiting-notice.ts`, structured
entries each chat formats in its own markup, as Telegram's decisions message does): at most ten bills, as many as fit, each with its
amount, payee, why it waits ("Code stopped it: *the rule in brief*." when
code stopped it, else the first sentence of reasoning, read as for Telegram's
section), "needs two approvals" (and that an
accountant can co-sign while co-signing is on) and a Review link to
`/approvals#payable-<id>` that carries no token. Every value goes through
`discordText` (invisible format characters, Unicode's Cf such as bidi overrides
and zero-width spaces, and half of an emoji left alone removed; whitespace and
control characters to one space; addresses shortened; Discord's markup and
mention characters backslash-escaped; then clipped by UTF-16 units, never
between the two halves of an emoji); only the app's own links are added raw,
inside `<…>`. A 2xx moves the cursor and clears `last_error`; a 429
asking for 2 seconds or less is waited out once inside a 20-second budget, any
other keeps the cursor; a 5xx or no answer keeps it and records `last_error` and
`failures`, which Settings shows; a 400 is recorded and passed over; a 401, 403,
404 or Discord code 10015 or 50027 deletes the connection and signs
`discord_disconnected { by: null, webhookId, via: "discord" }`, as **Disconnect**
does with `via: "settings"`. Before 0140 every read sees the missing table
(PGRST205/42P01) as not available: Settings says so and the stage does nothing.
It is not part of the transfer watch's posts: a stuck payment is no bill waiting
for approval.

**Invoices can arrive by email**
(docs/superpowers/specs/2026-10-03-email-invoices-design.md). Resend receives
at the inbound domain (`INBOUND_EMAIL_DOMAIN`: Resend's managed
`<id>.resend.app`, or a subdomain with its MX record); a workspace's address is
`invoices-<code>@<domain>`, the code 12 random base32 characters kept in
`invoice_inboxes` (migration `0068`, platform), which an owner or admin turns
on, replaces or turns off from Settings (`integrations.manage`), recorded
without the address. `POST /api/email/inbound` checks Resend's Svix signature
over the raw body before anything is read (`src/lib/email-inbox/verify.ts`),
routes the email to the first recipient whose code is an inbox's, stores it at
once in `inbox_emails` (tenant rows, one per Resend email, so a redelivery
stores nothing new), answers 200, and reads it in `after()`
(`src/lib/email-inbox/receive.ts`): the email and its first PDF, `.eml` or
`.txt` attachment from Resend's receiving API (the download only from Resend's
own domains, `resend.com` and `resend.app`), else its text, through the same
`readInvoiceDraft` and the shared draft rule; a picture attached instead of a
document is named in the reasons. The row ends `ready`, `needs_details` or
`unreadable`, with reasons a person reads, and keeps what was read (with the
matched counterparty's id and the document's hash); the workspace's Slack
channel is told. Nothing is added by itself: on Bills & receivables an owner or
admin runs `inbox.add` (the draft used once, put back if the invoice cannot be
added; `create_invoice` names `via: "email"` and `inboxEmailId`), `inbox.finish`
(the invoice form started from what was read, for any email ready, needing
details or unreadable; the entry also lists the fields the person changed) or
`inbox.dismiss`.

**A workspace can connect GitHub**
(docs/superpowers/specs/2026-10-04-github-app-design.md). One GitHub App serves
the deployment, on only when the five `GITHUB_APP_*` variables are set
(`src/lib/github/settings.ts`); `/api/github/*` answers 404 otherwise. An
owner's or admin's **Connect GitHub** (`/api/github/install`,
`integrations.manage`) goes to the app's install page with a state signed under
its own key derived from the master keys (ten minutes) and bound to an HttpOnly
nonce cookie, as Slack's is. `/api/github/callback` checks both, exchanges
GitHub's code for the person's own token, and connects the `installation_id`
only if `GET /user/installations` lists it for them, since GitHub's own
advice is never to trust that parameter; the token is then dropped.
`github_installations` (migration `0071`, platform) keeps the installation's
id, account and coverage, many to many with workspaces. The app's RS256 JWT
(`src/lib/github/app.ts`) finds a repository's installation and mints its
token for one run. The GitHub check (`refreshGitHubMilestones`) reads a
connected repository's pull requests with that token, so private ones verify
(`src/lib/github/tokens.ts`), and the deployment's `GITHUB_TOKEN` otherwise.
The cycle's `notices` stage comments on the pull request a milestone was paid
for (`src/lib/github/payment-comments.ts`): live payments confirmed on Arc
testnet within three days and after the first connection, only where the
repository's installation is one this workspace connected, claimed in
`payment_intents.pr_comment_at` and released if GitHub refuses, recorded as
`pull_request_commented` with the comment's link. The body escapes the
workspace's name, so it cannot link, mention or point at an issue, and never
names the payee.

**A bounty can be attached from a pull request comment**
(docs/superpowers/specs/2026-10-04-github-bounties-design.md). The app's
webhook, `/api/github/webhook`, is on only with `GITHUB_APP_WEBHOOK_SECRET` as
well; `src/lib/github/deliveries.ts` checks GitHub's `X-Hub-Signature-256`
over the raw body before reading it, answers 204 to every event but a new pull
request comment carrying a command, and 202 to that, handling it after the
response with `after()`. `src/lib/github/bounties.ts` acts for the one
workspace that connected the delivery's installation, saying nothing where
none did and refusing where several did. `/bounty <amount>` needs GitHub to
say the commenter can write to the repository (`repositoryPermission`), then
runs `milestone.add` as the member who connected the installation, read now
through `memberActor` on the `github` surface, which may run nothing else.
`github_bounties` (migration `0072`, platform) is claimed before anything is
made, unique per pull request and per comment, so two comments at once never
make two milestones and a delivery sent again does nothing twice; it then
gains its counterparty (the author's, created as a contractor named after the
login, or the one an earlier bounty made) and its milestone, and the ledger
records `github_bounty_attached`. `/payto <address>` from the pull request's
author goes through `changeCounterpartyAddress` as a payee link's address
does: stamped, held until a member confirms it, and emailed to them. Every
outcome gets a reply on the pull request; the agent then releases the
milestone under every guardrail, as any other. A `pull_request` delivery closed as
merged (`src/lib/github/merges.ts`) starts `runCycleSoon` (`pull_request_merged`)
for each connected workspace with a pending milestone on that pull request, as
the GitHub check reads its link, so the payment follows the merge within a
minute instead of waiting for the schedule.

## Early-payment offers

A supplier paid today for a discount it accepts (docs/superpowers/specs/2026-10-16-early-payment-offers-design.md).

- **Which bills, what to ask** (`src/lib/early-pay/offers-words.ts`, `offersView`). A payable scheduled or pending,
  with no discount, no payment intent and a due date at least 3 days out. The suggestion is twice the reserve's yield to
  the due date (`apy × days / 365`), rounded up to 0.25%, from 0.5% to 5%; with no reserve account the yield is 0, and
  only a failed read is an error. Shown on Bills & receivables above the list (`EarlyPaymentOffers`).
- **The offer** (`createOffer`, migration 0125). `create_early_payment_offer` checks eligibility
  (`early_payment_offer_eligible`), withdraws the bill's open offer, and stores the bill's amount, the discounted amount
  and the SHA-256 of a `vxo_` token (one open per invoice, partial unique index). It lapses after 7 days or the day
  before the due date. The tenant role only reads `early_payment_offers`; every write is a service-role function.
- **The supplier** (`/offer/[token]`, `decideOffer`). No session; the token is the credential, and `/offer/:token`
  is redacted for analytics. `decide_early_payment_offer` locks the offer and the bill. An acceptance needs the bill
  still eligible and its amount unchanged; it then sets `early_pay_discount_pct` and `discount_due_date` (today, 12:00
  UTC), returns the bill to `pending`, and marks the offer accepted. The ledger records the answer, and
  `runCycleSoon({ kind: "early_payment_accepted" })` lets the agent decide the bill at once with its usual timing: a
  discount ending today is paid today, after every check.
- **The agent's own offers** (`src/lib/agent/early-offers.ts`, stage `early_offers`, migration 0126;
  docs/superpowers/specs/2026-10-16-agent-early-payment-offers-design.md). An owner or admin turns them on with a
  ceiling (`set_agent_early_offers`, `orgs.early_offers_*`). After collections, in a workspace not paused and with
  email configured, each scheduled USDC bill due 7 days or more out is weighed once code allows it
  (`agentOfferAllowed`, `src/lib/early-pay/agent-rules.ts`): never offered before, its supplier with a notice email, no
  other open offer and no decline in 30 days, the suggestion within the ceiling, and the operating USDC left after this
  cycle's payments, less what falls due in 7 days and the offers out, covering it. The model answers `offer` or `skip`
  with a discount, kept between the suggestion and the ceiling (`boundOfferPct`); without a model, the written policy
  offers at the suggestion. `early_payment_offer_reviews` (one per bill) is claimed before the offer is made; the
  link goes to the supplier in a fixed template (`src/lib/email/early-payment-offer.ts`) under the offer's Resend
  idempotency key. A failed send withdraws the offer and releases the review; one left unsent for 15 minutes is a
  stopped run's and is withdrawn the same way. A skip is weighed again after 7 days. At most 3 offers a cycle; the
  ledger records `early_payment_offered` (`via: "agent"`, the decision, the written policy's answer) or
  `early_payment_offer_skipped`. In a sandbox (docs/superpowers/specs/2026-10-17-sandbox-offers-design.md), whose
  suppliers are sample data, the offers and the answers to counters go to the member who turned the offers on
  (`sandboxRecipient`, `orgs.early_offers_on_by`), with a "[Sandbox]" subject and `sandbox: true` on the entry; none
  goes when that member has left. The sample data includes a no-discount bill due in 21 days for it to offer.
- **Counters** (migration 0127; docs/superpowers/specs/2026-10-17-offer-counters-design.md). On an offer the agent made
  (`early_payment_offer_by_agent`, a review linked to the offer), the supplier's page takes a smaller discount
  (`counterOffer`, `counter_early_payment_offer`). The offer becomes `countered` with `counter_pct`, and
  `runCycleSoon({ kind: "early_payment_countered" })` starts a cycle. The `early_offers` stage answers counters before
  it makes offers (`answerCounter`). Code declines, with no model, when the agent's offers are off, the bill changed, the
  counter is no more than the reserve's yield to the due date, or the cash for offers falls short. Otherwise the model
  answers `accept | decline` beside the written policy (accept). `answer_early_payment_counter` answers a countered
  offer once: accepted, the bill takes the counter as its discount, ending today, and returns to pending, and the offer
  is accepted at the counter. The supplier is emailed the answer in a fixed template (`counterAnswerEmail`) under the
  offer's idempotency key, and an accepted counter starts a cycle that pays it.
- **Results and cover** (docs/superpowers/specs/2026-10-17-offer-results-design.md, no migration). `offersView` adds
  `results` (`offerResults`): offers made, by the agent, accepted, after a counter, declined, and what the bills paid
  early saved, with a yearly rate on the cash paid early weighted by days early. The section shows it as one line
  (`offerResultsLine`). Before counters, the `early_offers` stage keeps the offers out covered: while the operating USDC
  left after the cycle's payments, less what falls due within 7 days, is below every open offer, it withdraws the
  agent's own, the largest first, and records `early_payment_offer_withdrawn` with `reason: "cash"`.

## Customer discounts for paying early

While bills are held for want of cash, the agent offers customers a small discount to pay an open receivable within
days (docs/superpowers/specs/2026-10-17-customer-early-pay-discounts-design.md). The receivables side of the
early-payment offers above.

- **Setting** (`src/lib/customer-offers/store.ts`, migration 0129). An owner or admin turns it on with a ceiling from
  0.5% to 5% (`set_customer_offers`, `orgs.customer_offers_*`); `customer_offers_on` and `customer_offers_off` are signed.
  Live workspaces only: a sandbox has no wallet to receive a payment in.
- **The stage** (`src/lib/agent/customer-offers.ts`, stage `customer_offers`, after `early_offers`, needs reconcile,
  receipts and AP). The shortfall is the payables `held` whose newest AP entry says `execution.heldBecause:
  "cash_shortfall"` (`heldForCash`), less the operating USDC left after the cycle's payments and the discounts accepted
  and not yet paid (`cashShortfall`). With a shortfall, the receivables code allows (`customerOfferAllowed`: open USDC,
  nothing applied or matched, due 7 days or more out, never offered, a billing email and a kept pay link, no other open
  offer for the customer, no decline in 30 days) are weighed largest first, one per customer, three per cycle, until
  they would cover it (`pickCustomerOffers`). The model decides `{ action, pct, reasoning }`; code keeps `pct` between
  0.25% and the ceiling (`boundCustomerPct`); the written policy gives 1% per 30 days early (`suggestedCustomerPct`).
  Each review is claimed in `customer_discount_reviews` before `create_customer_discount_offer` makes the offer; the
  fixed email (`src/lib/email/customer-discount.ts`) goes under the offer's idempotency key, and a failed or unsent one
  is withdrawn. Signed: `customer_discount_offered`, `customer_discount_skipped`, `customer_discount_withdrawn`.
- **The customer's answer** (`/discount/[token]`, `vxd_` token, SHA-256 kept; `decide_customer_discount`). Accepting,
  while the receivable is still open with the same amount and nothing applied or matched, sets the receivable's
  `early_pay_discount_pct` and `discount_due_date` to the offer's, ending on the pay-by day; the amount never changes,
  so deal collection, CRM write-back and commissions read the receivable as before. Signed `customer_discount_accepted`
  or `customer_discount_declined`; an acceptance starts a cycle (`customer_discount_accepted`).
- **Paid at the discount** (`src/lib/agent/receipts.ts`). The stage reads each open receivable's `accepted` offer;
  `matchTransfer` also takes that offer's `offered_amount` (`owedAt`) for money that arrived after the offer was made
  and by the end of its pay-by UTC day, and says `atDiscount`; the full amount always matches too. A discount typed on a
  receivable without an offer is never taken. Settled at the discount, `settle_customer_discount` marks the offer `paid` and
  `customer_discount_taken` signs what it cost. The pay link page asks for the discounted amount while it applies
  (`payLinkDiscount`) and, paid, says what arrived (`paidAtDiscount`).

## Requests for more time

The mirror of the early-payment offers: a bill held for want of cash, and the agent asks the supplier for the same
amount on a later day (docs/superpowers/specs/2026-10-17-term-requests-design.md, migration 0128).

- **The setting** (`setTermRequests`, `src/lib/terms/requests.ts`). An owner or admin turns it on with the most days,
  from 3 to 30 (`set_term_requests`, `orgs.term_requests_*`), on Bills & receivables (`TermRequests`). The ledger
  records `term_requests_on` or `term_requests_off`, and turning it on starts a cycle (`term_requests_on`).
- **The stage** (`src/lib/agent/term-requests.ts`, stage `term_requests`, after `customer_offers`). In a workspace not
  paused and with email configured, each held payable whose latest `ap_pay` or `ap_hold` held it for want of cash
  (`heldForCash`, `execution.heldBecause: "cash_shortfall"`) is weighed once code allows it (`termRequestAllowed`,
  `src/lib/terms/rules.ts`): due within 14 days or past due by no more than 7, never asked about, its supplier with a
  notice email, no other open request and no decline in 30 days. The model answers `ask | skip` with days, from the
  bill, the operating USDC after this cycle's payments, what falls due and what customers owe in the next 30 days, and
  the supplier's earlier requests. The written policy (`referenceTermDays`) asks for the days until what customers owe
  covers the bill after what falls due before it, from 7 to the most, or the most; code keeps the days from 3 to the
  most (`boundTermDays`). The review (`payment_term_request_reviews`, one per bill) is claimed before the request is
  made, and the link goes out in a fixed template (`src/lib/email/term-request.ts`) under the request's Resend
  idempotency key; a failed send withdraws the request, and one left unsent for 15 minutes is withdrawn
  (`term_request_withdrawn`, `reason: "not_emailed"`). A skip is weighed again after 7 days. At most 3 requests a
  cycle; the ledger records `term_request_sent` (`via: "agent"`, the decision, the written policy's answer, and
  `daysLimited` when code changed the days) or `term_request_skipped`. In a sandbox, the requests go to the member who
  turned them on (`orgs.term_requests_on_by`), with a "[Sandbox]" subject and `sandbox: true`.
- **The request** (`createTermRequest`). `create_term_request` checks eligibility (`term_request_eligible`: held, a
  positive amount, no payment intent), withdraws the bill's open request, and stores the amount, the due date, the new
  due date (the due date plus the days) and the SHA-256 of a `vxt_` token, one open per bill. It stands 5 days, or
  until the new due date if sooner. The tenant role only reads `payment_term_requests`; every write is a service-role
  function.
- **The supplier** (`/more-time/[token]`, `decideTermRequest`). No session; the token is the credential, and
  `/more-time/:token` is redacted for analytics. `decide_term_request` locks the request and the bill. An agreement
  needs the bill still eligible with its amount and due date unchanged; it then moves `due_date` to the new date,
  returns the bill to `pending`, and marks the request accepted. The ledger records `term_request_accepted` or
  `term_request_declined` (`via: "terms_link"`), and `runCycleSoon({ kind: "term_request_accepted" })` lets the agent
  decide the bill again against the new date. A request never changes the amount, the payee or where it is paid.
- **Fewer days** (migration 0130; `counterTermRequest`, `counter_term_request`). Beside Agree and Decline, the supplier
  may propose fewer days than asked: the request becomes `countered` with `counter_days`, the ledger records
  `term_request_countered`, and `runCycleSoon({ kind: "term_request_countered" })` starts a cycle. The `term_requests`
  stage answers up to `TERM_COUNTERS_PER_RUN` (10) counters first. Code declines one whose bill is being paid; otherwise
  the model answers `accept | decline` from the bill, the cash after what falls due on or before it, what customers owe
  and the coverage below, beside the written policy (`referenceCounterDecision`: accept only when the bill is covered by
  the new date). `answer_term_counter` records the answer, an accepted counter moving `due_date` by those days; the
  supplier is emailed (`termCounterAnswerEmail`) under the answer's idempotency key, and the ledger records
  `term_counter_accepted` or `term_counter_declined`. Before 0130 runs, the stage reads the requests without
  `counter_days` and has no counter to answer.
- **Coverage, from code** (`coveredAfterDays`, `coveredWithin`, `src/lib/terms/rules.ts`). For a new request and for a
  counter, the model is given whether the bill is covered on its due date and, if not, how many days after it the cash
  and what customers owe first cover it, rather than adding them up itself.
- **Withdrawn when no longer needed** (`withdrawTermRequest`). Each cycle, with the setting on or off, an open request
  whose bill is being paid (paid, or a payment intent started) or is no longer held for want of cash is withdrawn, unless
  its email is still going. The supplier is told (`termRequestWithdrawnEmail`), and the ledger records
  `term_request_withdrawn` with `reason: "paid"` or `"not_needed"` and `supplierTold`.
- **The supplier's history.** The requests a supplier got leave out one withdrawn before its email went (no
  `term_request_sent`), which also no longer stops its bill being asked about again. Only a request the supplier itself
  declined (`declined`, no `counter_days`) starts the 30-day pause (`TERM_DECLINE_COOL_DAYS`); a counter the agent
  declined does not. The model is told how many requests were made, accepted, declined by the supplier, countered and
  declined by the agent, and withdrawn by the agent.
- **Told** in the activity toasts, Telegram and Slack: each request, answer, counter and withdrawal
  (`TERM_REQUEST_ACTIONS`, `src/lib/agent-activity.ts`).

## Asking a vendor for a missing document

A bill waiting for its purchase order or goods receipt, and the agent asks the vendor for the document through a
one-time link that sends it straight to the bill (docs/superpowers/specs/2026-10-23-document-requests-design.md,
migration 0142). Part 1 asks, collects and shows. Part 2 checks what comes back against the bill
(docs/superpowers/specs/2026-10-25-exception-resolution-part-2-design.md, migration 0144): with vendor requests on, a
document that matches adds the bill's purchase order and nothing else, and a person approves the payment. Neither part
pays, nor changes a bill's status, amount or address.

- **The setting** (`src/lib/document-requests/setting.ts`). `approval_policies.document_requests`, `off`, `shadow` or
  `on`, off by default; an owner (`approval.policy`) changes it in Settings, beside the payee lock
  (`DocumentRequestsPanel`, `setDocumentRequestsAction`). An upsert of the workspace's row, refused while a cycle runs,
  signed best effort as `document_requests_changed { by, from, to }`; shadow or on starts a cycle
  (`document_requests_on`). Before 0142 the column is missing (42703, PGRST204): it reads off, Settings says it is not
  available, and the stage does nothing.
- **The stage** (`src/lib/agent/document-requests.ts`, stage `document_requests`, after `term_requests`, needing `ap`
  only: it reads the holds the AP stage just wrote and moves no money). Off, it reads the setting and stops. Otherwise, not
  while paused: `close_document_requests` expires open requests past their date or whose bill no longer waits for
  information, and drafted ones with three attempts spent. A payable qualifies (`documentRequestAllowed`,
  `src/lib/document-requests/rules.ts`) when it is `awaiting_info`, `missingDetails` of its current row names a purchase
  order or a goods receipt, its counterparty has a notice email and is neither frozen (`frozen_at`, read without it
  before 0137) nor screened high risk, and it has no request drafted or open, none answered or expired in 7 days, and
  none revoked. It keys on the row, never on `guardrailRule`, which most match holds leave null. At most 20 requests
  made and 20 emailed in 24 hours per workspace, counting the agent's own rows only (`email_domain` set): a document a
  member attached (0144) counts toward its bill's 7 days, not toward the 20. The bills' earlier requests are read 100 bills at a time (`ID_CHUNK`),
  so no read's address grows long enough to be refused.
- **A sandbox** never emails its vendors (`orgs.mode`, read with the workspace's name): the request goes to the member
  who last set vendor requests to shadow or on, named by the latest `document_requests_changed` and found among the
  members (`listMembers`), as term requests and early offers send theirs. The email is marked `[Sandbox]` and says whose
  place they take; the request keeps that member's email domain, and both ledger entries carry `sandbox: true`. With no
  such entry, or once that member left, a sandbox asks no one. A workspace in shadow mode asks as a live one does: its
  bills are the business's own, and a request asks for a document, never a payment.
- **Shadow** drafts the request (`create_document_request`, one drafted or open per bill by a partial unique index) and
  signs `document_request_drafted { invoiceId, counterpartyId, requestId, missing, emailDomain }`, once per bill: the
  domain is the only part of the address kept. Nothing is sent; the cards say what Vestiarion would ask.
- **On** drafts it, or takes the one shadow drafted, and claims an attempt (`claim_document_request_send`, a
  compare-and-set on `send_attempts`, at most 3) under a new `vxu_` token, of which only the SHA-256 is stored. The email
  (`documentRequestEmail`, a fixed template, `fromName` the workspace's, so the sender reads "Workspace via Vestiarion"
  at Vestiarion's own address) goes under a Resend idempotency key per attempt. Sent, `mark_document_request_sent` opens
  the link for 14 days and the ledger records `document_requested` (with `expiresAt`). Not sent,
  `release_document_request_send` drops the token, and the request waits for the next cycle, or expires after the third
  attempt.
- **The vendor** (`/documents/[token]`, `src/lib/document-requests/intake.ts`). No session; the token is the credential,
  checked for its shape before any lookup, and `/documents/:token` is redacted for analytics; the page is noindex.
  `document_request_preview` answers only for an open, unexpired request whose bill still waits for information; any
  other link shows one sentence naming no one. The file never passes through a server function: `startDocumentUpload`
  makes a signed upload address (`platformStorage().uploadUrl`) at `<org>/document-requests/<request>/upload` in the
  private `documents` bucket, and the browser puts the file there (the Supabase origin is in `connect-src`). Sending it
  (`submitDocument`) reads the file back, refuses it unless its first bytes are a PDF, PNG or JPEG of at most 10 MB
  (`sniffDocumentType`), and moves it to `<org>/document-requests/<request>/<sha256>`, out of the upload address's reach.
  The upload address stays good for two hours and may overwrite the upload, so the moved file is read back from where it
  is kept and taken only when it hashes as the file checked; otherwise it is removed (`failed_check`). The vendor's form
  reads the file's first 8 bytes too (`sniffDocumentType` is pure), and asks for the upload address and puts the file
  with that type, so a PDF with no extension, which a browser gives no type, is still taken. `answer_document_request`
  takes it once, re-checking the path, the kind, the size and the fields; a file it does not take is removed. Both
  steps take a token from `takeDocumentAddressToken` (per IP, before the lookup) and `takeDocumentLinkToken` (per live
  link). The purchase order number is plain text on one line of at most 100 characters, with no control or format
  character, no line or paragraph separator (U+2028, U+2029) and no link; a note's line breaks, those separators among
  them, are read as `\n` (`readDocumentFields`). The function and the table refuse a control character too, named by
  code point (C0, DEL, C1 and the two separators) rather than `[[:cntrl:]]`, whose members follow the database's ctype
  (glibc counts the separators, PGlite does not), so the page never passes what Postgres refuses; and a link. The
  ledger records `document_received` (`by: null`, `via: "document_request"`, with `poReference`, `fileSha256`, `fileType`,
  `fileSize`), and `notifyDocumentReceived` emails the owners and admins after the vendor has its page, saying whether a
  purchase order number came and never what the vendor typed. While vendor requests are in shadow or on and 0144 has
  run, sending it raises the cycle event `document_received`, with no member, and the email says what the check does.
- **The cards** (`readDocumentRequests`, `src/lib/document-requests/read.ts`; `DocumentRequestLine`). Approvals
  (`ApprovalCard`) and Bills (`WaitingPayableAction`) show each waiting bill's latest request: what Vestiarion would ask
  (drafted, while shadow, only for a bill still `awaiting_info`, as what its current row lacks), when it asked and until
  when (open), what the vendor sent (answered), or a link that expired unanswered. The latest answered request is kept
  apart: under a newer request as `received`, or alone when the newer one shows nothing, so the vendor's file and
  purchase order stay on the card. An answered request links any member to `/api/document-requests/[id]/file`, which
  checks membership and redirects to a one-minute signed download from the storage's own origin; its purchase order is
  filled into Add details (`suggestedPo`, from `suggestedPoOf`), which still adds it as before. An owner or admin
  revokes an open request (`revoke_document_request`, `document_request_revoked`); a revoked request is not made again
  for that bill.
- **Storage and tenancy.** The tenant role only reads `document_requests` under RLS; every write is a service-role
  definer function. The bucket has no storage policy: only the service role reaches it, through `platformStorage()`
  (`src/lib/dal`), narrowed to that bucket. Deleting a workspace, or the account of its last member, names its files
  before `delete_org`, reading the rows by id in pages of 1000 (PostgREST's `max_rows` cuts a longer answer without an
  error), and after it removes those and every file left under the workspace's `document-requests` folder, which it
  lists (`documentFilesOf`, `removeWorkspaceDocumentFiles`): a file kept for an answer that did not go through and could
  not be removed then, or kept by an answer after the rows were read, is named by no row. So does the daily cleanup
  around `delete_sandbox_org`, once it deleted an idle sandbox. Removing the sample data removes the files named by the
  requests to its sample counterparties (`removeDocumentFiles`). Every read of 0142's column, table and functions treats
  their absence as none.

Part 2, checking the document (`src/lib/agent/document-checks.ts`, `src/lib/document-requests/check.ts`, rules DK1-DK16):

- **The stage** (stage `document_checks`, after `compliance`, needing none: a failed check stops nothing else, since the
  hold below is read from the table). While vendor requests are in shadow or on and the agent is not paused, it takes
  the answered requests with `checked_at` null, oldest answer first, at most 5 a cycle, one `takeDocumentReadToken`
  per read. A request a vendor answered before 0144 ran has `checked_at` null too, so the first cycle after it checks it
  once. A bill that no longer waits for a document, or a file a check outside shadow already compared for the bill
  (matched or mismatched), is skipped with no read; one skipped or unreadable before was never compared, and is read
  when it comes again. An image, a file over 4 MB by its row, one not kept at its own path, gone from storage (any
  other Storage failure fails the stage), whose hash is not the one recorded, a scan or a PDF unpdf cannot read is
  unreadable, and no model reads it. The rest goes through `readPdfBounded` (its text, up to 20,000 characters, as
  `readDocument` reads it) and `extractInvoice`: the model sees the document alone, never the bill, and `decide()`
  computes the rule-based reading beside it.
- **The parse** (`readPdfBounded`, `src/lib/invoice-document/pdf-prescan.ts` and `pdf-worker.ts`). The scheduled tick
  runs every live workspace's cycle in one process, four at a time, so the cycle never parses an outsider's PDF
  unbounded. pdf.js decodes each stream into an ArrayBuffer, which no heap limit counts, so first a pre-scan decodes
  every stream pdf.js would decode for text the way pdf.js does (its lexer, parser and inflate, ported: zlib refuses
  streams pdf.js decodes), counting bytes, and refuses a file past 16 MB decoded, or one it cannot measure (encrypted;
  LZW, run-length, Brotli or an image codec where text is read). Images a page only draws are left out. Then pdf.js runs
  in a `node:worker_threads` worker with its own heap (256 MB old, 32 MB young), a 512 MB budget for the process's
  resident memory that the parent reads every 25 ms, and 15 s. It refuses more than 50 pages before reading one, and
  stops reading pages once the text passes 20,000 characters (`truncated`). One parse runs at a time per process
  (`oneParseAtATime`, around the count, the parse and the clear). The file's own doing (the pre-scan, the pages, a parse
  error, its own heap full, a timeout while no other PDF was parsed on the thread) is unreadable, recorded like any
  other. A stop at the memory budget, which counts every thread's memory, or a timeout while `readDocument` parsed on the
  thread (`countedParse`), records nothing and is read again next cycle, still counted. A worker that never came online,
  or could not load unpdf, fails the stage, which is not the file's doing. The worker's script is plain text that
  imports unpdf from `node_modules`, so `next.config.ts` lists unpdf in `serverExternalPackages` and each function that
  reads PDFs carries it. Each parse is counted first (`parse_attempts`, `start_document_parse`, which answers the
  unfinished reads of that file's SHA-256 across the workspace's requests) and cleared once it ends
  (`finish_document_parse`, best effort, on every request with that file): a file whose count is already 2 is unreadable
  with no third parse, however often it is sent or attached. Before those functions, it parses with nothing counted.
  `readDocument` (From a document, email, the extension, chats) runs the same pre-scan, lenient: it refuses only a file
  measured past 16 MB, and still parses on the thread that asks.
- **The compare** (`compareDocument`, pure). Each value the model returns passes `normalizeExtraction` against the
  text. Code then checks, in order: the vendor (the counterparty's `nameKey` as whole words in the text's, or its billing
  domain or a subdomain, never a free email provider's, never the model's `vendorName`); the currency; the amount to its
  last decimal, in millionths, where the two readers and every "total due" line must agree; the purchase order (typed
  and standing alone in the text, read by both readers alike, or on file and not contradicted; nothing compared for a
  counterparty that needs none); every `0x` address the text writes being the one on file; and the model's `notes`
  being unset. The first failure gives the reason, built only from the counterparty's name, a purchase order, decimal
  figures and `0x` hex. A set `notes` is then quoted after that sentence as the reader's (` The reader noted: "…"`,
  `readerNoteWords` in `rules.ts`), within 0144's 300 characters, once `readerNoteOf` has cleaned it: format,
  default-ignorable (variation selectors, Hangul fillers), private-use and unassigned characters out; double quotation
  marks, characters that look like one and runs of any quote-like or prime-like characters (single quotes, backticks,
  acute accents, modifier primes, low single quotes, ornaments, gereshes) as `'` so it cannot close its quote, before
  NFKC, which then turns fullwidth letters and dots into plain ones; at most two marks on a letter; control characters
  as spaces, one line; HTML character references as spaces; links (a Markdown link or image, an autolink, one with a
  scheme, `javascript:`, `ethereum:` and `data:` among them, from `//` or `www.`, a domain name in any script with or
  without a path, an IPv4 address), email addresses and tokens replaced. A name is a link only when its last label, or
  one before it, is a top-level domain (`top-level-domains.ts`, the root zone's), so `statement.zip` goes and
  `receipt.tiff` or `St.Louis` stays; Han, kana and other scripts written without spaces are never read as a top-level
  domain. At most 200 characters. When the note does not fit after a purchase order sentence naming long values, the
  reason says that check's short sentence instead (`Step.shortFailure`), so the note is always quoted, and
  `DocumentComparison.sentence` keeps the whole one for the ledger's summary and the decision trail. The card and the
  decision trail split the note back out (`splitReaderNote`) and show it apart, in plain text, in boxes that clip
  stacked marks. Each check is signed as `document_checked` (`appendLedgerEntry`), with the file's SHA-256 and
  the values compared, the cleaned note as `readerNote` when the model flagged it, a mismatch's whole `sentence`, never
  the text, the vendor's note, an email address or a link, and with no `observed`.
- **The function** (`check_document_request`, service-role definer). It locks the request and records the check once
  (`already_checked` after), refusing a hash that is not the row's. With vendor requests on, a match for a bill that
  lacks its purchase order writes `invoices.po_reference`, spelled as the document writes it, compare-and-set on the
  payable being `awaiting_info` with no purchase order and no `payment_intents` row, and sets `po_written` in the same
  step; a bill that moved in between is recorded as skipped. It never marks goods received, nor writes any other field.
  In shadow it records and writes nothing (`check_shadow`). The follow-up then sees the purchase order supplied and
  reopens the bill, and the AP stage decides it in the same cycle.
- **The rule** (`invoice.vendor_document`, `src/lib/agent/guardrails.ts`). The AP stage reads the bills with
  `po_written` once (`vendorDocumentsOf`; a failed read stops the stage, and before 0144 it reads none).
  `enforceApGuardrails` wraps every other rule, the funded EURC swap's early return included, and holds a `pay` or
  `schedule` they let through for a person to approve. Every `ap_*` entry on such a bill carries
  `vendorDocument { requestId, source, fileSha256 }`. The hold has no end of its own: Return, the follow-up and a payment
  Circle never took decide it again and hold it again; only a person's Approve and pay pays it, and `overridesHold` is
  false for it, so no reason is asked.
- **Attachments** (`attachDocument`, `src/lib/document-requests/attach.ts`; `AttachDocumentDialog`). An owner or admin
  (`records.write`) attaches one PDF of at most 4,000,000 bytes, known by its first bytes, while vendor requests are in
  shadow or on, to a payable `awaiting_info` with a purchase order or goods receipt missing and no payment sent. It is
  stored at `<org>/document-requests/<id>/<sha256>` by `platformStorage().upload`, which never overwrites, before
  `attach_document` inserts the answered member row (`source = 'member'`, `attached_by`, no token, no email domain);
  a file the function refuses (`busy`, `same_file`, `not_waiting`) is removed. At most one attachment per bill waits
  to be checked. It signs `document_received { by, via: "attached" }` best effort, and the action raises the cycle
  event `document_received`. The cards say who sent each document and what its check found (`documentCheckLine`);
  the decision trail and Why it was paid read the two entries.
- **Before 0144.** Every read and call treats `42P01`, `42703`, `42883`, `PGRST202`, `PGRST204` and `PGRST205` as
  not there yet: the stage checks nothing, `vendorDocumentsOf` reads none, the cards read part 1's columns again,
  `readDocumentChecksStatus` says `checks: false` (no Attach a document, part 1's Settings copy, no cycle event), and
  `attachDocument` says checking documents is not available yet.

## Which bill first when the cash cannot cover them all

docs/superpowers/specs/2026-10-18-cash-priority-design.md; pure rules in `src/lib/agent/cash-priority.ts`, the plan in
`src/lib/agent/cash-priority-plan.ts`. `runApStage` calls `cashPriorityOf` right after its load: a cheap look (the loaded
pending and scheduled USDC plus the held USDC against operating plus reserve, less what is committed) decides whether to
plan at all, and shadow mode is read once for the stage (`shadowOnce`). `cashPriority` reads the open payables and the
latest word on each held or scheduled one (every AP decision action and `payment_rescheduled`), sets aside what is
committed (matched payables, verified milestones not in escrow, scheduled bills a person moved), and takes the competing
bills (`competingBills`: USDC, not
bank-paid, pending, scheduled or held with `heldBecause: cash_shortfall` on its latest decision, due within 14 days or
overdue). When they exceed what is left (`needsPlan`), it reuses the last `cash_priority_set` whose `fingerprint` (bill
ids, amounts, due days, and a late fee's term where there is one; not statuses, not cash, not what a fee costs today) matches and whose order still splits the same way (`sameSplit`), or asks
the model (`decide`, purpose `cash_priority`,
refs B1..Bn in the written policy's order, which is the fallback; a ref or a dollar amount left in a reason or the
reasoning becomes the bill's payee and amount in USDC before signing, `namedRefs`, since people read them and never see a
ref; the supplier history counts `requestsTheAgentSent`), bounds the order (`boundOrder`), fits it to the cash
(`planFrom`: keep while the kept total fits, skip what does not), and signs the plan. Kept bills that are held are
reopened with a compare-and-set on `held` and an `invoice_reopened` (`followUp.reason: "cash_priority"`), then loaded,
unless their latest decision records this plan's fingerprint (`cashPriority.fingerprint`) and that they were kept then
(`waits` not `true`): held again under the same plan, they are not retried, while one that waited under the same bills
and is kept now, as a person's order may make it, is reopened. Waiting bills join the stage's payables even before their day and are left out of the kept
bills' `obligationsDueBy` and cash ahead measure, and only theirs; `heldForPriority` turns a model `pay` or `schedule` on
one into a hold (`timingRule: "cash.priority"`) whose `shortOfCash` holds for want of cash, with `cashNeededUsdc` its own
amount plus the kept total, which the follow-up measures without re-measuring what falls due before it, so the
more-time and customer discount stages act on it and only enough cash for everything reopens it. A read that fails leaves the stage in date order. The activity feed tells
`cash_priority_set` (`cashPriorityItem`, tone `notice`) and a waiting bill's hold.

**A person's order** (docs/superpowers/specs/2026-10-18-cash-priority-order-design.md). `readPriorityFacts` reads the
competing bills, the cash and the fingerprint the same way for the cycle and for a person; `readPriorityView`
(`src/lib/agent/cash-priority-view.ts`) shows the latest order on the Payment plan tab (`CashPriorityOrder`) only while
its fingerprint is the current one, with the cash from the accounts. The command `cash_priority.set_order`
(`approval.decide`, console only) refuses while a cycle runs or in shadow mode; `setPersonOrder` reads the facts again,
refuses a changed fingerprint or a newer signed order than the one shown (`basedOn`, the shown order's `ts`; `changed`),
a cash that covers every bill (`no_choice`), an order that does not name each bill once (`personOrder`, `order`), and
an order that puts a bill the actor entered (`created_by`) ahead of any bill it was behind in the order shown (the
latest plan's order, compared by place, not by the kept part, which is empty while the cash covers no bill) unless they
are the only approver (`self_created`). It signs `cash_priority_set` as the person (`actor: "human"`, `decisionMode: "person"`, `by`,
`previousOrder`), each bill keeping the reason last given under the same bills; then
`runCycleSoon({ kind: "priority_order_set" })`. `planOf` reads `byPerson` and each bill's amount and due day back. While
every competing bill is one a person's order had, unchanged (`carriedOrder`), `cashPriority` applies it with `planFrom` to
the cash there is, with no model call; when bills left it, it signs it again for the rest (`carried: true`, actor
`agent`, not told in the activity feed). When a bill is new or changed, the model is given the person's earlier order
for the bills it had (`aPersonsEarlierOrder`). The activity reader reads a member's `cash_priority_set` besides the
agent's entries. A waiting bill's
hold then says a person chose to pay others first, with no reason of the agent's (`cashPriority.byPerson`), and the
activity feed says a member set the order.

## Telling the owner before the cash runs short

docs/superpowers/specs/2026-10-17-cash-short-alert-design.md, `src/lib/agent/cash-alert.ts`, stage `cash_alert` after
`document_requests` (needs `reconcile`). The stage reads the balances, the open invoices (payables still to pay and
receivables still owed, so a long paid history never crowds the read past PostgREST's row cap), what customers still owe
on each (`stillOwed` over `readAllocationRows`, as the console counts it) and the open milestones, maps them with
`outlookInputOf` (`src/lib/cash-outlook-input.ts`, shared with `todayFacts`) and runs `cashOutlook`, so its figures are
the console's. `cashShortOf` reads `shortOn`/`shortBy` (first negative day),
`lowestOn`/`need` (most negative day within 30) and the receivables expected by then. `alertDue` compares with the last
`cash_short_ahead` or `cash_short_cleared` entry: alert when none or cleared, the short day earlier, the need up by
max(1 USDC, 10%), or 7 days since; clear when no longer short after an alert; otherwise nothing. Short by under a cent
neither alerts nor clears, so a balance a hair either side of zero cannot flip it. The alert's detail adds
the balances and `doing` (bills held for want of cash from the latest AP decisions, open `payment_term_requests`, open
or unpaid accepted `customer_discount_offers`), each best effort (`null` when unreadable). Both actions are in
`CASH_ALERT_ACTIONS` in the activity feed (`cashAlertItem`, link to the payment plan, no `invoiceId`, tone `notice`: a
warning that is not counted among what waits for a person, ⚠️ in Telegram), so the console, Telegram and Slack tell
them. Skipped in shadow mode (`readShadowMode`). Code only, no model.

## The agent's weekly brief

docs/superpowers/specs/2026-10-18-weekly-brief-design.md, `src/lib/notifications/weekly-brief.ts`, email in
`src/lib/email/weekly-brief.ts`. `runScheduledCycle` (`src/lib/agent/cron.ts`) calls `sendWeeklyBrief()` after the digest
and the escalations, on the same never-throw terms. It goes only on a Monday (UTC), once per ISO week (`isoWeek`; the
week's `weekly_brief_sent` entry without `preview` stops a second), and not when `briefWorthSending` finds nothing to
say. In shadow mode (`readShadowMode`) `weeklyBriefFacts` also reads the `decision_verdict` entries since
`shadow.startedAt` (the week's, and all of them), sets `cash.short` to null since the wallet only mirrors agreed
payments, and the email speaks of verdicts: its subject leads with the agreement since shadow mode began. `weeklyBriefFacts` reads, for the last 7 days, confirmed USDC `payment_intents`, `ar_received`
entries and the agent's `ap_*`/`milestone_*` entries; the payables waiting for a person; and, through
`readOpenCashOutlook` (shared with the cash alert, `src/lib/agent/cash-alert.ts`), the next 7 days' outflows and
expected receipts and `cashShortOf`, over the 7 whole UTC days before today (`ar_received` and `ar_payment_applied`
count as money received). Recipients are the digest's (`decidingRecipients`: owners, admins, approvers with
`memberships.notify_email`), read before the figures. The week is claimed before the sends with the throwing
`appendLedgerEntry` (`weekly_brief_sent`): a cycle that starts while they go, or a tick cut short after them, finds it
claimed; a claim that cannot be signed sends nothing. When no send succeeds, `weekly_brief_failed` lets the claim go,
and the once-a-week check reads the week's last non-preview entry of the two, so a later Monday cycle retries.
`sendWeeklyBriefNowAction` (`src/app/actions/notifications.ts`, `approval.decide`) sends it to the session's own
address via `sendWeeklyBrief({ only })`, signed with `preview: true` and `by`, at most once per member in
`PREVIEW_EVERY_MS` (5 minutes); the button is `SendBriefNow` in `NotificationsPanel`. Its emails
are metered as `weekly_brief`. Payee addresses (docs/superpowers/specs/2026-10-22-weekly-brief-payee-lock-design.md):
`payeeWeek` reads the week's `counterparty_address_changed` (setting an address), `counterparty_address_confirmed`,
`address_change_check_sent` and `address_change_answered` entries, the agent's entries whose `detail->>guardrailRule` is
in `ADDRESS_HOLDS`, `readPayeeLock` and the frozen counterparties (none before 0137), or null when they cannot be read;
`payeeSentences` turns them into the email's **Payee addresses** section, frozen payees first, and counts toward
`briefWorthSending`. They are signed in `weekly_brief_sent` as `payees`.

## Setup reminders for workspaces that stop

docs/superpowers/specs/2026-10-19-activation-nudge-design.md. Pure rules in `src/lib/activation-nudge.ts` (`dueNudge`,
`dueNudges`, `nudgeOpen`, `nudgeWent`), sending in `src/lib/notifications/activation-nudge.ts`, emails in
`src/lib/email/activation-nudge.ts` (`actionEmailHtml`, no `loop`). The scheduled cycle visits only `mode = 'live'`
workspaces and every new workspace is a sandbox, so `POST /api/agent/tick` runs its own pass after
`runLiveOrganizations` and before the webhook dispatch: `runActivationNudges` reads `growth_workspaces` once for the
last 30 days (`readWorkspaces`, service role), keeps the `customers` side, and picks `first_bill` (no real bill, opened
24 hours ago or more) or `first_verdict` (shadow mode, `firstDecisionAt` 72 hours ago or more, no verdict). Oldest first,
one after another under `withOrg`; at most `NUDGES_PER_TICK` (20) reminders claimed a tick (a workspace reminded
already, or no longer due, does not count, so it never crowds out a new one); none started after 220 seconds into the
tick (checked before `growth_workspaces` is read too), and no send started later than `SEND_TIMEOUT_MS` before
`sendBy` (the dispatch's 15-second margin), with no claim when not even one could go; it runs with payments switched off, never throws, and never changes the tick's body or status
(a summary is logged when any is due). `sendActivationNudge`, in the workspace's scope, reads that stage's
`activation_nudge_sent`/`activation_nudge_failed` entries (a claim stands while there are more sent than failed; three
failures end it), re-reads the facts (a real bill, through an inner join on counterparties that are not sample; `readShadowSummary` for a
verdict still waiting), offers sample data only to a simulated testnet sandbox without it, and sends to
`decidingRecipients` (at most 5). The claim is signed with the throwing `appendLedgerEntry` before the sends; each send
carries a Resend idempotency key of SHA-256(workspace, stage, user id), and a key already taken counts as sent; when
none went, `activation_nudge_failed` lets the claim go. Emails are metered as `activation_nudge`. `/admin/growth`
shows **Nudged to finish setup** from `readSentNudges` (each customer workspace's ledger, at most 100, 8 at once) and
`growthMetrics.nudged`: came back means a real bill after a `first_bill` reminder, or a `decision_verdict` after a
`first_verdict` one.

## Bank payouts (BlindPay)

A vendor's bills paid to its bank account in Mexico, in pesos over SPEI, from the workspace's USDC
(docs/superpowers/specs/2026-10-16-bank-payouts-design.md). BlindPay is the off-ramp: the operating wallet approves
BlindPay's contract on Arc for the quote's amount, and BlindPay takes the tokens and pays the bank.

- **Settings** (`src/lib/blindpay/settings.ts`). On when `BLINDPAY_API_KEY` and `BLINDPAY_INSTANCE_ID` are set; the
  workspace's network picks BlindPay's (`arc_testnet` with its USDB test token on Arc testnet, `arc` with USDC on Arc
  mainnet), and `BLINDPAY_NETWORK`/`BLINDPAY_TOKEN` override it. Off, the Settings card says so and the routes answer 404.
- **Set-up** (`src/lib/bank-payouts/commands.ts`, `src/app/api/integrations/blindpay/terms`). An owner opens BlindPay's
  terms link; BlindPay sends them back with `tos_id`, and the same signed-in owner's request makes the workspace's
  business customer with BlindPay's test values (a development instance approves any). `workspace_payout_partners`
  (0124) keeps BlindPay's ids and the review status; the ledger records `bank_payouts_set_up`.
- **A vendor's account** (`src/lib/blindpay/clabe.ts`, `counterparty_bank_accounts`, 0124). An owner or admin enters the
  CLABE, whose control digit is checked before BlindPay sees it; it goes to BlindPay as a third party's account and
  only its bank code, last four and beneficiary name are kept, one in use per vendor, never edited (a guard trigger),
  removed rather than deleted. The ledger records `counterparty_bank_account_set` without the CLABE.
- **The agent** (`src/lib/agent/orchestrator.ts`). Bank-paid vendors are read once per stage (`bankAccountsOf`); such a
  vendor needs no address, is never paid across chains, and its decision records `paidToBank: true`. The guardrail
  `payout.bank_needs_person` holds every pay: a person approves every bank payout. Policy replay settles that stage from
  `paidToBank`. On Arc testnet, where BlindPay takes USDB (`bankPayoutTakesTestToken`), the stage reads the operating
  wallet's USDB once (`readTestUsdb`, or `ApStageInput.testTokenBalance`) and times such a bill against it alone, with no
  reserve and no USDC falling due, as a Gateway payout is timed against the Gateway balance; the model sees
  `treasury.usdbBalance`, and a hold for want of USDB is not `heldBecause: cash_shortfall`, which USDC coming in reopens.
- **Approvals** (`src/lib/agent/approvals.ts`, `src/lib/bank-payouts/words.ts`). The listing reads an indicative quote
  per bank payout, with no idempotency key, and the card shows the account and what the vendor receives. Approve and
  pay passes `bank: { bankAccountId, network, token }` to `payInvoice`; the intent's destination is
  `blindpay:<account id>`.
- **The payment** (`src/lib/payments.ts`, `src/lib/circle/bank-payout.ts`). The intent keeps `payout_route = 'bank'`
  from its first attempt: a bill first paid to a bank is never sent to an address, nor the other way round, and bank
  payouts never go in a batch. `payToBank` asks a fresh quote (keyless: a quote moves nothing, so a try after one
  expired gets a new one), refuses one whose sender amount is not the bill's or that expired, runs the approve as a
  Circle contract execution and waits for it to confirm, then asks for the payout, again on
  `PAYOUTS_ALLOWANCE_NOT_CONFIRMED`; each step's key is a UUID derived from the attempt's key and the step
  (`bankStepKey`), as Circle takes only UUIDs. A payout request with no answer, or one
  whose key BlindPay already holds, keeps the payment in flight (`MAY_HAVE_BEEN_ACCEPTED`), and it is asked for again
  under the same key, never looked for on Circle. The provider id is `blindpay:<payout id>`; reconciliation reads the
  payout from BlindPay, and `completed` confirms it. `refunded` reads as Circle's `FAILED`, so a person's Approve and
  pay opens the next attempt through `begin_payment_retry`, as for any transfer. `failed` is failed but not terminal:
  BlindPay holds the USDC until it refunds it, so nothing new is sent and the payout is read until it is refunded.
- **Test USDB** (`src/lib/bank-payouts/test-token.ts`). On Arc testnet BlindPay takes USDB, its test token, not USDC.
  BlindPay's dashboard mints it only to a browser wallet, so the card's **Mint 100 test USDB** has the operating wallet
  call `mintUSDB(uint256)` on it (anyone may mint to themselves) through the provider's `mintTestToken`, Arc testnet
  only; the ledger records `bank_payouts_test_token_minted`. Before the approve, `payToBank` reads the wallet's balance
  of the quote's token on the provider's chain and refuses a payout it does not cover; Approve and pay counts USDC only
  when that is the token BlindPay takes.
- **Notices** (`src/lib/bank-payouts/webhook.ts`). BlindPay's webhooks come through Svix: the signature
  (`svix-id.svix-timestamp.body`, HMAC-SHA256 under the `whsec_` key) and a five-minute window are checked before the
  body is read; a `payout.*` notice finds the workspace whose payment waits on that payout and starts a
  `payment_settled` cycle, which reads the payout itself.

## Accounting connectors: Xero, QuickBooks Online and Zoho Books

A workspace can bring its bills in from Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md), from
QuickBooks Online (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md) and from Zoho Books
(docs/superpowers/specs/2026-10-16-zoho-books-connector-design.md), any or all of them. The core,
`src/lib/connectors/`, names no provider: it talks to one through `AccountingProvider` (`provider.ts`: the authorize URL,
the code exchange, the organisations a token reaches, refresh, revoke, and paged reads of bills, contacts and accounts
mapped into `ExternalBill`, `ExternalContact` and `ExternalAccount`), and words each provider's own way through
`PROVIDER_WORDS` (Xero's organisations and suppliers, QuickBooks' companies and vendors, Zoho Books' organizations and
vendors). Each provider has its folder (`src/lib/xero/`, `src/lib/quickbooks/`, `src/lib/zohobooks/`: settings, HTTP,
OAuth calls, the pure mapping from its JSON in `map.ts`, and the provider object), wired in
`src/lib/accounting-providers.ts`, the one place the core meets them. Xero is on only with `XERO_CLIENT_ID` and
`XERO_CLIENT_SECRET` (a Xero "Web app"), QuickBooks only with `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET` (an
Intuit app; `QUICKBOOKS_ENVIRONMENT` picks sandbox or production companies), Zoho Books only with `ZOHO_BOOKS_CLIENT_ID`
(in Zoho's form, `1000.` and capital letters and digits) and `ZOHO_BOOKS_CLIENT_SECRET` (a Zoho server-based client);
otherwise its card and routes are not there. The Settings card (`AccountingPanel`), the review list (`AccountingBillsReview`), the
account picker, the launch and connect pages and the server actions (`src/app/actions/accounting.ts`) are one set, given
the provider. The core's providers are `xero`, `quickbooks` and `zohobooks` (kind `accounting`), `hubspot`, `pipedrive`
and `zohocrm` (`crm`, below), `asana` (`work`) and `googlesheets` (`export`: it brings nothing in, and writes close
packs out; see "Google Sheets: the close pack exported").

- **Schema (migration `0101`).** Four tenant tables, with row-level security, the restrictive guard and composite
  foreign keys to their connection, which the tenant role reads, inserts and updates and never deletes:
  `accounting_connections` (one per workspace, provider and external organisation; at most one not revoked per
  workspace and provider; status `connected`, `needs_reconnect` or `revoked`; the consent's version and time; the last
  sync and the last error in business words; the failures in a row and `next_sync_after`; a sync lease; the payment
  account), `external_links` (an external contact or bill, once, and the counterparty or invoice it became, with the
  provider's version), `accounting_bills` (the review list: each bill once, its facts as the provider has them now,
  `source_status` and `review_state`) and `accounting_sync_cursors` (per connection and object type, the phase, the
  `since` time and the checkpoint of a run under way). And one platform table, `accounting_tokens`, as `slack_installs`:
  RLS on, no policy, nothing for the tenant or browser roles. Only `src/lib/connectors/token-store.ts` reads it, in the
  workspace's own scope; each token is an envelope under the master key bound to the workspace, its column and its row
  (`accounting_tokens.refresh_token_enc/<id>`).
- **Tokens.** Xero rotates its refresh token on every use, so a lost update locks a connection out. `freshAccessToken`
  (`tokens.ts`) refreshes only under the row's lease (`accounting_token_lease`: one holder, 60 seconds, under the row's
  lock) and stores the new pair only for that holder over the version it read (`accounting_token_store`, a
  compare-and-set); a caller that finds the lease taken waits and reads what was stored. `invalid_grant` marks the
  connection needs reconnect.
- **Connecting.** `/integrations/xero` takes a signed-in person to their workspace's Xero card; `/integrations/xero/connect`
  lets them pick the workspace (the card's link names it in `?org=`, and the only one they manage is picked without it),
  read what Vestiarion does with Xero's data and tick **I agree**: real inputs with labels (`NativeChoice`), so the form
  works before any JavaScript. Its form posts, from this origin only, to `POST /api/integrations/xero/connect` (a
  signed-out person signs in and comes back with `?org=` kept), which checks the session, `integrations.manage` and the
  tick, and sends them to Xero with a state signed under its own HKDF key (ten minutes), carrying the consent and a
  nonce kept in an HttpOnly cookie. `GET /api/integrations/xero/callback` checks the state, the cookie, the person, their role again and
  the consent before it exchanges the code and reads `/connections`. One organisation is connected at once
  (`saveConnection`, then the tokens, then the first sync in `after()`); several are kept as a pending grant for ten
  minutes and picked on the connect page (`POST /api/integrations/xero/choose`). A workspace connected to another
  organisation is refused; the same one reconnects its row. `accounting_connected` records the consent.
- **Consent versions** (`consent.ts`). A change to what a statement says is a new version in `CONSENT_VERSIONS`, added
  last to `CONSENT_HISTORY`; a connection keeps the version it agreed to until it connects again. The connect page
  (`ConnectorConsent`) posts the version it showed, and `startConnect` records it only while it is still the current
  one; an older page is sent back to be read again (`?consent=changed`). The only gate on versions is
  `ACCOUNTANT_BOOKING_CONSENTS`. `tests/connector-consent.test.tsx` holds every gate to taking a provider's new version
  where it took the one before, every version literal in `src/` to `consent.ts`, `CONSENT_VERSIONS` to the connect
  route and page, and the migrations to checking a version's length only.
- **The model provider a statement names.** Versions `2026-10-15` say the agent's model provider sees a bill's facts,
  or may see a deal's, under its own API terms, and the connect page links its API terms and privacy policy; the
  versions before promised it would not train on them. The provider is `HOSTED_MODEL_PROVIDER` (DeepSeek), and the
  hosted deployment pins `AGENT_LLM_PROVIDER=deepseek` to match it rather than relying on auto-selection. Changing the
  hosted provider changes what people agreed to, so it takes a new version of every statement that names it.
- **Syncing** (`sync.ts`, `sync-store.ts`): suppliers, then bills, a page at a time in Xero's update order, each page read,
  then written, then the cursor moved, so a run stopped anywhere resumes at its page; no call to Xero happens inside a
  write. The backfill reads approved bills; later runs send `If-Modified-Since` and read every status. A run of several
  pages that read a change made during it, or saw Xero's count of matching bills (`pagination.itemCount`) fall from one
  page to the next (a bill paid while a backfill of approved ones runs), starts over from page 1. A `Retry-After` of at most 5 seconds is waited out
  once; a longer one, an outage or an unreadable answer ends the run and sets `next_sync_after` (Xero's wait, or 1, 2, 4
  minutes and so on up to an hour); a 401 refreshes once; a refused refresh or a 403 marks needs reconnect. `planBill`
  keeps each bill once by its version, takes a new open bill only when due or dated from 90 days before the first
  connection (`window_from`), and signs `accounting_bill_closed` when a bill already added is paid, voided or deleted in
  Xero. `POST /api/platform/accounting-sync` (the agent's bearer token, Supabase Cron every 15 minutes,
  `.github/workflows/accounting-sync.yml` by hand) runs each connection due (`accounting_connections_due`) for at most
  240 seconds, each under its five-minute sync lease and in its own workspace's scope, then revokes and deletes pending
  grants past their deadline. **Sync now** runs one in its action.
- **Adding bills** (`review.ts`, `src/lib/commands/accounting.ts`). The review list Bills & receivables opens from Waiting
  for review (every bill unticked to start, with Select all) reads each bill
  in review as a row of a bill list and gives it its fate with `fatesOf` and `checkBillList`'s own facts, so duplicates,
  currencies (shadow mode for anything but USDC and EURC, never VND), decimals and the form's schema are the import's.
  The supplier is the counterparty its contact is linked to, else the one with its name, else a new one added with the
  bill (a vendor, no address, a limit of its largest bill there). `accounting.add_bills` and `accounting.dismiss_bills`
  (`records.write`, the console only) check the bills again on the server, claim each before adding it, add it through
  `addInvoice` with `via: "xero"` and Xero's ids, and link the bill and the supplier.
- **The payment account** (I14): an owner or admin reads the chart of accounts from Xero, picks a bank account (or one
  Xero lets take payments, kept behind a toggle with a caution, as `accountsToOffer` splits them; never revenue or
  expense), sees a preview (`booking.ts`: a bill still open in US dollars with
  an amount due, one added first, else a plain example, never 0.00), and keeps it on the connection
  (`accounting_payment_account_chosen`). Payments are booked to it only as below.
- **Booking payments made on Arc** (docs/superpowers/specs/2026-10-12-accounting-writeback-design.md). A payment is
  only ever booked into a ledger of the same reality: one on Arc mainnet outside shadow mode into any organisation, one
  on Arc testnet or in shadow mode only into an organisation the provider says is a demo company (Xero's
  `IsDemoCompany`, or `Class: "DEMO"` when it gives no `IsDemoCompany`; a trial is real books). `bookingReality` (`posting.ts`, pure) decides it
  when a booking is drafted, when it is shown and right before it is sent, with the organisation read again; migration
  `0106`'s check refuses any row reaching `sending`, `sent` or `confirmed` otherwise, on a network and shadow flag its
  trigger reads from the payment itself as the booking is drafted (the payable's payment intent, the workspace's
  `shadow_modes` row, the bill's original currency), never only from what the insert says.
  - **Schema (migration `0106`).** `accounting_postings`, a tenant table (RLS, the restrictive guard, composite
    foreign keys to its connection and its invoice; read, insert and update, never delete): one booking per payable and
    provider (`unique (org_id, invoice_id, provider)`) and one per provider payment. What it writes (the bill, the
    amount and currency in the bill's currency, the day, the Arc transaction hash as reference) and the payment it
    mirrors (network, shadow, what left, the network fee) are fixed when drafted; `accounting_postings_guard` inserts
    only drafts or refusals, keeps the facts, and moves the state along `draft`/`failed` → `sending` → `sent` →
    `confirmed`, with `refused` and `confirmed` final. History is the ledger's.
  - **Drafting** (`booking-run.ts`, `booking-store.ts`, `booking-sync.ts`) rides on every sync (`syncInScope`: the
    sweeper, **Sync now**, the first sync): payables linked to a bill (`external_links`), `paid`, with a payment
    intent `confirmed` live, and no booking yet. `postingFacts` books USDC as USD and EURC as EUR at what left, a
    shadow bill at its own amount (less a discount's share); another currency than the bill's is refused. One
    `Organisation` read decides the rule for the run; when it fails, those payments wait. Drafts whose bill the last
    sync saw paid, voided or deleted are refused. The same step reads back bookings `sent`, and a `sending` one past
    its two-minute lease, by reference. It never sends: only a person's approval does.
  - **Review** (I10): `accounting.book_payments` (permission `accounting.book`, owner and admin, console only) from
    **To book in Xero** on Bills & receivables (`AccountingBookings`, read by `bookings-view.ts`), at most 10 at once.
    Each line carries `postingFingerprint` of exactly what was shown (the bill as last synced, the amount, currency,
    account, day and reference); the server works it out again, and a different one is refused as stale with nothing
    sent. The connection must hold the provider's write scopes (Xero: `accounting.payments`, asked for by new
    connections; an older one shows **Allow Vestiarion to book payments**, which reconnects the same row), an account
    must be chosen, and the ledger must sign.
  - **Sending** (`approvePosting`): claim the row (a compare-and-set over its state and attempts), look first for a
    payment with this reference on this bill (`findPayment`, deleted ones included: one there is adopted, a deleted
    one refuses; when Xero refuses the reference filter, the bill's own list shows only payments still standing, so
    for a booking an earlier send may have reached, `deletedMatters`, finding none there stops the send), check the bill now (`billCheck`: closed, already paid in Xero, another currency, or an amount due
    other than the one shown, which is stale), book it with an `Idempotency-Key` derived from the booking and its
    fingerprint, and on a timeout or a 5xx read back by reference before anything else. Then read the payment back once
    (`GET /Payments/{id}`): the same bill, amount, reference and account confirm it. Each transition appends
    `accounting_payment_drafted`, `_approved`, `_sent`, `_confirmed`, `_failed` or `_refused` (domain `ap`,
    `invoiceId`), which webhooks carry. The network fee is shown apart and never booked.
  - **The seam.** `AccountingProvider.booking?: BookingProvider` (`provider.ts`): `writeScopes`, `organisation`,
    `bill`, `findPayment`, `bookPayment`, `payment`, each mapped to the core's shapes; Xero's in
    `src/lib/xero/payments.ts` (pure) and `payments-api.ts`. A provider without it (QuickBooks and Zoho Books, for now)
    never books; one that adds it also sets `BOOKS_PAYMENTS` (`booking.ts`) for the account picker's preview.
  - **Where it shows**: **Booked in Xero** on the paid bill's card, a last row in **Where the payment is**, and a step,
    The books, in **Why it was paid**, all from the signed entries (`bookingFromEntries`, `booked.ts`). The card's own
    entry (`matchingEntry`) skips `accounting_` entries.
- **Before migration 0106** the bookings list is hidden and the sync's booking step has nothing to do; **before migration 0101** a missing table or function (`PGRST205`, `PGRST202`, `42P01`, `42883`) reads as
  `NotSetUpError`: the card says Xero is not set up yet, the review list is not shown, and the sweeper has nothing to do.
- **QuickBooks Online** differs where Intuit does, through optional parts of the core that leave Xero as it was:
  - *One company per grant.* The callback names it (`realmId`, the provider's `callbackOrganisationParam`), read only
    after every check and confirmed by reading `companyinfo/<realmId>` with the new token, so an edited realm id
    connects nothing. No picker.
  - *One workspace per company* (`exclusive`): revoking the app's token, or disconnecting it in QuickBooks, ends every
    grant for the company. Migration `0102` adds a partial unique index on `(provider, external_org_id)` for QuickBooks
    connections not revoked, and `accounting_connections_by_external`, a service-role function that finds connections
    by company across workspaces (the DAL keeps tenant tables from the platform client). A company another workspace
    holds is refused (`?quickbooks=other_workspace`), its new tokens neither kept nor revoked.
  - *Reads.* Paged queries (`SELECT … ORDERBY MetaData.LastUpdatedTime STARTPOSITION n MAXRESULTS 100`,
    `minorversion=75`) with a `count(*)` of the same filter on each page, as Xero's `itemCount`. The backfill asks for
    `Balance > '0' AND DueDate >= window_from` (`PageRequest.windowFrom`); later runs read every bill changed since
    `since`. A deleted bill never comes back from a query: the last page of each later run asks change data capture
    (`/cdc`, from five minutes before `since`, at most 30 days back) for deleted bills, which carry only an id and a time
    (`factsKnown: false`), so their row keeps its facts, only its status changes, and their time does not move the
    cursor. Versions are the update time and the `SyncToken`, so two changes
    in one second still order.
  - *Partly paid.* A bill's `Balance` is its amount due: one partly paid is offered at what is left, and an added bill
    whose amount due fell below its invoice's figure is listed on the review list (`partlyPaidSince`), for Xero too.
  - *Webhook* (`POST /api/integrations/quickbooks/webhook`, `src/lib/quickbooks/webhook.ts`): the raw body's
    `intuit-signature` (base64 HMAC-SHA256 under `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN`) is checked first; of the
    CloudEvents array only each event's realm and entity are read; the realms whose bills, bill payments or vendors
    changed are matched to their connections, and each connected one not backing off runs one sync in `after()`, with
    **Sync now**'s budget. Unknown realms and replays change nothing a sync would not.
  - *Disconnect URL* (`/integrations/quickbooks/disconnected`, `src/lib/connectors/disconnected.ts`): for the
    workspaces where the signed-in person manages integrations, it asks QuickBooks whether each connection still works
    (a fresh token through the serialized refresh, then one read) and marks it revoked only when QuickBooks refuses it,
    signing `accounting_disconnected` with `atProvider: true`.
- **Zoho Books** (`src/lib/zohobooks/`) differs where Zoho does, through one more optional part of the core:
  - *Data centers.* A Zoho account lives in one data center, each with its own accounts server and API domain: the US,
    the EU, India, Australia, Japan, the UK, Canada, Saudi Arabia and the UAE, in a fixed table in
    `src/lib/zohobooks/regions.ts`; China's, whose accounts are separate, is not in it. The authorize URL is the US
    accounts server's, which sends a person of another data center on to theirs. The core gained `callbackRegionParam`:
    Zoho Books names `location`, which `finishConnect` reads only after every other check (state, nonce cookie, person,
    role, consent) and hands to `exchangeCode` as `region`. A `location` not in the table is refused before anything is
    sent, and none is the US, where a client without multi-DC lives. The callback's `accounts-server` is never read, so
    an edited callback sends the client secret nowhere. A person outside the US connects only once their data center is
    turned on under the client's Settings tab in Zoho's API console, with the same credentials for all.
  - *Tokens.* Each token the provider hands the core is `<region>|<Zoho's token>` (`withRegion`, `regionalToken`),
    encrypted and kept as any other, so a refresh, a revocation and every API call go to the data center the token came
    from, a token is never sent to another, and no column was added. Zoho answers a refresh with an access token only: the
    refresh token it was given is kept. A refresh token lasts until revoked (`idleDays` 0, so the reconnect words name no
    idle days); `invalid_code`, `invalid_grant` or `invalid_client` at refresh marks needs reconnect. Zoho may answer a
    refusal with HTTP 200 and an `error` field, which is read as a refusal.
  - *Shared with Zoho CRM.* One Zoho "Server-based Applications" client serves Zoho Books and Zoho CRM (below), each
    with its own redirect URI registered on it. The OAuth calls in `oauth.ts` take the app (`ZohoApp`: the client, its
    scopes, Zoho Books' when it names none, and the name its logs carry), and the data center table, the regional tokens
    and the refusal rules above are the same for both. Each connection has its own grant: disconnecting one revokes only
    its own refresh token.
  - *Organizations.* `organisations` reads `GET /books/v3/organizations` with the new token: one connects at once, and
    several are kept as a pending grant and picked on the connect page, as Xero's tenants are. Not `exclusive`: several
    workspaces may connect one organization, each with its own grant, and no one-workspace index exists for it.
  - *Reads* (`api.ts`, pure mapping in `map.ts`). `<api domain>/books/v3/<resource>?organization_id=<id>` with
    `Authorization: Zoho-oauthtoken <token>`, 200 to a page, oldest first by `created_time`, `page_context.has_more_page`
    for the next. The backfill reads every bill (`filter_by=Status.All`) and the core keeps the open ones in its window;
    later runs read the bills changed since `since` (`last_modified_time`), whatever their status, so a bill paid or
    voided later is seen. `open`, `overdue`, `partially_paid` and `approved` are open, `paid` paid, `void` voided,
    `draft` and `pending_approval` drafts, never brought in. A bill's version is its `last_modified_time` in UTC, its
    amounts exact decimal strings, and its `balance` the amount due, so `partlyPaidSince` covers it. Vendors are its
    contacts (`contact_type=vendor`, every status), read in full on each run since Zoho filters contacts by no change
    time; an inactive one is read as archived.
  - *No deletions seen.* Zoho Books lists no deleted bill and has no change feed, so a bill deleted there after it was
    added stays as it is here, and one deleted while in review stays on the review list; no `accounting_bill_closed`
    ever has `sourceStatus` `deleted` for it. A bill voided there is seen and flagged. The guide says so.
  - *No booking, no webhook.* `accounts` answers none and there is no `booking` (`BOOKS_PAYMENTS.zohobooks` is false).
    Zoho's webhooks are workflow rules a person sets up in its own screens, with no API to register one, so the sweeper
    reads each connection every 15 minutes, as Xero's, and **Sync now** at once.
  - *Errors* (`http.ts`). A 429 is `rate_limited`, with Retry-After when Zoho sends one and a minute otherwise (100
    requests a minute per organization, and a daily allowance by plan); a 401 refreshes once; a 403 marks needs reconnect,
    as for every provider; 5xx and timeouts are `unavailable`.
  - *Migration `0122`.* The provider checks of `accounting_connections`, `accounting_tokens` and `external_links` take
    `zohobooks`, each replaced only while it does not yet, so a re-run never narrows a later widening (0116's rule), and
    `zohobooks_connector_ready(p_org_id)` answers true. The connect flow asks it (`zohoBooksReady`, a tenant RPC, which
    the data layer always sends `p_org_id`) before anyone is sent to Zoho, so before 0122 runs, connecting says Zoho
    Books is not set up on this deployment yet.

## Connectors: CRM (HubSpot, Pipedrive and Zoho CRM)

A workspace can bring its customers and won deals in from HubSpot
(docs/superpowers/specs/2026-10-12-hubspot-connector-design.md), from Pipedrive
(docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md, below) and from Zoho CRM
(docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md, below), any or all of them. It runs on the accounting
connectors' core, which
gains a provider kind (`PROVIDER_KINDS`: `accounting` or `crm`) and no HubSpot names: `ConnectingProvider` is what the
connect flow, the token refresh and disconnecting use of any provider, and `CrmProvider` (`src/lib/connectors/crm.ts`)
adds a page of deals with their companies (`ExternalDeal`, `ExternalCompany`) and deals read by id. HubSpot is the first
CRM (`src/lib/hubspot/`: settings, HTTP on the 2026-03 API version named once, OAuth, the pure mapping in `map.ts`, the
reads in `api.ts`, `hubspotProvider`), wired in `src/lib/crm-providers.ts`. It is on only with `HUBSPOT_CLIENT_ID` and
`HUBSPOT_CLIENT_SECRET`, from the app whose config is `integrations/hubspot/` (uploaded with `hs project upload`).

- **Schema (migration `0105`).** The checks of 0101 take `hubspot`, linked `company` objects and `deal` cursors, each
  replaced only while it does not take the value yet. `accounting_connections_hubspot_one_workspace` connects a HubSpot
  account to one workspace at a time, and `accounting_connections_by_external` (the service role's, word for word as
  QuickBooks') lets the connect flow ask first. `crm_deals`, a tenant table as 0101's: each deal read, once per
  connection, with its facts, `stage_state` (`open`, `won`, `lost`), its company and that company's main contact's
  email, `source_status` (`present`, `deleted`), the Vestiarion deal it became (`deal_id`), the `baseline` it was
  planned from or last reviewed at, and the changes last recorded (`flagged`).
- **Connecting.** The core's flow (state, nonce cookie, person, role, consent `hubspot-2026-10-15`; `hubspot-2026-10-13`
  said the model provider would not train on deals' facts, `hubspot-2026-10-12` that it writes nothing, and a connection
  keeps the version it agreed to), on
  `/integrations/hubspot`, `/integrations/hubspot/connect`, `POST /api/integrations/hubspot/connect` and
  `GET /api/integrations/hubspot/callback`. The token answer's `hub_id` is the account, its introspected `hub_domain` its
  name; one account per grant. `ConnectDeps.ready` probes `crm_deals`, so before 0105 no one is sent to HubSpot. An
  account another workspace holds is refused (`other_workspace`), and the tokens just granted are neither kept nor
  revoked. The config's required scopes read; its optional `crm.objects.deals.write` and `crm.schemas.deals.write` are
  asked for (`optional_scope`) only when the person ticks **Write receipts to HubSpot** on the connect page (receipts,
  below).
- **Syncing** (`crm-sync.ts`, `crm-store.ts`): deals by search, 100 a page in the order of `hs_lastmodifieddate`, `after`
  as the page's offset, so the core's cursor (object type `deal`) and its checkpoints, restarts and backoff work as for
  Xero. A backfill reads open deals and those won since `window_from`; later runs read every deal changed since five
  minutes before `since`. The page reaching HubSpot's 10,000-result cap ends the run without a restart (`capped`), and
  the next run starts at the latest change read itself, not five minutes before it, so a bulk edit of more than 10,000
  deals is read past rather than again and again (`pageOutcome`). Each
  page reads its companies and their main contacts (associations, batch reads); pipelines and the account's currency
  and time zone once per run. Search never returns a deleted deal, so linked deals and won ones still offered are read
  again by id each run; one HubSpot no longer has is `deleted`. `planCrmDeal` keeps each deal once by its version. The
  sweeper runs a CRM connection with this runner (`sweepAccounting({ crm })`).
- **Planning** (`crm-prefill.ts`, `crm-review.ts`, `src/lib/commands/crm.ts`). Bills & receivables lists the won deals
  under Deals, on its Receivables tab (a deal planned already shows the deal it became, `crmPlanState`); **Plan
  collections** opens the New deal form filled in by `dealPrefill`: the customer by its company's link, else its name
  (never a customer linked to another of the account's companies), else a new one; dollars as USDC and euros as EURC at
  par, another currency only in shadow mode,
  never VND; the close day as the start; HubSpot's deal id as the reference. `crm.plan_deal` (`records.write`) reads the
  row again, forces the reference, confirms through `confirmDeal` (`create_deal`, whose unique `external_ref` refuses a
  second plan), links the row (`deal_id`, `baseline`) and the company to the customer (`external_links`), and the
  deal's `deal_signed` says `via: "hubspot"`.
- **Changes** (`crmChanges`, pure): amount or currency, close day, stage leaving won, deleted, against the baseline;
  none for a cancelled deal. The sync records a new set once (`crm_deal_changed`, `flagDecision`). The deal's page says
  **Changed in HubSpot**; **Change deal** opens the Change deal form filled in (`changePrefill`), and saving it is the
  revise path with `via: "hubspot"`, marking the changes reviewed; **Keep the deal as it is** (`crm.keep_change`)
  records `crm_deal_change_kept`. Both send back the key of the changes the page showed (`changesKey`) and are refused
  when HubSpot changed the deal again since. Nothing is revised or cancelled automatically.
- **Billing emails.** `crm.fill_email` sets a linked customer's empty billing email from its company's main contact,
  only when a person presses **Use this email**: the email the list showed, written only where the billing email is
  still empty (`changeCounterpartyNoticeEmail({ onlyIfEmpty })`).
- **Receipts back in HubSpot** (docs/superpowers/specs/2026-10-13-crm-receipts-design.md; `crm-receipts*.ts`,
  `src/lib/hubspot/receipts.ts`, migration `0107`). Once an owner or admin turns on **Write receipts to HubSpot**
  (`accounting_connections.writes_on`, `crm.receipt_writes`, `integrations.manage`), each deal planned from HubSpot gets
  nine fields Vestiarion owns, in a `vestiarion` property group it makes once: collected, still owed, the currency, a
  collection status, the last receipt's day, amount and explorer link, a reconciliation status and the deal's page as
  evidence. `dealCollection` (pure, `src/lib/deals/collection.ts`, read by `readDealCollections`: the same figure the
  deal's page shows as Paid and Outstanding) counts only money that arrived on Arc (`incoming_transfers`, recorded once
  Circle reports it complete) and was applied to the deal's receivables, whole (0050) or in part (live allocations,
  0103): a part payment is partial, a fee is never collected, an invoice marked received without a payment on Arc is not
  counted and makes the reconciliation "needs review". The outbox `crm_receipt_writes` (a tenant table, one write in hand per
  deal, the fields fixed once queued) is filled after each CRM sync where a deal's fields changed (`queueReceipts`), and
  sent by the same run (`sendReceipts`): the reality rule against `GET /account-info/2026-03/details` (`accountType`:
  payments on Arc testnet or in shadow mode only to `DEVELOPER_TEST` or `SANDBOX`, refused otherwise, and held by the
  table's checks; an account HubSpot names no type for is not read, so neither written nor refused), a claim with a
  lease (every move compares the write's `attempts`, so a send whose lease ran out never moves a later claim), the
  deal's fields read, a conflict when HubSpot holds otherwise than the last write read back or a write since that it may
  have taken unanswered (never written over; **Write Vestiarion's figures** with `crm.receipt_overwrite` writes over exactly
  what the page showed), the write, and a read-back whose answer is the acknowledgement (`written`). A timeout reads
  back first; a failure waits (`failureDelayMs`), a rate limit ends the run; nothing that moves money reads any of it
  (`tests/crm-receipts.test.ts` pins it). Disconnecting turns writing off (`accounting_connections_writes_off`); a
  connection without both write scopes keeps reading and shows **Allow writing to HubSpot**. The deal's page shows what
  was written and when (`CrmReceiptCard`), the HubSpot card how the writes stand. Entries: `crm_receipt_writes_changed`,
  `crm_receipt_written`, `crm_receipt_conflict`, `crm_receipt_failed` (once per write), `crm_receipt_refused`,
  `crm_receipt_overwrite_chosen`.
- **Pipedrive** is the second CRM, on the same core, wired in `src/lib/crm-providers.ts` beside HubSpot. It is on only
  with `PIPEDRIVE_CLIENT_ID` and `PIPEDRIVE_CLIENT_SECRET`, from a private app in Pipedrive's Developer Hub (Callback URL
  `<origin>/api/integrations/pipedrive/callback`; scopes `base`, `deals:full`, `contacts:read`, `deal-fields:full`,
  `users:read`, `recents:read`, `webhooks:full`, which a person grants all at once or not at all; the Marketplace
  submission, `docs/distribution/pipedrive-marketplace.md`, drops the last two, which nothing reads). An install started
  in Pipedrive comes back to the callback with no state of ours: `finishConnect` exchanges nothing and sends the person
  to the connect page (`?installed=1`), which is also the app's Installation URL. It differs where Pipedrive does,
  through optional parts of the core that leave HubSpot as it was:
  - *The core, generalized.* `ProviderId` gains `pipedrive` (kind `crm`, `exclusive`). A deal's and a customer's
    source in their entries is either CRM's (`DealSource`); the reference a planned deal carries is the CRM's
    (`crmDealReference`: HubSpot's deal id as it is, Pipedrive's as `pipedrive-<id>`, since its small numbers would meet
    references people type); a deal the CRM says was deleted in a page read is marked so at once
    (`ExternalDeal.deleted`); a CRM may name no test account (`CrmReceiptWriter.testAccounts: false`); and
    `PROVIDER_WORDS.customer` says organization where HubSpot says company. `ConnectRefusal`
    (`connect-refusal.ts`) lets `organisations` refuse a grant with an outcome the card says in words.
  - *The folder*, `src/lib/pipedrive/`: `settings.ts` (the app, its scopes, the callback and webhook URLs),
    `credential.ts`, `http.ts`, `oauth.ts`, `map.ts` (pure, from Pipedrive's JSON), `api.ts`, `receipts.ts`,
    `webhooks.ts`, `store.ts`, `provider.ts` (`pipedriveProvider`) and `connect-deps.ts` (the connect flow's deps: the
    readiness probe, then, after the answer, the webhook made sure of and a first sync of at most 10 pages).
  - *Schema (migration `0116`, after 0105 and 0107).* The provider checks of `accounting_connections`,
    `accounting_tokens` and `external_links`, the writes switch (`accounting_connections_writes_check`) and
    `crm_receipt_writes_provider_check` take `pipedrive`, each replaced only while it does not take it yet and keeping
    `asana` (0115), so a re-run never narrows a later widening. `accounting_connections_pipedrive_one_workspace`
    connects a company, not revoked, to one workspace at a time. `pipedrive_connector_ready(p_org_id)` (0117) is the
    probe `pipedriveReady` (`store.ts`) asks after the core's `crmReady`, before anyone is sent to Pipedrive: the data
    layer sends `p_org_id` to every tenant function, so 0116's version without it was never found, and
    `tests/tenant-rpcs-migration.test.ts` holds every function in `TENANT_RPCS` to taking it.
    `crm_receipt_writes_account_test_check` (0107) is left as it is, so a Pipedrive write of payments on Arc testnet or
    in shadow mode can never reach sending, sent or written.
  - *Connecting.* The core's flow on `/integrations/pipedrive`, `/integrations/pipedrive/connect`,
    `POST /api/integrations/pipedrive/connect` and `GET /api/integrations/pipedrive/callback`, consent
    `pipedrive-2026-10-15` (`pipedrive-2026-10-14` before it). The authorize URL names no scope: Pipedrive's are the
    app's. The token answer's `scope` must read deals and their organizations (`deals:read` or `deals:full`, and
    `contacts:read` or `contacts:full`); a grant without them is revoked and refused before anything is kept
    (`?pipedrive=scopes`). The company is `users/me`'s `company_id`, named by its `company_name`; one per grant. A
    company another workspace holds is refused (`other_workspace`), and so is a workspace connected to another company
    (`other_organisation`); the same company again reconnects its row. Writing is not asked for here: the card's switch
    is the only place it is turned on.
  - *Tokens and the company's domain* (`credential.ts`, pure). The token answer's `api_domain` must be
    an https host under `pipedrive.com` (`https://<name>.pipedrive.com`), and is sealed with its token as one credential (`pd1|<host>|<token>`) in both token
    columns: every call goes to the domain of the token it carries, a refresh's new domain replaces the old one in the
    same compare-and-set, and no token is sent to a host Pipedrive did not name with it. A refresh stores the refresh
    token Pipedrive answers with, else the one sent, under the core's lease; `invalid_grant`, or a 400 or 401 for the
    refresh, marks the connection needs reconnect.
  - *Reads* (`api.ts`, `http.ts`). Deals from API v2 (`GET /api/v2/deals`), 100 a page by `update_time`: a backfill
    reads open and won deals (`planCrmDeal` keeps out those won before `window_from`), later runs every deal changed
    since five minutes before `since`, lost and deleted ones too. Pipedrive pages with opaque cursors and the core with
    page numbers: a reader remembers the cursor of each page it read, and one asked for a page it has no cursor for (a
    run resumed after its page budget) walks the cursors from page 1, at most once a run. Each page reads its
    organizations and persons by id (two calls); stages and pipelines once a run. `map.ts` reads the status as the stage
    state, the stage's name (a lost deal's lost reason) as its label, `local_won_date` (else `won_time`'s day) as a won
    deal's close day, the value as an exact decimal (refused beyond six places), and the organization, with the deal
    person's primary email, as the customer. Linked deals and won ones still offered are read again by id each run,
    from `/api/v2/deals` and, for those not there, `/api/v2/deals/archived`; one in neither, or deleted, is `deleted`. A
    `429` waits `Retry-After`, else `x-ratelimit-reset`, else the two-second burst window: at most five seconds once in
    the run, a longer wait ends it at its checkpoint.
  - *Webhooks only nudge* (`webhooks.ts`). The first sync after connecting and **Sync now** make sure
    (`ensureWebhookInScope`) Pipedrive has one webhook for the company's deals (`event_object=deal`,
    `event_action=*`, version 2.0) to `/api/integrations/pipedrive/webhook`, with Basic auth: the company id, and an
    HMAC of it under a key derived (HKDF) from the master key for this purpose alone, never stored; a deployment
    Pipedrive cannot reach (localhost) registers none. `POST /api/integrations/pipedrive/webhook` checks the Basic auth
    in constant time against every master key before reading anything, answers at once, and after the answer runs one
    sync of the company's connections that are not backing off, with **Sync now**'s budget, which reads the deals that
    changed from Pipedrive itself (`NUDGE_SYNC`: never every kept deal again by id, which the sweeper does, so one notice
    per deal change stays a small read of the company's shared API budget; notices during a run find it busy); the body
    is never read. Pipedrive's uninstall notice, `DELETE` on the callback URL with the app's
    client id and secret as Basic auth (compared in constant time), only names the company, and nudges the same way:
    the refresh then fails and the card asks to reconnect. The sweeper still runs every connection every 15 minutes.
  - *Receipts* (`receipts.ts`). The nine figures as custom deal fields Vestiarion makes once per company
    (`POST /api/v2/dealFields`), "Vestiarion: Collected" to "Vestiarion: Evidence": numbers as `double`, the day as
    `date`, the rest as `varchar`, the statuses in words read back into their codes. Pipedrive keys a field by a hash
    it picks, so they are found by name; one of the same name and another type is someone else's, never changed, and
    nothing is written. Written with `PATCH /api/v2/deals/{id}` and read back with `GET /api/v2/deals/{id}`; the
    outbox, the read-back, field ownership and conflicts are the core's. Pipedrive's plan is not readable, so making the
    fields is the check: a refusal (a plan's custom field limit, a user who may not add fields) is said in Pipedrive's
    words with what to do, on the deal's receipt card and the Settings card.
  - *The reality rule, with no sandbox signal.* Nothing in Pipedrive's API names a developer sandbox, so `account()`
    answers `COMPANY`, never a test account: payments on Arc mainnet outside shadow mode are written once an owner or
    admin turns writing on, and payments on Arc testnet or in shadow mode never are. The switch is not offered to such a
    workspace (`crmReceiptsPanel` with `testAccounts: false`, `noTestAccountRule`), a write queued anyway is refused
    with the reason, and the database refuses its sending. Reading, planning and change detection work everywhere.
  - *Disconnecting* revokes the refresh token at Pipedrive, which uninstalls the app and its webhook, deletes the
    tokens and turns writing off, with `accounting_disconnected`; planned deals, links and rows stay.
  - *Entries.* No new action: `deal_signed` and `deal_revised` carry `via: "pipedrive"` and
    `pipedrive: { companyId, dealId, organizationId }`, `create_counterparty` and `counterparty_notice_email_changed`
    `pipedrive: { companyId, organizationId }`, and the connection, change and receipt entries `provider: "pipedrive"`.
  - *Before 0116 and 0117, or without the app*, the card says Pipedrive is not set up yet or is not there, the routes answer 404
    without the app, and the sweeper never sees a Pipedrive connection.
- **Zoho CRM** is the third CRM (docs/superpowers/specs/2026-10-16-zoho-crm-connector-design.md), on the same core,
  wired in `src/lib/crm-providers.ts` beside HubSpot and Pipedrive, and read only. It is on with the Zoho client Zoho
  Books uses (`ZOHO_BOOKS_CLIENT_ID` and `ZOHO_BOOKS_CLIENT_SECRET`), or with `ZOHO_CRM_CLIENT_ID` and
  `ZOHO_CRM_CLIENT_SECRET` when both are set; its redirect URI, `<origin>/api/integrations/zohocrm/callback`, is
  registered on the client beside Zoho Books'. Without a client there is no card, the pages are not found and the
  routes answer 404. It differs where Zoho CRM does:
  - *The core.* `ProviderId` gains `zohocrm` (kind `crm`, not `exclusive`: several workspaces may connect one
    organization, since nothing is written there for them to contend over). `PROVIDER_WORDS` says organization, and
    account for the customer; `idleDays` 0. The reference a planned deal carries is `zohocrm-<id>`
    (`crmDealReference`). A deal's and a customer's source in their entries is `zohocrm: { organizationId, dealId,
    accountId }` (`DealSource`, `CustomerSource`).
  - *The folder*, `src/lib/zohocrm/`: `settings.ts` (the client, the callback URL and the six read scopes:
    `ZohoCRM.modules.deals.READ`, `.accounts.READ`, `.contacts.READ`, `ZohoCRM.org.READ`,
    `ZohoCRM.settings.layouts.READ`, `ZohoCRM.settings.pipeline.READ`), `http.ts`, `map.ts` (pure, from Zoho CRM's
    JSON), `api.ts` (the reader), `store.ts` (`zohoCrmReady`), `provider.ts` (`zohoCrmProvider`) and `connect-deps.ts`
    (the readiness probe, then a first sync of at most 10 pages after the answer).
  - *Zoho's OAuth.* Zoho Books' calls (`src/lib/zohobooks/oauth.ts`) with Zoho CRM's scopes, and everything Zoho Books
    does with data centers: the callback's `location` read after every other check and only from the fixed table, each
    token kept as `<data center>|<token>`, a refresh at the token's own data center keeping the refresh token.
  - *Connecting.* The core's flow on `/integrations/zohocrm`, `/integrations/zohocrm/connect` (**Continue to Zoho
    CRM**), `POST /api/integrations/zohocrm/connect` and `GET /api/integrations/zohocrm/callback`, consent
    `zohocrm-2026-10-16`. One organization per grant (`GET /crm/v8/org`: its id, `company_name` and `iso_code`), so
    nothing to pick. A workspace connected to another organization is refused (`other_organisation`); the same
    organization again reconnects its row.
  - *The API domain is the data center's.* Every call goes to `ZOHO_REGIONS[<the token's data center>].api`
    (`https://www.zohoapis.<tld>`, API v8, `Authorization: Zoho-oauthtoken`), never to a domain an answer names. A
    Developer Edition or sandbox organization, whose API lives on `developer.` or `sandbox.zohoapis`, does not answer
    there, so connecting one says Zoho CRM did not finish connecting.
  - *Which deals are won.* Each stage's `forecast_type` in the Deals layouts' pipelines (`GET /settings/layouts?module=Deals`,
    then `GET /settings/pipeline?layout_id=` for each), read once per run, by its actual and its display value:
    `Closed Won` won, `Closed Lost` lost, `Open` open. A stage the pipelines do not name, or a token that may not read
    them (a 403, an answer that does not read), falls back to Zoho CRM's own stage names: "Closed Won" won, "Closed
    Lost" and "Closed-Lost to Competition" lost, anything else open.
  - *Reads* (`api.ts`, `map.ts`). `GET /crm/v8/Deals` with its fields named, 200 a page, oldest change first
    (`sort_by=Modified_Time`). A backfill reads every deal, and the core keeps the open ones and those won in its window;
    later runs read the deals changed since five minutes before `since`, by `If-Modified-Since`; 204 and 304 read as no
    records. Zoho CRM pages by number for its first 2,000 records and by `page_token` beyond: the reader remembers each
    page's token, and a run resumed past page 10 walks the tokens from the last page it can reach. A deal's version is
    its `Modified_Time` in UTC, its amount an exact decimal, its currency its own `Currency`, else the organization's
    `iso_code` (read once per run), its close day `Closing_Date`, and its customer `Account_Name`, with the email of its
    `Contact_Name`, read by id in one call a page. Linked deals and won ones still offered are read again by id
    (`?ids=`) each run; one Zoho CRM no longer has is `deleted`.
  - *No webhook.* Zoho CRM's notifications need a channel per module and a renewal; the sweeper reads every connection
    every 15 minutes, and **Sync now** at once.
  - *Errors* (`http.ts`). 401 `unauthorized` (a refresh, then a reconnect), 403 `forbidden`, 429 `rate_limited` a
    minute later (Zoho CRM sends no Retry-After), 5xx and timeouts `unavailable`, an answer that does not read
    `bad_response`.
  - *Read only, held by the database (migration `0123`).* The provider checks of `accounting_connections`,
    `accounting_tokens` and `external_links` take `zohocrm`, each replaced only while it does not yet (0116's rule).
    `accounting_connections_writes_check` and `crm_receipt_writes_provider_check` are left taking HubSpot and Pipedrive
    only, and the provider has no `receipts`, so a Zoho CRM connection can never turn writing on nor have a write
    queued, and the card offers no switch. No one-workspace index. `zohocrm_connector_ready(p_org_id)`, in
    `TENANT_RPCS`, is the probe `zohoCrmReady` asks after the core's `crmReady`: before 0123 runs, the card, the list
    and the connect flow say Zoho CRM is not set up on this deployment yet, and no one is sent to Zoho.
  - *Where it shows.* Settings, **Zoho CRM** (`ZohoCrmPanel`); Bills & receivables, Receivables, **From Zoho CRM: N won
    deals** (`CrmDeals`, `#from-zohocrm`; `?zohocrm=<row>` opens the New deal form filled in), and "N won deals in Zoho
    CRM" under Waiting for review; a deal's page, **Changed in Zoho CRM** (`?from=zohocrm`).
  - *Disconnecting* revokes the refresh token at the token's own data center and deletes the tokens, with
    `accounting_disconnected`; planned deals, links and rows stay.
  - *Entries.* No new action: `deal_signed` and `deal_revised` carry `via: "zohocrm"` and
    `zohocrm: { organizationId, dealId, accountId }`, `create_counterparty` and `counterparty_notice_email_changed`
    `zohocrm: { organizationId, accountId }`, and the connection and change entries `provider: "zohocrm"`. Nothing is
    written to Zoho CRM, so there are no receipt entries.

## Contractor work accepted from Asana

A milestone's work can be delivered in an Asana task and accepted there against its criteria
(docs/superpowers/specs/2026-10-14-asana-acceptance-design.md). Asana is a third provider kind on the connector core,
`work` (`PROVIDER_KINDS`), connected, refreshed and disconnected through `ConnectingProvider` like HubSpot, with no bills
or deals: `src/lib/asana/` holds its settings (`ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET`; off otherwise), HTTP (every
request to `app.asana.com`, at an address built from digit-only ids), OAuth (exactly the app's nine registered scopes,
`%20`-delimited; a refresh keeps the refresh token Asana does not send back), the pure mapping, the reads and the
provider. A grant is one Asana user's: `external_org_id` is their gid, and the connection reads what they can see. Not
exclusive. Consent `asana-2026-10-14`.

- **Schema (migration `0115`).** The core's provider checks take `asana`, and `milestones.verification_method` takes
  `asana`, each replaced only while it does not take the value yet. `milestones.acceptance_criteria` (3 to 2000
  characters, with who and when) is written by a person, never by Asana. `asana_task_links`, a tenant table (RLS, the
  restrictive guard, composite foreign keys to the milestone and the connection; read, insert and update, never
  delete): one live link per milestone and per task, what Asana says of the task as last read (completed, when, by
  whom, the assignee, the deliverables' links and their fingerprint), its state (`waiting`, `ready`, `accepted`,
  `held` with a reason, `after_payment`) and the version accepted. `asana_webhooks`, a platform table as
  `accounting_tokens` (RLS on, no policy): one webhook per linked task, the id in its target address, the handshake's
  secret sealed under the master key bound to the workspace, the column and the row.
- **The two moves on a milestone**, each a database function under the link's and the milestone's row locks, invoker
  rights for the tenant role: `accept_asana_task` verifies a `pending` milestone (`verified`, status `verified`, method
  `asana`) only while the task last read is completed, its fingerprint is the one the person saw and the criteria's
  SHA-256 is the one they saw; `hold_asana_acceptance` takes an acceptance back (`verified` false, status `pending`)
  unless a payment intent for the milestone is not `failed` or it is paid (then only the link is held, `after_payment`,
  a dispute), it is closed, or a person claimed its decision in the last ten minutes (then nothing changes, and the next
  read tries again). Neither writes an amount, a payee, an address or a payment. `tests/asana-paying-path.test.ts` pins
  that the agent, the payments and the money commands reach Asana only through `refreshAcceptedWork` and
  `recheckAcceptedWork`, that the contractor stage still pays only `verified` milestones, and that Asana's code writes
  a milestone only through these functions and its criteria.
- **Reads** (`reads.ts`, `acceptance.ts`, pure `planRead`): the task, its attachments (`/attachments?parent=`) and its
  comments (stories of subtype `comment_added`), the deliverables (`deliverables.ts`: attachments by gid and upload
  time, https links in the description and comments; renaming changes nothing) and their fingerprint. A completed task
  is `ready` with criteria and `held` (`no_criteria`) without; never accepted. An accepted task reopened (or reopened and
  completed again: its `completed_at` differs), with another fingerprint, or no longer shown (404, 403) is withdrawn
  through `hold_asana_acceptance`, `milestone_acceptance_withdrawn`. A link held after an acceptance stays held until a
  person accepts again. Reads happen after a signed webhook delivery, in the cycle right after GitHub's check and before
  the contractor stage (`refreshAcceptedWork` in `milestone-verification.ts`: the accepted links of milestones verified
  by `asana` and still `verified` or `held`, verified first, at most 20, 30 seconds), every 15 minutes from the sweeper
  (`sweepAccounting({ work })`, under the connection's sync lease, the live links of open milestones, verified first, at
  most 100), on **Check Asana now**, and right before an acceptance. Both pick the milestones first
  (`linksOfMilestones`): a paid milestone's link stays live and accepted, as its history, and a limit over every live
  link would in time hold none of the open ones. Each uses the connection's token through `asanaSession`
  (`freshAccessToken` under the token row's lease; a 401 refreshes once; a short rate limit is waited once). A refused
  refresh marks the connection to reconnect. A read that fails leaves an acceptance as it was. Whatever took a
  verification back while the contractor stage decided (a read here, or a person revoking it), the stage holds each
  planned release to the milestone as it is just before sending (`stillVerified`) and sends none no longer verified.
  Right before that check it reads the accepted Asana tasks of exactly those releases once more
  (`recheckAcceptedWork`, `recheckBeforeSending` in `workspace.ts`: reads start for 10 seconds, the stage waits at most
  20, then sends on the acceptances as they stand and the cycle says so), since the cycle's read can be seconds old by
  then: on Arc testnet a task reopened 3 seconds after that read had its release sent 6 seconds later.
- **Webhooks** (`webhook.ts`, `webhook-store.ts`, `POST /api/integrations/asana/webhook/<id>`): a link's webhook row is
  made first, then Asana is asked (`POST /webhooks`, after the answer, only on an https origin, filtered to the task, its
  stories and its attachments, each covered by a read scope the connection has: Asana refused every unfiltered one,
  naming `time_tracking_entries:read`); the `X-Hook-Secret`
  handshake is taken once, for a row still pending, within two minutes, sealed and echoed (a webhook Asana refuses
  to make is logged with Asana's own reason, from `reasonOf` in `http.ts`, any address in it replaced); the secret in
  Asana's 201 (the
  top-level `X-Hook-Secret` of its body, as Asana documents it) must be the one kept, compared in constant time, or the
  webhook is deleted, as it is when the answer carries none. Each delivery's `X-Hook-Signature` (hex HMAC-SHA256 of the raw body) is
  compared in constant time before anything else; the body is never parsed or believed, and a signed delivery only reads
  the linked task again in `after()`. A deleted or unknown row answers 410, which makes Asana delete the webhook;
  unlinking, a paid or closed milestone, and disconnecting delete them.
- **Commands** (`src/lib/commands/asana.ts`, `records.write`, the console only): `milestone.link_task` (a pasted link
  read for its ids by `taskRefOf`, never opened; or the picker's workspace, project and task, read live through
  `asanaChoicesAction`), `milestone.set_criteria`, `milestone.accept` (the checkbox, the fingerprint and the criteria's
  hash the page showed, a fresh read, then the self-acceptance check, then `accept_asana_task`, then
  `milestone_accepted` and a cycle soon), `milestone.unlink_task` and `milestone.check_task`. Self-acceptance
  (`selfAcceptance`, `identities.ts`): the member's email against the payee's notice email, and, where Asana has them,
  the member's Asana user (the connection's own for whoever connected it, else by their email) against the Asana user
  with the payee's email. Pay now on an Asana-linked milestone is refused to its payee (`paysOwnPayout`, by email
  only: Pay now never waits on Asana); Verify manually is refused on one (revoking stays). The check is only as good as
  the identities it has: a payee who is a member under another email, with no notice email or no Asana user under it,
  is not recognised, and an owner or admin can still unlink a task and verify by hand, which has no payee check.
- **Where it shows.** Contractors: `AsanaTaskCard` under each milestone waiting for verification (or a linked one); ready and held links
  count under **Needs you**. Settings: `AsanaPanel`, with the last 30 days' figures (`acceptanceKpis`: acceptances,
  acceptances taken back, the median time from an acceptance to the agent's first `milestone_release` or
  `milestone_hold` after it). The evidence page: `deliveredFromAsana`, Asana's word that the task was completed (verified
  outside, its link checked through Asana's API) beside the person's acceptance.
- **Before migration 0115**, reads answer not set up (42P01, PGRST205, 42703 and the function codes): no card, no
  controls, the cycle and the sweeper read nothing, and the connect flow sends no one to Asana.

## API

The versioned API boundary lives under `src/app/api/v1/`:

```text
status/route.ts                  safe capability and configuration summary
ledger/route.ts                  append-only, ascending audit stream
ledger/verify/route.ts           guarded hash-chain verification
invoices/route.ts                newest-first invoice collection; POST adds one
invoices/[id]/evidence/route.ts  one payable's evidence, vestiarion-evidence/1
invoices/[id]/receipt/route.ts   one payable's receipt, vestiarion-receipt/1
counterparties/route.ts          newest-first counterparty collection; POST adds one
counterparties/[id]/route.ts     counterparty plus screening history
milestones/route.ts              newest-first milestone collection
milestones/[id]/evidence/route.ts  one milestone's evidence, vestiarion-evidence/1
payee-lock/evidence/route.ts     the payee lock's evidence for a period
close-packs/[month]/route.ts     a calendar month's close pack, vestiarion-close-pack/1
treasury/route.ts                balances, obligations, forecast, actions
insights/route.ts                unchanged insights telemetry read model
```

`src/lib/api/contract.ts` owns the success/error envelopes, error codes,
opaque cursors, page-size policy, and `limit + 1` pagination. Every v1 handler
passes through `guardApiRequest` (`src/lib/api/guard.ts`) with its scope,
`read` for a `GET` and `write` for a `POST` (`tests/access-gates.test.ts`
holds each handler to it): it authenticates the bearer token as a workspace API key
(`src/lib/platform/api-keys.ts`, migration `0027_api_keys.sql`) and, on
success, `handleApiRequest` runs the route inside `withOrg(key.orgId)`, so a
key serves exactly one workspace's data. A key works only while the person who
created it is a member of that workspace: whatever ends the membership revokes
it (migration `0069`). A missing, malformed, unknown, or
revoked key answers `401 unauthorized`; a key without the route's scope
answers `403 forbidden`. `AGENT_API_TOKEN` does not authenticate this surface
— it remains only the cron secret for `/api/agent/tick`,
`/api/platform/cleanup`, and `/api/agent/reset` — and neither does the Chrome
extension's token, whose own endpoints are under `/api/extension/v1` (see
"Invoice capture for Chrome"). Resource-specific pure
mapping and validation live in `src/lib/api/counterparties.ts`,
`src/lib/api/invoices.ts`, `src/lib/api/milestones.ts`, and
`src/lib/api/treasury.ts` so null preservation and chain-hash rules can be
tested without a database.

The four writes add records and nothing more. A key with the `write` scope
(migration `0066_api_write.sql`) passes `guardApiWrite`, which also reads the
key's issuer with `memberActor` and refuses one who can no longer add records
(`records.write`) with `403`. It posts a JSON body that `src/lib/api/write.ts`
reads (one object, at most 64 KB) and two schemas check: the strict body
schema in `src/lib/api/schemas.ts`, which refuses a field it does not take, then
the console form's own schema. The record is added through the same
`createCounterparty` (`src/lib/counterparties/create.ts`) and `createInvoice`
(`src/lib/invoices/create.ts`) the console uses, or for a milestone and a payee
link through the commands `addMilestone` and `issuePayeeLink`, whose refusals
`refusalResponse` turns into the API's errors. Each is the key's issuer's, with
`via: "api"` and `apiKeyId` in the ledger entry. A payee link's answer holds
the link, which only this answer ever does, so that route keeps no outcome for
an `Idempotency-Key` and answers with `Cache-Control: no-store`. An address added this way is
stored as an unconfirmed change, so the agent holds payments to it until a
person confirms it. A payable starts a cycle with `runCycleSoon`. Writes are
counted per key (`takeApiWriteToken`, a burst of 30, then one every 2 seconds) after the scope check.
`withIdempotency` (`src/lib/api/idempotency.ts`) claims an
`Idempotency-Key` in `api_idempotency`, a platform table only the service role
reaches, after the body validates: the first outcome is given back for 24 hours
and replayed with `Idempotent-Replayed: true` (the daily cleanup,
`deleteExpiredIdempotencyOutcomes` in `src/lib/platform/cleanup.ts`, deletes it
after that, response body and all), a different body or a request
still in flight answers `409 conflict`, and a `5xx` releases the claim so a
retry runs again. A claim left without an outcome for 10 minutes
(`IN_FLIGHT_TIMEOUT_MS`, longer than any function runs) is taken over by the
next request with that key.

The five evidence reads (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md)
answer, in `{ data }`, the documents the session downloads build, by the same builders, with members named by user
id (`people: "id"` in `readEvidence`, `readPayeeLockEvidence` and `readClosePack`), so a download and an API
answer are checked by the same `verifyEvidence`. The receipt is `readReceiptDocument`
(`src/lib/receipts/document-read.ts`), which never selects a receipt link's `token_hash`. Their shared helpers
are in `src/lib/api/evidence.ts`: `documentAnswer` serializes once with `cache-control: no-store` and answers
`400` for a close pack or payee lock period over 4 MB (`API_DOCUMENT_MAX_BYTES`), below Vercel's response limit;
`workspaceInScope` reads the key's workspace's slug and name. A malformed id, month or period is refused before any
read, then `takeApiEvidenceToken` (10 at once, then one every 6 seconds, per key, one bucket for the five) brakes
them, since each checks every cited entry's signature and the evidence reads ask the chain's RPC and check the links
people gave. They write nothing: no ledger entry, no row, no webhook. Their operations carry `mcp: false`, so they
have no MCP tool until the tools are designed for them, and `NO_MCP_TOOL_YET` in `tests/access-gates.test.ts` names
their routes.

Collections intended for human browsing are newest first and use
`created_at + id` as a stable cursor. The ledger is the exception: its `seq`
is ascending and, within one organization, a correct resume watermark even
though it runs with gaps — continuity is proven by the hash chain, not by
`seq`. The legacy `src/app/api/ledger/verify/route.ts` still serves the Audit
page; it is member-only and takes `?org=<slug>` (see the
[verify reference](https://www.vestiarion.xyz/docs/api/verify-ledger#the-public-key)).

## Webhooks

Where the API is pulled, webhooks push: a workspace registers its own
HTTPS endpoints (`webhooks.manage`, above) and each new `ledger_entries` row
reaches them without polling. An `after insert` trigger on `ledger_entries`
(migration `0028`) enqueues one `webhook_deliveries` row per active endpoint,
in the same transaction as the append. Enqueueing never fails the append: an
enqueue error raises a warning and the entry is still appended. A dispatcher
(`deliverPendingWebhooks`, `src/lib/webhooks/deliver.ts`) claims due rows and
sends each one HMAC-signed. It runs right after the request that appended
an entry (`dispatchWebhooksSoon` schedules it with `after()` from
`appendSigned`, one per burst), right after every scheduled tick, and every
10 minutes from Supabase Cron (`POST /api/platform/webhooks`), which sweeps up
retries. A
destination's host is resolved once, at connect time, and every address must
pass the same public-only rule as when the endpoint was added; the connection
is pinned to the addresses checked, which closes the DNS-rebinding gap a
separate check would leave. Full detail — the payload, retries, the endpoint
limit, and how to verify both the delivery's signature and the ledger entry's
own — is in the [webhooks docs](https://www.vestiarion.xyz/docs/webhooks).

## Invoice capture for Chrome

The Chrome extension Vestiarion Invoice Capture (`extensions/chrome-invoice-capture/`;
docs/superpowers/specs/2026-10-15-invoice-capture-design.md) sends an invoice a person selects in a page, or a file
they choose, to their workspace as a draft. Its single purpose ends there: a draft becomes a bill only in the console.

**Drafts.** Migration `0121` adds `invoice_drafts`, a tenant table under the usual isolation and guard, which the
tenant role reads, adds and changes and never deletes. A draft holds the fields read (supplier, invoice number, amount,
currency, invoice date, due date, purchase order, memo), its source (`selection` or `file`, or `payee_link` for an invoice
a payee sent through its payee link, migration `0133`, with no connection) and the document's kind and
SHA-256, what the reader made of it (`read`: every warning for the console, the document's own notes for the extension,
the counterparty matched, the fields as read), who captured it through which connection, and its state: `draft`,
`sent`, `confirmed` with the invoice it became, or `discarded`. A trigger, `invoice_drafts_guard`, holds the
moves (draft to sent, draft or sent to discarded, sent to confirmed, confirmed back to sent only while no bill is
linked), keeps where a capture came from fixed and its fields fixed once sent, lets the text only be removed, and links
a bill once; a check keeps a bill on confirmed drafts only and a unique key one draft per bill. `read` is at most 64
KB. Reading reuses `readInvoiceDocument`
(`src/lib/invoice-document/draft.ts`), the reader of From a document, the chats and email, which now also returns the
text read, the invoice date and the document's own warnings; `readInvoiceDraft` is its draft alone, as before. A
picture is captured blank, not read. The commands are in `src/lib/commands/invoice-drafts.ts`:
`invoice_draft.capture`, `.edit` and `.send` run on the new `chrome` surface, and `invoice_draft.confirm` and
`.discard` in the console. Confirm claims a `sent` draft in one guarded update with the id the bill will have
(`claimed_invoice_id`) and calls `addInvoice` with it, so every check of a bill applies. Only a refusal that wrote
nothing (`counterparty_not_found`, `forbidden`, `surface`) puts the draft back without a look; any other failure looks
the bill up by that id, and a bill written before its ledger entry failed keeps the draft confirmed and linked, never
added twice. The `create_invoice` entry names `via: "chrome"`, the draft and its invoice number; a draft that may
repeat a bill or another draft (`src/lib/invoice-drafts/duplicates.ts`, the agent's `findDuplicates` and the invoice
number) needs the person's **This is not a duplicate**. Bills & receivables lists the sent drafts as the review panel
`captured` (50 at most, "50+" past that), without their text: **What was captured** reads it when it is opened
(`readCapturedTextAction`). The link to add a supplier carries the draft's id, never its name. One connection keeps at
most 50 drafts never sent. The captured text (`raw_text`) goes when the draft is decided; `invoice_capture_sweep()`, run
by the daily cleanup (`src/lib/invoice-drafts/retention.ts`), clears it from 29 days after capture (and from any decided
draft), deletes drafts never sent after 6, a day early so a daily run keeps the 30 and 7 days promised, links or puts
back a draft left confirmed without its bill for an hour, and deletes codes a day after they expired and connections 30
days after they ended.

**Authorization without an API key.** `/extension/authorize` is an OAuth authorization endpoint with PKCE (S256 only)
for the extension ids in `CHROME_EXTENSION_IDS` (`src/lib/extension/settings.ts`), and once any is listed the Chrome Web
Store's copy (`STORE_EXTENSION_ID`, the id the store gave it, with its page at `STORE_URL`) and the copy
offered for download (`DOWNLOAD_EXTENSION_ID`: `public/downloads/vestiarion-invoice-capture.zip`, built by
`scripts/build-extension-download.mjs` with the public key in `src/lib/extension/download-key.json` as its manifest's
`key`, so every copy has one id; `tests/extension-download.test.ts` keeps the zip equal to the package), whose one
redirect address is
`https://<id>.chromiumapp.org/`; any other client or address is refused on the page, never redirected to. The signed-in
person picks a workspace where they hold `records.write` and allows it; `allowExtensionAction` issues a one-time code
(`extension_auth_codes`, SHA-256, five minutes). `POST /api/extension/v1/token` uses the code up in one guarded update,
then compares the client, the redirect address and the verifier and reads the role again; the connection is inserted
with the code's hash, so a code presented twice always finds and revokes it, and the exchange checks the code's
`replayed_at` again after its insert, for a replay that landed in between. It answers an access token (`vxa_…`, an
hour) and a refresh token (`vxr_…`, thirty days, replaced on every refresh, the one replaced kept as
`retired_refresh_hash`: used again, it revokes the connection, `reused_refresh`, as does a second refresh racing the
first, whose guarded update matches nothing) for the audience `vestiarion-chrome` and the scopes
`invoice_draft:create` and `invoice_draft:read` only, kept as SHA-256 on the connection (`extension_grants`). A
connection lasts at most 90 days from `created_at` (`CONNECTION_LIFETIME_MS`, and a check on the row), and a role
without `records.write` revokes it at a refresh or a request (`role_changed`). The extension refreshes from its service
worker, one refresh at a time. Both tables are platform tables, like API keys, read only by
`src/lib/extension/tokens.ts`; a connection cascades with its membership, and `removeMember`, leaving and account
deletion read the connections first and record `extension_disconnected` (`member_removed`, `member_left`,
`account_deleted`) for each. `POST /api/extension/v1/revoke` (RFC 7009) and Settings' **Chrome extension** section end
one. The races are tested over the in-memory PostgREST with a hook that runs a request between two others: PGlite is
one connection in one process and cannot hold two transactions open at once.

**The extension's endpoints are under `/api/extension/v1`, not `/api/v1`.** They are not in the OpenAPI document, the
SDK, the CLI or the MCP server, and they take no API key, as `/api/v1` takes no extension token (an extension token is
not `vxk_…`, so `authenticateApiKey` refuses it before any lookup). `guardExtensionRequest`
(`src/lib/extension/http.ts`) checks the origin (CORS answers only `chrome-extension://<id>` of the allowed ids), the
token, its audience and scope, sixty requests a minute per connection, and the member's role read now through
`memberActor` on the `chrome` surface. `POST invoice-drafts` takes `{ source: "selection", text }` (at most 20,000
characters in 100 KB, read with a byte cap whether or not the length is sent) or a file of at most 4 MB, with a required `Idempotency-Key` kept on the draft (unique per
connection); `GET`, `PATCH` and `POST …/send` reach only the connection's own drafts. Before migration `0121`, or without
`CHROME_EXTENSION_IDS`, they answer 503 and the console shows nothing new.

**The extension** is plain JavaScript modules shipped as they are (`extension/`): Manifest V3 with exactly `activeTab`,
`scripting`, `storage`, `identity`, `contextMenus` and `alarms` and no host permission (its calls are CORS requests, without
cookies), no content scripts, no remote code. It reads a selection only when a person presses Capture or uses the
context menu, whose selection waits in session storage for **Send to Vestiarion** for five minutes, then an alarm removes
it; it is never sent by itself. It connects through `chrome.identity.launchWebAuthFlow` from its service worker, keeps the access token in
`chrome.storage.session` and only the refresh token in `chrome.storage.local` (closed to content scripts with
`setAccessLevel` where Chrome supports it).
`tests/chrome-extension-manifest.test.ts` holds the manifest and the code to that; `tests/invoice-capture-flow.test.ts`
runs every call it makes against the routes in-process, over an in-memory PostgREST (`tests/support/memory-postgrest.ts`).

## Developer docs

The public docs at `/docs` are built in this app with `@next/mdx`. The written
pages are MDX in `content/docs/`; the API reference pages are generated from
the operations in `src/lib/api/openapi.ts`, which also serve
`/api/v1/openapi.json`; `src/lib/docs/markdown.ts` writes each page's `.md`
view, `/llms.txt` and `/llms-full.txt`; and `src/lib/docs/nav.ts` is the one
list of pages. Tests hold the content to the code: every nav page has its MDX,
every link and anchor resolves, the OpenAPI document covers every v1 route, and
the webhook verification snippets run against the signing code. The Guides
pages (`content/docs/guides/`) are for people using the app rather than the
API; they quote its buttons, fields and messages exactly, and
`tests/docs-guides.test.ts` checks each quoted string against the source file
it comes from, so renaming one in the app means updating the guide. Their step screenshots are the app’s own components rendered with sample data by `/docs-shots/<name>` (`src/app/docs-shots/`), which answers only where `DOCS_SCREENSHOTS=1` is set; `npm run docs:screenshots` photographs them into `public/docs/guides/`, and `tests/docs-screenshots.test.tsx` holds every `<Screenshot>` to an existing PNG with alt text, and every PNG to a guide. The nav groups pages by what a reader is doing (`docs/superpowers/specs/2026-10-11-docs-clarity-design.md`,
`docs/superpowers/specs/2026-10-16-docs-redesign-design.md`): Get started, Pay bills, Plan and report, Get paid, Trust and
controls, Connect your tools, Developers, then the API reference, webhooks and the changelog. The long sections split
their pages into short runs under a `NavPage.group` ("Accounting" in Connect your tools), which only the sidebar draws.
Every section is a disclosure in the sidebar, open when it holds the page being read; pages keep their addresses
whatever their group. The docs' home (`DocsHomeHero`, then `content/docs/index.mdx`) leads with search and the two ways
in, then popular workflows, `<TopicIndex />` (every section and its first pages, built from the nav) and the developer
resources. MDX pages have `<Callout kind="note|tip|important|warning|real-money">`, whose kind is written beside its
title on the page and in the `.md` view, `<Action href>` for a guide's one next step in the app, `<Flow>` and
`<FlowStep title>` for a workflow the guide describes (a numbered list in the `.md` view), `<Card icon>` from one set of
line icons, and numbered `## 1. …` steps, which `DocsHeading` draws with a number badge while keeping their ids. A `<Screenshot>` opens larger in a dialog
(`ZoomableImage`). A `<Video>` (`src/components/docs/Video.tsx`) shows a guide's walkthrough film, an MP4 and its poster
under `public/docs/videos/`, in the browser's own player with `preload="none"` (no embed, no autoplay), its title,
length and caption below, and its transcript, written between its tags in the MDX, under "Read the transcript"; the
`.md` view links the file and gives the transcript. A `<Video>` missing an attribute or its transcript fails the render,
and `tests/docs-videos.test.tsx` holds each one to an existing fast-start MP4 of the length it states, and every file
there to a guide. `GUIDE_VIDEOS` (`src/lib/docs/videos.ts`) lists them, one per main flow, with the guides each also
walks through; the test holds it to the MDX, and the app offers each one beside its guide's links: `DocsLink` adds
"Watch" and the length after "Docs" for a link to a whole guide that has one, and the getting-started checklist after
"Read the guide". The proxy skips `docs/videos/`, and `outputFileTracingExcludes` keeps the files out of the server
functions. **A PR that
changes `/api/v1` or webhooks adds a changelog entry** to
`content/docs/changelog.mdx`: dated, newest first, saying what changed for an
integrator.

The TypeScript SDK lives in `sdk/` (`@vestiarion/sdk`). It has no dependencies, uses `fetch` and Web Crypto only, and
is type-checked, linted and tested with the app. It is held to the code in four ways:

- `sdk/src/types.ts` is rendered from the OpenAPI document by `npm run sdk:types` (`scripts/lib/sdk-types.ts`).
  `tests/sdk-types.test.ts` fails when the file is stale.
- `tests/sdk-contract.test.ts` runs the SDK against the v1 routes in-process.
- `tests/sdk-webhooks.test.ts` holds its checks to `src/lib/webhooks/sign.ts`, `src/lib/ledger.ts` and the receipt
  verifier.
- `tests/sdk-evidence.test.ts` runs `verifyEvidence` (`sdk/src/evidence.ts`), which checks an evidence document,
  a receipt, the payee lock's evidence or a close pack offline, over the five evidence examples, and holds each entry's
  verdict to the server's `verifyEntry`. Those examples (`content/docs/examples/get-*-evidence.json`,
  `get-invoice-receipt.json`, `get-close-pack.json`) are not recorded answers: `scripts/evidence-examples.ts` builds
  them with the real builders from a made-up workspace, signed with a key made for the run and never written down, so
  no real workspace's entries are published and every example still verifies.

`npm run sdk:pack` compiles the package and packs it into `public/sdk/vestiarion-sdk-<version>.tgz`, the URL the docs
install from. That file is committed, and a version already packed is never packed again, so a lockfile's integrity
hash keeps matching. `tests/sdk-package.test.ts` holds the tarball to a fresh build.

A released version also goes to the npm registry, published from that same file by an owner of the `@vestiarion` npm
organization:

```text
npm publish public/sdk/vestiarion-sdk-<version>.tgz --access public
```

Both installs then get the same bytes. The next version's `sdk/README.md` should name `npm install @vestiarion/sdk`
first; 0.1.0's README, inside its immutable tarball, names the site's URL.

The CLI lives in `cli/` (`@vestiarion/cli`, whose `bin` is `vestiarion`). It is ESM for Node 20 or later, parses its
arguments with `node:util` `parseArgs`, and depends on `@vestiarion/sdk` and nothing else. The root `devDependencies`
name the same SDK range as `cli/package.json`, so the CLI is type-checked, linted and tested against the SDK as npm
serves it, not against `sdk/src`. It is held to the code in four ways:

- Each command names the operations it calls in its help (`cli/src/commands/`). `tests/cli.test.ts` holds every one to
  an operation of the OpenAPI document, and runs each command against the recorded answers in
  `content/docs/examples/`: its text, its `--json`, its exit code and the request it sends.
- The same test checks the key's precedence (`--api-key`, `VESTIARION_API_KEY`, then a profile), that a saved key goes
  only to the API it was checked against and no other key goes there, the config file's place and mode, the
  confirmation before a write and its refusal without a terminal, that `show` stops paging after 10,000 records or at
  a cursor the API already gave, and that no output and no URL ever holds a key.
- `vestiarion ledger verify` checks an audit export with the SDK's `verifyLedgerEntry` (`cli/src/ledger-export.ts`).
  `tests/cli-ledger-verify.test.ts` runs it and `public/tools/verify-ledger-export.mjs` on the same exports, and
  requires the same words and verdict.
- `npm run cli:pack` builds it into `public/cli/vestiarion-cli-<version>.tgz`, committed and never repacked, as the
  SDK's is. `tests/cli-package.test.ts` holds that tarball to a fresh build, runs its `bin` unpacked beside the SDK's
  tarball, and runs `npx` against it.

An owner of the `@vestiarion` npm organization publishes the CLI from that file, as the SDK:

```text
npm publish public/cli/vestiarion-cli-<version>.tgz --access public
```

The Postman collections are rendered from the OpenAPI document by `npm run postman:build` (`scripts/lib/postman.ts`)
into `public/postman/`: "Vestiarion: Getting Started", five requests from a key to a first write; "Vestiarion API
reference", every operation in a folder per tag, with a saved example of its success and of each documented error; and
an environment with `baseUrl` and an empty, secret `apiKey`. They live under `public/` so the site serves them at
`/postman/<file>`, the URL Postman imports from, from the same deploy as the API they describe, with
`Access-Control-Allow-Origin: *` for Postman's browser app; the proxy skips `postman/`. The saved errors quote the API's
own messages. Getting Started's writes send no example address: they add a counterparty at `{{vendorAddress}}`, which
the person running them sets to a wallet they control, and their pre-request scripts refuse to send while it is empty.
`tests/postman.test.ts` fails when a committed file differs from what the generator renders, when one does not
validate against the Postman Collection v2.1.0 schema (kept in `tests/fixtures/postman/`), when a saved message is not
in `src/lib/api` or the v1 routes, when any file holds something shaped like a key, or a payee-link token other than
the example's invented one, or authenticates other than with `{{apiKey}}`, and when a Getting Started request carries a
literal wallet address. A generator that meets an error code without a message, or a parameter it does not place,
throws rather than guess.

`server.json`, at the root, describes the remote MCP server for the official MCP Registry: Streamable HTTP at
`/api/mcp`, and the API key as a required, secret `Authorization` header, `Bearer {api_key}`. `tests/mcp-registry.test.ts`
validates it against the registry's schema (kept in `tests/fixtures/mcp-registry/`), and holds its name to the
repository's GitHub namespace and its version to `MCP_SERVER_VERSION` (`src/lib/mcp/version.ts`), which the route
reports as `serverInfo.version`. Publishing it, and the Postman collections' public workspace, are a maintainer's
steps, in `docs/distribution/`.

The SDK's and the CLI's versions are their own. The product's version is a git tag, `vX.Y.Z` or `vX.Y.Z-beta.N`, published as a GitHub
Release by `.github/workflows/release.yml`, which a maintainer starts by hand once the tag is pushed; `CHANGELOG.md`
says what each release changed for the people using it. A tag deploys nothing: Vercel deploys `main`. How to release,
sign a tag and fix a wrong release is in `docs/RELEASING.md`.

## Growth tracking for the team

Migration `0099` adds what the team records about its own growth, apart from any workspace: `growth_campaigns`,
`growth_leads` (businesses the team found by hand, each with its source, segment, campaign, evidence, a draft message,
a review status and a stage), `growth_spend` (cash and founder hours) and `growth_revenue` (pricing talks, pilots,
invoices and payments; only `payment_received` ever counts as revenue). They are platform tables: row level security
on, nothing for `anon` or `authenticated`, reached only through `platformDb()`.

Every change to a lead's stage, review status, campaign, workspace or source, and its creation, is written to the
append-only `growth_lead_events` by the trigger `growth_leads_log`, so attribution and stage are never overwritten
without a trace; the events refuse update, delete and truncate, except the cascade when their lead is deleted. The
note and the team member reach the trigger through two transaction-local settings, `growth.note` and `growth.by`, that
`growth_update_lead(p_lead, p_changes, p_note, p_by)` and `growth_import_leads(p_rows, p_by)` set before they write.
A write made any other way (the link cleared when a workspace is deleted) is logged with neither.

**The first-touch cookie.** `FirstTouch` (`src/components/analytics/FirstTouch.tsx`), in the root layout, writes a
first-party cookie, `vx_ft`, when the address carries `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`,
`utm_term` or `ref` and the browser holds none yet: those tags, each cut to 100 characters of `[A-Za-z0-9._~-]` (a
tag with an `@` is dropped), the landing path without its query, the referring site's host, and the time; 90 days,
`SameSite=Lax`, `Secure` on https, under 1 KB (`src/lib/growth/attribution.ts`). `createWorkspaceAction` reads it once
the workspace exists and calls `record_org_attribution`, which keeps the first touch in `org_attribution` and never
replaces it. Recording never fails or holds up onboarding: no cookie, a database error, or an answer slower than 1.5
seconds is logged at most (`src/lib/growth/record.ts`). The privacy page describes the cookie.

**Counterparty pages say who sent them** (`docs/superpowers/specs/2026-10-19-counterparty-loop-design.md`).
`src/lib/growth/loop.ts` names the nine public pages and seven emails a business sends its counterparties. `SiteFooter`'s
`loop` prop puts "Sent with Vestiarion…" and a link to the landing page, opened in a new tab, at a token page's foot;
`actionEmailHtml`'s `loop` adds the same link to an email's footer. Each link carries `utm_source` (the kind of page),
`utm_medium` (`counterparty_page` or `counterparty_email`) and `utm_campaign=counterparty_loop`, nothing of the page
itself; the landing page's first-touch cookie keeps them, and /admin/growth counts customer workspaces whose first touch
came from the loop (`growthMetrics().fromLoop`). Member emails carry no link.

**Workspaces from accountants** (accountant client links AC5). When an accountant's client link is claimed, migration
`0143`'s `claim_client_link` writes the new workspace's `org_attribution` in the same transaction, `utm_source=accountant`,
`utm_medium=client_link`, `utm_campaign=accountant_client` (`ACCOUNTANT_CLIENT_CAMPAIGN`, `src/lib/growth/attribution.ts`),
write-once as `record_org_attribution` is; the join action then skips the cookie's first touch. `growth_workspaces` is not
redefined: it already returns the attribution, and /admin/growth's **From accountants** tile counts customer workspaces
with that campaign (`growthMetrics().fromAccountants`). A claim that fails records the cookie's first touch instead.
Only the claim gives a workspace that campaign: `firstTouchFrom` and `parseFirstTouch` drop a `utm_campaign` of
`accountant_client`, in any case, from an address or a cookie, so a visitor cannot put a workspace in the tile.

**The founder dashboard** at `/admin/growth` is for people on `platform_team` only. `growthTeamUser()`
(`src/lib/growth/gate.ts`) asks `growth_team_member(p_user)` on every call and fails closed; the page answers anyone
else, signed in or not, with `notFound()`, so it never says it exists, and every action in
`src/app/admin/growth/actions.ts` and the CSV export at `/admin/growth/leads.csv` ask the gate again themselves
(`tests/access-gates.test.ts`, `tests/growth-access.test.ts`). It is in no navigation and no sitemap, and asks not to
be indexed. It shows `open_funnel` per network, the workspaces from `growth_workspaces(p_since)` (customers apart from
ours by `open_funnel`'s rule, with the first decision and the second real bill by `0089`'s definitions, and no email or
person's name), figures with their numerators and denominators ("Not enough data yet" where a denominator is 0),
retention by week (`retentionCohorts`, `src/lib/growth/retention.ts`: each workspace active in its week k when a real bill
was added or a person decided a payment, read from its own records in its own scope by `readRetentionActivity`),
breakdowns by source, segment and campaign, the leads with their trails, an approval queue, a CSV import that previews
every row and never overwrites a lead, and forms for campaigns, spend and revenue. The calculations live in
`src/lib/growth/metrics.ts` and `csv.ts`, and the page's Definitions section (`src/lib/growth/definitions.ts`) says
where each figure comes from. **It never sends a message to anyone**: approving a lead records a decision, and
Vestiarion never sends outreach. Payment volume is never shown as revenue, and amounts in different currencies are
never added together.

**The team's screening page** at `/admin/screening` (`docs/superpowers/specs/2026-10-22-screening-health-design.md`)
sits behind the same gate: the page answers anyone off `platform_team` with `notFound()`, and its one action,
`checkScreeningNowAction` (`src/app/admin/screening/actions.ts`), asks `growthTeamUser()` again itself. The page shows
the deployment's screening setup from its environment (`screeningSetup`: provider, the address's origin, whether a key
is set, which variable set is read) without calling anyone, and live checks across workspaces from
`screening_health()` (migration 0139, service role only, read by `src/lib/screening/platform-health.ts`, which no other
module imports): the last complete and last failed live check with the failed one's note cut to 120 characters, and the
counts over 24 hours and 7 days, workspace slugs only. Live checks there are provider lookups: OFAC address verdicts
(source `ofac-sdn`), written as live without calling a provider, are left out, a sandbox's included. **Check now** screens the fixed fictitious name "Zenith Trading
Example LLC" with the deployment's provider and key and shows the outcome. It writes no counterparty, no compliance
check and no ledger entry, only one `console.info` line, `screening check: provider=… origin=… ok=… status=… ms=…`,
never the key or the full address. The key's runbook is in `docs/self-hosting.md`.

**Inbound leads from /studios.** The page for studios that pay contractors per deliverable (`src/app/studios/page.tsx`)
reads the landing's figures the same way (`readAllTimeOrNull` per network, `readLatestDecision`); its count of code
refusals is `refusedByCode` from those open numbers, one network at a time, customers apart, never written into the
page. Its guided setup form posts to `requestGuidedSetupAction` (`src/app/studios/actions.ts`), which has no session
to gate on: `submitGuidedSetup` (`src/lib/growth/inbound.ts`) is the gate. There is no shared rate limiter
(`src/lib/rate-limit.ts` is per instance), so a bot is kept out without a store: a honeypot field, a form token signed
when the page is drawn (`vx1.<body>.<HMAC>`, keyed by HKDF from `VESTIARION_MASTER_KEYS` for this purpose alone, as the
GitHub and Slack states are) that must be at least 3 seconds and at most a day old, and a cap of 4,000 characters on the
whole submission (`src/lib/growth/guided-setup.ts`). A bot is thanked like a person and nothing is written; a token
older than a day asks the person to reload. A request that reads right is written through `growth_import_leads` as one
lead: source `inbound`, contact channel `website_form`, the email as the handle, the first touch's `utm_campaign` as
the campaign only when `growth_campaigns` has that id, the first touch's tags in `source_detail` either way, and the
answers in the notes. A dedupe key already taken is skipped, as in an import, and the person is thanked all the same.
When `GROWTH_INBOUND_NOTIFY_EMAIL` is set, the team gets a short note through `sendEmail` about a new lead (never the
message); nothing is ever sent to the person who asked. The approval queue's card shows an inbound lead's contact,
site, notes and source detail.

**The address lookalike checker.** `/check-address` (`src/app/check-address/page.tsx`,
`docs/superpowers/specs/2026-10-21-address-checker-design.md`) is a free public page, static and outside `/tools`,
which serves downloads. Everything runs in the browser and nothing is sent: there is no form, request or URL
parameter.
- `checkAddress` (`src/lib/address-check.ts`) checks the pasted address's characters (invisible ones, lookalikes from
  other scripts, length, hex) and its EIP-55 checksum.
- It compares the address with those the person pasted as known: at least 3 hex digits shared at each end, or 5 at one,
  a broader rule than the payee lock's first 6 and last 4, which it includes.
- It checks the OFAC snapshot the page carries, its date shown, and addresses that are not a wallet, from the network
  profiles: the zero and burn addresses, the USDC and EURC contracts, Arc's USDC system address.
- `tests/check-address-page.test.tsx` holds the checker's code to making no request.

## Onboarding by role

`docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md` (R1 to R6). Each member's first real task
as a short checklist, ticked from what happened, rendered by one component (`GettingStarted`,
`src/components/vx/GettingStarted.tsx`):

- **Whose.** `checklistRoleOf` (`src/lib/onboarding/role-checklists.ts`): an owner and an admin follow the owner's, the
  console's Get started (`gettingStarted`, which now opens with the workspace created and asks to set or confirm the
  limits before the first payment); an approver an approver's (`approverChecklist`), on the console and on Approvals; an
  accountant an accountant's (`accountantChecklist`), on `/accountant`; a viewer none.
- **Ticked from data.** The owner's from the rows the console reads, plus the limits: a person's `agent_budget_changed`
  or `approval_policy_changed` (`readLimitsSet`), or a `limits_confirmed` mark from Keep these limits
  (`confirmLimitsAction`, `agent.budget`). An approver's and an accountant's from the person's own signed acts
  (`readPersonActs`: `detail.by` the person, actor human: decisions, `accounting_payment_approved`,
  `ar_payment_applied`, `handoff_exported`) and from marks for what leaves no row: Approvals opened, a held bill's
  reasons seen there, the accountant console opened, one workspace's queue opened. A page only reads them while it
  renders, and ticks this visit's steps itself; while a mark is missing it renders `ChecklistVisit`
  (`src/components/vx/ChecklistVisit.tsx`), which sends `recordApprovalsVisitAction` or `recordAccountantVisitAction`
  once the page is in the browser (Next.js forbids a mutation during rendering, and a prefetch could tick a step for a
  page nobody opened). Each action is gated as every action is (`authorize`, then `inOrg`), checks the role again, and
  reads whether a bill waits on the server (`billWaitingOnApprovals`). `/accountant` reads the marks in each workspace
  where the person is an accountant, through `withOrg(orgId, ..., { userId })`, never across tenants
  (`readAccountantOnboarding`), and has the visit recorded in each of those still missing it, one action per workspace.
  The accountant's optional fifth step, Invite a client (accountant client links AC6), is offered only where client links
  work (after migration `0143`) and ticked once one of the person's links was used, read by their own user id
  (`listClientLinks().everUsed`). A step marked `optional` is never `next`, and the checklist shows and counts as done
  without it.
- **Marks** (`src/lib/onboarding/read.ts`, migration `0114`): `onboarding_marks (org_id, user_id, mark)`, one row each,
  under the two tenant policies, select and insert only for the tenant role, cascading with the workspace and the
  account. Before `0114` runs, reads answer `available: false` (42P01, PGRST205, 42703), nothing is recorded, and the
  pages offer neither Don't show again nor Keep these limits.
- **Dismissed for good.** `dismissChecklistAction` (`workspace.read`) records `dismissed_<role>` only for the checklist
  the person's own role sees. The accountant's is dismissed in the workspace its steps open, and stays dismissed on the
  console once any of the person's workspaces holds the mark.
- **Never more than the role may do.** Each step carries `needs`, the permission it takes; `tests/role-checklists.test.ts`
  checks every variant of every role's checklist against `PERMISSIONS`, an admin's owner-only steps shown as an owner's.
- **Landing.** Accepting an invitation redirects to `firstStepHref(role, slug)`.

## Evidence links people can open

`docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md` (E1 to E4); `src/lib/evidence-links/`.

- **The allow-list** (`allow-list.ts`, pure). `checkTargetOf` takes a pull request or a comment on `github.com`, an
  Asana task or attachment on `app.asana.com`, and a signed link (`/storage/v1/object/sign/...?token=`) to the
  workspace's own Supabase (`storageHostOf`, https and a public name only), and builds the request address itself:
  GitHub's API from the link's owner, repository and number; Asana's `/api/1.0/tasks/<id>` or `/api/1.0/attachments/<id>`
  from the id alone. Anything
  else is `notChecked` with its reason: another scheme, credentials, a port, an IP literal in any notation, a local name,
  another host, another path. `requestAllowed` checks every address again before a request, a redirect's included.
- **The check** (`check.ts`). `checkEvidenceLinks(hrefs)` answers `open` (public, or a private repository the
  workspace's own connection reads), `cannot_open` (with the reason: deleted, private and not the workspace's, refused,
  expired), `not_checked` or `no_answer`. Each host is resolved and the request dropped unless every
  address is public (`isPublicAddress`, as webhooks use it); `redirect: "manual"`, five seconds, at most one redirect and
  only GitHub's API to itself; at most 25 links a call. Asana is asked with the workspace's own Asana connection's token
  alone, sent to Asana's API only, and without one an Asana link is not checked. GitHub is asked with the workspace's own connection
  (`pullRequestTokens`), else the deployment's `GITHUB_TOKEN`, sent to `api.github.com` only; a private repository seen
  only through the deployment's token, or a 403 to that token, answers as not public, as a deleted one does, after as
  many requests (a comment's repository is asked first) and kept as long. A signed link's expiry is read from
  its token first; storage is asked for one byte with the link's own signature only. Results are kept in memory per
  workspace and link (five minutes open, two can't be opened, thirty seconds no answer, 500 at most); nothing is stored,
  and no link is logged.
- **Where.** The evidence page and its download (`readEvidence`), and the Contractors cards (`milestoneDecision`'s
  `links`, checked on the page, open milestones first): a link that can't be opened is shown without an anchor, with the
  reason, and its fact reads Could not open; a link not checked is shown as given, `rel="noreferrer nofollow ugc"`. Bills'
  documents and deal costs' documents are never kept, and a receipt's link is never stored, so nothing there is offered.

## The accountant console

`docs/superpowers/specs/2026-10-13-accountant-console-design.md`. An outside accountant who looks after several small
businesses is invited to each as a member with the `accountant` role, and works across them from one page, `/accountant`
(`src/app/accountant/page.tsx`, `src/components/accountant/AccountantConsole.tsx`).

**The role** (A1). `accountant` is a fifth value of `memberships.role` and `invitations.role` (migration `0112`, which
replaces each check once, while it does not name the accountant, so every existing membership keeps its role). It holds
`workspace.read`, `accounting.book` (booking payments made on Arc in Xero after reviewing each, write-back W6) and
`receivables.reconcile`, a permission split from `records.write` for the receivables bookkeeping: applying money received
and reversing it (`receivable.apply_payment`, `receivable.reverse_allocation`), and replying to and closing what a
customer said on its statement link (`customer_request.reply`, `customer_request.close`). Owners and admins hold
`receivables.reconcile` too, so nothing changed for them; approvers and viewers never held `records.write`. Making and
stopping a statement link stays `records.write`. The accountant decides no payment and pauses nothing, so the SQL
functions that name the deciding roles (`0025`, `0061`, `0076`, `0077`) are unchanged and leave it out. It ranks with
the approver (`role_rank` 2, `RANK` 1): an owner or an admin may grant it, an accountant grants nothing. `0112` also
makes `can_assign_role` answer false, never null, for a role `role_rank` does not know. Customer messages
(`notifyCustomerWrote`) now reach an accountant whose email switch is on, and Settings' Notifications offers an accountant
that switch as "Email me when a customer writes on its statement link". A Xero connection's consent says who approves
what is booked: versions `xero-2026-10-13` and `xero-2026-10-15` name the accountant (`ACCOUNTANT_BOOKING_CONSENTS`),
and an accountant's booking on a connection agreed under an earlier version is refused (`consent`) with whom to ask,
until Xero is reconnected.
"Unless the owner grants more" is a role change: one person holds one role in a workspace.

**The read model** (A2, A3; `src/lib/accountant/read.ts`, `triage.ts`). Never a service-role read across tenants. The
page checks the session (`verifySession`) and lists the person's own memberships (`membershipsOf`, the read every
workspace page's gate makes, from the session's user id, per request). Each workspace is then read inside
`withOrg(orgId, ..., { userId })`, four at a time: its requests carry a tenant token naming that workspace and that
person, so row-level security confines them even if a filter were wrong (`tests/accountant-portfolio.test.ts` reads an
accountant invited to three of four workspaces and checks every tenant request's token names one of the three and the
accountant, that the fourth is never read, and that removing the membership drops the workspace from the next read).
Each part of a workspace is read on its own, and one that fails is named on its card (`unread`) while the rest show:

| Kind | Read | Age from | Opens | Who acts |
| --- | --- | --- | --- | --- |
| `past_decide_by`, `decision` | payables `held`, `flagged`, `awaiting_info` (split by `decideByOf`), milestones `held` | the decide-by day once past; else `decided_at` | Approvals at the bill; Contractors | `approval.decide` |
| `cosign` | the same payables, for an accountant while `accountant_cosigns` is on: those `readCosignStates` answers `can_cosign`, in place of their decision item | as the decision item would | Approvals at the bill | `approval.cosign` |
| `confirm_address` | `counterparties` with `address_changed_at` set (newest first, at most 200), kept where `addressUnconfirmed`; frozen ones from `readFrozenPayees` | `address_changed_at` | Counterparties at the payee | `approval.decide`; an accountant's `approval.cosign` while co-signing is on; a frozen payee `records.write`, who unfreezes it; under the payee lock, not whoever gave the address (`loadNewPayeeFacts`, `addressGiver`) while `billApproversBesides` counts someone else, as `giver_confirms` refuses |
| `to_book` | `accounting_postings` `draft` or `failed` | `created_at` | the bookings review | `accounting.book`; an accountant only on a connection whose consent is in `ACCOUNTANT_BOOKING_CONSENTS`, as the command checks |
| `receivable_overdue` | receivables `pending`/`matched` past `due_date` | the due date | the receivable | `receivables.reconcile` |
| `customer_says_paid`, `disputed` | open `customer_requests` of kind `paid`, `dispute` | `created_at` | From customers | `receivables.reconcile` |
| `connector` | `accounting_connections` whose `connectionStatus` is an error | `last_error_at` | Settings at the connector | `integrations.manage` |
| `limit` | `readUsageLimits` without Gateway's balance, reached ones | the day | Settings, Usage this month | the limit's own |

`routeTo(role, kind)` says "You can ..." or which roles of the workspace act; the queue puts what the viewer can act on
first, then by kind, then the oldest. For an accountant, `readWorkspaceTriage` reads `accountant_cosigns` once
(`readAccountantCosign`, unread counts as off and is named) and passes it to the decision part and the address part. A
bill is one item whatever its co-sign state: `can_cosign` makes it `cosign`, saying the figure and whether one approval
is given; `cosigned` and `blocked` keep the decision item and say so first; a co-sign read that fails leaves the
decision items and names "bills to co-sign". No member list is read, and no address is put on an item. The KPI is how many items are open in each age bucket (under a day, 1 to 3, 4 to 7,
8 to 30, over 30 days). The console counts items and never adds money: each amount stays on its item, in its currency.

**The hand-off** (A7; `GET /api/accountant/handoff?org=&format=csv|json&month=YYYY-MM`, `src/lib/accountant/handoff.ts`).
The audit export's gate in its order (a cross-site request refused, the session, the membership read afresh, a 404 that
never says whether a workspace exists), then, in the workspace's scope: the month's (UTC; the last full month by default)
decisions from the signed ledger (the agent's `AGENT_DECISION_ACTIONS` and a person's approvals, rejections and returns,
an accountant's co-signs among them, `approval_given` with `cosign: true` marked `cosign` and `co-sign` in the CSV, read
with an `or` so no other `approval_given` counts against the most rows, with their numbers and hashes), the payment intents created or confirmed in it, the postings paid in it, and the
workspace's open items now, with the ledger's head so the audit export of the same chain verifies it. CSV is one table
with a `section` column (formula-safe through `csvCell`, a BOM first); JSON is `vestiarion-handoff/1`. Each download
appends `handoff_exported` and is braked at 10 a person in 10 minutes, counted from those entries. Nothing is stored:
removing a member makes their next console load and download answer as for a workspace they never joined, as removing
them revokes their API keys (`0069`).

**Client invite links** (`docs/superpowers/specs/2026-10-23-accountant-client-links-design.md`). An accountant brings a
new client in with one link, and the client opens their own workspace with the accountant already in it.

- **The table** (migration `0143`). `accountant_client_links` is a platform table (`PLATFORM_TABLES`): RLS on, no policy,
  every privilege revoked from `anon`, `authenticated` and `vestiarion_tenant`. A row is the accountant's
  (`created_by`, cascading with their account), with an optional bound `email` (lowercased, at most 254 characters), the
  token's `sha256` hex only (`token_hash`, unique, `^[0-9a-f]{64}$`), `expires_at` (7 days), `used_at`, `revoked_at`, and
  the workspace it opened (`org_id`, set null when that workspace is deleted). Making and revoking a link is signed in no
  ledger, since no workspace exists yet: the row keeps who and when. Its functions, `service_role` only, definer with an
  empty `search_path`, are in `PLATFORM_RPCS`.
- **Making one** (AC1; `createClientLinkAction`, `src/app/accountant/actions.ts`, outside `src/app/actions` because a
  link belongs to no workspace, gated on the session). `createClientLink` (`src/lib/platform/client-links.ts`) makes a
  `vxj_` token of 32 random bytes and sends only the SHA-256 of its secret to `create_client_link(p_actor, p_email,
  p_token_hash)`, which refuses someone who is no workspace's accountant (`not_an_accountant`) and, under an advisory
  lock per accountant, more than 20 made in a day, revoked ones counted, or 10 open at once. The link
  (`siteOrigin()/join/<token>`) is returned once and never logged. `/accountant` shows **Invite a client**
  (`src/components/accountant/ClientLinks.tsx`, read by `readClientLinksSection`) to someone with an accountant
  membership, and lists their 25 newest links (`listClientLinks`) as open, used, expired or revoked; a used one names its
  workspace only while they are still a member of it. `claim_client_link` does not ask whether the link's maker is still
  an accountant anywhere, since the client consents to that person by name, so someone with no accountant membership left
  still gets the list while one of their links is open, without the form (`canCreate: false`), to revoke it.
  `revoke_client_link(p_actor, p_link_id)` revokes only the actor's own open link, whatever their memberships.
- **The client's page** (AC2; `/join/[token]`, `src/app/join/[token]/page.tsx`). `requiresSession` covers `/join/`, as
  `/invite/`, so nothing shows before sign-in and `vx_after_sign_in` brings the client back. `client_link_preview`
  returns the state for any known hash, and the accountant's id and address and the bound address for an open link only;
  `clientLinkPreview` trusts the row only when its hash equals the one asked for, compared in constant time
  (`sameTokenHash`). `joinView` turns it into what the page offers: the form for an open link bound to no one or to the
  signed-in address, one sentence for a link bound elsewhere, the accountant's own, or an expired, used or revoked one,
  naming no one. The page asks not to be indexed, and the analytics see `/join/:token` (`redactPath`).
- **Opening the workspace** (AC3; `joinFromClientLinkAction`, `src/app/join/actions.ts`, also outside
  `src/app/actions` and gated on the session). It checks the link first (a dead link opens nothing), then calls
  `createWorkspace({ network: "arc-testnet", via: "accountant_link" })` whatever the form sent, since Arc mainnet's
  allowlist is `*` in production and protects nothing. There is no second copy of `create_org`. Then
  `claim_client_link(p_token_hash, p_user_id, p_org_id)` locks the link and checks it is open, unexpired and bound (if
  bound) to the client's address, that the accountant is not the client, that the client created and owns `p_org_id`, and
  that the accountant is not a member yet; it then inserts the accountant's membership with the role `accountant`, a
  literal never taken from the caller, and `invited_by` the client, marks the link used and records the first touch, in
  one transaction. `claimClientLink` signs `member_joined { by, role: "accountant", clientLinkId, grantedBy }` in the new
  workspace only, best effort as an accepted invitation's is; nothing is read or written in the accountant's other
  workspaces. A claim that fails (the link used or revoked since the check, or a failed request) leaves the workspace,
  does not use the link, and sends the console `?accountant=not-added`, which says "Your accountant was not added." with
  a link to Members. Shadow mode then starts as at onboarding.
- **Before `0143` runs.** Production runs ahead of its migrations: a missing table or function (42P01, PGRST205, 42883,
  PGRST202) reads as `available: false` on the console and `not_ready` on the page, which say client links are not
  available yet, and the live slice offers no accountant to bring along (`clientLinksAvailable`).

## The monthly close pack

`docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md`. One workspace's calendar month in one table: every
payment Circle confirmed in it, one row each, with its bill, approval chain, checks, transaction and the signed entry
that records it, each cell resting on entries the file carries in full. It reads; it decides nothing, pays nothing and
calls no model. No migration.

**The modules** (`src/lib/close-pack/`). `month.ts` (pure, browser-safe) is the one month parser, `closePackMonth`, with
`monthEnded`, `monthsBeside` and `closePackMonthFrom` for the page's query; the hand-off's `handoffPeriod` returns
`closePackMonth(month, now)` and `HandoffPeriod` is `ClosePackMonth`, so the two never disagree on a month. `types.ts`
holds the shared contract (`ClosePack`, `vestiarion-close-pack/1`, `CLOSE_PACK_MAX_PAYMENTS`). `build.ts` is pure:
`buildClosePack` reuses `settlementOf` and `booksOf`, the receipt's `intentFacts`, `recordingEntry` and
`invoiceNumberInDetail`, the decision trail's `decisionChecks`, `deciderName` and `ruleWords`, `bookingFromEntries`,
`providerOfSource`, the chain and network profiles, `secondPersonOf` (payee lock evidence EP2) and `pullRequestName`,
so the pack and each evidence page say the same. `words.ts` words every cell once for the page, the CSV and the table.
`export.ts` writes the signed JSON (`closePackJson`, exactly `JSON.stringify(closePackDocument(...), null, 2)`), the
table (`closePackTable`, plain strings, which the Google Sheets export writes RAW) and the CSV (`closePackCsv`: a byte-order
mark, CRLF, `csvCell` on every cell) with its 51 `CLOSE_PACK_COLUMNS`. `read.ts` reads; `record.ts` records downloads.

**The read** (`readClosePack`, inside `inOrg` or `withOrg`, through `db()` only, writing nothing). The month's
`payment_intents` whose `confirmed_at`, `created_at` or `submitted_at` falls in it, a page of 1000 at a time, at most
2,001 to tell a cut; the month's `escrow_funded` and `escrow_refunded`; the first `compliance_sweep` that recorded
`sanctionedWallets`; the ledger's head; the members (`listMembers`, `null` on failure); then the bills, milestones and
`invoices.document_pay_to` (through `readDocumentPayTo`, none before `0136`) a hundred ids per filter; then the payees,
the bills' and milestones' entries by `detail->>invoiceId` and `detail->>milestoneId`, the `decision_verdict` entries
by `detail->>subjectId`, and the payees' address entries by `detail->>counterpartyId`, each paged by `seq`; then one
`compliance_checks` read per distinct payee and anchor time (the agent's decision, else the paying entry, else when it
was sent), ten at once, a failure marking those payments `unreachable`. It builds twice, as `readEvidence` does: once to
find the entries the rows cite, then, after `verifyEntry` checks each of those alone with
`ledgerPublicKeyPems(ledgerVerificationKeyring())`, retired keys included, again with the checks.

**The rules.**
- **The month** (CP1). A calendar month in UTC; no workspace has a time zone. With none, the last full month; this month
  is allowed and reads "so far"; a month to come, one before 2020 or anything not `YYYY-MM` is refused.
- **The rows** (CP2). A `confirmed` intent whose `confirmed_at` falls in the month and whose source is a payable invoice
  or a milestone: one row per intent (a retry is `earlierAttempts` on it), oldest first. Simulated and shadow-mode rows
  are marked; an intent whose bill is gone is counted in `withoutBill`, not listed. Each intent is a row of one month.
- **Not settled** (CP3). Each intent created or sent in the month that is not a row of it, in `settlementOf`'s states,
  with `settled_later` and a BlindPay `refunded` told apart first; never in the totals.
- **Escrow** (CP4). The month's `escrow_funded` and `escrow_refunded`, listed apart; a release that paid is a row.
- **Left out** (CP5). Bills marked paid with no payment, money received, treasury moves, `payment_actuals`, and bookings
  without a payment; the guide says where each is.
- **Amounts** (CP6). Six-place decimal strings, summed in millionths as `BigInt`, per token, never across tokens; route
  fees (`bridge_fee`) are summed, network fees (`fee_usd`) listed per row and never summed.
- **The approval chain** (CP7). The paying entry, the agent's decision before it, `authorizedBy` (`code`, `person`,
  `two_people`), the approvals from `approval_paid.detail.approvals`, an accountant's co-sign joined by bill and person
  to the newest `approval_given` with `cosign: true` before the paying entry, the flags it recorded, a shadow-mode
  verdict, and the address paid with its giver and its confirmation. The paying entry is what let the current attempt
  go, as the settlement track reads it (`stages.authorized.seq`); a person's approval that only reconciled a transfer an
  earlier entry had sent, with no `retriedAfter`, gives way to that entry, by the ledger alone too. People are named by email with their role now
  (`people: "id"` names them by id only); someone gone is a former member.
- **The checks** (CP8). Guardrails, screening, OFAC's address list, the payee lock, the invoice's own address and a
  milestone's verification, each in the evidence chain's words (`EVIDENCE_WORDS`) or "Does not apply", with its entries
  and a warning for bad news. The payee lock is read against the lock in force when it was sent: the newest
  `payee_lock_changed` after the confirmation and before the paying entry, or with none, at or before it was sent (the
  workspace's, read up to the month's end), else the confirmation's; a payment sent under a lock an owner eased is
  stated, with a warning, citing the change. A pull request is named as text, never linked; the pack reads no chain.
- **The transaction** (CP9). Its route and the transaction that paid the payee, as a receipt reads it; explorer links are
  built from the chain profile's `explorerTx` for a hash that is `0x` and 64 hex digits only. A bank payout names its bank
  code and last 4 digits only.
- **The record and the books** (CP10). The newest entry recording the transaction (else the newest naming the bill's
  `tx_ref`), with its server check; the books' `mismatch` and the booking. The pack carries each cited entry once, in
  full, oldest first, and no other.
- **The page** (CP11; `/o/[slug]/evidence/close-pack`, `src/components/ClosePackView.tsx`, a `SUBPAGES` row inside the
  Audit log). `requireMembership` then `inOrg`; `?month=` read once through `closePackMonthFrom`. A member reads it ten
  times at once, then once every 6 seconds (`takeClosePackPageToken`, per instance), since each read checks every cited
  signature. Viewing and printing record nothing. The print drops the shell, the controls, the buttons and the links,
  adds a line only the print shows, and keeps each card on one page where it fits (`break-inside-avoid`).
- **The downloads** (CP12; `GET /api/evidence/close-pack?org=&month=&format=csv|json`). The audit export's gate in its
  order: a cross-site request refused (403), the session (401), a bad format or month before the workspace is looked up
  (400), the membership read afresh (404, as for a workspace that does not exist). JSON by default, last month by
  default. Files are `vestiarion-close-pack-<slug>-<YYYY-MM>[-so-far].csv|json`. The JSON is not signed with the ledger
  key, which signs entries only: its entries and its download's own entry make it checkable. An API key reads the
  JSON from `GET /api/v1/close-packs/{month}` (CP18), members by user id, and records no entry.
- **Each download is recorded** (CP13, CP15). `close_pack_exported` (actor `human`, domain `system`)
  `{ by, month, ended, format, payments, notSettled, sha256, headSeq }`, appended best effort after the file is built
  and before it is sent, with the SHA-256 of the exact bytes served, the CSV's byte-order mark included. It names no one
  by email. It is the brake's count: ten per person per workspace in ten minutes (`CLOSE_PACK_EXPORT_LIMIT`,
  `recentClosePackExportsBy`); the eleventh answers 429 with `retry-after: 600`. Since a download appends its entry only
  once its read is done, downloads sent at once would all count the same earlier ones: once the membership is read and
  before the ledger is counted or the month is read, the route takes a token from a bucket per person per workspace
  (`takeClosePackDownloadToken`, keyed `<userId>:<orgId>`, six within a minute, in any tab, then one a minute, per
  instance), and answers 429 with `retry-after: 60` past it. A failed read answers 500 and records nothing.
- **Who sees it** (CP14). Every member (`workspace.read`), as every evidence page and the hand-off.
- **Limits** (CP15). At most 2,000 payments a month, rows and not settled together; past it the pack is `cut`.
- **Where it opens** (CP16). **Monthly close pack** on the Audit log, beside the audit export; each accountant console
  card's **Close pack:** line, with last month and this month so far.
- **Untrusted text** (CP17). Vendor names, invoice numbers, memos and a vendor's typed PO are shown as text only:
  escaped by React, guarded by `csvCell`, data in the JSON; a memo is cut to 200 characters. No file is opened or
  served: documents are named by their SHA-256.
- **Later surfaces** (CP18). `GET /api/v1/close-packs/{month}` builds on `closePackDocument` in its own change, and the
  Google Sheets export (below) on `closePackTable`; `ClosePackDocument` holds only plain JSON values.
- **No migration** (CP19). Every column read predates `0136` but `invoices.document_pay_to`, which reads as none before
  it, so the pay-to check does not apply.

## Google Sheets: the close pack exported

`docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md`. A workspace connects one Google account, and an
owner, admin or accountant writes a month's close pack into a spreadsheet in that account's Drive. It writes a copy:
it reads nothing back into Vestiarion, decides nothing, pays nothing and calls no model. Migration `0145`.

- **A provider on the connector core** (GS1). `googlesheets`, label "Google Sheets", of a new `ProviderKind`, `export`:
  it brings nothing in. Every `Record<ProviderId, ...>` has its entry; `AccountingProviderId` excludes it and the
  accounting, CRM and work registries return null for it, so no booking, review list or sync path takes it. It reuses
  `accounting_connections` and `accounting_tokens`, `startConnect`, `finishConnect`, `saveConnection`,
  `disconnectConnection`, `freshAccessToken` and `connectionTokenStore`. Its folder, `src/lib/googlesheets/`, holds
  `settings`, `http`, `oauth`, `provider`, `connect-deps`, `ready`, `table` (pure), `sheets`, `store`, `export`, `views`
  (pure, browser-safe) and `panel`; the routes are `src/app/api/integrations/googlesheets/{connect,callback}`, the page
  `/integrations/googlesheets/connect`, the actions `src/app/actions/googlesheets.ts`, the card `GoogleSheetsPanel` and
  the close pack page's control `src/components/close-pack/SheetsExport.tsx`. The page makes that control from the month
  and the workspace and hands it to `ClosePackView` as `sheets`, which keeps it at one place in the tree whether the pack
  was read or not, so a render whose read is refused keeps the export's answer; a done export does not revalidate, since
  that would read the whole pack again inside the action's 120 seconds, and its answer, which carries its month, stands
  in for that month's "Last exported" line until the page is read again. The control is keyed by the month, since a
  month link changes only `?month=` and Next keeps the page's client state across it: another month starts it afresh.
- **Off, then not set up** (GS2). Without `GOOGLE_SHEETS_CLIENT_ID` and `GOOGLE_SHEETS_CLIENT_SECRET`, or with an id
  that is not a Google OAuth client id, there is no card, no export control, both routes answer 404 and the connect page
  is not found. With the client but before `0145`, `googleSheetsReady()` finds no `googlesheets_connector_ready` and
  throws `NotSetUpError`: the card says Google Sheets is not set up, the connect route sends the person back with
  `error=not_set_up`, and the close pack page shows no control.
- **One scope** (GS3). `https://www.googleapis.com/auth/drive.file`, Google's non-sensitive Drive scope: Vestiarion
  reaches only the files it makes. No identity scope: the account is Drive's `about.get` user. The authorize URL asks
  `access_type=offline`, `prompt=consent` and `include_granted_scopes=false`; a grant whose `scope` lacks `drive.file`
  throws `ConnectRefusal("scopes")` before any other call, and nothing is kept.
- **The account** (GS4, GS6). One per workspace, connected by an owner or admin (`integrations.manage`); not
  `exclusive`, so one Google account may serve several workspaces. `external_org_id` is the Drive `permissionId`,
  checked; `external_org_name` is `maskEmail(emailAddress)`, or "A Google account": the full address is stored nowhere.
- **The month's file** (GS7). Each export lists the Drive files tagged
  `appProperties.vestiarionClosePack = "<org id>:<YYYY-MM>"` (the id a UUID, the month passed `closePackMonth`), oldest
  first. None: `files.create` makes a spreadsheet with the name and the tag, and the tag is listed again: an export
  whose own file is listed and is not the oldest trashes its own and takes the oldest; one whose own file is not listed
  yet (Drive's search can lag a create) keeps it, so two racers never trash both files, and the next export takes the
  oldest. Found: the oldest is renamed (so "so far" drops once the month ends); one that answers `gone` is passed over,
  never trashed. The name is "Vestiarion close pack", the workspace, the month (with "so far") and the network's label,
  joined by middle dots and cut to 200 characters. The list does not search shared drives: a file moved into one is
  replaced by a new one in My Drive.
- **The tabs** (GS8, GS9). `formatTabs`, one `batchUpdate`: **Payments** and **Summary** added back if missing or renamed
  (a title differing only by case is taken back), the grid sized to the rows (which drops rows from a longer export),
  the header frozen and bold, the money columns `#,##0.00####`, widths set; any other tab is left alone. The format
  clears no value, so a values write that fails leaves the last export's rows under its own Summary. A file just made,
  or found with only Google's first tab (`sheetId` 0, named neither Payments nor Summary, nothing frozen and not 51
  columns, read from `gridProperties`: a run that made it stopped before its format), has that tab renamed Payments; a
  Payments tab a person renamed after deleting Summary keeps its frozen header or 51 columns, so it is left alone. Values
  go RAW, never `USER_ENTERED`, in `values:batchUpdate` requests of at most 500 rows; every row is 51 cells, and a month
  with no payment also writes row 2 as 51 empty cells with the header and the Summary, so a note there is cleared in
  that request and the read back is the header alone. `sheetValues` writes six columns as
  numbers (`bill_amount`, `amount_paid`, `discount`, `network_fee_usd`, `route_fee_usdc` when they have six places
  and round trip, `earlier_attempts` when it is digits) and every other cell as the table's text, so `=`, `+`, `-` and
  `@` stay text. The Summary is label and value rows from the pack, ending with how to check it.
- **The hash and the read back** (GS10). `paymentsSha256` is the SHA-256 of `JSON.stringify` of the tab as written,
  each row padded with `""` to 51 cells, which Apps Script's `getDataRange().getValues()` reproduces. After writing, the
  tab is read back once (`UNFORMATTED_VALUE`), padded and hashed: equal hash and row count, or the export failed
  `mismatch`.
- **The ledger and the brake** (GS11). Done: `close_pack_exported` with `format: "google_sheets"` and `connectionId`,
  `spreadsheetId`, `created`. Failed once the values write was sent, or on a mismatch: `close_pack_export_failed`
  `{ by, month, ended, format, connectionId, spreadsheetId, stage, reason }`, `stage` `write` or `read_back`; every
  failure from the values write on is recorded (`RECORDED` maps each `GoogleFailure`, `reconnect` and `gone` included),
  since an earlier request of 500 rows may have landed. A failure before any row was sent records nothing. `recentClosePackExportsBy` counts both kinds, so downloads and exports share
  the ten in ten minutes, checked before the pack is read or Google is called. The export action also takes the
  downloads' burst token first (`takeClosePackDownloadToken`, keyed `<userId>:<orgId>`).
- **Calls to Google** (GS12; `http.ts`). Five fixed addresses (`accounts.google.com/o/oauth2/v2/auth`,
  `oauth2.googleapis.com/token` and `/revoke`, `www.googleapis.com/drive/v3`, `sheets.googleapis.com/v4`); any other
  host is refused, with `redirect: "error"`, `cache: "no-store"` and 20 seconds a call. Paths are built from ids that
  match `SPREADSHEET_ID`; `webViewLink` is never read, and the spreadsheet's link is `spreadsheetUrl(id)`. Failures are
  read from Google's short reason code only (`rate_limited`, `unauthorized`, `reconnect`, `forbidden`, `drive_full`,
  `gone`, `unavailable`, `bad_response`), and a log line names the call, the status and that code. At most one retry a
  call: a 401 refreshes the token once; a rate limit of 10 seconds or less is waited out; a 5xx or timeout repeats only
  reads and the values write, never a create, an update or the format. No call starts after 90 seconds; the close pack
  page sets `maxDuration = 120` for its Server Actions.
- **Tokens and reconnecting** (GS13). Google's refresh answer carries no refresh token, so the one sent is kept.
  `invalid_grant`, `unauthorized_client` or `invalid_client`, a 401 that stays after a refresh, or a 403 without the
  Drive permission mark the connection `needs_reconnect` (`markSheetsReconnect`), which the card and the accountant
  console's connector problems show.
- **Disconnecting** (GS14). Google's revoke ends the account's whole grant, so it is sent only when
  `connectedElsewhere("googlesheets", permissionId, orgId)` is false; otherwise the revoke passed does nothing. Either way
  the tokens are deleted, the connection is revoked and `accounting_disconnected` is signed. Spreadsheets stay. The
  answer (revoked, not confirmed by Google, or kept for another workspace) is held by the card, not the Disconnect
  button, which the revalidated page drops in the same render, so it stays beside Connect Google Sheets.
- **Never due** (GS15). `saveConnection` writes `next_sync_after` `EXPORT_NEVER_DUE` (`9999-12-31T00:00:00.000Z`) for a
  provider of kind `export`, so `accounting_connections_due` never hands the sweeper a Sheets connection; `0145` does not
  redefine that function.
- **Who** (GS5, GS18). Exporting is `accounting.book` (owner, admin, accountant); approvers and viewers see the month's
  last export and its link, read from the newest `close_pack_exported` of format `google_sheets` for the month, with no
  button. No Google mark is shown: `PROVIDER_MARKS` excludes `googlesheets`, and the card and the connect page use
  lucide's `FileSpreadsheet`.
- **Migration `0145`.** The provider checks of `accounting_connections` and `accounting_tokens` take `googlesheets`,
  each replaced only while it does not yet (a later widening must keep it); `external_links` is left as it is.
  `googlesheets_connector_ready(p_org_id)` answers true for the tenant role and `service_role`, and is in `TENANT_RPCS`.

## Usage metering

`src/lib/usage/` (U1 to U4). One `usage_events` row (migration `0112`, a tenant table under the two policies, append-only
for the tenant role) per thing a workspace used that costs something: `model_call` (each call `decide()` makes, answered
or not, with the provider's reported tokens and, where the model's price is known, its cost in USD: Claude's list prices
are built in, others come from `AGENT_LLM_PRICES`; `purpose` names what for: payable, milestone, treasury, proposal,
reminder, extraction, chat), `circle_transfer` (a live send or batch in `payments.ts`, with the chain-reported fee, and a
live treasury move), `x402_purchase` (a payee history bought, at its price in USDC), `email` (each Resend attempt whose
message names a `meter`; one sent outside a workspace's scope, after a payee's or a customer's request, is written into
the workspace by `recordUsageFor`) and `connector_sync` (each Xero, QuickBooks, Zoho Books, HubSpot, Pipedrive or Zoho CRM sync that ran). `recordUsage`
writes through the workspace's own tenant client, records nothing outside a scope, and never throws: metering never
stands between a send and its record. A row holds counts, tokens and a cost with its currency; never an address, an
amount paid to someone or what an email said. Attribution and display only: nothing reads it to charge or to stop.

Settings' **Usage this month** (`UsagePanel`, every member) sums the month per kind and purpose, costs exactly
(millionths) per currency and never across them, and lists the limits the product already enforces elsewhere
(`usageLimits`): a sandbox's 20 cycles a day, the agent's spending limit, the payee history checks' daily most and
Gateway balance, 50 invitations a day, and a connector to reconnect. Each says where the workspace stands, what stops
when it is reached, and who acts; a reached one is said at the top of the section and in the accountant console's queue.

## Data ownership

Supabase tables read by the API include `accounts`, `counterparties`,
`compliance_checks`, `invoices`, `milestones`, `treasury_actions`, `forecasts`,
`ledger_entries`, `cycle_runs`, `cycle_snapshots`, and payment telemetry.
Monetary database values are `numeric(20,6)` and are converted to numbers only
at the read boundary. Nullable measurements remain nullable; absence is not
reported as zero.

## Shared visual system

`src/app/globals.css` owns the shared palette, type, spacing, radius, elevation and motion tokens;
`src/components/ui/tokens.ts` mirrors the palette and motion values needed in TypeScript. The bill journey's public
type and fluid page/section spacing are additive: default Tailwind typography, the existing radius values, colour
values and control sizes stay intact for the app, docs and email. `cn.ts` registers the semantic font sizes and spacing
so caller overrides keep working. `Heading` separates semantic heading level from visual size, while `Section` supplies
a fluid gutter and a centred container; blue and ink tones carry `focus-inverse` automatically. `Card` keeps its default
surface elevation and adds an optional flat edge. The primitives add no client boundary. The development-only,
noindex `/design/visual-system` specimen demonstrates composition without payment evidence; production returns 404.
Rules and rollout boundaries are in `docs/design/visual-system.md`; token equality, AA colour pairs, class merging and
server-rendered primitive contracts are tested. The landing uses these primitives for the bill's journey.

The public token pages and sign-in use the server-rendered `src/components/public/PublicMain.tsx` and its scoped CSS
for reading widths, gutters, compact headings, wrapping and 44px touch areas. Checkbox/radio labels provide the large
equivalent target while their visual controls retain the shared primitive's size. These presentation rules do not
change workspace controls. The payee page still sends only `payeeView(status)` to its client journey; action answers,
`answered`/`over`, refresh fallback and heading focus remain owned by that existing journey and its forms. `/signup`
still redirects to the existing sign-in form. `/open` composes `Section` and `Heading` around its unchanged readers and
number formatting, with a single column for figures on narrow phones. `SiteChrome` retains its header height and
public navigation, supplies larger chrome targets and a quiet compact footer, and is shared by the docs shell; docs
MDX, article layout, sidebar, search and page controls stay intact. This phase introduces no client boundary,
dependency, authentication change or migration. Its scope is in
`docs/superpowers/specs/2026-10-20-public-visual-system-design.md`.

Workspace decisions taken from a phone (`docs/superpowers/specs/2026-10-21-decide-from-a-phone-design.md`) use
`Button`'s `touch` size: `sm` from 640px up and md's 44px below it. The approval card's actions, its shadow-mode
verdict (`VerdictControl size="touch"`) and a held milestone's Pay now and Close without paying use it. The card wraps
the whole payee address rather than truncating it. On a phone, Contractors' "Needs you" and "Paid" tiles span both
columns (`StatTile` takes a `className` for its place in the grid), so a total in the millions keeps its own row.

## Social previews

Public links use Next.js file-based metadata routes: `src/app/opengraph-image.tsx`
for Open Graph consumers such as Discord and Slack, and
`src/app/twitter-image.tsx` for X. Both are static, 1200×630 PNGs rendered by the
shared `src/app/_og/SocialPreview.tsx` frame from the committed Geist and
Newsreader font files plus the application's real SVG mark. The renderer reads
no request, tenant, database, Circle, or ledger data. Its palette comes from
`src/components/ui/tokens.ts`, whose values are checked against `globals.css`.

On the production Vercel deployment (`VERCEL_ENV=production`), the root
metadata pins every canonical and image URL to `https://www.vestiarion.xyz`
regardless of `SITE_URL`. Preview and local builds use `SITE_URL` when it is
set, falling back to the same canonical origin when it is absent. Authentication
links retain the separate, stricter `siteOrigin()` policy. The proxy excludes
both metadata image paths and `og/`, so a crawler fetching a preview never
performs a Supabase session refresh.

The pay, payee, receipt and shared report link pages have cards of their own
(`docs/superpowers/specs/2026-10-06-mainnet-polish-design.md` E1), so a link
pasted into a chat does not show the platform's "Arc testnet" card whatever the
link's network. Like the docs images they are served under `og/`, by
`src/app/og/link/[page]/route.ts`: one card per kind of link, rendered at build
time, with the page's badge and words and "Arc" in the footer. They read nothing
of any link, so no token reaches an image's address. Each page points its Open
Graph and X metadata at its card with `linkSocialMetadata` (`src/lib/link-previews.ts`),
which repeats the site-wide fields a page's `openGraph` replaces.

Each docs page has its own image: its title, its summary, and either its
section or, on a reference page, its request line, beside a card of the docs'
sections with its own marked (`src/app/_og/DocsPreview.tsx`, in the same
frame). Next.js allows no `opengraph-image` file after the optional catch-all
`docs/[[...slug]]`, so the images are served by one route handler,
`src/app/og/docs/[[...slug]]/route.ts`, prerendered for every page in the nav,
and the docs pages point at them through `docsSocialMetadata()` in
`src/lib/docs/social.ts`. A summary is cut short enough that it never reaches
the footer, whether the title takes one line or two.

## Verification

Pure contract and payload behavior is covered by `tests/api-contract.test.ts`;
authentication and per-workspace scoping are covered by
`tests/api-key-scope.test.ts`. `npm run verify` runs lockfile consistency,
TypeScript, lint, and the complete Vitest suite. The suite never reaches the
network: `tests/setup.ts` refuses any request to a host other than loopback, so a
stub that leaves a chain read open fails at once rather than waiting on a real
RPC. `npm run build` validates the production route graph. Live API checks use the local app plus a real
workspace API key (created on `/o/<slug>/settings`) and Supabase data.
