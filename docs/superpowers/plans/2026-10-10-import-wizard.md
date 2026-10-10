# Import a bill list Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business imports the bill list it already keeps (its own columns, dates, number format and currency), sees
every row's fate before anything is written, and adds the rows through the `addInvoice` command; the rows that cannot be
added go out as a CSV with the reason and come back fixed.

**Architecture:** Pure, browser-safe modules under `src/lib/bill-import/` read the table, match the columns, read dates
and amounts, and decide each row's fate from facts handed to them (counterparties, possible duplicates, rates). The
browser uses them for the mapping step; the server runs them again for the check and the import, with facts read in the
workspace's scope (`src/lib/bill-import/facts.ts`). The import is a command, `invoice.import`, that calls `addInvoice`
per row. The panel `src/components/intake/BillImport.tsx` replaces `InvoiceCsvImport`.

**Tech Stack:** Next.js 16 server actions, TypeScript, zod, vitest, Supabase (fake client in tests).

**Spec:** `docs/superpowers/specs/2026-10-10-import-wizard-design.md`

## Global Constraints

- No migration. Nothing runs against a remote database.
- Amounts stay decimal strings from the cell to the insert for USDC and EURC; JPY and KRW take no decimals; USDC 6.
- Never offer VND. Outside shadow mode only USDC and EURC are added.
- Nothing is written before the person presses **Add N bills**; the server reads the list again for the check and
  for the import.
- Product copy in plain English; "Arc" for both networks.
- Commits neutral, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Single test files: `npx vitest run tests/<file>`; the gate is `npm run verify`, then `npm run build`.

## Tasks

### Task 1: The table — `src/lib/bill-import/table.ts`
- [ ] Tests `tests/bill-import-table.test.ts`: comma, semicolon and tab lists; quotes with doubled quotes, delimiters
      and line breaks; BOM; blank rows skipped with row numbers kept; an unclosed quote refused; a semicolon list
      whose amounts hold commas.
- [ ] `readTable(text): { delimiter: "," | ";" | "\t"; rows: Array<{ line: number; cells: string[] }> }`.

### Task 2: Columns — `src/lib/bill-import/columns.ts`
- [ ] Tests `tests/bill-import-columns.test.ts`: synonyms per field; the old template maps every column; a column is
      given once; a list without known names has no header; "Why it can't be added" maps to nothing.
- [ ] `IMPORT_FIELDS`, `FIELD_LABELS`, `headerKey`, `detectHeader(cells)`, `detectMapping(headers)`,
      `columnNames(table, hasHeader)`.

### Task 3: Dates — `src/lib/bill-import/dates.ts`
- [ ] Tests `tests/bill-import-dates.test.ts`: every accepted shape; Excel serials; two-digit years; impossible dates;
      the list's order decided, asked, or asked on conflict; 03/03 not ambiguous.
- [ ] `readDate(cell, order): { ok: true; iso } | { ok: false; reason }`, `dateOrderOf(cells): "dmy" | "mdy" | "any" | "ask"`.

### Task 4: Amounts and currencies — `src/lib/bill-import/amounts.ts`
- [ ] Tests `tests/bill-import-amounts.test.ts`: symbols and codes off; decimal mark decided, asked, conflicting;
      thousands by space and apostrophe; JPY whole numbers and `12000.00`; fractional JPY refused; SGD 2 decimals;
      USDC 6 decimals exact (`1,234.567891` → `1234.567891`); negative and bracketed refused; symbol inference only
      when unambiguous.
- [ ] `currencyDigits`, `splitCurrency(cell)`, `decimalMarkOf(cells)`, `readAmount(text, mark, digits)`,
      `symbolCurrencies`, `isCurrencyCode`, `decimalKey`.

### Task 5: Rows and fates — `src/lib/bill-import/rows.ts`
- [ ] Fixture `tests/fixtures/bill-import-100.csv` (100 rows with seeded problems) and
      `tests/bill-import-rows.test.ts`: questions asked; every seeded problem's fate and reason; counts; duplicates in
      the file and against existing invoices; the failed-rows CSV round trip (its rows read back, the extra column
      ignored).
- [ ] `importSettingsSchema`, `questionsFor(table, settings, workspace)`, `readRows(...)`, `fatesOf(rows, facts)`,
      `failedRowsCsv(table, fates)`, `memoWithInvoiceNumber`.

### Task 6: `createInvoice`, `addInvoice` and `shadowBill`
- [ ] Tests: `addInvoice` passes `original` and the import's provenance; the `create_invoice` entry carries
      `via: "import"`, `importFile`, `importRow`, `invoiceNumber`; `shadowBill` with a given mode reads no
      `shadow_modes` row.
- [ ] Extend the three; decision trail says "A person added it, imported from a list."

### Task 7: Facts, the command and the actions
- [ ] `src/lib/bill-import/facts.ts`: counterparties, the invoices that could be duplicates (by counterparty and due
      day range), the shadow mode, the network, the rates.
- [ ] `src/lib/commands/imports.ts` `importInvoices(actor, { text, settings })`, policy `invoice.import`.
- [ ] `src/app/actions/bill-import.ts`: `checkBillImportAction`, `importBillsAction`.
- [ ] Tests `tests/bill-import-action.test.ts` with the fake Supabase: nothing written by the check; the fixture
      imported once, then again with nothing new; shadow rows carry the original figure; a refused role writes nothing.

### Task 8: The panel
- [ ] `src/components/intake/BillImport.tsx`: list, columns, check, done; failed rows download.
- [ ] Replace `InvoiceCsvImport` on AP / AR, the design page and the docs shots; tab **Import a list**.
- [ ] Remove `src/lib/invoice-csv.ts`, `InvoiceCsvImport.tsx`, `importInvoicesAction` and their tests; move what
      they held (the template) to the new tests.

### Task 9: Docs
- [ ] Guide `content/docs/guides/import-bills.mdx`, registered in `nav.ts`, `content.ts` and `tests/docs-guides.test.ts`.
- [ ] first-payment, shadow-mode, try-it (if it names the CSV), README, ARCHITECTURE, self-hosting,
      real-data-rollbacks, changelog (webhook consumers: `create_invoice` with `via: "import"` replaces
      `import_invoice`).

### Task 10: Verify and open the PR
- [ ] `npm run verify`, `npm run build`, the flow in the browser with the dev server if it runs here.
- [ ] Push, open the PR (not merged).
