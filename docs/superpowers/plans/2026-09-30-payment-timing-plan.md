# Payment Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AP agent chooses when to pay (`schedule` with `payOn`, bounded by the due date), captures early-payment discounts on their last valid day, re-decides scheduled invoices on the day with every check, and records why.

**Architecture:** A pure `payment-timing.ts` computes the timing facts and a reference answer (like `planTreasury`), handed to the model and used as fallback; code bounds `payOn`; guardrails treat `schedule` as `pay`; migration 0038 adds invoice terms, `scheduled_for`, `paid_amount` and status `scheduled`; the AP stage loads due scheduled invoices; `payInvoice` pays the discounted amount by the deadline.

**Tech Stack:** Postgres (PGlite tests), supabase-js via tenant `db()`, zod decision schemas, the existing `decide()` LLM wrapper with reference fallback, Next.js 16 server components/actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-payment-timing-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md).
- Decision action union (exact): `pay | schedule | hold | flag_fraud | request_info`; `schedule` requires `payOn` as `YYYY-MM-DD` (UTC calendar date).
- Bounds (exact): `payOn` must be after today (UTC) and no later than the invoice's due date (UTC date); after due → due date; today or earlier, or unparseable → pay now; each correction sets `timingRule` in the ledger detail to one of `payon.after_due`, `payon.not_after_today`, `payon.invalid`.
- Discount: applies when paid on or before the end of the discount deadline's UTC day; amount paid = `round6(amount × (1 − pct/100))`; limits are checked against the full invoice amount.
- Status `scheduled` requires `scheduled_for`. Scheduled invoices count as open obligations at `scheduled_for`.
- Ledger actions: `ap_schedule` (new), `ap_pay` detail gains `discountTaken`, `amountPaid`, `scheduledFor` (when it had been scheduled); `approval_paid` gains `discountTaken`, `amountPaid`. Ids and numbers only.
- UI strings (exact): form labels "Early-payment discount (%)" and "Discount deadline"; outcome "Scheduled for <date>"; invoice status "Scheduled · <date>"; terms "<pct>% off if paid by <date>"; console section title "Scheduled payments". Dates render with the app's existing formatter (utcDay: "Sep 30, 2026").
- `/api/v1` invoices gain `scheduledFor` (string|null), `earlyPayDiscount` ({ percent: number; deadline: string } | null), `paidAmount` (number|null); status filter accepts `scheduled`; OpenAPI + `content/docs/examples/list-invoices.json` updated; `content/docs/changelog.mdx` gets a dated entry (AGENTS.md).
- Migration number 0038 (0039 is reserved for the A2 session). Commit messages neutral, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Subagents never touch production. Another session (A2) edits `src/app/actions/intake.ts` on its own branch — keep changes there minimal (fields in the insert only).

## Review Focus

1. **A scheduled invoice that becomes unsafe before its day** (risk turns high, address changes, agent paused) must not be paid on the day (Task 3).
2. **A model that keeps postponing** — rescheduling is bounded by the due date; on the due date `schedule` is corrected to pay now (Tasks 2, 3).
3. **Discount arithmetic and deadline edges** — paid on the deadline day gets it, the day after does not; rounding to 6 decimals; a person's approval applies the same rule (Tasks 2, 3).
4. **Obligations and treasury** — a scheduled invoice still counts against the buffer (at its scheduled date), so treasury never sweeps money a scheduled payment needs (Task 3).
5. **Existing invoices with no terms and a far due date** now wait until the due date instead of paying at once — the sample-data "paid" row must stay paid in the first cycle (due today) (Task 4).

---

### Task 1: Migration 0038

**Files:** Create `supabase/migrations/0038_payment_timing.sql`; Test `tests/payment-timing-migration.test.ts`.

