# Failed-transfer retry: a payment Circle reports as failed can be sent again, by a person, never twice

Every payment is one `payment_intents` row per invoice or milestone, with an idempotency key derived from the source (`paymentIdempotencyKey`). Once Circle has returned a transaction id, the app only ever reconciles that id: this is the duplicate-payment boundary (`executePayment`).

When Circle reports a transfer in a terminal failure state, the boundary becomes a dead end:
- `payInvoice` maps the failure to `held`, and the invoice waits in Approvals;
- a person's **Approve and pay** calls `executePayment` again, which reconciles the same failed transaction and records `failed` again;
- a new transfer would need a new idempotency key, since Circle returns the original transaction for a key it has seen, and nothing ever makes one.

The invoice can never be paid. Circle's own documentation says a `FAILED` or `CANCELLED` transaction "must be re-initiated".

Two defects sit next to it:

- **`STUCK` is counted as a failure.** `FAILED_STATES` (src/lib/circle/settlement.ts) includes `STUCK`, and its comment reads "Circle states that end a transfer without moving money". Circle's documentation says the opposite: `STUCK` "is not a terminal failure". The transaction was sent and can still be mined, or accelerated. Today a stuck transfer is recorded `failed` with no error of ours, so `paymentWasSent` reports that nothing moved, and a person may Reject or Return an invoice whose transfer can still confirm. Any retry built on the current classification could pay twice.
- **Circle's reason is lost.** A failed transaction carries `errorReason` (e.g. `INSUFFICIENT_NATIVE_TOKEN`, `FAILED_ON_CHAIN`), but `recordResult` clears `last_error`, and the person sees only "provider reported failure".

This design fixes both defects and lets a person send a failed payment again.

It was decided on 2026-09-30 by the implementer under the partner's standing instruction.

## 1. What this builds

