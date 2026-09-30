# Failed-Transfer Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A payment Circle reports in a terminal failure state can be sent again by a person (Approve and pay), under a new idempotency key, never twice; `STUCK` is treated as in flight; Circle's failure reason is kept and shown.

**Architecture:** `payment_intents` stays one row per source; migration 0036 adds `provider_state`, `failure_reason`, `transfer_attempt`, `previous_attempts` and the RPC `begin_payment_retry`, which rotates the row to the next attempt's key only when the current attempt failed terminally. `executePayment` gains `retryTerminalFailure`, used only by `approveAndPay`, which re-reads Circle before opening the attempt.

**Tech Stack:** Postgres (PGlite tests), supabase-js through the tenant `db()`, the Circle developer-controlled-wallets SDK (via `LiveProvider`), Vitest with `tests/support/fake-supabase.ts`, React server rendering tests.

**Spec:** `docs/superpowers/specs/2026-09-30-failed-transfer-retry-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md).
- Terminal failure states (exact): `CANCELLED`, `DENIED`, `FAILED`. `STUCK` is in flight (`pending`), never failed.
- Attempt 1's idempotency key is byte-identical to today's `paymentIdempotencyKey(sourceType, sourceId)`; attempt n>1 hashes `vestiarion/payment/v1/<type>/<id>/attempt/<n>` with the same UUID shaping.
- `last_error` keeps its meaning (an error of ours, e.g. a read that did not complete); Circle's `errorReason` goes to `failure_reason`, Circle's `state` to `provider_state`.
- Only `approveAndPay` passes `retryTerminalFailure: true`; the agent's cycle and reconciliation never re-send a failed transfer.
- UI strings (exact): "The last payment attempt failed: <reason>. Approving sends a new transfer." with <reason> = Circle's failure reason, or `Circle reported <STATE>` when none; and "The payment is still in flight on Arc testnet. It cannot be approved, rejected or returned until Circle settles it."
- Ledger: `approval_paid` detail gains `attempt` (number) and, on a retry, `retriedAfter: { providerTxId, providerState, failureReason }`; ids and states only.
- `/api/v1` payload shapes do not change; `content/docs/changelog.mdx` gets a dated entry (ledger detail fields + STUCK in flight), per AGENTS.md.
- Every exported server action awaits `authorize` first and works inside `inOrg`. UI uses `src/components/ui/*` primitives. Commit messages neutral, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Subagents never touch production.

## Review Focus

1. **A transfer recorded `failed` before this change that was really `STUCK`** — the retry must read Circle now and refuse unless the live state is terminal; the RPC must also refuse a null or `STUCK` `provider_state` (Tasks 2, 3).
2. **Two people approving the same failed invoice at once** — `claim_invoice_decision` serialises approvals, and `begin_payment_retry`'s expected-key condition must make a second retry a no-op; never two transfers (Task 3).
3. **A retry that fails again** — attempt 2 failing terminally must leave the invoice held with the new reason, and a third approval must open attempt 3 (Task 3).
4. **Existing rows** — every intent already in production is attempt 1, `previous_attempts = []`, `provider_state` null; reconciliation of an in-flight one must fill `provider_state` without changing its key (Tasks 2, 3).
5. **Reject/Return on a stuck transfer** — must refuse as `payment_in_flight` (Task 3).

---

### Task 1: Settlement states and what the provider reports

**Files:** Modify `src/lib/circle/settlement.ts`, `src/lib/circle/types.ts`, `src/lib/circle/liveProvider.ts`, `src/lib/circle/simulateProvider.ts`; Tests `tests/circle-settlement.test.ts`, `tests/circle-live-provider.test.ts`, and any other test that builds a `TransferResult` literal (add the two fields).

- `FAILED_STATES` = `["CANCELLED", "DENIED", "FAILED"]`; rewrite its comment: terminal states that end a transfer without moving money and require re-initiation; `STUCK` was sent and can still be mined (Circle: "not a terminal failure"), so it is pending.
- `TransferResult` gains `providerState: string | null` and `failureReason: string | null`. `LiveProvider.transfer` and `reconcileTransfer` set them from the Circle transaction (`transaction.state`, `transaction.errorReason ?? null`; both null when no transaction was read). The simulator sets `providerState: null, failureReason: null` — check the SDK type for `errorReason`'s exact field name.
- Tests: `STUCK` → pending in `awaitSettlement` and `reconcileTransfer`; `FAILED` with `errorReason: "INSUFFICIENT_NATIVE_TOKEN"` → failed with both fields; `CANCELLED`/`DENIED` → failed; `COMPLETE` → confirmed with `providerState: "COMPLETE"`.
- Commit: `Treat a stuck Circle transfer as in flight and keep Circle's state and failure reason`.

---

### Task 2: Migration 0036 — attempts, provider state, and `begin_payment_retry`

**Files:** Create `supabase/migrations/0036_payment_attempts.sql`; Modify `src/lib/dal/index.ts` (allow the RPC for the tenant client, alongside `claim_payment_intent`); Test `tests/payment-attempts-migration.test.ts`.

```sql
-- Failed-transfer retry (docs/superpowers/specs/2026-09-30-failed-transfer-retry-design.md).
alter table public.payment_intents add column if not exists provider_state text;
alter table public.payment_intents add column if not exists failure_reason text;
alter table public.payment_intents add column if not exists transfer_attempt integer not null default 1;
alter table public.payment_intents add column if not exists previous_attempts jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and conname = 'payment_intents_transfer_attempt_positive') then
    alter table public.payment_intents add constraint payment_intents_transfer_attempt_positive check (transfer_attempt >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.payment_intents'::regclass and conname = 'payment_intents_previous_attempts_is_array') then
    alter table public.payment_intents add constraint payment_intents_previous_attempts_is_array check (jsonb_typeof(previous_attempts) = 'array');
  end if;
end $$;

-- Opens the next attempt of a payment whose current attempt Circle ended in a
-- terminal failure (R1, R3): only when the row still holds the expected key,
-- is failed, has a provider id, and its provider state is terminal. Returns
-- the row, or a row of nulls when nothing matched (as claim_payment_intent).
create or replace function public.begin_payment_retry(
  p_org_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_expected_key text,
  p_new_key text
)
returns public.payment_intents
language plpgsql
set search_path = ''
as $$
declare
  retried public.payment_intents;
begin
  update public.payment_intents
     set previous_attempts = previous_attempts || jsonb_build_array(jsonb_build_object(
           'attempt', transfer_attempt,
           'idempotencyKey', idempotency_key,
           'providerTxId', provider_tx_id,
           'providerState', provider_state,
           'failureReason', failure_reason,
           'failedAt', updated_at
         )),
         idempotency_key = p_new_key,
         transfer_attempt = transfer_attempt + 1,
         provider_tx_id = null,
         tx_hash = null,
         provider_state = null,
         failure_reason = null,
         status = 'created',
         last_error = null,
         confirmed_at = null,
         executed_at = null,
         updated_at = now()
   where org_id = p_org_id
     and source_type = p_source_type
     and source_id = p_source_id
     and idempotency_key = p_expected_key
     and status = 'failed'
     and provider_tx_id is not null
     and provider_state in ('CANCELLED', 'DENIED', 'FAILED')
  returning * into retried;
  return retried;
end;
$$;

revoke execute on function public.begin_payment_retry(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.begin_payment_retry(uuid, text, uuid, text, text) to service_role;
grant execute on function public.begin_payment_retry(uuid, text, uuid, text, text) to vestiarion_tenant;
```

Check first how 0018 grants `claim_payment_intent` to `vestiarion_tenant` and whether tenant functions need `security definer` or run as invoker under RLS (mirror `claim_payment_intent` exactly — it is `language plpgsql set search_path = ''`, invoker). Also check whether the column list of the other fee/settled columns (`fee_usd`, `fee_source`, `settled_in_ms`) should be cleared too, and clear them if the row's shape makes a stale value misleading.

- PGlite tests (style of tests/control-migration.test.ts or similar): columns/defaults/constraints; an existing-shaped row reads attempt 1 and `[]`; the RPC on a `FAILED` row with a provider id → attempt 2, new key, history item with every field, cleared transfer fields, status `created`; returns nulls (no change) for: wrong expected key, status `pending`, provider id null, provider_state `STUCK`, provider_state null; as the tenant role it changes only its own org's row (another org's row with the same key shape is untouched).
- Commit: `Record payment attempts and allow opening the next one after a terminal failure`.

---

### Task 3: `executePayment` retry and `approveAndPay`

**Files:** Modify `src/lib/payments.ts`, `src/lib/agent/approvals.ts`; Tests `tests/payments.test.ts` (extend), `tests/approvals.test.ts` (extend) — read both first and follow their fakes.

**Interfaces:**
- `paymentIdempotencyKey(sourceType, sourceId, attempt = 1)` — attempt 1 unchanged; n>1 hashes the attempt path.
- `PaymentIntent` gains `providerState`, `failureReason`, `transferAttempt`, `previousAttempts` (mapped from the row).
- `PaymentIntentStore`:
  - `ensure` finds or creates the row by source: upsert with `onConflict: "source_type,source_id", ignoreDuplicates: true`, then `getBySource(sourceType, sourceId)`; new rows get attempt 1's key.
  - `recordResult` also writes `provider_state` and `failure_reason`.
  - new `beginRetry(intent: PaymentIntent): Promise<PaymentIntent | null>` calls `begin_payment_retry` with `paymentIdempotencyKey(type, id, intent.transferAttempt + 1)`; a row with no id → null (lost race or not retryable).
  - claim/recordResult/recordError keep keying by the intent's current `idempotencyKey`.
- `executePayment(request, { provider, store?, retryTerminalFailure?: boolean })`:
  1. `intent = ensure(...)`; confirmed → return.
  2. `intent.providerTxId` set: reconcile (as today) → record. If `retryTerminalFailure` and the reconcile result is `failed` with `providerState` in the three terminal states → `beginRetry(intent)`; null → return the recorded execution (no transfer); else continue to 3 with the new intent. Otherwise return as today.
  3. claim → transfer with `intent.idempotencyKey` → record, as today.
- `PaymentExecution` gains `attempt` and `retriedAfter: { providerTxId, providerState, failureReason } | null`.
- `approveAndPay`: pass `retryTerminalFailure: true` through `payInvoice` (add an optional `retryTerminalFailure` to `payInvoice`'s deps, default false, forwarded to `executePayment`); `alreadySent` must be false for an intent that failed terminally (the balance check applies to the retry): compute it as "confirmed, or a provider id whose provider_state is not terminal-failed"; `paymentIntentOf` selects `provider_state` too; `paymentWasSent` treats `provider_state = 'STUCK'` (and `SENT`, `QUEUED`, `INITIATED`, `CLEARED`, `CONFIRMED`) as sent — simplest: sent unless (no intent) or (status failed and provider_state in the three terminal states, or provider id null) — rewrite it with that rule and a comment.
  - the `approval_paid` detail gains `attempt` and `retriedAfter` from the execution.
  - `listWaitingPayables` exposes `lastAttempt: { state: "failed"; reason: string } | { state: "in_flight" } | null` per payable, from the intent it already reads (select `provider_state, failure_reason` too): failed terminally → `{ state: "failed", reason: failure_reason ?? \`Circle reported ${provider_state}\` }`; a provider id with a non-terminal state or `STUCK` → `in_flight`.
- Tests (payments): key for attempt 1 equals the old derivation for a fixed source (hard-code the expected UUID computed from today's code before changing it); no flag + failed → reconcile only; flag + `FAILED` → RPC with attempt-2 key, claim, transfer with attempt-2 key, execution `attempt: 2, retriedAfter` set; flag + `STUCK`/`pending`/`confirmed`/reconcile throws → no RPC, no transfer; RPC returns nulls → no transfer; attempt 2 failing → recorded failed with its reason; a later flagged call opens attempt 3.
- Tests (approvals): retry pays a held invoice on attempt 2 with the ledger detail; the balance check runs on a retry (insufficient → refused, no RPC); Reject and Return refuse when `provider_state = 'STUCK'`; `listWaitingPayables` maps both `lastAttempt` shapes.
- Commit: `Let a person resend a payment Circle ended in a terminal failure`.

---

### Task 4: The approval card, the guide and the changelog

**Files:** Modify `src/components/ApprovalCard.tsx`, `content/docs/guides/first-payment.mdx`, `content/docs/changelog.mdx`, `tests/docs-guides.test.ts`; Test the card in its existing test file (find it: `tests/control-ui.test.tsx` or `tests/approvals*.tsx`).

- Card: when `payable.lastAttempt?.state === "failed"`, a `Callout` (tone `refused`) with "The last payment attempt failed: <reason>. Approving sends a new transfer."; when `in_flight`, a `Callout` (tone `held`) with "The payment is still in flight on Arc testnet. It cannot be approved, rejected or returned until Circle settles it." and the decision controls disabled or hidden (match how the card handles `processing`).
- Guide: in "## 5. Approve a held payment", a paragraph: when a payment fails (the card says why, from Circle), fix the cause if needed — e.g. fund the operating wallet — then **Approve and pay** sends a new transfer; Vestiarion never sends a second transfer while the first could still settle; a payment still in flight on Arc testnet can't be approved, rejected or returned until it settles. Pin the two card sentences in QUOTED for `guides/first-payment` against `src/components/ApprovalCard.tsx` (the failed sentence up to "Approving sends a new transfer.").
- Changelog: a dated 2026-09-30 entry, newest first, in the file's format: `approval_paid` ledger entries (and so `ledger.appended` webhooks and `/api/v1/ledger`) may carry `attempt` and `retriedAfter`; a Circle transfer in `STUCK` is now reported in flight rather than failed; no endpoint or schema changed.
- Run `npx vitest run tests/docs-guides.test.ts tests/docs-content.test.ts` + the card test, then `npm run verify`.
- Commit: `Show a failed or in-flight payment on the approval card and document retries`.

---

## Rollout (the controller)

1. The partner applies 0036 (`npm run db:migrate`); the controller probes read-only: columns, constraints, RPC grants, every existing intent at attempt 1 with `[]`.
2. PR, green, merge. 3. One real payment in testnet-2 confirms on attempt 1 with `provider_state = 'COMPLETE'`. 4. Record in spec §5.
