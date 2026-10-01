# Paying a EURC invoice from USDC by a swap: plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps are RED → GREEN; each task ends with its tests and a commit.

**Goal:** a live workspace whose EURC is short of a EURC payable can pay it after a USDC→EURC swap the agent decided, bounded by code, keyed, and signed.

**Architecture:**
- `src/lib/fx/swap-service.ts` talks to Circle's Stablecoin Service (quote, create) and encodes the Adapter call.
- `src/lib/fx/swap.ts` runs a swap for a payment, from its `fx_swaps` row and ledger entry; the provider sends the two keyed contract calls.
- The AP stage offers the swap to the model, guards it, resumes open swaps, and pays after one.

**Tech stack:** Next.js 16, Supabase (fakeSupabase in tests, PGlite for the migration), vitest, viem (encode/decode), `@circle-fin/app-kit/chains` (Adapter address), Circle Developer-Controlled Wallets.

**Spec:** `docs/superpowers/specs/2026-10-01-eurc-swap-design.md`

## Global constraints

- Amounts are 6-decimal; base units are converted with integers, never with a float multiply.
- Keys: `swapStepKey(seed)` is a UUID derived from `sha256("vestiarion/swap/v1/" + seed)`, the same scheme as `escrowStepKey`.
- Copy says "Arc testnet" plainly, and never "simulated" or "no real money".
- Commits are neutral.

## Review focus

1. **A swap whose answer was lost.** The next cycle must not swap again (resume before the balance read).
2. **The rate moved between quote and create.** The minimum output below `short` sends nothing.
3. **A paused agent.** It sends neither a swap nor a resume.
4. **Without 0048** (`42P01`), EURC payables behave as today.
5. **USDC left after the swap.** It must cover the 7-day USDC obligations.

---

### Task 1: migration `0048_fx_swaps.sql`

**Files:**
- `supabase/migrations/0048_fx_swaps.sql`;
- `tests/fx-swap-migration.test.ts`;
- the RLS and table inventories, wherever the escrow migration added `escrow_contracts`.

**Steps:**
- **RED.** Write PGlite tests for:
  - the table and its columns;
  - the state check;
  - the one-`submitted`-per-invoice index;
  - tenant isolation;
  - an idempotent re-run.
- **GREEN.** Write the migration.
- Commit.

### Task 2: the Stablecoin Service client

**File:** `src/lib/fx/swap-service.ts`; tests in `tests/fx-swap-service.test.ts`.

**Produces:**
- `SwapOffer`, `SWAP_COST_CAP_PERCENT = 3`, `SWAP_SLIPPAGE_BPS = 300`, `ADAPTER`;
- `quoteUsdcForEurc(usdcIn, { fromAddress, apiKey?, fetch?, retryDelayMs? })`, returning
  `{ eurcEstimated, eurcMinimum, provider }`; it throws `FxQuoteError`;
- `sizeSwap(short, usdcPerEurc, quote)`, returning `{ offer } | { offer: null, reason }`;
- `createSwapTransaction(usdcIn, { fromAddress, apiKey?, fetch? })`, returning
  `{ eurcEstimated, eurcMinimum, deadline, callData, adapter }`;
- `encodeAdapterExecute(transaction, usdcInUnits)`.

**Tests:**
- base units;
- retry once on no route;
- 429 → unavailable;
- the key as Bearer, and keyless after a 401;
- sizing that scales once, or gives up with a reason;
- `costPercent`;
- the calldata decoded with the Adapter ABI;
- create refusing an answer without `executionParams`.

### Task 3: the provider's two calls

**Files:** `ChainProvider.swapForEurc?` in `src/lib/circle/types.ts`, implemented on `LiveProvider`;
tests in `tests/swap-provider.test.ts`.

**What it does:**
- `approve(adapter, usdcInUnits)` on USDC under `approveKey`, then `callData` to the adapter under
  `executeKey`; each is settled with `awaitSettlement`.
- It returns `{ approve: Step, execute: Step }`, where `Step = { status, txId, txHash, state }`.
- A failed approve does not send the execute.

### Task 4: `swapForPayment` and `resumeOpenSwap`

**File:** `src/lib/fx/swap.ts`; tests in `tests/fx-swap.test.ts` (fakeSupabase, a fake provider, a
fake service fetch).

**Behaviour:**
- **Happy path:** the row is inserted before the calls, with the keys from the swap id; the balance is
  read before and after; the row is closed `confirmed`; one `fx_swap` entry.
- **The rate moved:** nothing is inserted or sent.
- **A failed execute:** the row is `failed`; an `fx_swap` entry with state `failed`.
- **Losing the unique-index race:** fails, sends nothing.
- **A pending execute:** `{ ok: false, pending: true }`, and the row stays `submitted`.
- **`resumeOpenSwap`:**
  - re-sends under the same keys with the stored calldata;
  - null when there is no open row;
  - null on `42P01`.

### Task 5: the AP stage

**Files:**
- `src/lib/agent/orchestrator.ts`: facts, schema, prompt, reference, timing, the pay branch,
  `runApStage`'s resume and figures;
- `src/lib/agent/guardrails.ts`: the S5 rows.

**Tests:**
- `tests/eurc-swap-ap.test.ts`, over the same harness as `tests/eurc-ap.test.ts`, with injected
  `quoteSwap` and `swaps`;
- additions to `tests/guardrails.test.ts`.

**Behaviour:**
- **An offer is shown, and paid with a swap:**
  - the swap runs before the EURC transfer;
  - `ap_pay` carries `detail.swap`;
  - the stage's EURC rises and its USDC falls.
- **The model says pay without `fundWithSwap`:** `treasury.insufficient_eurc`.
- **The two caps:** the cost cap, and USDC needed for obligations.
- **`fundWithSwap` on a payable that is not short:** ignored.
- **A failed swap:** held, `fx.swap_failed`.
- **Paused:** no swap and no resume.
- **An open swap:** resumed before the decision, so no second swap.
- **No route:** the reference holds, and the reason is in `swapUnavailable`.
- **The timing plan** uses `eurcBalance + eurcMinimum`: a later day is scheduled without a swap.

### Task 6: UI

**Files:** `src/components/vx/map.ts` (the swap row and the guardrail notes) and its tests.

**Behaviour:**
- "Funded by swap" with a tx link from `detail.swap`.
- The band notes for the three rules.

### Task 7: docs

**Files:**
- `content/docs/guides/first-payment.mdx`;
- `content/docs/changelog.mdx`;
- the privacy page;
- the docs tests that pin them.
