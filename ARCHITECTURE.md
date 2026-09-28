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
passes through `src/lib/api/guard.ts` with read scope. Resource-specific pure
mapping and validation live in `src/lib/api/counterparties.ts`,
`src/lib/api/milestones.ts`, and `src/lib/api/treasury.ts` so null preservation
and chain-hash rules can be tested without a database.

Collections intended for human browsing are newest first and use
`created_at + id` as a stable cursor. The ledger is the exception: its `seq`
is ascending and, within one organization, a correct resume watermark even
though it runs with gaps — continuity is proven by the hash chain, not by
`seq`. The legacy `src/app/api/ledger/verify/route.ts` still serves the Audit
page; it is member-only and takes `?org=<slug>` (see `docs/api.md`).

## Data ownership

Supabase tables read by the API include `accounts`, `counterparties`,
`compliance_checks`, `invoices`, `milestones`, `treasury_actions`, `forecasts`,
`ledger_entries`, `cycle_runs`, `cycle_snapshots`, and payment telemetry.
Monetary database values are `numeric(20,6)` and are converted to numbers only
at the read boundary. Nullable measurements remain nullable; absence is not
reported as zero.

## Verification

Pure contract and payload behavior is covered by `tests/api-contract.test.ts`.
`npm run verify` runs lockfile consistency, TypeScript, lint, and the complete
Vitest suite. `npm run build` validates the production route graph. Live API
checks use the local app plus a real `AGENT_API_TOKEN` and Supabase data.
