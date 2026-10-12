# Bring customers and deals in from HubSpot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace connects one HubSpot account; its companies and deals come in; a won deal becomes a Vestiarion
deal through the New deal form, prefilled; a deal changed in HubSpot afterwards says so on the deal, and a person
saves a new version or keeps it.

**Architecture:** Migration 0105 widens 0101's checks for `hubspot`, adds one workspace per hub and the tenant table
`crm_deals`. The core gains a provider kind, `ConnectingProvider`, `CrmProvider`, a CRM runner, its store, the pure
plan, change and prefill functions, and the review and panel reads. `src/lib/hubspot/` is the provider. Three
commands (`crm.plan_deal`, `crm.keep_change`, `crm.fill_email`); actions, two routes, `HubSpotPanel`,
`HubSpotDeals` and the deal page's callout show it.

**Spec:** `docs/superpowers/specs/2026-10-12-hubspot-connector-design.md`

## Global Constraints

- Migration 0105 only; additive; re-runnable; never run against a remote database; no Supabase MCP; no live call to
  HubSpot from a test.
- Core edits small and additive: Xero's tests stay green; QuickBooks lands on the same core in parallel.
- Tenant data through `db()` in the workspace's scope; tokens only through `token-store.ts`.
- No token, body or email in a log; masked emails in entries.
- Product copy in plain English; "Arc" for both networks; never VND; expected money never shown as cash.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.
- Commits neutral, each ending with the Co-Authored-By line. Single files: `npx vitest run tests/<file>`.

---

### Task 1: Migration 0105 and the table lists
**Files:** `supabase/migrations/0105_crm_connectors.sql`, `tests/crm-migration.test.ts`, `src/lib/dal/index.ts`,
`tests/support/pglite.ts`, `tests/rls.test.ts`, `tests/delete-org-migration.test.ts`.
- [ ] Test first: `hubspot` accepted by the three checks, `company`/`deal` object types; one workspace per hub (Xero
  still shared); `accounting_connections_by_external` for the service role only; `crm_deals` isolated, never deleted
  by the tenant, cascading; a second run. Then the migration and the lists. Commit.

### Task 2: Core kinds and the connect flow
**Files:** `src/lib/connectors/provider.ts`, `consent.ts`, `status.ts`, `connections.ts`, `connect.ts`;
`tests/hubspot-connect.test.ts`, `tests/connectors-status.test.ts`.
- [ ] `hubspot` id, label, kind, consent words; `ConnectingProvider`; `exclusive` and `connectedElsewhere`;
  `ConnectDeps.ready`; CRM words in the status and the connected entry. Callback tests mirroring Xero's, plus a hub
  connected elsewhere. Commit.

### Task 3: HubSpot mapping (pure) with fixtures
**Files:** `src/lib/hubspot/map.ts`, `tests/fixtures/hubspot/*.json`, `tests/hubspot-map.test.ts`.
- [ ] Tokens, introspection, account details, pipelines, a search page (paging, cap, total), associations (primary),
  companies, contacts, a deal (amount, currency, close day by time zone, stage). Commit.

### Task 4: HubSpot HTTP, OAuth, reads and provider
**Files:** `src/lib/hubspot/{settings,http,oauth,api,provider,connect-deps}.ts`, `src/lib/crm-providers.ts`;
`tests/hubspot-api.test.ts`.
- [ ] Settings from env; the token requests, refresh (keeps the refresh token), revoke, introspect; the backfill and
  incremental search bodies; a page with its companies and contacts; linked deals by id; failures and 429 waits. Commit.

### Task 5: The plan, change and prefill functions (pure)
**Files:** `src/lib/connectors/crm.ts`, `crm-prefill.ts`; `tests/crm-plan.test.ts`, `tests/crm-prefill.test.ts`.
- [ ] `planCrmDeal` (version, window), `crmChanges` (amount changed, stage lost, deleted, unchanged, cancelled),
  `dealPrefill` (customer by link, name, new, ambiguous; currencies; amounts; start). Commit.

### Task 6: The CRM runner, its store and the sweeper
**Files:** `src/lib/connectors/crm-sync.ts`, `crm-store.ts`, `sweep.ts`, the sweeper route; `tests/crm-sync.test.ts`,
`tests/connectors-sweep.test.ts`.
- [ ] Pages with checkpoints, the cap, a 429, reconnect; linked deals deleted and restored; changes flagged once;
  hand-typed references linked; the sweeper runs a CRM connection with the CRM runner. Commit.

### Task 7: Commands and actions
**Files:** `src/lib/commands/crm.ts`, `policy.ts`, `index.ts`, `src/lib/deals/write.ts` (an optional source),
`src/lib/counterparties/create.ts`, `src/lib/payment-notices.ts`, `src/app/actions/{hubspot,deals}.ts`;
`tests/commands-crm.test.ts`.
- [ ] Plan (server re-check, forced reference, link, entries), keep, fill email; the permission map. Commit.

### Task 8: Pages and components
**Files:** `src/app/integrations/hubspot/{page,connect/page}.tsx`, `src/app/api/integrations/hubspot/{connect,callback}/route.ts`,
`src/components/{HubSpotPanel,HubSpotDeals,CrmChangeCallout}.tsx`, `DealForm`, `DealChangeForm`, `DealsSection`,
the settings, invoices and deal pages, `/docs-shots`; `tests/hubspot-panel.test.tsx`.
- [ ] The card for every state; the list with its rows; the prefilled forms; render checks. Commit.

### Task 9: Docs and the app config
**Files:** `content/docs/guides/hubspot.mdx`, `src/lib/docs/{nav,content}.ts`, `content/docs/guides/deals.mdx`,
`content/docs/changelog.mdx`, `README.md`, `ARCHITECTURE.md`, `docs/self-hosting.md`, `.env.example`, `/terms`,
`/privacy`, `integrations/hubspot/`; the docs tests.
- [ ] Guide, nav, loaders, the guide test's phrases; legal pages name HubSpot; the CLI upload; grep for stale text.
  `npm run verify`, `npm run build`. Commit, push, PR.
