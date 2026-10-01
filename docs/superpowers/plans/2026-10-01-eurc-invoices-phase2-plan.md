# EURC invoices, phase 2: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** An invoice can be in EURC. The agent checks an EURC payable against the counterparty's
USDC limit at a quoted rate and pays it in EURC from the operating wallet, or holds it with a
named rule. No USDC figure ever includes euros.

**Architecture:** Phase 1 is already on this branch: the quote (`src/lib/fx/quote.ts`), token support
in the providers, and migration 0040. Phase 2 threads `currency` through the following, in order:
1. intake;
2. every USDC total;
3. the payment path (`executePayment` → `payInvoice` → reconcile and approvals);
4. the AP decision (quote, EURC balance, guardrails, ledger detail);
5. the UI;
6. the docs.

**Spec:** `docs/superpowers/specs/2026-10-01-eurc-invoices-design.md` (E1–E7, R1–R4).

## Global constraints

- `Stablecoin = "USDC" | "EURC"` (`src/lib/circle/types.ts`) is the one currency type; invoices use
  the same two values (`invoices_currency_check`, 0040).
- Copy says "Arc testnet" plainly, with no disclaimers. Amounts are written `<n> <currency>`.
- Limits, the treasury buffer, the forecast, "Paid out to date" and the open numbers stay in USDC (R3).
- No new migration: 0040 holds the schema. `open_numbers` in 0040 already counts USDC only.
- The quote's source string is `circle-stablecoin-quote` (E2).
- A sandbox has no EURC balance to check (E7). Its EURC balance is `null`, and nothing holds for it.

## Rulings made while planning (from reading main after A1)

- **P1: timing for an EURC payable uses EURC money.**
  - The operating balance is the EURC balance: live, or treated as covering in a sandbox.
  - The reserve is not counted (`reserveApy` 0, `reserveBalance` 0), because the reserve is USDC.
  - Obligations are the other open EURC payables only.

  Cost if wrong: an EURC payable is never scheduled to earn USDC yield, which it cannot earn anyway.
- **P2: a duplicate is the same bill in the same currency.** `findDuplicates` is given only the
  same-currency history. Cost if wrong: an EURC and a USDC invoice with the same PO are not linked.
- **P3: the guardrails see the USDC value.**
  - `enforceApGuardrails` gets `amount` = the USDC value for the limit rule.
  - Two new rules, both applied to `pay` and `schedule`:
    - `fx.rate_unavailable`: no quote;
    - `treasury.insufficient_eurc`: live, and the EURC balance is below what would be sent.
  - The model still decides first, and the rules apply after it (E4, E5).
- **P4: no API write path exists.** `/api/v1` only reads invoices, and `currency` is already in its
  response. The changelog says that `currency` can now be `EURC`, and names the ledger detail's
  new fields.

## Review focus

- An EURC payable that has no quote: held with `fx.rate_unavailable`, never paid, even when the model
  says pay.
- A live EURC payable above the EURC balance but well inside the USDC balance: held with
  `treasury.insufficient_eurc`, never paid in USDC.
- A USDC payable in a book that also holds large EURC payables: its shortfall, the treasury buffer
  and the forecast count none of the EURC.
- A person approving an EURC payable: the funds check reads EURC (in live), the transfer carries
  `token: "EURC"`, and the summary says EURC.
- A reconcile of an in-flight EURC payment: it re-sends nothing, and when it does submit, it
  submits EURC.

---

### Task 1: Currency at intake (form and CSV)

**Files:**
- `src/lib/intake-validation.ts`
- `src/app/actions/intake.ts`
- `src/components/intake/InvoiceIntake.tsx` (plus its CSV template text)
- tests: `tests/intake*.test.ts*`

**Produces:**
- `invoiceInputSchema.currency` and `csvInvoiceInputSchema.currency`: `"USDC" | "EURC"`, default
  `"USDC"`. The CSV is case-insensitive, and a blank cell means USDC.
- The amount message no longer says USDC: "Use a positive amount with at most 6 decimal places".

- [ ] Tests:
  - the form and the CSV accept `EURC`, default to USDC, and refuse `EUR`/`GBP` with a clear message;
  - the insert carries `currency`;
  - the form renders a Currency select (USDC, EURC);
  - a CSV with no `currency` column still imports.
- [ ] RED, implement, GREEN, then commit.

### Task 2: USDC totals stay USDC

**Files:**
- `src/lib/agent/obligations.ts`: `PayableObligation.currency?`; `summarizePayableObligations` skips non-USDC rows.
- `src/lib/agent/orchestrator.ts`:
  - the treasury stage's open invoices select gains `currency`;
  - the forecast receivables are filtered to `currency = 'USDC'`;
  - `PayableBookRow.currency` and `obligationsDueBy(..., { currency })` count only rows in that currency.
- `src/lib/queries.ts`: `stats()` sums `totalPaidOut` over USDC invoices and milestones only. Milestones are always USDC. `onchainTransfers` counts every on-chain transfer.
- tests: `tests/obligations*.test.ts`, `tests/orchestrator*.test.ts`, `tests/queries*.test.ts`.

