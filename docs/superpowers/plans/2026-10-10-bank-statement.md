# Plan: what the business paid, from its bank statement

Spec: `docs/superpowers/specs/2026-10-10-bank-statement-design.md`. Branch `feat/bank-statement`. Test first: each step
starts with a failing vitest file, then the code, then a commit.

1. **Table** (`src/lib/bank-statement/table.ts`, B2). `readTable(text, delimiter?)`: delimiter detection, `sep=`, quotes,
   line breaks in quotes, BOM, each record's file line; `findHeaderRow`. Test: `tests/bank-statement-table.test.ts`.
2. **Columns** (`src/lib/bank-statement/columns.ts`, B3). `suggestMapping(headers)` and the mapping type. Test:
   `tests/bank-statement-columns.test.ts`.
3. **Values** (`src/lib/bank-statement/values.ts`, B4). Date orders and their detection; the decimal mark and its
   detection; `readAmount` to minor units, signs, symbols. Test: `tests/bank-statement-values.test.ts`.
4. **Lines and balance** (`src/lib/bank-statement/lines.ts`, B3–B5, B9). `readStatement(text, choices, today)`: the
   questions still open, the lines, the rows not read, the period; `checkBalances(lines)`; `lineKey` with identical lines
   kept apart. Test: `tests/bank-statement-lines.test.ts`.
5. **Matching** (`src/lib/bank-statement/match.ts`, B6–B7). `matchStatement(lines, bills, used)`. Test:
   `tests/bank-statement-match.test.ts`.
6. **Migration 0094** (B9–B10). `supabase/migrations/0094_bank_statement_lines.sql`; TENANT_TABLES (dal and PGlite
   support), `seedOrgRows`, `tests/rls.test.ts` append-only list, `tests/account-deletion.test.ts`. Test:
   `tests/bank-statement-migration.test.ts`.
7. **Domain** (`src/lib/bank-statements.ts`, B8–B9, B11). `readStatementBills`, `readUsedLines`, `previewStatement`,
   `keepStatementLine`; `recordActual` takes source `statement` and the line (detail, `line_used`). Test:
   `tests/bank-statements.test.ts`, additions to `tests/actual-payments.test.ts`.
8. **Command** (`src/lib/commands/statements.ts`, B8). `importBankStatement`, `payable.import_statement` in the policy.
   Test: `tests/commands-statements.test.ts`.
9. **Actions and UI** (B12). `src/app/actions/bank-statement.ts`; `src/components/BankStatementImport.tsx`; the card in
   `ActualsComparison`; the report page reads whether 0094 ran and the accounts named before. Test:
   `tests/bank-statement-import-view.test.tsx`, `tests/actuals-comparison-view.test.tsx`.
10. **Docs**. Guides (report, shadow mode, try it), README, ARCHITECTURE, changelog (ledger detail reaches webhooks),
    `tests/docs-guides.test.ts` quotes; docs-shots for the guide's screenshot.
11. **Verify**. `npm run verify`, `npm run build`, the flow on the dev server or /docs-shots in headless Edge; PR.
