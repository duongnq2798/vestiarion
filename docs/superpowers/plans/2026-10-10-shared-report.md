# A report the business can share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner or admin shares the workspace report by a public, revocable link that hides what they choose; anyone with the link reads a live copy with no session. The report (private and shared) gains a value section that keeps measured, estimated and not-counted figures apart, from an owner's one answer about how bills were handled before.

**Architecture:** Migration 0095 adds `report_shares` (token hash, options, revocation) and `report_baselines` (append-only answers), plus the service role's `report_share_by_token`. `src/lib/report-share-token.ts` makes and hashes links. `src/lib/report-value.ts` and `src/lib/shared-report.ts` are pure: the value groups, and the shared view from the report's facts and the share's options. `src/lib/report-shares.ts` and `src/lib/report-baseline.ts` write and read inside the organization scope, degrading before 0095. `src/lib/platform/shared-report.ts` looks a link up and reads the facts inside that workspace's own scope. Three commands in `src/lib/commands/report.ts`; server actions in `src/app/actions/report-share.ts`. The report page renders the value section, the share control and the live links; `/report/[token]` renders the shared view.

**Tech Stack:** Next.js 16 server components and server actions, TypeScript, vitest, Supabase (fake client in tests), PGlite for the migration.

**Spec:** `docs/superpowers/specs/2026-10-10-shared-report-design.md`

## Global Constraints

- Migration number 0095 only; additive; re-runnable; never run against a remote database.
- Tenant data through `db()` inside the organization scope; commands gate first; actions authorize first.
- Product copy in plain English; "Arc" for both networks; an Arc testnet payment is never the business's bank paying.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.
- Commits neutral, each ending with the Co-Authored-By line.
- Run single files with `npx vitest run tests/<file>`; the gate is `npm run verify`, then `npm run build`.

---

### Task 1: Migration 0095 and the tenant table lists

**Files:** Create `supabase/migrations/0095_report_shares.sql`, `tests/report-share-migration.test.ts`. Modify `src/lib/dal/index.ts` (`TENANT_TABLES`, `PLATFORM_RPCS`), `tests/support/pglite.ts` (`TENANT_TABLES`, `seedOrgRows`), `tests/rls.test.ts`, `tests/account-deletion.test.ts`.

- [ ] Test first: checks on both tables; token hash unique and 64 hex; the tenant may revoke but not change options or the hash, not clear a revocation, not delete; answers append-only; the function returns a live share with the name only when shown and null for a stopped or unknown one; only the service role runs it; tenant isolation; re-runnable.
- [ ] Run: fails. Write the migration, add the tables to the lists and the seed, the deletion keys and the RLS branches.
- [ ] Run the migration test, `rls`, `delete-org-migration`, `lifecycle-migration`, `dal`, `account-deletion`: pass. Commit.

### Task 2: Tokens and the agreement rate

**Files:** Create `src/lib/report-share-token.ts`, `src/lib/verdict-rate.ts`, tests. Modify `src/components/ShadowModeSummary.tsx`, `src/components/vx/WorkspaceReport.tsx` to call `agreementRate`.

- [ ] Tests first; implement; run; commit.

### Task 3: The value groups, pure

**Files:** Create `src/lib/report-value.ts`, `tests/report-value.test.ts`. Modify `src/lib/workspace-report.ts` (count bills stopped as duplicates).

- [ ] Tests first: three groups, no total; estimate only with an answer and only from decided bills; duplicates not counted as saved; on-offer discounts not counted. Implement; run; commit.

### Task 4: The shared view, pure

**Files:** Create `src/lib/shared-report.ts`, `tests/shared-report.test.ts`.

- [ ] Tests first: stable labels, names scrubbed from reasoning, amounts hidden everywhere, memos never, neutral title, sandbox and sample labels, agreement rate equal to the console's, comparison null without actuals and only recorded bills counted, decisions newest first capped at 50. Implement; run; commit.

### Task 5: Shares and answers in the workspace

**Files:** Create `src/lib/report-shares.ts`, `src/lib/report-baseline.ts`, tests.

- [ ] Tests first over the fake client: only the hash stored; the entry with its options; a failed entry revokes the row; the cap of 10; stopping revokes then signs; stopping a stopped link refuses; answers validated, kept, signed; not ready before 0095. Implement; run; commit.

### Task 6: Commands and permission

**Files:** Create `src/lib/commands/report.ts`, `tests/commands-report.test.ts`. Modify `src/lib/auth/roles.ts` (`report.share`), `src/lib/commands/policy.ts`, `src/lib/commands/index.ts`, `tests/roles.test.ts`.

- [ ] Tests first; implement; run `commands-*`, `roles`; commit.

### Task 7: The public read

**Files:** Create `src/lib/platform/shared-report.ts`, `tests/platform-shared-report.test.ts`.

- [ ] Tests first: malformed token never looked up; null and missing function read as no share; a live one is read inside its own workspace's scope and built with its options. Implement; run; commit.

### Task 8: The pages

**Files:** Create `src/app/actions/report-share.ts`, `src/components/ReportShareControl.tsx`, `src/components/ReportBaselineControl.tsx`, `src/components/vx/ReportValue.tsx`, `src/components/vx/SharedReport.tsx`, `src/app/report/[token]/page.tsx`, `tests/shared-report-view.test.tsx`. Modify `src/app/o/[slug]/report/page.tsx`, `src/components/vx/WorkspaceReport.tsx`, `src/lib/link-previews.ts`, `src/lib/analytics/redact.ts` and its test.

- [ ] View test first; implement; run `access-gates`, view tests, link previews; commit.

### Task 9: Docs and verification

**Files:** `content/docs/guides/report.mdx`, `content/docs/guides/shadow-mode.mdx`, `content/docs/guides/try-it.mdx`, `content/docs/changelog.mdx`, `README.md`, `ARCHITECTURE.md`, `docs/superpowers/specs/2026-10-09-workspace-report-design.md`, `tests/docs-guides.test.ts`; docs shots for the shared view.

- [ ] Write the docs; grep for text this makes stale; `npm run verify`; `npm run build`; render the public page with no session (dev server or docs shots and headless Edge). Commit, push, open the PR.