- **`STUCK` is in flight, not failed.** `FAILED_STATES` becomes the three terminal failure states only: `CANCELLED`, `DENIED`, `FAILED`. A `STUCK` transfer reconciles as `pending` every cycle, and Reject and Return refuse it as `payment_in_flight`.
- **The provider reports what Circle said.** `TransferResult` gains `providerState` (Circle's `state`, or `null` for the simulator) and `failureReason` (`errorReason`, or `null`). Migration 0036 adds `payment_intents.provider_state` and `payment_intents.failure_reason`, and `recordResult` writes both. `last_error` keeps its meaning: an error of ours, such as a read that did not complete.
- **Attempts.**
  - Migration 0036 also adds `payment_intents.transfer_attempt integer not null default 1` and `previous_attempts jsonb not null default '[]'`.
  - Attempt 1 keeps today's key, so existing rows and every key already sent to Circle are unchanged.
  - Attempt *n* > 1 uses `paymentIdempotencyKey(sourceType, sourceId, n)`, derived from `vestiarion/payment/v1/<type>/<id>/attempt/<n>`.
  - The row stays one per source (`unique (source_type, source_id)`), so every reader that looks an intent up by its source keeps working.
- **`begin_payment_retry(p_org_id, p_source_type, p_source_id, p_expected_key, p_new_key)`.** This RPC opens the next attempt in one conditional update. It applies only when the row's key is still the expected one, its `status` is `failed`, it has a `provider_tx_id`, and its `provider_state` is one of the three terminal failure states. In that case:
  - the failed attempt is appended to `previous_attempts` as `{ attempt, idempotencyKey, providerTxId, providerState, failureReason, failedAt }`;
  - the row gets the new key and `transfer_attempt + 1`;
  - the transfer fields are cleared, and `status` returns to `created`.

  It returns the row, or nothing when another request already moved it.
- **`executePayment(request, { provider, store, retryTerminalFailure })`.**
  - Without `retryTerminalFailure` (the agent's cycle, reconciliation), behavior is unchanged: a failed transfer is reconciled, never re-sent.
  - With it, when the intent has a provider id:
    1. It reads Circle first.
    2. Only when that read reports a terminal failure state does it open the next attempt with `begin_payment_retry`, then claim and transfer under the new key.
    3. A read that says pending, confirmed or stuck, or a read that fails, is recorded as today and returned without a new transfer.
  - The intent is found by its source, and the key comes from the row, not from the source alone.
- **Only a person retries.**
  - `approveAndPay` passes `retryTerminalFailure: true`. Every approval check applies: no self-approval, no high-risk counterparty, the shown address, the operating balance (a retry moves money again, so the balance check is no longer skipped), and the claim.
  - The agent's cycle never retries. The invoice stays `held` for a person, who can read Circle's reason first. The fix may need to happen elsewhere, for example funding the wallet.
- **The approval card says what happened.**
  - A held payable whose last attempt failed shows "The last payment attempt failed: <reason>. Approving sends a new transfer." The reason is Circle's `failureReason`, or "Circle reported <state>" when there is none.
  - A stuck one shows "The payment is still in flight on Arc testnet. It cannot be approved, rejected or returned until Circle settles it."
- **The ledger records the retry.** `approval_paid` gains `attempt` and, on a retry, `retriedAfter: { providerTxId, providerState, failureReason }`. The summary is unchanged.
- **Docs.** The first-payment guide's "Approve a held payment" section explains a failed payment and a retry. The changelog gains an entry: the new `approval_paid` detail fields, and `STUCK` now reported as in flight.

## 2. Decisions

- **R1. Only Circle's terminal failure states open a new attempt, read at the moment of the retry.** The stored status is not trusted for this, because a transfer recorded failed before this change may have been `STUCK`. Reading Circle right before opening the attempt, and requiring the RPC's `provider_state` condition, means a transfer that could still move is never followed by a second one.
- **R2. A person retries, not the agent.** The failure's reason often needs someone to act first, such as topping up the wallet or fixing a paymaster policy. An agent retrying on a schedule would repeat the failure, and each `FAILED_ON_CHAIN` burns gas. Approve and pay is also where every payment check already lives.
- **R3. One row per source, and a new key per attempt.** A new row per attempt would break every reader that looks an intent up by its source: the orchestrator's in-flight map, sample-data removal, workspace deletion, reject and return. Keeping the row and rotating its key keeps them all correct. `previous_attempts` preserves the history, and the ledger has every attempt's outcome.
- **R4. Attempt 1's key is today's key.** Nothing already sent to Circle changes identity.
- **R5. Milestones.** A person-driven retry applies to invoices. A failed milestone release keeps today's behavior, and the change to `STUCK` applies to it too. A manual milestone retry is out of scope (§6).

## 3. Components

```
supabase/migrations/0036_payment_attempts.sql   provider_state, failure_reason, transfer_attempt, previous_attempts, begin_payment_retry
src/lib/circle/settlement.ts                    FAILED_STATES terminal only; STUCK → pending
src/lib/circle/types.ts, liveProvider.ts        TransferResult.providerState, failureReason
src/lib/circle/simulateProvider.ts              providerState/failureReason null
src/lib/payments.ts                             attempt keys, store by source, beginRetry, retryTerminalFailure
src/lib/dal/index.ts                            begin_payment_retry allowed for the tenant client
src/lib/agent/approvals.ts                      retryTerminalFailure, balance check on retry, ledger detail, card data
src/components/ApprovalCard.tsx                 the failed / stuck lines
content/docs/guides/first-payment.mdx, changelog.mdx
```

## 4. Testing

- **Settlement:**
  - `STUCK` maps to pending in `awaitSettlement` and `reconcileTransfer`;
  - `FAILED`, `CANCELLED` and `DENIED` map to failed, and carry `providerState` and `failureReason`.
- **Migration (PGlite):**
  - the columns and their defaults;
  - `begin_payment_retry` moves a terminal-failed row to attempt 2, appends the history and clears the transfer fields;
  - it refuses (returns nothing) when the key is not the expected one, the status is not failed, there is no provider id, or the provider state is `STUCK` or null;
  - the tenant role can run it only for its own org.
- **`executePayment`:**
  - without the flag, a failed intent is reconciled and never re-sent;
  - with it and a terminal state, the RPC is called with attempt 2's key, then the claim, then a transfer under the new key;
  - with it and `STUCK`, `pending`, `confirmed`, or a read that fails, there is no RPC and no transfer;
  - a lost race (the RPC returns nothing) sends no transfer;
  - attempt 1's key is byte-identical to today's.
- **`approveAndPay`:**
  - a held invoice whose attempt failed terminally is paid on attempt 2, and the ledger carries `attempt: 2` and `retriedAfter`;
  - the balance check applies to the retry;
  - Reject and Return refuse a stuck transfer.
- **The card:** the failed line with Circle's reason, and the stuck line.

## 5. Rollout

1. Apply 0036 before the merge. It is additive: old code never selects the new columns, and `begin_payment_retry` is new.
2. Merge on green.
3. **Check production for regressions.**
   - Neither environment can produce a failed payment on demand: the simulator always confirms, and a real terminal failure can't be forced on Arc testnet. So the retry path itself is proven by the tests in §4.
   - Make one real payment in a live workspace (e.g. `testnet-2`). It must confirm on attempt 1 under its unchanged key, with `provider_state` `COMPLETE` recorded.
   - A read-only probe must find every existing intent at attempt 1 with `previous_attempts = []`.
4. Record the result in this spec.

### Rollout record (2026-09-30)

- **Migration 0036** was applied by the partner before the merge of #70. A read-only probe found:
  - the four columns with their defaults, and the `transfer_attempt_positive` and `previous_attempts_is_array` checks;
  - `begin_payment_retry(uuid,text,uuid,text,text)` executable by `vestiarion_tenant` only, not `anon` or `authenticated`;
  - all 12 existing intents at attempt 1, with `previous_attempts = []` and `provider_state` null;
  - the new columns readable through PostgREST (200), so the schema cache had reloaded.
- **After the deploy**, `listWaitingPayables` read the new fields through the app's code: `founding` had four waiting payables, none with a prior attempt; `testnet-2` had none.
- **Regression payment in `testnet-2`**, a live workspace on a hosted wallet:
  - ledger #407 `ap_pay`, Centronex 0.5 USDC, paid by the agent in a cycle at 14:56 UTC and signed by the workspace's rotated key `5e69c0196d40a5ec`;
  - its intent: `confirmed`, `provider_state = 'COMPLETE'`, `transfer_attempt = 1`, `previous_attempts = []`, and an idempotency key equal to the attempt-1 derivation;
  - the transaction: `0x0faa216f…4f772e1`, fee 0.003186 USDC (chain reported), settled in 2 s, receipt status `0x1` in block 64794074;
  - `verifyLedger()` afterwards: `{ valid: true, checkedEntries: 67 }`.
- **The retry path itself** is proven by the tests in §4, since no failed payment can be produced on demand.

## 6. Out of scope

- Accelerating or cancelling a `STUCK` transfer through Circle's API.
- The agent retrying automatically.
- A manual retry for a failed milestone release.
- Refunds or reversals of a confirmed payment.
