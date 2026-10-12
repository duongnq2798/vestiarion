# Apply money received to invoices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person applies an incoming Arc payment to one or more open receivables, settles a receivable from several
payments, keeps an overpayment as the customer's credit, records a small difference as a fee with a reason, and reverses
an application by appending a correction; the agent suggests each application with why. Bills & receivables can be
searched by more than a name.

**Architecture:** Migration 0103 adds `receivable_allocations`, append-only for the tenant role, with triggers that hold
the invariants (locks, sums, currency, one customer, versions) and settle or reopen the receivable in the same
transaction, and a trigger that keeps a whole match off a payment or receivable already applied. Pure logic in
`src/lib/allocations/` (`model.ts`: amounts, balances, plans, reversals; `suggest.ts`: suggestions) and
`src/lib/invoice-search.ts`. Reads and writes in `src/lib/allocations/book.ts` and `src/lib/allocations/apply.ts`,
degrading before 0103. Two commands in `src/lib/commands/allocations.ts` (`records.write`), server actions in
`src/app/actions/allocations.ts`, UI in `src/components/ApplyPayments.tsx` and `src/components/AllocationLines.tsx`,
wired into Bills & receivables. The cycle's receipts stage skips allocated rows and applies an exact outstanding; the
collections stage asks for what is still owed; the pay page shows it.

**Tech Stack:** Next.js 16 server actions and server components, TypeScript, vitest, Supabase (fake client in tests),
PGlite for the migration.

**Spec:** `docs/superpowers/specs/2026-10-12-allocations-design.md`

## Global Constraints

- Migration number 0103 only; additive; re-runnable; never run against a remote database; no Supabase MCP.
- Tenant data through `db()` inside the organization scope; commands gate first; actions authorize first.
- Product copy in plain English; "Arc" for both networks; never offer or mention VND; no money disclaimers; a bank line
  is never presented as an Arc payment.
- An MDX line with a quote or apostrophe before an issue number fails the ui-consistency test.
- Commits neutral, each ending with the Co-Authored-By line.
- Run single files with `npx vitest run tests/<file>`; the gate is `npm run verify`, then `npm run build`.

---

### Task 1: Migration 0103 and the tenant table lists

**Files:** Create `supabase/migrations/0103_receivable_allocations.sql`, `tests/allocations-migration.test.ts`.
Modify `src/lib/dal/index.ts`, `tests/support/pglite.ts` (list, seed), `tests/rls.test.ts` (append-only lists),
`tests/account-deletion.test.ts` (the `created_by` foreign key).

- [ ] Tests first (PGlite): shape checks; a part payment leaves the receivable open; payments of one transfer across
  three receivables settle all three in one insert; over the payment refused; over the receivable refused; other
  currency refused; other customer refused; closed receivable refused; whole-matched payment and receivable refused;
  fee needs a reason and a payment; reversal mirrors, once only, frees and reopens; a reversal leaving a fee alone
  refused; two people with the same version: one wins (and the unique index alone refuses a duplicate number); a whole
  match refused on an allocated payment or receivable; tenant isolation, append-only; re-runnable.
- [ ] Run: fail. Write the migration; add the table to the lists and the seed. Run the migration test, `rls`,
  `delete-org-migration`, `lifecycle-migration`, `dal`, `account-deletion`: pass. Commit.

### Task 2: The model, pure

**Files:** Create `src/lib/allocations/model.ts`, `tests/allocations-model.test.ts`.

- [ ] Tests first: amounts in millionths; balances (open, part paid, paid, closed; whole match; reversed rows);
  payment state (unapplied, version, customer); `planApplication` (partial; lump sum across three; overpayment leaves
  credit; fee with reason; fee without reason or payment refused; different currencies refused; other customer refused;
  stale version); `planReversal` (frees outstanding; already reversed refused; last payment takes its fees, fees first);
  the exact single match is still `matchTransfer`'s.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 3: Suggestions, pure

**Files:** Create `src/lib/allocations/suggest.ts`, `tests/allocations-suggest.test.ts`.

- [ ] Tests first: reference; exact outstanding from the sender's customer; exact sum of 2 to 4 among the 12 oldest;
  oldest first with credit; short by a fee within 1% and 5.00; unknown sender (one or several of the amount); at most 3;
  the same input in any order gives the same output; bounded time on 40 receivables.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 4: Reads, writes and the commands

**Files:** Create `src/lib/allocations/book.ts`, `src/lib/allocations/apply.ts`, `src/lib/commands/allocations.ts`,
`tests/allocations-apply.test.ts`, `tests/commands-allocations.test.ts`. Modify `src/lib/commands/policy.ts`,
`src/lib/commands/index.ts`.

- [ ] Tests first: `not_ready` before 0103; an application writes rows with the version, sorted by receivable, then one
  signed entry per row; database refusals in plain words; reversal rows; the commands are `records.write`, console only,
  gate first; approver and viewer refused before anything is read.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 5: The cycle, the reminders and the pay page

**Files:** Modify `src/lib/agent/receipts.ts`, `src/lib/agent/collections.ts`, `src/lib/email/receivable-reminder.ts`,
`src/lib/platform/pay-links.ts`, `src/app/pay/[token]/page.tsx`. Tests in `tests/receipts.test.ts`,
`tests/collections-stage.test.ts`, `tests/collections-email.test.ts`, `tests/pay-links.test.ts`.

- [ ] Tests first: the whole match unchanged with no allocations table; an allocated transfer or receivable is left out;
  an exact outstanding is applied with an `ar_payment_applied` entry; reminders use what is still owed and say what
  arrived, and none for a paid one; the pay page asks for what is still owed.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 6: Search, pure

**Files:** Create `src/lib/invoice-search.ts`, `tests/invoice-search.test.ts`.

- [ ] Tests first: id and prefix, invoice number, memo word, PO, counterparty, amount typed two ways, outstanding, a
  payment's transaction hash, Circle id and sender; nothing for an empty query.
- [ ] Run: fail. Implement. Run: pass. Commit.

### Task 7: The UI

**Files:** Create `src/components/ApplyPayments.tsx`, `src/components/AllocationLines.tsx`,
`src/app/actions/allocations.ts`, `tests/allocations-ui.test.tsx`. Modify `src/components/vx/map.ts`,
`src/components/vx/DecisionRows.tsx`, `src/lib/decision-trail.ts`, `src/lib/agent-activity.ts`,
`src/app/o/[slug]/invoices/page.tsx`, `src/app/docs-shots/shots.tsx`, `scripts/docs-screenshots.mjs`.

- [ ] Tests first: the receivable card's paid, part paid and outstanding, and its applied lines; the trail steps; the
  Apply payments list renders suggestions with why, credit, and the not-set-up message; the actions authorize first.
- [ ] Implement; render through /docs-shots in headless Edge; commit.

### Task 8: Docs and verification

**Files:** Create `content/docs/guides/apply-payments.mdx`. Modify `src/lib/docs/nav.ts`, `tests/docs-content.test.ts`,
`tests/docs-guides.test.ts`, `content/docs/guides/first-payment.mdx`, `content/docs/changelog.mdx`, `README.md`,
`ARCHITECTURE.md`.

- [ ] Write the guide and the rest; grep for stale text ("Only a matched transfer", "exact amount").
- [ ] `npm run verify`, `npm run build`. Push, open the PR.