- Columns on `public.invoices` (all `add column if not exists`): `early_pay_discount_pct numeric(5,2)`, `discount_due_date timestamptz`, `scheduled_for timestamptz`, `paid_amount numeric(20,6)`.
- Constraints (idempotent `do $$ … pg_constraint … $$` blocks, as 0036): `invoices_discount_pair` — both discount columns null or both set; `invoices_discount_pct_range` — pct > 0 and < 100; `invoices_discount_before_due` — `discount_due_date <= due_date`; `invoices_scheduled_has_date` — `status <> 'scheduled' or scheduled_for is not null`; `invoices_paid_amount_positive` — `paid_amount is null or paid_amount > 0`.
- Status: replace `invoices_status_check` to add `'scheduled'` — read 0025 (it rewrote the check to add `processing`) and follow exactly the same drop-and-recreate pattern, keeping every existing value.
- End with `notify pgrst, 'reload schema';` (as 0036).
- PGlite tests (style of tests/payment-attempts-migration.test.ts): columns exist; each constraint refuses what it should and allows the valid shapes (org_id named on tenant inserts); `scheduled` status accepted with a date and refused without; replay idempotent; every old status still accepted.
- Commit: `Add payment terms and scheduling to invoices`.

---

### Task 2: `payment-timing.ts`, guardrails, obligations

**Files:** Create `src/lib/agent/payment-timing.ts`, `tests/payment-timing.test.ts`; Modify `src/lib/agent/guardrails.ts` (+ `tests/guardrails.test.ts`), `src/lib/agent/obligations.ts` (+ its test).

**Interfaces (produce exactly):**
```ts
export interface PaymentTimingInput {
  now: Date;
  amount: number;
  dueDate: string;                         // ISO timestamp from the invoice
  discount: { pct: number; deadline: string } | null;
  operatingBalance: number;
  reserveApy: number;                      // e.g. 0.045
  earlierObligations: number;              // open payables (and verified milestones) due before this invoice's target date, excluding this invoice
}
export interface PaymentTiming {
  today: string;                           // YYYY-MM-DD (UTC)
  dueOn: string;                           // YYYY-MM-DD (UTC) of dueDate
  discountValue: number | null;            // round6(amount * pct/100) when a discount is still available today
  discountAvailableUntil: string | null;   // YYYY-MM-DD, when still available
  floatValueToDue: number;                 // round6(amount * reserveApy * daysBetween(target-if-discount-skipped, due)/365) — 0 when no discount
  targetOn: string;                        // the date the policy would pay on
  recommendation: { action: "pay" } | { action: "schedule"; payOn: string };
  reason: string;                          // one sentence, cites the numbers
  shortfall: boolean;                      // operatingBalance - earlierObligations < amountDueAt(targetOn)
  amountDueAtTarget: number;               // discounted when targetOn <= discount deadline
}
export function planPaymentTiming(input: PaymentTimingInput): PaymentTiming;
export function boundPayOn(payOn: string | undefined, input: { now: Date; dueDate: string }):
  { action: "pay"; timingRule: "payon.not_after_today" | "payon.invalid" | null } |
  { action: "schedule"; payOn: string; timingRule: "payon.after_due" | null };
export function discountApplies(discount: { pct: number; deadline: string } | null, now: Date): boolean; // true through the end of the deadline's UTC day
export function amountToPay(amount: number, discount: { pct: number; deadline: string } | null, now: Date): { amountPaid: number; discountTaken: number };
export function utcDate(value: Date | string): string; // YYYY-MM-DD
```
Rules for `planPaymentTiming` exactly as spec §1 (due today/overdue → pay; discount available → compare `discountValue` with `amount × apy × (due − deadline)/365`, target deadline when the discount is worth at least as much, else due; no discount → due; target ≤ today → pay; `reason` sentences, e.g. "A 2% early-payment discount (8 USDC) is worth more than holding the cash to the due date (0 USDC of yield); paying on the discount deadline, Oct 10, 2026." / "No early-payment discount; paying on the due date, Oct 30, 2026, keeps 400 USDC available until then." / "Due today; paying now." — use `utcDay`-style dates, find the existing formatter).

- Guardrails: `ApGuardrailInput.action` gains `"schedule"`; every check that applies to `pay` applies to `schedule` (same statuses and rule ids); the override reasoning says "scheduling refused" instead of "payment refused" for schedule. Tests: each rule blocks schedule.
- Obligations: `OPEN_PAYABLE_STATUSES` gains `"scheduled"`; `PayableObligation` gains optional `scheduled_for`; a scheduled row is dated by `scheduled_for` (fallback due_date). Tests.
- Tests for the pure module: every rule and edge in the spec §4 list, including deadline-day inclusive, the day after, rounding to 6 decimals, apy 0, apy high enough that yield beats a tiny discount, overdue, bad dates for boundPayOn.
- Commit: `Compute when to pay an invoice, and bound the agent's chosen date`.