- [ ] Tests:
  - an EURC row is out of the buffer, out of `obligationsDueBy` for a USDC invoice, and in it for an EURC invoice;
  - the forecast's inflow ignores EURC receivables;
  - `totalPaidOut` ignores an EURC paid invoice, and `onchainTransfers` counts it.
- [ ] RED, implement, GREEN, then commit.

### Task 3: The payment carries its token

**Files:**
- `src/lib/payments.ts`:
  - `PaymentRequest.token?: Stablecoin`, default USDC;
  - `ensure` writes `token`;
  - `transfer({... token})`.
- `src/lib/agent/pay.ts`:
  - `PayInvoiceInput.currency?: Stablecoin`;
  - `executePayment({ ..., token })`;
  - `syncOperatingBalance` only after a USDC payment.
- `src/lib/agent/orchestrator.ts`: the reconcile path passes the invoice's currency.
- `src/lib/agent/approvals.ts`:
  - load `currency`;
  - the funds check: for USDC as today; for EURC, `getTokenBalance(op, "EURC")` in live, skipped in a sandbox;
  - the error is "The operating wallet holds <b> EURC, less than this invoice.";
  - `payInvoice` gets `currency`;
  - `approvalPaidSummary` writes the currency;
  - `WaitingPayable.currency`.
- tests: `tests/payments*.test.ts`, `tests/pay*.test.ts`, `tests/approvals*.test.ts`.

- [ ] Tests:
  - an EURC request inserts `token: 'EURC'` and calls `transfer` with `token: "EURC"`, and USDC stays the default;
  - `payInvoice` with EURC passes the token and does not sync the USDC balance;
  - approving a live EURC payable checks the EURC balance and refuses a short one with the EURC message;
  - the paid summary says EURC;
  - reconcile submits with the invoice's currency.
- [ ] RED, implement, GREEN, then commit.

### Task 4: The AP decision for an EURC payable

**Files:**
- `src/lib/agent/guardrails.ts`:
  - `ApGuardrailInput.fx?: { available: boolean }` and `eurcShort?: boolean`;
  - the rules `fx.rate_unavailable` and `treasury.insufficient_eurc`, both `held`, for `pay`/`schedule`.
- `src/lib/agent/orchestrator.ts` (`runApStage`, `decideApPayable`):
  - load `currency`;
  - for EURC:
    - call `quoteEurcInUsdc(amount)`, catching `FxQuoteError` → null;
    - `usdcValue` = the estimated output;
    - in live, read the EURC balance once per stage and keep it current after each EURC payment;
    - timing per P1;
    - duplicates per P2;
    - guardrails per P3;
    - the prompt gains `invoice.currency`, `invoice.usdcValue` and `treasury.eurcBalance`, and the
      system prompt says limits are in USDC and an EURC invoice is weighed at its USDC value;
    - the fallback uses the USDC value for the limit and holds with no quote;
    - `payInvoice` gets `currency`.
  - The ledger detail gains `currency`, `usdcValue` and
    `fx: { rate, source: "circle-stablecoin-quote", quotedAt } | null`.
  - Summaries and lines say `<amount> <currency>`.
- tests: `tests/eurc-ap.test.ts` (new) with the fake Supabase, a stubbed quote, and a fake provider.

- [ ] Tests:
  - an EURC payable inside its limit at the rate is paid with `token: "EURC"`, and the detail has the rate;
  - an EURC payable over its limit at the rate (but under it in face value) is held with `counterparty.payment_limit`;
  - with no quote it is held with `fx.rate_unavailable`, even when the model says pay;
  - live and EURC short: held with `treasury.insufficient_eurc`, with no transfer;
  - a USDC twin with the same PO does not make an EURC invoice a duplicate;
  - USDC payables behave exactly as before (existing suites green).
- [ ] RED, implement, GREEN, then commit.

### Task 5: Amounts shown in their currency

**Files:**
- `src/components/vx/map.ts` (`invoiceDecision`) and the decision card's amount.
- The approvals card (`src/components/approvals/*`).
- The invoices page lists.
- The console's Stopped cards.
- The CSV/audit export, if it writes invoice amounts.

Each takes the invoice's `currency` and writes `<n> EURC` where it wrote `<n> USDC`.

- [ ] Tests: an EURC invoice renders "EURC" on its decision card and on its approval card, and a
  USDC one is unchanged.
- [ ] RED, implement, GREEN, then commit.

### Task 6: Docs and changelog

**Files:**
- `content/docs/guides/first-payment.mdx`: a short "Invoices in EURC" section with the exact UI
  strings, the rate, the two hold rules, and funding EURC from the faucet.
- `content/docs/changelog.mdx`: a dated entry saying `currency` can be `EURC`, and the decision's
  new ledger detail fields.
- The API docs page for invoices: `currency` is `USDC` or `EURC`.

- [ ] `npx vitest run tests/docs-*.test.ts` passes, then `npm run verify` passes, then commit.
