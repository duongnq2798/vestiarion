# Identity and tenancy — design

**Status:** approved in conversation, section by section, 2026-09-27. Awaiting review of this document.
**Scope:** Tier 0 of the P0 list — authentication, organizations, multi-tenant data isolation, RBAC.
**Follows:** the ledger key-custody work (#2–#7), which made per-tenant signing keys possible.

## 1. Goal

Vestiarion today serves exactly one business, operated by whoever holds `AGENT_API_TOKEN`. There are
no users, no organizations, no roles. The goal of this tier is a product a stranger can use:

> A person who is not the operator signs up, creates a workspace for their business, invites their
> colleagues with appropriate roles, and runs the agent against their own data — without anyone
> editing `.env`, touching Vercel, or being able to see any other business's data.

**Success criteria**

1. A new user reaches a working sandbox workspace through the UI alone.
2. Two organizations exist in production and neither can read or write the other's rows — proven by
   test on a real Postgres, and observed on production through both the UI and the API.
3. The founding organization (today's data, 114+ ledger entries, live on Arc testnet) keeps its full
   history, and its chain verifies byte-for-byte as it did before migration.
4. Every action a person takes is attributable to a user in the ledger, and permitted by their role.
5. Forgetting to scope a query to an organization is a build failure, not a code-review catch.

## 2. What exists today

| Concern | Today |
|---|---|
| Identity | One shared secret, `AGENT_API_TOKEN`, unlocks the UI (cookie) and the API (bearer). |
| Tenancy | `VestiarionConfig` is a value and `runWithConfig` scopes it through `AsyncLocalStorage` (`src/lib/context.ts`) — built for this, never used for more than one business. |
| Data | 12 tables, no tenant column. `ledger_entries.seq` is a global identity column. `sim_clock` is a single row (`id = 1`). |
| Database access | Service-role client everywhere. RLS is enabled with no permissive policies, which works only because the service role bypasses RLS. 8 files under `src/app` call `supabase()` directly; 10 go through query modules. |
| Keys | Ledger signing keys are per-config (key custody #2–#5); Circle credentials and the signing key come from env. |
| Rate limits | `src/lib/rate-limit.ts` keeps buckets in an in-process `Map` — per serverless instance, so not a shared limit. |
| API guard | `src/lib/api/guard.ts` already carries a `scope` parameter that nothing distinguishes yet. |
| Framework | Next.js 16.3: `middleware` is now `proxy.ts` (Node runtime), and the bundled auth guide recommends optimistic checks in proxy with real checks in a Data Access Layer. |

## 3. Decisions

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Isolation model | Shared database, `org_id` on every tenant table, RLS as a second line | Project-per-tenant: physical isolation, but minutes of provisioning per signup is wrong for self-serve |
| D2 | Onboarding | Self-serve signup | Invite-only was simpler; the product needs strangers to be able to try it |
| D3 | Migration strategy | Strangler through the existing scope, in deployable steps | Big-bang: one long branch, nothing measurable on production until the end |
| D4 | Where the org lives in a request | URL path, `/o/[slug]/…` | Cookie: two tabs on two orgs collide, and email links (Tiers 1–2) could not name their org |
| D5 | Ledger topology | One hash chain per organization | One global chain with `org_id`: an organization's audit export would have holes where other tenants' entries sit |
| D6 | Secrets | Per-org Circle credentials and ledger key, encrypted at rest under a platform master key | Platform-held credentials: the platform would custody every tenant's funds |
| D7 | Roles | `owner`, `admin`, `approver`, `viewer`, static permission map in code | Custom roles: no customer has asked; the map can become data later without changing call sites |

## 4. Architecture

### 4.1 Concepts

- **User** — a person, authenticated by Supabase Auth (`auth.users`). Magic link and Google.
- **Organization** — one business: one workspace, one ledger chain, one signing key, one mode
  (`sandbox` or `live`).
- **Membership** — a user's role in one organization.

### 4.2 Request lifecycle

```
request
  └─ proxy.ts                optimistic: session cookie present? if not → /login?next=…
       └─ page / route
            └─ verifySession()          DAL, React cache(); supabase.auth.getUser() — validated, not trusted from cookie
                 └─ resolveOrg(slug)    membership lookup; not a member → notFound() (404, not 403)
                      └─ runWith(contextFor(org, user), …)
                           └─ requirePermission(action)   403 / `forbidden`
                                └─ orgScoped()            the only client pages and modules may use
```

`VestiarionContext` gains `orgId` and `userId`. `currentOrgId()` throws when no scope has been entered.
There is no implicit default organization: an unscoped query touching tenant data is the exact failure
that would put one business's rows on another's screen, so it must be impossible, not merely unusual.

### 4.3 Routing

| Path | Who |
|---|---|
| `/`, `/login`, `/signup`, `/auth/callback` | public |
| `/onboarding` | signed in, may have no organization |
| `/o/[slug]/…` | members of that organization — every current product route moves here (`console`, `invoices`, `counterparties`, `contractors`, `compliance`, `audit`, `insights`), plus a new `settings` for members and invitations (step 5) |
| `/api/v1/…` | bearer token (see 4.5) |
| `/api/agent/tick` | cron secret (see 4.4) |

### 4.4 The agent cycle

`POST /api/agent/tick` stops meaning "run the business" and becomes "run every organization that is
due". It lists `live` organizations and, for each, enters `runWith(contextFor(org))` and runs the
existing cycle. One organization's failure is recorded in that organization's `cycle_runs` row and
does not stop the others — the stage isolation already in the cycle, lifted one level.

Sandbox organizations are not in the cron. Their cycles run when a member presses *Run cycle*,
capped at 20 per organization per UTC day, counted from `cycle_runs` so the cap is shared across
serverless instances. LLM keys stay platform-level in this tier; the cap is what bounds their cost.

`AGENT_API_TOKEN` keeps its name and becomes the platform's cron secret. It no longer unlocks the UI.

### 4.5 The v1 read API, transitional

Until scoped API keys exist (Tier 2), a request to `/api/v1/…` authenticated with `AGENT_API_TOKEN`
reads **the founding organization only**. This is a stated, temporary binding with a known end, not a
tenancy rule: Tier 2 replaces the platform token on this surface with per-organization keys and
removes the binding.

## 5. Data model and migration

### 5.1 New tables

```sql
orgs (
  id                         uuid primary key default gen_random_uuid(),
  slug                       text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  name                       text not null,
  mode                       text not null default 'sandbox' check (mode in ('sandbox', 'live')),
  created_by                 uuid references auth.users(id),
  created_at                 timestamptz not null default now(),
  last_active_at             timestamptz not null default now(),
  ledger_signing_key_enc     jsonb,   -- envelope, see 5.4
  circle_api_key_enc         jsonb,
  circle_entity_secret_enc   jsonb,
  settings                   jsonb not null default '{}'  -- per-business policy now read from env
)

memberships (
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'approver', 'viewer')),
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
)

invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  email        text not null,          -- lowercased; this table is deletable, the ledger is not
  role         text not null check (role in ('owner', 'admin', 'approver', 'viewer')),
  token_hash   text not null unique,   -- sha256 of the emailed token; the token itself is never stored
  invited_by   uuid not null references auth.users(id),
  expires_at   timestamptz not null,   -- created_at + 7 days
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
)
```

`settings` carries what `configFromEnv` reads per business today (follow-up days, rescreen interval,
clock mode). Platform concerns — Supabase, LLM keys, OpenSanctions URL, the master key, the cron
secret — stay in env.

### 5.2 Tenant column

`org_id uuid not null references orgs(id) on delete restrict` on: `accounts`, `counterparties`,
`invoices`, `milestones`, `treasury_actions`, `compliance_checks`, `forecasts`, `ledger_entries`,
`payment_intents`, `cycle_runs`, `cycle_snapshots` — each with an index leading on `org_id`.
`sim_clock` becomes `(org_id primary key, current_day)`.

`invoices` and `milestones` gain `created_by uuid` so Tier 1 can enforce that no one approves what
they created.

Existing unique constraints (`payment_intents.idempotency_key`, `payment_intents (source_type,
source_id)`, `cycle_snapshots.cycle_run_id`) are all over UUIDs, hence globally unique already, and are
unchanged.

### 5.3 Ledger: one chain per organization

`append_ledger_entry` takes `p_org_id`, locks on `pg_advisory_xact_lock(hashtext('vestiarion_ledger:'
|| p_org_id::text))`, reads `prev_hash` from the newest row **of that organization**, and inserts
`org_id`. A hash collision between two organizations' lock keys only serialises two unrelated appends;
it cannot fork a chain.

`seq` stays a global identity column. Within an organization it is monotonic with gaps, which keeps
the v1 cursor a correct watermark (`seq > cursor`). Continuity is proven by the hash links, not by
`seq`; `docs/api.md`'s phrase "gap-free `seq`" is corrected to say so.

`advance_sim_day`, `claim_payment_intent` and `ledger_entries_for_targets` also take `p_org_id` and
filter by it. All RPCs stay `security invoker`, so RLS (5.6) applies inside them too.

### 5.4 Encrypting per-org secrets

AES-256-GCM. Envelope stored as `{"k": "<key id>", "iv": "<b64>", "tag": "<b64>", "ct": "<b64>"}`.
The additional authenticated data is `org_id || ':' || column name`, so a ciphertext copied into
another organization's row, or into another column, fails to decrypt instead of decrypting to the
wrong tenant's secret.

`VESTIARION_MASTER_KEYS` = comma-separated `id:base64(32 bytes)`. The first entry encrypts; every
entry decrypts. Rotation is: prepend a new key, re-encrypt, remove the old one.

Decryption happens only server-side, inside the organization's scope. No endpoint returns a secret.
A secret that fails to decrypt follows #7: reading continues with a warning; signing and transfers fail
loudly.

Every organization gets its own Ed25519 ledger key **when the organization is created** — generated
once, encrypted, stored, and recorded as the first entry of its chain. This is not the on-demand,
unpersisted generation #3 forbids in production; that rule exists because such a key is lost with the
instance. This one is persisted before it signs anything.

### 5.5 Backfill

Migration `0015` creates a **founding organization** (slug `founding`, mode `live`, name
`Vestiarion workspace`) and assigns every existing row to it, then sets `org_id not null`. The
founding chain is unchanged byte for byte, so it verifies exactly as before.

It has no owner at migration time, because no user exists yet. Two platform commands, run once by the
operator:

- `npm run org:grant -- founding <email> owner` — after the operator has signed up.
- `npm run org:adopt-env -- founding` — encrypts `LEDGER_SIGNING_KEY`, `CIRCLE_API_KEY` and
  `CIRCLE_ENTITY_SECRET` from env into the founding row, then verifies that the stored ledger key
  derives key id `9b03458d9a617871`. Only after that verification are the env copies removed from
  Vercel. No organization reads its secrets from env afterwards.

### 5.6 Isolation: two lines

**Line 1 — the Data Access Layer.** `orgScoped()` wraps the client: every `from()` adds
`.eq('org_id', currentOrgId())`, every insert sets `org_id`. ESLint `no-restricted-imports` forbids
importing the raw `supabase()` outside `src/lib/dal/`. The eight direct callers under `src/app` are
migrated to the DAL.

**Line 2 — RLS that actually applies.** Policies on every tenant table:
`using (org_id = (auth.jwt() ->> 'org_id')::uuid)` with the matching `with check`. Because the service
role bypasses RLS, these policies protect nothing unless requests run as a role that does not. So each
request runs as `authenticated` carrying an `org_id` claim, by one of two mechanisms chosen by a spike
that is the first step of the plan:

- **Option A — a short-lived JWT per request**, signed by the server with the project's JWT secret
  (`role: authenticated`, `sub`, `org_id`, 5-minute expiry), passed to supabase-js as the auth token.
  **Chosen if** the spike shows this project's PostgREST accepts such a token and `auth.jwt()` returns
  the claim.
- **Option B — direct Postgres** through the transaction-mode pooler with `pg` (already a production
  dependency), as a dedicated role without `BYPASSRLS`, setting `role authenticated` and
  `request.jwt.claims` with `set local` inside each transaction — which is how Supabase itself feeds
  `auth.jwt()`, so the same policies apply unchanged. **Chosen if** Option A is rejected.

The cron uses the same mechanism per organization. The service role remains only for platform
operations: creating organizations, the commands in 5.5, migrations.

## 6. Authentication and onboarding

- **Sign-in:** Supabase Auth, magic link and Google, sessions in cookies via `@supabase/ssr`.
- **First sign-in with no membership:** `/onboarding` → name the business. The server action
  generates the organization's Ed25519 key and encrypts it (5.4) — key generation belongs in Node,
  not SQL — then calls `create_org(name, slug, ledger_key_enc)`, which in one transaction checks the
  per-user limit, inserts the organization in `sandbox` mode, and makes the caller its `owner`. The
  action then appends the organization's first ledger entry, signed with the new key.
- **Limits, enforced in the database** (shared across serverless instances, unlike the in-process
  limiter): at most 3 *existing* organizations with `created_by` = the user (deleted ones do not count),
  checked inside `create_org()`; at most 20 sandbox cycles per organization per UTC day (4.4). Magic-link send rates are Supabase Auth's own limits.
- **Email delivery:** Supabase's built-in mailer is intended for development and is rate-limited;
  production uses a custom SMTP provider, and the same provider sends Tier 2 notifications. The
  provider is chosen and its limits measured during planning, not assumed here.
- **Abandoned sandboxes:** `last_active_at` is refreshed at most hourly on member activity. A daily job
  deletes `sandbox` organizations inactive for 60 days through `delete_sandbox_org(p_org_id)`, which
  refuses any organization whose mode is not `sandbox`. A `live` organization is never deleted
  automatically.
- **Sandbox runs the simulate provider** and holds no Circle credentials.

Moved to Tier 3 (production/sandbox separation), because they are that item: the go-live flow (entering
Circle credentials, validating them, bootstrapping wallets, the `org_mode_changed` entry) and the
sample-data loader with its exact removal. Tier 0 keeps the `mode` column, sandbox as the default for
new organizations, and the founding organization as `live`.

## 7. Roles and permissions

| Action | owner | admin | approver | viewer |
|---|:-:|:-:|:-:|:-:|
| Read everything, verify the ledger, export audit | ✓ | ✓ | ✓ | ✓ |
| `agent.pause` | ✓ | ✓ | ✓ | |
| `approval.decide` *(Tier 1)* | ✓ | ✓ | ✓ | |
| Counterparties, invoices, milestones, `agent.run_cycle` | ✓ | ✓ | | |
| `agent.resume` | ✓ | ✓ | | |
| Invite / remove / change `approver` and `viewer`; API keys *(Tier 2)* | ✓ | ✓ | | |
| Invite / remove / change `admin` and `owner` | ✓ | | | |
| Go live, Circle credentials, rotate ledger key, delete organization | ✓ | | | |

- Pause and resume are asymmetric on purpose: anyone who can approve money leaving can stop it;
  starting it again is deliberate.
- `approver` cannot create invoices, separating maker from checker from the start.
- **Enforced in the database, not only in code:** every organization keeps at least one `owner` (a
  trigger rejects removing or demoting the last one), and no one grants a role above their own.
- **Invitations:** owner or admin invites by email; the emailed token is stored only as its hash,
  expires in 7 days, and accepting requires signing in with that email address.
- **The ledger records who, never an email address.** Human actions record `detail.by = <user id>`.
  The ledger is signed and immutable; personal data placed in it could never be erased, which would
  make an erasure request impossible to honour. Names are resolved from the user id at render time.
  Membership and role changes are ledger entries.

## 8. Error handling

| Situation | Result |
|---|---|
| Tenant data touched with no organization in scope | `currentOrgId()` throws |
| Not a member of `/o/[slug]` | 404 — the slug's existence is not disclosed |
| Member without the permission | 403 page; `forbidden` in the API |
| Organization secret fails to decrypt | Reading continues with a warning; signing and transfers fail loudly (as #7) |
| One organization fails during the cron | Recorded in its own `cycle_runs`; the others run |
| Session expired mid-action | `/login?next=<the original URL>` |
| `create_org()` over the per-user limit | Refused with a message naming the limit |

## 9. Testing

**Postgres, in process (PGlite — the parity-test infrastructure from #6):**

- *Backfill:* build the schema as it is before `0015`, insert representative rows including a signed
  chain, run `0015`, and assert every row belongs to the founding organization and its chain verifies
  identically to before.
- *Per-organization chains:* interleave appends to two organizations; each chain verifies on its own;
  appends to one never change the other's `prev_hash`.
- *RLS, for real:* recreate Supabase's `auth.jwt()` (it reads `request.jwt.claims`), `set role
  authenticated` with a claim for organization A, and assert that no row of organization B can be
  selected, inserted, updated or deleted — through tables and through every RPC.
- *Database invariants:* the last owner cannot be removed or demoted; a role above the granter's is
  refused; `create_org()` refuses a fourth organization; `delete_sandbox_org()` refuses a live one.

**Unit, in the existing style:** the permission map as a table-driven test with hand-written expected
values; the envelope — round trip, one flipped ciphertext byte rejected by the GCM tag, the wrong
master key, a ciphertext moved to another organization's row rejected by the AAD, decryption under a
non-current key id.

**Build-time:** the ESLint rule against the raw client, proven by a fixture file that must fail lint.

**On production, after each deployable step** (as with #2–#7): the founding organization still reports
`valid: true` with every entry; a second, sandbox organization is created and cannot see the founding
organization's data through the UI or the API.

## 10. Rollout — each step deployable and measured

1. **Spike:** does this Supabase project accept a server-signed JWT (Option A)? Outcome picks A or B.
2. **Auth and registry:** `@supabase/ssr`, `proxy.ts`, `/login`, `/signup`, `/auth/callback`;
   `orgs`, `memberships`, `invitations`; `0015` backfill; `org:grant` and `org:adopt-env`. Product
   routes move under `/o/[slug]`. Only the founding organization exists; the operator signs in as its
   owner. `AGENT_API_TOKEN` stops unlocking the UI; until step 5 enforces the full permission map,
   every mutating control requires the `owner` role — the one rule that is safe with a single user.
3. **The Data Access Layer:** `orgScoped()`, `currentOrgId()`, the lint rule, the eight direct callers
   migrated, per-organization ledger chains, per-organization secrets read from `orgs`. Because
   `currentOrgId()` now throws without a scope, the cron enters the founding organization's scope
   explicitly in this step; step 5 generalises it to every due organization.
4. **RLS:** policies, the mechanism chosen in step 1, the PGlite isolation tests.
5. **Self-serve and roles:** `/onboarding`, `create_org()`, limits, invitations, the permission map
   enforced everywhere, the cron iterating organizations, sandbox cleanup.

Each step lands as its own pull request, with production measured after it deploys.

## 11. Out of scope

- **Tier 1 — control:** approval inbox, agent pause/kill switch *(the permissions are defined here;
  the features are not)*.
- **Tier 2 — integration:** scoped API keys, signed webhooks, notification email.
- **Tier 3 — trust and operations:** audit export, the go-live flow, the sample-data loader.
- **Independent of every tier:** landing-page copy and a professional footer.
- Per-organization LLM keys and GitHub tokens; custom roles; SSO/SAML; billing.

## 12. Risks

| Risk | Handling |
|---|---|
| Option A is rejected by the project's JWT configuration | Option B needs no new dependency; decided by the spike before any RLS work |
| The master key leaks from Vercel env and exposes every tenant's secrets | Accepted for this stage and stated; KMS is the next step, and the envelope's key id makes that migration possible without re-encrypting in place |
| Moving every route under `/o/[slug]` breaks links and bookmarks | The founding organization's old paths redirect to `/o/founding/…` |
| The existing agent-cycle rate limit (`rate-limit.ts`) is per-instance and therefore weak today | Recorded; the new limits are database-backed; replacing the old one is a follow-up, not part of this tier |
| RLS and advisory-lock concurrency are only as strong as their tests | RLS gets real PGlite tests (9); lock concurrency stays verified by reading, since PGlite is single-connection — stated, not claimed |
