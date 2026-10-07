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
`/api/slack/install`, `src/app/actions/github.ts` and `/api/github/install`, for connecting and removing the workspace's Slack and
GitHub — `owner` and `admin` hold it; the
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

**Deleting your account** (spec §6) is the last item of `AccountMenu` (`src/components/vx/AccountMenu.tsx`: the workspace sidebar and the `/onboarding` header), gated by the
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
  - Whether hosted wallets and passkey wallets are offered.
- **Mainnet pays nothing unless a deployment opens it** (phase 2a, below):
  - `orgConfig` carries the network. While Arc mainnet is off, a workspace on it gets no Circle credentials, with the
    reason, so its provider refuses.
  - Go live refuses a Circle key whose prefix names another network.
- **`/open`:** one section per network, Arc mainnet first.
  - `open_numbers`, `open_first_payments` and `open_outcomes` take `(p_since, p_network)` and count one network.
  - Their one-argument versions stay for older code.

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
  - The workspace layout shows `MainnetBanner`.
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
  - Approve and pay, Pay now and Bring cash back refuse before any claim, and the workspace layout draws
    `PaymentsOffBanner` with the recorded reason.
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
`addInvoice` — whose first statement is `gate(actor, "<command>")`:

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
milestones and payee links, run `addMilestone` and `issuePayeeLink`; the
invoice form, the CSV import and the write API's invoices move onto
`addInvoice` next.

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
  `ar_reminder_sent`, each wait `ar_reminder_deferred`.
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
channel is told. Nothing is added by itself: on AP / AR an owner or admin runs
`inbox.add` (the draft used once, put back if the invoice cannot be added;
`create_invoice` names `via: "email"` and `inboxEmailId`), `inbox.finish` (the
invoice form started from what was read, for any email ready, needing details
or unreadable; the entry also lists the fields the person changed) or
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
it comes from, so renaming one in the app means updating the guide. Their step screenshots are the app’s own components rendered with sample data by `/docs-shots/<name>` (`src/app/docs-shots/`), which answers only where `DOCS_SCREENSHOTS=1` is set; `npm run docs:screenshots` photographs them into `public/docs/guides/`, and `tests/docs-screenshots.test.tsx` holds every `<Screenshot>` to an existing PNG with alt text, and every PNG to a guide. **A PR that
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

The pay, payee and receipt link pages have cards of their own
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
