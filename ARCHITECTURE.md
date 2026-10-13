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
then `startShadowMode` in USDC with the creator as actor. A refusal leaves the workspace created and sends the console
`?shadow=not-started`, where it says so until shadow mode is on.

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
`/api/integrations/xero/*`, for connecting and removing the workspace's Slack, GitHub and Xero — `owner` and `admin` hold it; the
limit on deciding payments from Slack takes `org.administer`, an owner's). The remaining permissions — `workspace.read` (beyond
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
dispatch.

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

**Deleting your account** (spec §6) is the last item of `AccountMenu` (`src/components/vx/AccountMenu.tsx`: the workspace sidebar, folded or not, and the `/onboarding` header), gated by the
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
isolation the cycle already had, lifted one level). The endpoint reports
`{ organizations: [{ slug, ok, lines } | { slug, ok: false, error }] }`, `200` when every
organization succeeded and `500` when any failed. Sandbox organizations are never in this list: a
member runs their own cycles from the console instead, capped at `SANDBOX_DAILY_CYCLES` (20) per
organization per UTC day. The cap is enforced inside `begin_cycle_run` (migration 0022), which
opens the `cycle_runs` row under a per-organization lock and counts the day's runs in the same
transaction, so it holds across serverless instances rather than resetting per cold start.

Supabase Cron calls the tick at 17 minutes past every sixth hour (`supabase/cron/watches.sql`), with
the agent's bearer token from Vault, and `.github/workflows/agent-cycle.yml` stays for a manual run.
GitHub's schedule called it until 2026-10-07, 2 to 4 times a day at uneven hours. A daily recurring
payment's invoice is made by the first cycle of its due day (`leadDays` is 0 for it), so a skipped
tick left the day's invoices waiting for the next cycle, or for an event to start one.

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
- **What a first payment is** (`newPayeeCheck`, `src/lib/new-payee.ts`): one to an address that no confirmed
  `payment_intents` row has paid.
- **Who stands behind the address:** read from the counterparty's `compliance` ledger entries, newest first. The
  entry that set the address (`create_counterparty`, `counterparty_address_changed`) names who gave it: a member, or
  the payee for a payee link or GitHub. `counterparty_address_confirmed` entries after it name who confirmed it.
- **Where it applies:** wherever payments are real, meaning the chain provider is live. Real payments follow readable
  Circle credentials, not `orgs.mode`.
- **The agent's side:** the cycle passes the AP and contractor stages the facts (`loadNewPayeeFacts`,
  `src/lib/new-payee-facts.ts`). Code holds a first payment one party alone stands behind as
  `counterparty.new_payee`.
- **A person's side:** Approve and pay, and Pay now on a milestone, refuse the member who gave the address unless they
  are the sole approver.
- **Afterwards:** the follow-up reopens a payable held this way once its address is paid, or two parties stand behind
  it.

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
wallet, a Gateway payout's from the Gateway balance. The Approvals card names the route and its fee.

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

**Trying a limit on past decisions** (`docs/superpowers/specs/2026-10-10-policy-replay-design.md`).
- **What it replays** (`replayDecisions`, `src/lib/policy-replay.ts`, pure): the agent's `ap_*` and `milestone_*`
  decisions in the window, by ledger sequence, twice: under the figures in force (each counterparty's
  `baseline_payment_limit`, `approval_policies`, `agent_budgets`) and with one candidate swapped in. No model is asked.
