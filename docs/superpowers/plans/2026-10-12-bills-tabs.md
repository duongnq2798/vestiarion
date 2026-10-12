# Plan: Bills & receivables as a summary, three tabs and one New menu

Spec: `docs/superpowers/specs/2026-10-12-bills-tabs-design.md`. Branch `feat/bills-tabs`. Test first: each step starts
with a failing vitest file (pure functions, or `renderToStaticMarkup` for components), then the code, then a commit. No
migration, no server action changed.

1. **The address** (`src/lib/bills-view.ts`, B3, B4, B8, B9). `readBillsQuery`, `resolveBillsView`, `billsHref`,
   `invoiceHref`, `legacyHashHref`, the filters, sorts and `pageOf`. Test: `tests/bills-view.test.ts` (every row of the
   legacy table).
2. **What a row says** (`src/components/vx/bill-next-step.ts`, B6, B15). `billNextStep`, `billBlockers`,
   `collectionState`. Test: `tests/bill-next-step.test.ts`.
3. **Review lists start unticked** (`AccountingBillsReview`, B12). Select all. Test: `tests/accounting-bills-review.test.tsx`.
4. **The pieces** (`src/components/bills/*`, B1, B2, B6–B11, B13). Summary cards, strip, tabs (keyboard pure helper
   `nextTabIndex`), list (chips, search, sort, rows, pages, empty states), detail panel, New ▾, legacy redirect,
   `BillsScreen`. Test: `tests/bills-screen.test.tsx` (tabs' roles and controls, chips' counts and current, the strip only
   when something waits, New ▾'s items and the viewer's sentence, rows' blockers and next actions, mobile markup).
5. **Payment plan** (`src/components/vx/PaymentPlan.tsx`, B14). Summary row, day headings with the balance after, lines
   folded with reasons and Approve inside. Test: `tests/payment-plan-ui.test.tsx` updated.
6. **The page** (`src/app/o/[slug]/invoices/page.tsx`, B5). Reads per tab, rows and details for the page shown,
   `BillsScreen`. Source tests updated to where each fact now lives (decision-rows, control-ui, settlement-track,
   allocations-ui, deals-view, payment-plan-ui).
7. **The app's own links** in the new form: agent activity (toasts, Slack, Telegram), stuck-payment email, Payments in
   flight, evidence chain, Settings' Xero/QuickBooks/HubSpot panels, email inbox's Slack post, a deal's "All deals",
   Scheduled payments' "All bills". Their tests updated.
8. **States for screenshots** (`src/app/docs-shots/bills/[state]/page.tsx`, flag-gated). Empty workspace, dozens of
   bills, a held bill with no PO, plan with a shortfall, receivables overdue, the strip, mobile. Photographed at 1440, 1024
   and 390 into `docs/superpowers/specs/bills-tabs-shots/`.
9. **Docs**. first-payment, try-it, import-bills, payment-plan, apply-payments, deals, hubspot, xero, quickbooks,
   email-invoices, evidence, where-a-payment-is, shadow-mode, workspace, report; README, ARCHITECTURE; docs-guides quotes
   moved to their new files; guide screenshots re-shot with `npm run docs:screenshots`.
10. **Verify**. `npm run verify`, `npm run build`, headless Edge at 1440/1024/390 and 320 (no sideways scroll), keyboard
    pass on the tabs and panels; merge origin/main if it moved; PR, not merged.
