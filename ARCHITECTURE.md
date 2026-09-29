# Vestiarion architecture

Vestiarion is a Next.js 16 App Router application backed by Supabase. Server
components and route handlers reach tenant data only through the Data Access
Layer (`src/lib/dal`): `db()` scopes every query to the organization in scope,
and ESLint forbids importing the raw service-role client anywhere outside it.
Circle provides Arc testnet payment execution, while simulation modes remain
available for screening and reserve operations.

## Isolation: two lines

One organization's data never reaches another's request, by two independent
mechanisms (spec §5.6):

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
for a compromised or buggy request. `anon` and `authenticated` keep no
privileges, as since `0003`. Row-level security does not constrain
foreign-key checks, so migration `0019` makes every tenant-to-tenant foreign
key composite (`org_id, ...`) and widens `cycle_snapshots`'s unique key to
`(org_id, cycle_run_id)`, so the database itself refuses a link into another
organization's row.

## Workspaces, roles and the cron

A person creates their own workspace at `/onboarding` (`createWorkspaceAction` ->
`createWorkspace`, `src/lib/platform/workspace.ts`, spec §6). The server generates the
organization's id and a fresh Ed25519 ledger key before calling `create_org(p_org_id, p_user_id,
p_name, p_slug, p_ledger_key_enc)` (migration `0020`) — the key's ciphertext is bound to the id, so
the id has to exist first. `create_org` is `service_role`-only (`anon`, `authenticated`, and
`vestiarion_tenant` cannot call it); in one transaction, under an advisory lock keyed to the
caller so two concurrent requests cannot both slip past the limit, it enforces at most 3
organizations per `created_by`, inserts the organization in `sandbox` mode, and makes the caller
its `owner`. `createWorkspace` then seeds two accounts — `Operating (simulated)` at 10,000 USDC and
an empty `Reserve (simulated)` — and appends the first ledger entry, `org_created`, signed with the
new key; a failure at this stage is rolled back (accounts deleted, then the organization row) —
unless its first ledger entry already committed, in which case the chain, and the workspace, stay.

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

**The permission map** (spec §7) lives as data in `src/lib/auth/roles.ts` — `PERMISSIONS` maps each
of `workspace.read`, `agent.pause`, `approval.decide`, `records.write`, `agent.run_cycle`,
`agent.resume`, `members.manage`, `api_keys.manage`, `webhooks.manage`, and `org.administer` to the roles that hold it
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
[Webhooks security](https://www.vestiarion.xyz/docs/webhooks/security#who-sees-what)). The remaining permissions — `workspace.read` (beyond
the leaving case above) and `org.administer` — and `canAssignRole`'s rule that an admin may grant
`approver` or `viewer` but nothing at its own rank or above while only an owner assigns `admin` or
`owner`, are defined in `roles.ts` ahead of the feature that will call `org.administer`.

**Members and invitations** (spec §7, §10 step 5b) go through service-role-only functions in
migration `0021`, each told who is acting and re-deriving that person's role inside its own
transaction — `src/lib/platform/members.ts` wraps them, adds the signed ledger entry, and never
passes an email address into it (`detail.by` and `detail.member` carry user ids only). `owner` may
grant or change any role; `admin` may grant or change only `approver` and `viewer`; no one else may
do either — enforced identically by `can_assign_role` in the database and `canAssignRole` in
`roles.ts`. Inviting (`invite_member`) generates 32 random bytes, base64url-encoded, for the link,
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
otherwise. The members page (`/o/[slug]/members`) lists members and open invitations through
`org_members`, and lets `owner`/`admin` change a role, revoke an invitation, or remove a member; any
member can leave (`remove_member` with `p_actor = p_user_id`), and the `memberships_keep_an_owner`
trigger (`0020`) still refuses to remove or demote a workspace's last owner.

**Abandoned sandboxes** are cleaned up daily. A sandbox organization's `last_active_at` is touched
(at most once an hour) on membership-gated page views; one whose `last_active_at` is more than 60
days old is deleted — `delete_sandbox_org` (migration `0022`) refuses outright if the organization is
not a sandbox, and re-checks `last_active_at` against the cutoff before deleting, so an organization
that became active between the listing and the delete survives. A `live` organization is never
deleted automatically. `POST /api/platform/cleanup`, bearer-guarded the same way as the cron, lists
and deletes candidates; `.github/workflows/sandbox-cleanup.yml` calls it once a day and on manual
dispatch.

**The cron** (`POST /api/agent/tick`) no longer runs one configured business.
`runLiveOrganizations` (`src/lib/agent/cron.ts`) lists every organization in `mode = 'live'` and,
for each, enters its scope with `withOrg` and runs a cycle; one organization's failure is caught,
recorded as that organization's own result, and does not stop the rest (spec §4.4 — the stage
isolation the cycle already had, lifted one level). The endpoint reports
`{ organizations: [{ slug, ok, lines } | { slug, ok: false, error }] }`, `200` when every
organization succeeded and `500` when any failed. Sandbox organizations are never in this list: a
member runs their own cycles from the console instead, capped at `SANDBOX_DAILY_CYCLES` (20) per
organization per UTC day. The cap is enforced inside `begin_cycle_run` (migration 0022), which
opens the `cycle_runs` row under a per-organization lock and counts the day's runs in the same
transaction, so it holds across serverless instances rather than resetting per cold start.

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
approves their own payable. The claim makes a decision exclusive; it is the
payment intent's idempotency key (`paymentIdempotencyKey("invoice", id)` in
`src/lib/payments.ts`) that keeps an invoice from being paid twice. A
`processing` invoice a crashed request never finished can be reclaimed ten
minutes after `reviewed_at`, and a failed update after a claim is logged by
invoice id. All three server actions (`src/app/actions/approvals.ts`)
require `approval.decide`. An invoice whose payment was already sent — its
intent confirmed, pending or submitting, or holding a provider id with an
unread reconcile error — can only be approved: Reject and Return are refused
with `payment_in_flight` before the claim, the card offers only Approve and
pay, and Approve skips its funds check when a transfer already exists, since
it reconciles rather than pays again.

**A payment still in flight is reconciled, not decided again.** An approval
whose transfer is still pending leaves the invoice `matched`, which the AP
stage selects. For a `matched` invoice that already has a payment intent, the
stage skips the model and the guardrails and calls `payInvoice`, which
reconciles the existing intent through its idempotency key and records
`ap_reconcile` with `detail.reconciled: true`; otherwise a guardrail the
person deliberately overrode could hold the invoice over a real transfer.
A reconcile that did not complete — no operating account, a provider that
could not be read, or an error before any result — leaves the invoice
`matched` for the next cycle rather than demoting it. When no transfer
exists yet and one could be resubmitted, the counterparty's risk level is
read again first, and a counterparty now screened high risk is not paid.
The contractor stage does the same for a `verified` milestone whose release is
already in flight. It records `milestone_reconcile` rather than asking the
model again, so a change of mind cannot record a released payment as held.
Only a payment with something to reconcile is reconciled. An intent with no
provider id that was never claimed, or whose submission failed before the
provider returned an id, has no transfer to look up. So its invoice or
milestone is decided again, through the model and the guardrails. If a lost
submission did reach the provider, a resubmission reuses the same idempotency
key.

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
  before each payment, and the treasury stage re-reads it before each
  reserve deposit or withdrawal, holding instead of calling the payment
  provider and marking the ledger entry's detail with
  `heldBecause: "agent_paused"` (`src/lib/agent/pause.ts`).

A person's own decisions in Approvals continue while the agent is paused —
pausing is how the automation is stopped, and an approval is a deliberate
human act, not the agent's own move.

**Ledger actions** `approval_paid`, `approval_rejected`, `approval_returned`,
`agent_paused`, and `agent_resumed` record every decision, pause, and resume,
each carrying the acting person's user id, never an address.

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

**The switch** is the member's own: `memberships.notify_email` (migration
`0026`), on by default. It changes only from the Members page
(`/o/[slug]/members`), which shows it — "Email me when payments need a
decision" — only to a member who holds `approval.decide`; a viewer sees
nothing, because a viewer cannot decide and so receives nothing.
`setNotifyEmailAction` (`src/app/actions/notifications.ts`) is gated on
`workspace.read`, and writes only the row named by the session's own user id
— a `userId` field in the form is never read.

## Read API

The versioned read boundary lives under `src/app/api/v1/`:

```text
status/route.ts                  safe capability and configuration summary
ledger/route.ts                  append-only, ascending audit stream
ledger/verify/route.ts           guarded hash-chain verification
invoices/route.ts                newest-first invoice collection
counterparties/route.ts          newest-first counterparty collection
counterparties/[id]/route.ts     counterparty plus screening history
milestones/route.ts              newest-first milestone collection
treasury/route.ts                balances, obligations, forecast, actions
insights/route.ts                unchanged insights telemetry read model
```

`src/lib/api/contract.ts` owns the success/error envelopes, error codes,
opaque cursors, page-size policy, and `limit + 1` pagination. Every v1 route
passes through `guardApiRequest` (`src/lib/api/guard.ts`) with the `read`
scope: it authenticates the bearer token as a workspace API key
(`src/lib/platform/api-keys.ts`, migration `0027_api_keys.sql`) and, on
success, `handleApiRequest` runs the route inside `withOrg(key.orgId)`, so a
key serves exactly one workspace's data. A missing, malformed, unknown, or
revoked key answers `401 unauthorized`; a key without the route's scope
answers `403 forbidden`. `AGENT_API_TOKEN` does not authenticate this surface
— it remains only the cron secret for `/api/agent/tick`,
`/api/platform/cleanup`, and `/api/agent/reset`. Resource-specific pure
mapping and validation live in `src/lib/api/counterparties.ts`,
`src/lib/api/milestones.ts`, and `src/lib/api/treasury.ts` so null preservation
and chain-hash rules can be tested without a database.

Collections intended for human browsing are newest first and use
`created_at + id` as a stable cursor. The ledger is the exception: its `seq`
is ascending and, within one organization, a correct resume watermark even
though it runs with gaps — continuity is proven by the hash chain, not by
`seq`. The legacy `src/app/api/ledger/verify/route.ts` still serves the Audit
page; it is member-only and takes `?org=<slug>` (see the
[verify reference](https://www.vestiarion.xyz/docs/api/verify-ledger#the-public-key)).

## Webhooks

Where the read API is pulled, webhooks push: a workspace registers its own
HTTPS endpoints (`webhooks.manage`, above) and each new `ledger_entries` row
reaches them without polling. An `after insert` trigger on `ledger_entries`
(migration `0028`) enqueues one `webhook_deliveries` row per active endpoint,
in the same transaction as the append. Enqueueing never fails the append: an
enqueue error raises a warning and the entry is still appended. A dispatcher
(`deliverPendingWebhooks`, `src/lib/webhooks/deliver.ts`) claims due rows and
sends each one HMAC-signed, running right after every scheduled tick and
again on a 10-minute schedule (`POST /api/platform/webhooks`). A
destination's host is resolved once, at connect time, and every address must
pass the same public-only rule as when the endpoint was added; the connection
is pinned to the addresses checked, which closes the DNS-rebinding gap a
separate check would leave. Full detail — the payload, retries, the endpoint
limit, and how to verify both the delivery's signature and the ledger entry's
own — is in the [webhooks docs](https://www.vestiarion.xyz/docs/webhooks).

## Developer docs

The public docs at `/docs` are built in this app with `@next/mdx`. The written
pages are MDX in `content/docs/`; the API reference pages are generated from
the operations in `src/lib/api/openapi.ts`, which also serve
`/api/v1/openapi.json`; `src/lib/docs/markdown.ts` writes each page's `.md`
view, `/llms.txt` and `/llms-full.txt`; and `src/lib/docs/nav.ts` is the one
list of pages. Tests hold the content to the code: every nav page has its MDX,
every link and anchor resolves, the OpenAPI document covers every v1 route, and
the webhook verification snippets run against the signing code. **A PR that
changes `/api/v1` or webhooks adds a changelog entry** to
`content/docs/changelog.mdx`: dated, newest first, saying what changed for an
integrator.

## Data ownership

Supabase tables read by the API include `accounts`, `counterparties`,
`compliance_checks`, `invoices`, `milestones`, `treasury_actions`, `forecasts`,
`ledger_entries`, `cycle_runs`, `cycle_snapshots`, and payment telemetry.
Monetary database values are `numeric(20,6)` and are converted to numbers only
at the read boundary. Nullable measurements remain nullable; absence is not
reported as zero.

## Verification

Pure contract and payload behavior is covered by `tests/api-contract.test.ts`;
authentication and per-workspace scoping are covered by
`tests/api-key-scope.test.ts`. `npm run verify` runs lockfile consistency,
TypeScript, lint, and the complete Vitest suite. `npm run build` validates the
production route graph. Live API checks use the local app plus a real
workspace API key (created on `/o/<slug>/settings`) and Supabase data.