- **The checks:** the stages of `enforceApGuardrails`, and of the contractor stage for a release, in their order. The
  three figure checks are run again: the payment limit for the risk the decision recorded (`paymentLimitForRisk`), two
  approvals, and the spending limit against running UTC-day and 7-day totals carried from decision to decision, with the
  six days before the window counted as recorded. Every other check is read from the recorded `guardrailRule`: passed
  before it, fired at it, and settled past it only from the facts (no `payout`, a USDC bill, `observed.newPayee`, a
  bill's recorded `onChainLimit`); anything else is can't tell. A bill paid earlier in the replay counts once: a later
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
- **The landing, for a business owner first** (`docs/superpowers/specs/2026-10-11-landing-clarity-design.md`): the hero
  says what Vestiarion is and who it is for, beside two sample bills in the product's own words; then how it works in
  three steps, who it is for (one tab per kind of team, every panel in the HTML), safety and control in plain words,
  the proof, the developers' way in, the questions and the close.
  - One call to action everywhere (`src/components/landing/cta.ts`): `/onboarding?shadow=1`, which opens a workspace
    with shadow mode ticked; the sign-in page says what follows the link when that is where it leads.
  - Each call to action carries `data-cta`; Google Analytics, where it runs, sends `cta_click` with that name and the
    redacted path, nothing else. Activation itself is read from the database (`/admin/growth`).
  - The technical showcase is `/how-it-decides`: the decision receipt replayed in its arch beside the live ledger's
    head, the decision loop step by step, and the claims with the receipts behind them.
  - The questions' answer about Arc mainnet says it is open to anyone only while `MAINNET_ALLOWLIST` holds `*`
    (`mainnetOpenToEveryone`).
  - Nothing above the proof waits for a read (landing stream S1): `LandingPage` is not async. It starts the reads (both
    networks' open numbers, the latest decision, the founding workspace's chain modes, the reserve count) and hands
    them to `Proof` as promises; its latest decision, figures and live legs each stream in behind their own fallback,
    so the hero arrives with the first bytes. A chain-mode read that fails shows the legs as not live, never as live.
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
  - Under it in the proof, the decisions before it (`docs/superpowers/specs/2026-10-11-landing-recent-decisions-design.md`):
    `recent_team_decisions()` (0100), the service role's alone, reads the same workspaces on the same terms (and never
    a simulated payment's decision), one decision per bill (its newest) out of the newest 500, and counts each
    network's decisions in the past 7 days apart.
    Its rows carry no signature and no workspace id. `src/lib/platform/recent-decisions.ts` reads it at most once a
    minute; `recentDecisionView` says what came of each (paid, held, refused by code...) and why, and links a
    transaction only when one went out. The list shows rows strictly older than the latest decision. Until 0100 runs,
    or when the read fails, the latest decision stands alone.
- **The landing's proof** (`docs/superpowers/specs/2026-10-08-landing-proof-design.md`, and landing clarity P1-P3):
  what the proof section says runs live, and the measurements, come from every workspace, never from the founding one
  alone.
  - The live legs (`src/components/landing/provenance.ts`): the USYC reserve is live once any live workspace runs a
    real one (`reserveRunsLive()`, a count over `orgs.usyc_live_at`, never which workspace), and links to the research
    note's section on it. Payments link to the team's latest Arc mainnet payment on the explorer, read from
    `open_numbers`; "Live on Arc mainnet" links to /open's mainnet section.
  - The measurements are the open numbers, all time (`readAllTimeOrNull`): Arc mainnet's panel, then Arc testnet's.
    Under "Customers" every figure is customers' own (workspaces, payments, then their verdicts or their on-time
    share); the team's payments sit on a line of their own under them, with its latest payment on the explorer. No
    total is shown where it could be read as customers'. A network whose numbers cannot be read says so, and the other
    still shows.
