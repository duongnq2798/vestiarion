# First payment in minutes: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Guide a workspace from an empty book to its first on-chain payment, and show on `/open`
how many workspaces got there and how long it took.

**Architecture:** The checklist stays a pure function of rows the console already reads. The balance
re-read lives in Settings' Go live panel. The new metric is a second service-role definer function
(`open_first_payments`), merged into each side by the reader.

**Tech stack:** Next.js 16 App Router, React 19, Supabase Postgres (PGlite in tests), vitest, zod.

**Spec:** `docs/superpowers/specs/2026-10-01-first-payment-design.md`

## Global constraints

- Copy says "Arc testnet" plainly; no disclaimers about money being unreal.
- The console makes no Circle call and no extra query for the checklist (G1, G2).
- Migrations are idempotent (`create or replace`, `if not exists`); the function is `security definer`,
  `set search_path = ''`, executable by `service_role` only.
- `open_numbers` is not redefined here (the EURC branch's 0040 redefines it).
- Guides quote UI strings exactly (`tests/docs-guides.test.ts`).

## Review focus

- A live workspace with no payment: the checklist must come back, with steps 1–3 ticked.
- A payee whose only address arrived through a payee link (unconfirmed): step 4 stays open and says so.
- A tab left open on Settings with an unfunded wallet: reads stop after 15 minutes, and while hidden.
- A workspace whose first payment is before the period but a later one inside it: not counted.
- A median with no first payments in the period: shown as a dash, not 0 minutes.

---

### Task 1: The checklist

**Files:** `src/lib/getting-started.ts`, `src/components/vx/GettingStarted.tsx`,
`src/app/o/[slug]/console/page.tsx`, `tests/getting-started.test.ts`, `tests/getting-started-ui.test.tsx`.

**Produces:**
```ts
export type GettingStartedStepId = "wallet" | "fund" | "live" | "payee" | "payable" | "payment";
export interface GettingStartedInput {
  mode: "sandbox" | "live";
  accounts: Array<{ kind: string; circle_wallet_id: string | null; balance: number }>;
  counterparties: Array<{ name?: string; role?: string; address: string | null; address_changed_at?: string | null; address_confirmed_at?: string | null; sample?: boolean }>;
  payableCount: number;
  onchainPayments: number;
  waitingCount: number;
}
export function ownPayableCount(invoices: Array<{ counterparty_id: string; direction: string }>, counterparties: Array<{ id: string; sample?: boolean }>): number;
// GettingStarted gains `guide: "go-live" | "first-payment"`.
```

- [ ] Rewrite the tests first: the six titles in order; each done rule; a client and a sample never
  tick the payee step; an unconfirmed address does not tick it, and the body names the payee and says
  to confirm the address; `ownPayableCount` ignores receivables and samples; step 6's path is
  `/approvals` while `waitingCount > 0`, else `/invoices`; `show` stays true for a live workspace
  with no on-chain payment and turns false at the first; the guide switches after step 3; UI: "1 of 6
  done", the first-payment guide link, nothing rendered after the first payment; the console pin.
- [ ] Run: `npx vitest run tests/getting-started.test.ts tests/getting-started-ui.test.tsx`. Expected: FAIL.
- [ ] Implement. Console: `gettingStarted({ mode: access.membership.mode, accounts: accountsRows,
  counterparties, payableCount: ownPayableCount(invoices, counterparties), onchainPayments:
  dashboardStats.onchainTransfers, waitingCount: needsReview })`.
- [ ] Run again. Expected: PASS. Then `npx tsc --noEmit`. Commit.

### Task 2: The balance line reads again while unfunded

**Files:** create `src/lib/funding-watch.ts` and `tests/funding-watch.test.ts`; modify `src/components/GoLivePanel.tsx`.

**Produces:**
```ts
export const FUNDING_WATCH_INTERVAL_MS = 30_000;
export const FUNDING_WATCH_LIMIT_MS = 15 * 60_000;
export function shouldReadBalanceAgain(input: { balance: number | null; openedAt: number; now: number; visible: boolean; pending: boolean; sample: boolean }): boolean;
```

- [ ] Tests: true when unread or 0, visible, not pending, not sample, and `now - openedAt < LIMIT`;
  false for each of: balance > 0, hidden, pending, sample, at the cap.
- [ ] Run: `npx vitest run tests/funding-watch.test.ts`. Expected: FAIL (module missing).
- [ ] Implement, and wire into `BalanceLine`: one `setInterval(FUNDING_WATCH_INTERVAL_MS)` plus a
  `visibilitychange` listener, each dispatching the existing form action when
  `shouldReadBalanceAgain` holds; cleaned up on unmount. Also pin the wiring in a source test.
- [ ] Run again. Expected: PASS. Commit.

### Task 3: `open_first_payments` (migration 0042)

**Files:** create `supabase/migrations/0042_first_payments.sql` and `tests/first-payments-migration.test.ts`;
modify `src/lib/dal/index.ts` (`PLATFORM_RPCS`).

**Produces:** `open_first_payments(p_since timestamptz) returns jsonb`:
`{ sides: { customers|ours|total: { firstPayments: int, medianMinutesToFirstPayment: numeric|null } } }`.
A workspace's first payment is its earliest `payment_intents` row with `provider = 'circle'`,
`provider_mode = 'live'` and `status = 'confirmed'`, timed by `coalesce(executed_at, confirmed_at, updated_at)`.
It counts in the period when that time is `>= p_since`. Minutes are measured from `orgs.created_at`,
floored at 0. The side rule is copied from `open_numbers`.

- [ ] Tests (PGlite): two payments in one workspace count once, timed by the first; simulated and
  failed payments never count; the median across three workspaces; a first payment before
  `p_since` is not counted even with a later one inside; customers vs ours vs total; a period with
  none gives 0 and null; `anon`/`authenticated` cannot execute it; `service_role` can.
- [ ] Run: `npx vitest run tests/first-payments-migration.test.ts`. Expected: FAIL (function missing).
- [ ] Write the migration. Run again. Expected: PASS. Commit.

### Task 4: `/open` and `npm run numbers`

**Files:** `src/lib/platform/open-numbers.ts`, `src/components/open/OpenNumbersTable.tsx`,
`scripts/open-numbers.ts`, `tests/open-numbers.test.ts`, `tests/open-page.test.tsx`.

**Produces:** `SideNumbers` gains `firstPayments: number` and `medianMinutesToFirstPayment: number | null`.
`formatFigure(value: number | null, format: "count" | "usdc" | "duration")`: a duration renders
as `—` for null, then `n min` under an hour, `h h m min` under a day, and `d d h h` after that.

- [ ] Tests: the reader calls both RPCs with the same `p_since` and merges them; one failing RPC fails
  the read (and the memo forgets it); duration formats; the table renders both rows.
- [ ] Run: `npx vitest run tests/open-numbers.test.ts tests/open-page.test.tsx`. Expected: FAIL.
- [ ] Implement. `OPEN_ROWS`: after `payees`, add "Workspaces that made a first payment on Arc testnet"
  (count) and "Median time from workspace opened to first payment" (duration).
- [ ] Run again. Expected: PASS. Commit.

### Task 5: Docs and the checklist screenshot

**Files:** `content/docs/guides/go-live.mdx`, `content/docs/guides/first-payment.mdx`,
`src/app/docs-shots/shots.tsx` (the `go-live-checklist` input), `public/docs/guides/go-live-checklist.png`.

- [ ] Update the checklist paragraph (six steps, shown until the first payment settles) and the
  screenshot's alt text; add the balance line's re-read to step 3 of the go-live guide; point the
  first-payment guide's opening at the checklist.
- [ ] Run: `npx vitest run tests/docs-guides.test.ts tests/docs-screenshots.test.ts`. Expected: PASS.
- [ ] Run `npm run docs:screenshots -- go-live-checklist`, and look at the PNG.
- [ ] `npm run verify`. Expected: PASS. Commit.
