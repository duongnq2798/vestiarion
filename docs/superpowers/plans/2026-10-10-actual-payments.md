# Agent vs what really happened Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member records how the business actually paid each payable outside Vestiarion (or that it did not), one by one or from a CSV, and the workspace report compares it, bill by bill, with what the agent decided, each figure linked to its source.

**Architecture:** Migration 0090 adds `payment_actuals`, an append-only tenant table whose corrections chain by `replaces`. `src/lib/actual-payments.ts` records one (validation, the row, the signed entry) and reads them back, degrading when the table is not there yet. `src/lib/actual-payments-csv.ts` parses and matches a CSV (pure). `src/lib/actual-payments-compare.ts` compares the report's facts with the records (pure). Two commands in `src/lib/commands/actuals.ts` gate them on `records.write`; server actions in `src/app/actions/actual-payments.ts` call them. The report page reads the records and renders `ActualsComparison` with its controls.

**Tech Stack:** Next.js 16 server actions and server components, TypeScript, vitest, Supabase (fake client in tests), PGlite for the migration.

**Spec:** `docs/superpowers/specs/2026-10-10-actual-payments-design.md`

## Global Constraints

- Migration number 0090 only; additive; re-runnable; never run against a remote database.
- Tenant data through `db()` inside the organization scope; commands gate first; actions authorize first.
- Product copy in plain English; "Arc" for both networks; never offer or mention VND; no money disclaimers.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.
- Commits neutral, each ending with the Co-Authored-By line.
- Run single files with `npx vitest run tests/<file>`; the gate is `npm run verify`, then `npm run build`.

---

### Task 1: Migration 0090 and the tenant table lists

**Files:** Create `supabase/migrations/0090_payment_actuals.sql`, `tests/actual-payments-migration.test.ts`. Modify `src/lib/dal/index.ts` (`TENANT_TABLES`), `tests/support/pglite.ts` (`TENANT_TABLES`, `seedOrgRows`), `tests/rls.test.ts` (append-only lists).

- [ ] Write the migration test: a paid record needs day, amount, currency and method; a not-paid one a reason and nothing else; one first record per bill; one correction per record; a correction about another bill is refused; another workspace's bill is refused; a tenant sees only its own rows and cannot update or delete them; rows go with their bill and their workspace.
- [ ] Run it: fails (no table).
- [ ] Write the migration; add the table to the tenant lists and the seed.
- [ ] Run the migration test, `tests/rls.test.ts`, `tests/delete-org-migration.test.ts`, `tests/dal.test.ts`: pass.
- [ ] Commit.

### Task 2: The comparison, pure

**Files:** Create `src/lib/actual-payments-compare.ts`, `tests/actual-payments-compare.test.ts`. Modify `src/lib/workspace-report.ts` (export the report's bill scope; `payOn` on a decision), `src/lib/workspace-report-read.ts` (read `payOn`).

- [ ] Tests first: earlier and later days and the median; not recorded; held but paid; paid on Arc but not paid; partial amount; a correction replaces the earlier record (and a not-paid correction of a paid one); different currencies never compared or summed; discount measured for agent and business, on offer estimated; sample and sandbox scope; waits not flagged.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 3: The CSV, pure

**Files:** Create `src/lib/actual-payments-csv.ts`, `tests/actual-payments-csv.test.ts`. Modify `src/lib/invoice-csv.ts` (export the row reader).

- [ ] Tests first: headers, blank currency and method, bad dates and amounts; match by id, by invoice number in the memo as a whole word, ambiguous, unknown; a row for a recorded bill is a correction, or skipped when the same; the template of bills not recorded.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 4: Recording, the commands and the permission

**Files:** Create `src/lib/actual-payments.ts`, `src/lib/commands/actuals.ts`, `tests/actual-payments.test.ts`, `tests/commands-actuals.test.ts`. Modify `src/lib/commands/policy.ts`, `src/lib/commands/index.ts`.

- [ ] Tests first: validation messages; a first record and its entry; a correction names the current record, and one that is not current is refused; the unique-index race reads as "changed a moment before"; the table missing refuses with `not_ready`; a receivable is refused; owner and admin may, approver and viewer may not; the API, Slack and Telegram may not.
- [ ] Run: fail. Implement. Run: pass, with `tests/commands-gates.test.ts`. Commit.

### Task 5: Server actions, the report section, the controls

**Files:** Create `src/app/actions/actual-payments.ts`, `src/components/vx/ActualsComparison.tsx`, `src/components/ActualPaymentControl.tsx`, `src/components/ActualsCsvImport.tsx`, `tests/actuals-comparison-view.test.tsx`. Modify `src/app/o/[slug]/report/page.tsx`.

- [ ] View test first: rows, flags, "Not recorded", links to the audit entries and the explorer, the not-set-up message, no controls for a viewer.
- [ ] Implement; run the view test and `tests/access-gates.test.ts`. Commit.

### Task 6: Digest, docs, verify, build, PR

**Files:** Modify `src/lib/traction-digest.ts` (one line), `content/docs/guides/report.mdx`, `content/docs/guides/shadow-mode.mdx`, `content/docs/changelog.mdx`, `README.md`, `ARCHITECTURE.md`, `tests/docs-guides.test.ts` (quoted strings).

- [ ] Docs, with the quoted labels pinned; grep for text the change makes stale.
- [ ] `npm run verify`; `npm run build`; check the page on the dev server if it can run here.
- [ ] Push, open the PR.