- **Motion** (`docs/superpowers/specs/2026-10-08-landing-motion-design.md`): reduced motion removes movement, not every
  change. Under `prefers-reduced-motion: reduce`, `globals.css` keeps transitions for opacity and colours only and cuts
  keyframe animations, except on an element marked `data-calm-motion`; `Reveal` fades without lifting. Each moving
  piece has a designed reduced state. On /how-it-decides, "How a decision becomes an action"
  (`src/components/landing/pipeline/`) lights the step crossing the middle of the viewport and its part of a sticky
  diagram; the server's HTML lights every step. That page's receipt prints as calm motion under reduce, and publishes a beat (`hero/replay-beat.ts`) with the time
  its first line started; `ArchLights` climbs the arch's stones on that clock and rings the keystone in the outcome.
  The open numbers count up once when first seen (`CountUp`); "For developers" types each guide's own snippet (API, SDK,
  MCP, GitHub, `landing/build/snippets.ts`) over a complete copy a screen reader reads.

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
- **A feature a network lacks** refuses by name (`FeatureOffError`: "… does not run on Arc mainnet yet") and never
  falls back to testnet values. This covers CCTP, Gateway, the USYC reserve, the EURC swap and hosted wallets, which
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
    of 50 USDC a day and 150 USDC in 7 days. `changeAgentBudget` keeps a figure there.
  - It also starts with two approvals above 100 USDC (`approval_policies`, phase 2b), which `changeTwoApprovals` keeps
    on there. `org_created` records the starting limits.
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
  - A bridge's approve, and a Gateway connection never made, are not marked.
- **Screening that fails closed:** `orgConfig` marks a live workspace on a deployment with no screening service
  (`compliance.serviceRequired`). `screenName` then gives no verdict rather than the bundled list's, so its
  counterparties stay `unscreened`.

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
  the workspace and section, the agent's last cycle (`AgentActivity`, mounted once at every width so its toasts always
  come) and three chips, network, payments and agent, which open a "Workspace status" panel. The chips combine the
  layout's `PlatformStatus` with the page's `PageStatus`, which only the page can read, inside `inOrg`:
  `chainModes={shellModes()}` and `status={await shellStatus()}` (`src/lib/shell-status.ts`: shadow mode, and the
  workspace's own screening, which read out of scope would be the deployment's). `workspace-status.ts` turns both into
  chips and rows, pure and tested; payments off wins, then held, shadow mode, simulated, live. A fact the layout or the
  page could not read (the switch, the pause, shadow mode) shows as not known, never as its healthy value, since the
  payment gates refuse on the same failure; the agent shows as stopped while payments are off or held.
- **Banners** (Arc mainnet, payments switched off, agent paused) are read by the layout and drawn by each page under its
  header (`FrameBanners`). The loading and error states draw the same header with the layout's facts alone, and the
  same `CONTENT_FRAME` width (`frame.ts`, 90rem).
- Inside a workspace a bar sticks to the top at every width (the phone bar below `lg`, `WorkspaceHeader` from `lg`), so
  `html:has([data-workspace-frame])` sets a `scroll-padding-top` that every anchor lands below.

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
  contractor sends purchase orders, and its answer is stored as `purchase_order_required` with the row.
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
- **Nothing that pays reads it.** No server action, ledger entry or setting: the levers live in component state and
  are gone with the page. Safe to spend today, the treasury's buffer, cash holds and every guardrail still count no
  receivable; `tests/cash-scenarios-ui.test.tsx` fails if a file under `src/lib/agent`, `src/lib/commands`,
  `src/app/actions` or `src/app/api` imports a cash-scenario module.

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

## Why it was paid: the evidence chain

`/o/[slug]/evidence/invoice|milestone/<id>` (spec `2026-10-10-evidence-chain-design.md`) gives every member one page
per payable or contractor milestone: what was agreed, what was delivered, the bill, the payee, the decision, the people,
the payment, the receipt and the signatures. `navItemForPathname` files it under its record's section (Bills &
receivables, or Contractors), and the header's breadcrumb links back there. Every payable's and milestone's card footer
links it (`Decision.chain`, set by `invoiceDecision` and `milestoneDecision`; `src/lib/evidence-paths.ts`), and so
does the decision trail's last line.

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
  person or a payee typed is shown, marked not opened, and never fetched. `intentFacts` and `recordingEntry`
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
  nothing, the ledger included.
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
approves their own payable. The claim makes a decision exclusive; it is the
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
earlier), its priority (`overdue`, `today`, `week`, `later`) and who can act: the members whose role holds
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
`shareCustomerStatement`, `stopCustomerStatement`, `replyToCustomerRequest`, `closeCustomerRequestCommand` — whose
first statement is
`gate(actor, "<command>")`:

- the scope in force must be the actor's workspace, or it throws
  (`ActorScopeError`): a surface that entered one workspace cannot act for
  another's member;
- the role must hold the command's permission (`COMMAND_PERMISSIONS`, drawn from
  the permission map);
- the surface must be one that may run it (`SURFACE_COMMANDS`): the console runs
  everything; Telegram adds invoices and decides nothing; Slack approves, rejects
  or returns a payable, pauses the agent and adds invoices; the API adds records;
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
and filter behind it; **Waiting for review** only when something does (bills from Xero or QuickBooks, payments to book,
invoices by email, HubSpot won deals); then **Bills**, **Payment plan** and **Receivables**.

- **The address holds the view** (`src/lib/bills-view.ts`). `tab`, `filter`, `q`, `sort`, `page`, `open` (a bill's
  detail), `review` (a review list over the page) and `new` are read by `readBillsQuery` and resolved against the
  workspace by `resolveBillsView`; every link on the page is written by `billsHref`. Addresses from before the tabs land
  where they meant: `?history=all`, `?status=…`, `?add`, `?hubspot=…`, `?q=…` on the server, and fragments
  (`#trail-<id>`, `#settlement-<id>`, `#from-xero`, `#deals`, …) by `legacyHashHref` in the page, since a fragment never
  reaches the server. The app's own links use the new form (`invoiceHref`).
- **Only the tab shown is built.** The figures, the strip and the New forms read on every tab, with one
  `ledger_entries_for_targets` call for every invoice as before; the plan (and the chain balance it reads) only on its
  tab; payment intents, shared receipts and pay links only for the 25 rows on the page and an open detail.
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
  (`src/lib/commands/customer-portal.ts`: `customer_portal.share`, `customer_portal.unshare`, `customer_request.reply`,
  `customer_request.close`) need `records.write`, from the console only; a reply and a close are signed
  `customer_request_replied` (with `textSha256`) and `customer_request_closed`. Each entry shows in the invoice's trail.
- **Reminders.** The collections stage reads the open promises and disputes of the receivables it would remind
  (`readReminderPauses`): an open dispute holds an invoice's reminders until it is closed, an open promise through its
  day (`reminderPause`).
- **Before 0109 runs** the lookups answer no link, the reads answer `available: false` (`PGRST205`, `42P01`), the
  commands refuse `not_ready`, the Receivables tab says statements are not set up, and reminders go as before.

## The payment plan

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
on or after the day escalations started in the workspace (`approval_escalation_starts`, 0108: one row per workspace,
set by its first run, insert-only for the tenant role, so a payable already past its day then is never emailed and
turning escalations on sends no backlog), reads the recipients, the workspace and the members before anything is
claimed, claims each in `approval_escalations` (migration 0108: unique per payable and decide-by day, an
`ignoreDuplicates` upsert, so only the rows it inserted are news), and emails the digest's recipients, with the same
switch and cap, deduplicated by member and address, each one message a run about the payables they may act on (`whoCanAct` over every member, as the card names them;
`decisionEscalationEmail`, `src/lib/email/decision-escalation.ts`: names, amounts, statuses and days, escaped; no
address). A payable someone received keeps its claim with `sent_at` and the counts, and the ledger records
`decision_escalated` (`detail: { invoiceIds, decideBy, recipients, failed }`); a payable nobody received has its claim
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
  entry), and one with nothing owed is not reminded (migration 0103). One whose
  customer promised a day on its statement waits through that day, and one it
  disputes waits until a person resolves it (`readReminderPauses`, migration
  0109; see Customer statements).
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
read by the same `readAgentActivity` as the console's toasts, and then moves
the cursor past everything read: a failed send keeps it for the next cycle,
a 403 disconnects the chat, and a message Telegram refuses to parse is sent
once as plain text and then passed.

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
role and the install's limit again (`slackActor`). The cycle's last stage,
`slack` (`src/lib/slack/notify.ts`), posts the agent's decisions after the
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