---

### Task 3: The AP stage, payInvoice and approvals

**Files:** Modify `src/lib/agent/orchestrator.ts`, `src/lib/agent/pay.ts`, `src/lib/agent/approvals.ts`, `src/lib/queries.ts`; Tests `tests/orchestrator.test.ts` (or the AP-stage test file — read which one drives `executeCycle`'s AP stage), `tests/pay.test.ts`, `tests/approvals.test.ts`, `tests/queries*` if any.

- `apDecisionSchema`: action enum per constraints; `payOn: z.string().optional()`; refine: `schedule` requires `payOn`. `ApDecision` updated. `SYSTEM_PROMPT` gains a rule paragraph: choose when to pay; you may schedule up to the due date; take an early-payment discount when it is worth more than keeping the cash, paying on its deadline; otherwise paying on the due date keeps the cash available; pay now when due today or overdue; never schedule past the due date; cite the figures.
- The AP user prompt gains `terms: { earlyPayDiscount: {percent, deadline} | null }`, `timing: <PaymentTiming>` (from `planPaymentTiming`, with `earlierObligations` computed from the cycle's open payables due before this invoice's target, excluding it, plus open verified milestones), `scheduledEarlier: { payOn, reasoning } | null`, and `responseShape.action` / `payOn`.
- Fallback: when the existing fallback would `pay`, use the timing plan's recommendation (pay or schedule with payOn); every other fallback branch unchanged.
- Loading: payables `in("status", ["pending", "matched", "scheduled"])`, then skip `scheduled` rows whose `scheduled_for` is after now (they are counted in obligations but not decided). Select the new columns.
- After the model: bound a `schedule` with `boundPayOn` (a corrected pay becomes a pay decision; record `timingRule`); guardrails get the (possibly corrected) action; `schedule` not blocked → invoice `status: "scheduled"`, `scheduled_for: <payOn>T00:00:00.000Z`, reasoning, `decided_at`; ledger `ap_schedule` with `decision`, `timing`, `timingRule`, `terms`, `observed` (as `ap_pay`), `referenceDecision`, `agreedWithReference`; line "<name>: scheduled for <payOn> (<amount> USDC)". Metrics: count schedule as its own outcome if `cycle-metrics.ts` has a place for it (add `scheduledCount`), else document.
- Pay (`action === "pay"`): `payApInvoiceIfNotPaused`/`payInvoice` get the discount; `payInvoice` input gains `discount?: { pct: number; deadline: string } | null` and uses `amountToPay(amount, discount, new Date())` for the transfer; `PayInvoiceResult` gains `amountPaid` and `discountTaken`; the invoice update sets `paid_amount` when paid; `ap_pay` detail gains `discountTaken`, `amountPaid`, `scheduledFor` (the row's scheduled_for when it had one); clear `scheduled_for` when the invoice leaves `scheduled` (paid/held/flagged…).
- `approveAndPay` passes the invoice's discount to `payInvoice` and records `discountTaken`/`amountPaid` in `approval_paid` (select the columns in `loadWaitingPayable`).
- `queries.ts` stats: paid-out sums `paid_amount ?? amount`.
- Obligation measurement in the cycle selects `scheduled_for` for the open payables (Task 2 made obligations use it).
- Tests: a clean invoice with terms → `ap_schedule` with the deadline, status scheduled, ledger shape; the same invoice with the model saying schedule past due → bounded to due with `timingRule`; `schedule` on a high-risk counterparty → flagged; a scheduled invoice before its day → not decided, still in obligations; on its day → decided again and paid at the discounted amount (transfer amount asserted) with `scheduledFor` in the ledger; the day after the deadline → full amount; paused → held; counterparty turned high risk between → flagged, no transfer; the fallback (heuristic mode) schedules per the plan; approveAndPay pays discounted within the deadline.
- Commit: `Let the agent schedule payments and take early-payment discounts`.

---

### Task 4: Intake, API v1, sample data, changelog

**Files:** Modify `src/lib/intake-validation.ts`, `src/components/intake/InvoiceIntake.tsx`, `src/components/intake/InvoiceCsvImport.tsx` (header help), `src/app/actions/intake.ts` (insert fields only), `src/lib/invoice-csv.ts` if it maps columns, `src/lib/api/invoices.ts`, `src/lib/api/schemas.ts`, the v1 invoices route(s), `src/lib/api/openapi.ts` if fields are listed there, `content/docs/examples/list-invoices.json`, `content/docs/changelog.mdx`, `src/lib/sample-data.ts`, `docs/superpowers/specs/2026-09-30-sample-data-design.md` §3; Tests: intake, csv, api contract/openapi, sample-data tests.

- Intake: optional `earlyPayDiscountPct` (0 < p < 100, max 2 decimals) and `discountDeadline` (a date); both or neither ("Enter both the discount and its deadline, or neither."); deadline no later than the due date ("The discount deadline must be on or before the due date."). CSV optional columns `early_pay_discount_pct`, `discount_deadline` with the same rules. Form labels per constraints, in the existing `Field` style, grouped under the due date.
- API: payload fields per constraints (`earlyPayDiscount.deadline` as the ISO string, `percent` as a number); `INVOICE_STATUSES` gains `scheduled`; type-locked zod schemas and the example updated so the contract tests pass; changelog entry dated 2026-09-30 (what changed for an integrator: new fields, new status, new ledger actions `ap_schedule` and detail fields on `ap_pay`/`approval_paid`).
- Sample data: Northwind "Hosting — September" due today (so paid in the first cycle); add Northwind "Annual support plan", 400 USDC, PO-1044, goods received, 2% discount with deadline today+10, due today+30. Update the fixture tests and the sample-data spec §3 table (a new row: "scheduled for its discount deadline, paid at 392 USDC on that day").
- Commit: `Accept early-payment terms on invoices and expose scheduling in the API`.

---

### Task 5: What a person sees, and the guide

**Files:** Modify `src/components/vx/map.ts`, `src/components/vx/DecisionCard.tsx` (outcome), `src/components/vx/types.ts` if outcomes are typed there, `src/app/o/[slug]/invoices/page.tsx`, `src/app/o/[slug]/console/page.tsx` (+ a small `ScheduledPayments` component in src/components/vx/), `content/docs/guides/first-payment.mdx`, `tests/docs-guides.test.ts`; Tests: decision card / map tests, a console source test, the component test.

- Decision: `ap_schedule` maps to an outcome reading "Scheduled for <date>" with the reasoning; pick a tone from the existing outcome set that reads as "pending, not a problem" (read DecisionCard's outcome styles; don't invent colours — ui-consistency test).
- Invoices page: status "Scheduled · <date>"; terms line "<pct>% off if paid by <date>" when an invoice has a discount; paid invoices with `paid_amount` < amount show it (e.g. "Paid 392 USDC (2% discount)").
- Console "Scheduled payments": up to 5 scheduled payables, soonest first: date, counterparty, amount (the discounted amount when the discount will apply on that date), and the first sentence of the reasoning; hidden when there are none. Read the console's existing data loading (it already loads invoices) — no extra query if the rows are there.
- Guide: a section "## When the agent pays" in first-payment.mdx before "Approve a held payment": the agent may schedule a payment up to its due date; with an early-payment discount it pays on the discount's last day and pays the discounted amount; otherwise it pays on the due date; on the day it checks everything again (risk, limit, address, pause); pause stops scheduled payments; how it shows on the console and invoices. Pin the exact UI strings (constraints) in QUOTED.
- Commit: `Show scheduled payments and payment terms, and document when the agent pays`.

---

## Rollout (the controller)

The partner applies 0038 (`npm run db:migrate`); the controller probes read-only (columns, constraints, status check, PostgREST sees the columns). PR, green, merge, deploy. Then spec §5 steps 3–4 with the partner, record in spec §5, arc-canteen update. Update the A1 row in tameion-roadmap.md.
