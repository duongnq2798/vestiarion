# Vestiarion architecture

Vestiarion is a Next.js 16 App Router application backed by Supabase. Server
components and route handlers use the service-role client in
`src/lib/supabase.ts`; client components must never import it. Circle provides
Arc testnet payment execution, while simulation modes remain available for
screening and reserve operations.

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
`created_at + id` as a stable cursor. The ledger is the exception: its
gap-free sequence is ascending so integrations can resume from a watermark.
The legacy `src/app/api/ledger/verify/route.ts` remains unchanged for the Audit
page.

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