## Accounting connectors: Xero and QuickBooks Online

A workspace can bring its bills in from Xero (docs/superpowers/specs/2026-10-12-xero-connector-design.md) and from
QuickBooks Online (docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md), either or both. The core,
`src/lib/connectors/`, names no provider: it talks to one through `AccountingProvider` (`provider.ts`: the authorize URL,
the code exchange, the organisations a token reaches, refresh, revoke, and paged reads of bills, contacts and accounts
mapped into `ExternalBill`, `ExternalContact` and `ExternalAccount`), and words each provider's own way through
`PROVIDER_WORDS` (Xero's organisations and suppliers, QuickBooks' companies and vendors). Each provider has its folder
(`src/lib/xero/`, `src/lib/quickbooks/`: settings, HTTP, OAuth calls, the pure mapping from its JSON in `map.ts`, and the
provider object), wired in `src/lib/accounting-providers.ts`, the one place the core meets them. Xero is on only with
`XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` (a Xero "Web app"), QuickBooks only with `QUICKBOOKS_CLIENT_ID` and
`QUICKBOOKS_CLIENT_SECRET` (an Intuit app; `QUICKBOOKS_ENVIRONMENT` picks sandbox or production companies); otherwise its
card and routes are not there. The Settings card (`AccountingPanel`), the review list (`AccountingBillsReview`), the
account picker, the launch and connect pages and the server actions (`src/app/actions/accounting.ts`) are one set, given
the provider.

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
    `src/lib/xero/payments.ts` (pure) and `payments-api.ts`. A provider without it (QuickBooks, for now) never books;
    one that adds it also sets `BOOKS_PAYMENTS` (`booking.ts`) for the account picker's preview.
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

## Connectors: CRM (HubSpot)

A workspace can bring its customers and won deals in from HubSpot
(docs/superpowers/specs/2026-10-12-hubspot-connector-design.md). It runs on the accounting connectors' core, which
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
- **Connecting.** The core's flow (state, nonce cookie, person, role, consent `hubspot-2026-10-13`; `hubspot-2026-10-12`
  said it writes nothing, and a connection keeps the version it agreed to), on
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

## API

The versioned API boundary lives under `src/app/api/v1/`:

```text
status/route.ts                  safe capability and configuration summary
ledger/route.ts                  append-only, ascending audit stream
ledger/verify/route.ts           guarded hash-chain verification
invoices/route.ts                newest-first invoice collection; POST adds one
counterparties/route.ts          newest-first counterparty collection; POST adds one
counterparties/[id]/route.ts     counterparty plus screening history
milestones/route.ts              newest-first milestone collection
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
`/api/platform/cleanup`, and `/api/agent/reset`. Resource-specific pure
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
counted per key (`takeApiWriteToken`, 30 a minute) after the scope check.
`withIdempotency` (`src/lib/api/idempotency.ts`) claims an
`Idempotency-Key` in `api_idempotency`, a platform table only the service role
reaches, after the body validates: the first outcome is kept for 24 hours
and replayed with `Idempotent-Replayed: true`, a different body or a request
still in flight answers `409 conflict`, and a `5xx` releases the claim so a
retry runs again. A claim left without an outcome for 10 minutes
(`IN_FLIGHT_TIMEOUT_MS`, longer than any function runs) is taken over by the
next request with that key.

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
it comes from, so renaming one in the app means updating the guide. Their step screenshots are the app’s own components rendered with sample data by `/docs-shots/<name>` (`src/app/docs-shots/`), which answers only where `DOCS_SCREENSHOTS=1` is set; `npm run docs:screenshots` photographs them into `public/docs/guides/`, and `tests/docs-screenshots.test.tsx` holds every `<Screenshot>` to an existing PNG with alt text, and every PNG to a guide. The nav groups pages by what a reader is doing (`docs/superpowers/specs/2026-10-11-docs-clarity-design.md`): Start here,
Everyday work, Trust and controls, Connect your tools, Developers, then the API reference and webhooks, which the sidebar
folds (`NavSection.folded`) until opened or holding the page being read; pages keep their addresses whatever their group.
MDX pages have `<Callout kind="note|tip|important|warning|real-money">`, whose kind is written beside its title on the
page and in the `.md` view, `<Action href>` for a guide's one next step in the app, and numbered `## 1. …` steps, which
`DocsHeading` draws with a number badge while keeping their ids. A `<Screenshot>` opens larger in a dialog
(`ZoomableImage`). **A PR that
changes `/api/v1` or webhooks adds a changelog entry** to
`content/docs/changelog.mdx`: dated, newest first, saying what changed for an
integrator.

