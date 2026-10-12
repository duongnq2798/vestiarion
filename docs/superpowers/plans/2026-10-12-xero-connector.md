# Bring bills in from Xero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace connects one Xero organisation; its approved bills come into a review list on Bills &
receivables, a person adds them through the bill list's check, and an owner picks the Xero account payments will be
booked to. The core under it serves QuickBooks next.

**Architecture:** Migration 0101 adds four tenant tables (`accounting_connections`, `external_links`,
`accounting_bills`, `accounting_sync_cursors`) and one platform table (`accounting_tokens`) with four service-role
functions. `src/lib/connectors/` is the provider-agnostic core (provider interface, token refresh with a lease and a
compare-and-set, backoff, cursors, `planBill`, the review rows, the sync runner, the connect flow).
`src/lib/xero/` is the provider. Two commands add and dismiss bills; server actions and three route handlers drive it;
`XeroPanel` and `XeroBillsReview` show it.

**Spec:** `docs/superpowers/specs/2026-10-12-xero-connector-design.md`

## Global Constraints

- Migration 0101 only; additive; re-runnable; never run against a remote database.
- Tenant data through `db()` in the organization's scope; tokens only through `token-store.ts` and `platformDb()`.
- Commands gate first; actions `authorize` first and work in `inOrg`; routes re-read the session and role.
- No external call inside a database transaction; no token in a log, an entry or a response.
- Product copy in plain English; "Arc" for both networks; never VND; no money disclaimers.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.
- Commits neutral, each ending with the Co-Authored-By line. Single files: `npx vitest run tests/<file>`.

---

### Task 1: Migration 0101 and the table lists
**Files:** `supabase/migrations/0101_accounting_connectors.sql`, `tests/accounting-migration.test.ts`;
`src/lib/dal/index.ts`, `tests/support/pglite.ts`, `tests/rls.test.ts`, `tests/delete-org-migration.test.ts`,
`tests/account-deletion.test.ts`.
- [ ] Test first: tenant isolation of the four tenant tables; `accounting_tokens` closed to the tenant and browser
  roles; one active connection per workspace and provider; links unique both ways; the lease (one holder, expiry),
  the store (holder and version, bumps the version, clears the lease), release; `accounting_connections_due`;
  cascades with the workspace; a second run.
- [ ] Write the migration; add the tables to the lists, the seed and the deletion tests. Run the four suites. Commit.

### Task 2: Core shapes, backoff, status words (pure)
**Files:** `src/lib/connectors/provider.ts`, `backoff.ts`, `status.ts`; tests.
- [ ] `parseRetryAfter`, `failureDelayMs`, `nextAttemptAfter`; `connectionStatus` words for every state. Commit.

### Task 3: Xero mapping (pure) with fixtures
**Files:** `src/lib/xero/map.ts`, `tests/fixtures/xero/*.json`, `tests/xero-map.test.ts`.
- [ ] Bills (statuses, amounts due, dates in both forms, currencies, numbers), contacts (suppliers only), accounts
  (payable ones), paging (`pagination`, short page), connections and the auth event. Commit.

### Task 4: `planBill` and the cursor (pure)
**Files:** `src/lib/connectors/bills.ts`, `cursors.ts`; tests.
- [ ] Version check, window, review/added/dismissed transitions, closed later; checkpoint after a page, the last
  page's move to incremental (backfill start less five minutes), resume. Commit.

### Task 5: Tokens with a serialized refresh
**Files:** `src/lib/connectors/tokens.ts`, `token-store.ts`; tests.
- [ ] Two callers, one refresh; a store after the lease moved is refused; `invalid_grant` → reconnect; fresh token
  returned without a lease; envelopes bound to the row. Commit.

### Task 6: Xero HTTP and OAuth
**Files:** `src/lib/xero/settings.ts`, `http.ts`, `oauth.ts`, `provider.ts`; tests with a fake fetch.
- [ ] Authorize URL and scopes; code exchange and refresh (Basic auth, form body); revoke; connections; 429 with
  `Retry-After`, 401, 403, 5xx as `ProviderError`s; invoices query (where, Statuses, order, page, If-Modified-Since,
  tenant header). Commit.

### Task 7: The sync runner and the sweeper
**Files:** `src/lib/connectors/sync.ts`, `connections.ts`, `links.ts`, `bill-store.ts`; `src/app/api/platform/accounting-sync/route.ts`;
`supabase/cron/watches.sql`, `.github/workflows/accounting-sync.yml`, `tests/supabase-cron.test.ts`.
- [ ] Fake provider and stores: backfill across pages, resume after a 429, a long Retry-After sets the next time,
  401 then refresh, 403 → needs reconnect, a bill paid later, entries for a closed added bill, lease taken → skip.
  Commit.

### Task 8: The connect flow
**Files:** `src/lib/connectors/state.ts`, `consent.ts`, `connect.ts`; routes `api/integrations/xero/{connect,callback,choose}`;
`tests/xero-connect.test.ts`.
- [ ] Start (origin, session, role, consent), callback (state mismatch, expired, another person, non-member, consent
  missing, cancel, one organisation, several → choose), choose (not theirs, expired, picked). Commit.

### Task 9: Review rows and the commands
**Files:** `src/lib/connectors/review.ts`, `src/lib/commands/accounting.ts`, `policy.ts`, `invoices/create.ts`,
`counterparties/create.ts`, `decision-trail.ts`, `evidence-chain.ts`; tests.
- [ ] Fates through `fatesOf` (currency rules, duplicates, new supplier, ambiguous name); add (new counterparty,
  link, `via: "xero"`, marks added), dismiss; gates. Commit.

### Task 10: Actions, pages and components
**Files:** `src/app/actions/xero.ts`, `src/app/integrations/xero/page.tsx`, `connect/page.tsx`,
`src/components/XeroPanel.tsx`, `XeroAccountPicker.tsx`, `XeroBillsReview.tsx`, `XeroConnectForm.tsx`; Settings and
Bills pages; docs shots; render tests.
- [ ] Panel states (not set up, not connected, connected, needs reconnect, error, payment account), review list,
  account preview. Commit.

### Task 11: Docs
- [ ] `content/docs/guides/xero.mdx` (+ nav, docs-guides quotes), import guide, README, ARCHITECTURE, self-hosting,
  `/terms`, `/privacy`, changelog. Commit.

### Task 12: Verify and open the PR
- [ ] `npm run verify`, `npm run build`, docs screenshots in headless Edge; push; open the PR (not merged).
