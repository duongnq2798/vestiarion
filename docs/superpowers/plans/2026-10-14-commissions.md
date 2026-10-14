# Commissions on money received: plan

Spec: `docs/superpowers/specs/2026-10-14-commissions-design.md` (C1-C15).

1. **Migration 0118** (`supabase/migrations/0118_commissions.sql`): the four tables, their guards, row-level security and
   grants; `set_commission_plan`, `end_commission_plan`, `record_commissions`, `create_commission_payout`;
   `claim_invoice_decision` with the partner's refusal, and `payment_approvals_not_beneficiary`. PGlite test first
   (`tests/commissions-migration.test.ts`): a part payment, a fee under gross and net, a whole match, a replay and two
   callers (no double accrual), a reversal before and after a payout, the hold window, a payout and its refusals, a
   rejected payable giving its lines back, the partner's approval refused. Seed the tables in
   `tests/support/pglite.ts`; add them to `TENANT_TABLES` and the functions to `TENANT_RPCS`.
2. **Pure model** (`src/lib/commissions/model.ts`): the rate typed, the plan form, the formula in words, each partner's
   review (due now, held, in payables, carried forward), refusals in words. Tests first
   (`tests/commissions-model.test.ts`), the formula held to the SQL's rounding.
3. **Read and write** (`src/lib/commissions/read.ts`, `write.ts`, `record.ts`, `beneficiary.ts`): the page's read, the
   plan and payout writes with their entries, the idempotent recording with its entries, and the partner check for
   Approvals. Not set up before 0118.
4. **Commands** (`src/lib/commands/commissions.ts`): `commission.set_plan`, `commission.end_plan`,
   `commission.create_payable`, `records.write`, console only; the partner refused. Recording after
   `applyReceivedPayment` and `reverseAppliedPayment`.
5. **Cycle and Approvals**: recording in the receipts stage, best effort; `beneficiary_approval` in `approveAndPay`
   and from the claim.
6. **Console**: `/o/[slug]/invoices/commissions` (plans, the plan form, the review), a link under Deals on Receivables,
   nested in Bills & receivables' navigation; server actions in `src/app/actions/commissions.ts`.
7. **End to end** (`tests/commissions-flow.test.ts`): plan, a part payment applied, accrual, past the hold window,
   review, payout, then the AP stage pays the payable the payout created, under the guardrails.
8. **Docs**: guide `content/docs/guides/commissions.mdx` (nav, `tests/docs-guides.test.ts`), `CHANGELOG.md`
   [Unreleased], `ARCHITECTURE.md` section, `content/docs/changelog.mdx` for the new entries.
9. `npm run verify`, then the pull request.
