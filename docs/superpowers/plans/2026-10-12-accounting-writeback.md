# Book payments made on Arc in Xero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A payment made on Arc for a bill brought in from Xero is drafted as a booking, an owner or admin reviews
exactly what will be written to Xero and approves it, and Vestiarion books it against the bill, idempotently, never
into a ledger of another reality.

**Architecture:** Migration 0106 adds `accounting_postings`. `src/lib/connectors/posting.ts` is pure (the reality rule,
the facts, the fingerprint, the words); `booking.ts`-adjacent modules hold the runs with the provider and the store
injected (`booking-run.ts`), the database (`booking-store.ts`) and the review list's read (`bookings-view.ts`).
`src/lib/xero/payments.ts` maps Xero's JSON, `payments-api.ts` calls it. One command, `accounting.book_payments`, under
a new permission `accounting.book`. The UI: `AccountingBookings` on Bills & receivables, a badge and a settlement row on
the card, a step in the evidence chain.

**Spec:** `docs/superpowers/specs/2026-10-12-accounting-writeback-design.md`

## Global Constraints

- Migration 0106 only; additive; re-runnable; never run against a remote database; no Supabase MCP.
- Never call Xero from tests: fixtures and a fake fetch.
- No external call inside a database write; no token in a log, an entry or a response.
- Keep the seam additive (`booking?:` on `AccountingProvider`): the QuickBooks branch renames the Xero components and
  actions, so this work adds new files and touches theirs as little as possible.
- Product copy in plain English; "Arc mainnet" for real money; "Arc testnet" only for the rule that names it; never VND.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.

---

### Task 1: Migration 0106 and the table lists
**Files:** `supabase/migrations/0106_accounting_postings.sql`, `tests/accounting-postings-migration.test.ts`;
`src/lib/dal/index.ts`, `tests/support/pglite.ts`, `tests/rls.test.ts`, `tests/delete-org-migration.test.ts`,
`tests/account-deletion.test.ts`.
- [ ] Test first: isolation; one booking per payable and provider; facts fixed; transitions; the reality check on
  `sending`/`sent`/`confirmed`; `sent` needs a payment id; cascades; a second run.
- [ ] Write the migration; add the table to the lists, the seed and the deletion tests. Commit.

### Task 2: The pure core
**Files:** `src/lib/connectors/posting.ts`, `src/lib/connectors/provider.ts`; `tests/connectors-posting.test.ts`.
- [ ] `bookingReality`, `postingFacts` (USDC→USD, EURC→EUR, shadow original, discount, yen), `postingFingerprint`,
  `billCheck` (closed, already paid, currency, amount due), `paymentMatches`, `idempotencyKey`. Commit.

### Task 3: Xero's payments
**Files:** `src/lib/xero/payments.ts`, `payments-api.ts`, `provider.ts`, `settings.ts`; fixtures; tests.
- [ ] `mapOrganisation`, `mapPayment(s)`, `paymentBody`, `validationMessage`; the calls with a fake fetch (headers,
  `Idempotency-Key`, `where=Reference==`). Scopes gain `accounting.payments`. Commit.

### Task 4: The runs
**Files:** `src/lib/connectors/booking-run.ts`; `tests/connectors-booking-run.test.ts`.
- [ ] `draftPostings` (candidates, organisation read once, refused by the rule, already paid, currency),
  `sendPosting` (every branch of W7 with a fake provider and store), `confirmSent`. Commit.

### Task 5: The store, the command, the action
**Files:** `booking-store.ts`, `bookings-view.ts`, `src/lib/commands/bookings.ts`, `policy.ts`, `roles.ts`,
`src/app/actions/accounting-bookings.ts`, `sweep.ts`; tests with the fake Supabase.
- [ ] The permission and surface; at most 10 lines; stale refused; each line its own outcome; the sync step. Commit.

### Task 6: Where it shows
**Files:** `AccountingBookings.tsx`, `posting-words.ts`, `map.ts`, `types.ts`, `DecisionCard.tsx`,
`SettlementTrack.tsx`, `evidence-chain.ts`, `panel.ts`, `XeroPanel.tsx`, invoices page, docs shots.
- [ ] `bookingFromEntries`; the badge, the settlement row, the evidence step; the review list; the scope prompt. Commit.

### Task 7: Docs
- [ ] `content/docs/guides/xero.mdx` "Book payments in Xero", README, ARCHITECTURE, changelog, privacy, terms; the
  docs-guides test entries; grep for "writes nothing to Xero" and "Nothing is written". Commit.

### Task 8: Verify and open the PR
- [ ] Merge origin/main if it moved; `npm run verify`; `npm run build`; headless Edge render of the review list; push;
  open the PR (not merged).
