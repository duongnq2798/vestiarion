# Bring bills in from QuickBooks Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace connects one QuickBooks Online company; its open bills come into the same review list as
Xero's, a person adds them through the bill list's check, an owner picks the bank account payments will be booked to,
and QuickBooks' webhooks bring changes in sooner than the sweeper.

**Architecture:** No migration: 0101's tables take `provider = 'quickbooks'`. `src/lib/quickbooks/` is the provider
(settings, HTTP, OAuth, pure mapping, reads, webhook). The core (`src/lib/connectors/`) gains optional pieces only
where QuickBooks differs: the company named in the callback, one workspace per company, a deleted bill without facts,
a bounded backfill, provider words, a disconnect confirmed at the provider, partly paid bills. The Xero-only cards,
actions and pages become provider-generic.

**Spec:** `docs/superpowers/specs/2026-10-12-quickbooks-connector-design.md`

## Global Constraints

- No migration, no SQL against any remote database, no Supabase MCP, no live call to Intuit from a test.
- Xero's tests stay green; where a Xero component moves, its test follows the move with the same assertions.
- Tenant data through `db()` in the workspace's scope; tokens only through `token-store.ts`.
- No token, body, query or realm record in a log, an entry or a response.
- Product copy in plain English; "Arc" for both networks; never VND; no money disclaimers.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.
- Commits neutral, each ending with the Co-Authored-By line. Single files: `npx vitest run tests/<file>`.

---

### Task 1: Core extensions (pure parts first)
**Files:** `src/lib/connectors/provider.ts`, `status.ts`, `consent.ts`, `bills.ts`, `sync.ts`, `sync-store.ts`,
`review.ts`, `connect.ts`, `connections.ts`; tests `connectors-status`, `connectors-plan`, `connectors-sync`,
`connectors-review`.
- [ ] `PROVIDER_WORDS`; status and consent words per provider (Xero's unchanged).
- [ ] `ExternalBill.factsKnown`; the sync keeps a row's facts for a deleted bill; `billClosed` names the row's supplier.
- [ ] `PageRequest.windowFrom` passed by the runner.
- [ ] Partly paid: `ReviewRowView.total`, added bills whose amount due fell below the invoice's figure.
- [ ] `callbackOrganisationParam`, `exclusive` in `finishConnect`; `disconnectConnection({ atProvider })`. Commit.

### Task 2: QuickBooks mapping (pure) with fixtures
**Files:** `src/lib/quickbooks/map.ts`, `tests/fixtures/quickbooks/*.json`, `tests/quickbooks-map.test.ts`.
- [ ] Bills (open, paid, voided, partly paid, JPY, USD, missing currency), CDC tombstones, vendors, bank accounts,
  tokens, CompanyInfo, Preferences, query pages and counts, Faults. Commit.

### Task 3: QuickBooks HTTP, OAuth, reads, provider
**Files:** `src/lib/quickbooks/settings.ts`, `http.ts`, `oauth.ts`, `api.ts`, `provider.ts`, `connect-deps.ts`,
`src/lib/accounting-providers.ts`; `tests/quickbooks-api.test.ts`.
- [ ] Settings from env; the queries, paging, counts, CDC on an incremental page 1, failures by status; token
  requests, refresh, revoke; base URLs; `minorversion=75`. Commit.

### Task 4: Connect flow and routes
**Files:** `src/app/integrations/quickbooks/{page,connect/page}.tsx`, `src/app/api/integrations/quickbooks/{connect,callback}/route.ts`,
shared `AccountingLaunch`/`AccountingConnect`; `tests/quickbooks-connect.test.ts`.
- [ ] Mirror Xero's callback tests; realm missing or unreadable; company connected to another workspace. Commit.

### Task 5: Webhook
**Files:** `src/lib/quickbooks/webhook.ts`, `src/app/api/integrations/quickbooks/webhook/route.ts`;
`tests/quickbooks-webhook.test.ts`.
- [ ] Signature, array of events, entity filter, unknown realm, backing off, replay, size limit. Commit.

### Task 6: Disconnect URL
**Files:** `src/lib/connectors/disconnected.ts`, `src/app/integrations/quickbooks/disconnected/page.tsx`;
`tests/quickbooks-disconnected.test.ts`.
- [ ] Refused tokens recorded with `atProvider`; working ones untouched; only managed workspaces. Commit.

### Task 7: Generic cards and actions
**Files:** `src/app/actions/accounting.ts` (replaces `xero.ts`), `src/components/AccountingPanel.tsx`,
`AccountingBillsReview.tsx`, `AccountingAccountPicker.tsx` (replace the Xero ones), Settings and Bills & receivables
pages, `src/app/docs-shots/shots.tsx`, `scripts/docs-screenshots.mjs`; `tests/xero-panel.test.tsx` follows,
`tests/quickbooks-panel.test.tsx`.
- [ ] One card per provider; one review list per provider; partly paid lines. Commit.

### Task 8: Sweeper with both providers, trail and evidence words
**Files:** `tests/connectors-sweep.test.ts`, `src/lib/decision-trail.ts`, `src/lib/evidence-chain.ts`; their tests.
- [ ] A due QuickBooks and a due Xero connection both run; "brought in from QuickBooks". Commit.

### Task 9: Docs
**Files:** `content/docs/guides/quickbooks.mdx`, `src/lib/docs/nav.ts`, `content.ts`, `content/docs/guides/xero.mdx`,
`import-bills.mdx`, `content/docs/index.mdx`, `content/docs/changelog.mdx`, `README.md`, `ARCHITECTURE.md`,
`docs/self-hosting.md`, `.env.example`, `src/app/terms/page.tsx`, `src/app/privacy/page.tsx`,
`.github/workflows/accounting-sync.yml`, `supabase/cron/watches.sql` comments; docs and legal tests.
- [ ] Guide quotes held by `tests/docs-guides.test.ts`; screenshots `quickbooks-settings.png`,
  `quickbooks-review.png` from `/docs-shots`. Commit.

### Task 10: Verify and open the PR
- [ ] `git fetch origin`; merge `origin/main` if it moved; `npm run verify`; `npm run build`; push; `gh pr create`.
