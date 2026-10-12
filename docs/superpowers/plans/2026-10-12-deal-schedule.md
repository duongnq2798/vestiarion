# Plan: deals as collection schedules

Spec: `docs/superpowers/specs/2026-10-12-deal-schedule-design.md`. Branch `feat/deal-schedule`. Test first: each step
starts with a failing vitest file, then the code, then a commit.

1. **Money** (`src/lib/deals/money.ts`, D2, D3). Minor units per currency, parsing a typed amount, decimals back, the
   deal currencies (never VND). Test: `tests/deal-money.test.ts`.
2. **Schedule** (`src/lib/deals/schedule.ts`, D4–D6). `buildSchedule` for the four templates, the remainder on the last
   line, month-end days, terms; `checkLines`; `carryRounding`. Test: `tests/deal-schedule.test.ts` (30/70, three
   milestones, a 12-month retainer on day 31, custom lines that do not add up, JPY and KRW).
3. **Versions and release rules** (`src/lib/deals/revision.ts`, `src/lib/deals/lines.ts`, D7–D10). `proposeCorrection`,
   `planRevision`, `planCancel`, `lineState`, `releaseRefusal`, `dueForRelease`, `dealSummary`. Test:
   `tests/deal-revision.test.ts`, `tests/deal-lines.test.ts` (a price change after one paid line, cancel stops the
   planned lines, nothing released is rewritten).
4. **Migration 0104** (`supabase/migrations/0104_deals.sql`). Tables, RLS, grants, triggers, `create_deal`,
   `revise_deal`; TENANT_TABLES and TENANT_RPCS, PGlite seed, rls and account-deletion lists. Test:
   `tests/deals-migration.test.ts` (re-run, isolation, sums at commit, the line guard, idempotent create, one invoice
   per line).
5. **Domain** (`src/lib/deals.ts`, `src/lib/deals-read.ts`). Create, revise, cancel, reopen, release, the switch, the
   reads, planned lines, the cycle's release; `createInvoice` takes the deal. Test: `tests/deals.test.ts`.
6. **Commands** (`src/lib/commands/deals.ts`, D13). `deal.create`, `deal.change`, `deal.release`,
   `deal.auto_release`. Test: `tests/commands-deals.test.ts`, `tests/commands-gates.test.ts`.
7. **Cash** (D14). `cash-outlook.ts` (planned apart), `cash-scenario-basis.ts`/`cash-scenarios.ts` (coverage),
   `payment-plan.ts`/`payment-plan-input.ts`/`payment-plan-read.ts` (incoming, apart). Tests beside the existing ones.
8. **Cycle**. The recurring stage releases due lines of deals with the switch on.
9. **Actions and UI**. `src/app/actions/deals.ts`; the Deals section and New deal on Bills & receivables; the deal page;
   the deal on each receivable; Treasury and the payment plan. Test: `tests/deals-view.test.tsx`.
10. **Docs**. `content/docs/guides/deals.mdx` (nav, loaders, quotes), cash-scenarios, payment-plan and get-paid guides,
    README, ARCHITECTURE, changelog (new ledger entries reach webhooks).
11. **Verify**. `npm run verify`, `npm run build`, /docs-shots in headless Edge; PR.