The TypeScript SDK lives in `sdk/` (`@vestiarion/sdk`). It has no dependencies, uses `fetch` and Web Crypto only, and
is type-checked, linted and tested with the app. It is held to the code in three ways:

- `sdk/src/types.ts` is rendered from the OpenAPI document by `npm run sdk:types` (`scripts/lib/sdk-types.ts`).
  `tests/sdk-types.test.ts` fails when the file is stale.
- `tests/sdk-contract.test.ts` runs the SDK against the v1 routes in-process.
- `tests/sdk-webhooks.test.ts` holds its checks to `src/lib/webhooks/sign.ts`, `src/lib/ledger.ts` and the receipt
  verifier.

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

The SDK's version is its own. The product's version is a git tag, `vX.Y.Z` or `vX.Y.Z-beta.N`, published as a GitHub
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

**The founder dashboard** at `/admin/growth` is for people on `platform_team` only. `growthTeamUser()`
(`src/lib/growth/gate.ts`) asks `growth_team_member(p_user)` on every call and fails closed; the page answers anyone
else, signed in or not, with `notFound()`, so it never says it exists, and every action in
`src/app/admin/growth/actions.ts` and the CSV export at `/admin/growth/leads.csv` ask the gate again themselves
(`tests/access-gates.test.ts`, `tests/growth-access.test.ts`). It is in no navigation and no sitemap, and asks not to
be indexed. It shows `open_funnel` per network, the workspaces from `growth_workspaces(p_since)` (customers apart from
ours by `open_funnel`'s rule, with the first decision and the second real bill by `0089`'s definitions, and no email or
person's name), figures with their numerators and denominators ("Not enough data yet" where a denominator is 0),
breakdowns by source, segment and campaign, the leads with their trails, an approval queue, a CSV import that previews
every row and never overwrites a lead, and forms for campaigns, spend and revenue. The calculations live in
`src/lib/growth/metrics.ts` and `csv.ts`, and the page's Definitions section (`src/lib/growth/definitions.ts`) says
where each figure comes from. **It never sends a message to anyone**: approving a lead records a decision, and
Vestiarion never sends outreach. Payment volume is never shown as revenue, and amounts in different currencies are
never added together.

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

## Data ownership

Supabase tables read by the API include `accounts`, `counterparties`,
`compliance_checks`, `invoices`, `milestones`, `treasury_actions`, `forecasts`,
`ledger_entries`, `cycle_runs`, `cycle_snapshots`, and payment telemetry.
Monetary database values are `numeric(20,6)` and are converted to numbers only
at the read boundary. Nullable measurements remain nullable; absence is not
reported as zero.

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
TypeScript, lint, and the complete Vitest suite. `npm run build` validates the
production route graph. Live API checks use the local app plus a real
workspace API key (created on `/o/<slug>/settings`) and Supabase data.
