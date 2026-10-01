# Paying a EURC invoice from USDC by a swap

Status: design, 2026-10-01. Extends `2026-10-01-eurc-invoices-design.md`, whose "Stretch" this is.

## 1. Goal

Today a live workspace pays a EURC invoice only from the EURC it already holds. When the operating
wallet's EURC is short, the payable is held (`treasury.insufficient_eurc`) and a person has to fetch
EURC from the faucet. A business that keeps its money in USDC and pays a contractor who bills in
euros needs another option.

With this change the agent can **decide to swap** USDC for EURC, then pay. The swap goes through
Circle's Stablecoin Service, the swap service behind App Kit's `kit.swap()`, on Arc testnet, from the
operating wallet. It is:
- a decision the model takes and explains;
- bounded by code;
- run under keys, so a retry never swaps twice;
- recorded in the signed ledger with its rate, with the swap's transaction on Arc testnet.

Done when, in production, a EURC invoice the wallet's EURC could not cover is paid after a real swap.
That means a swap transaction on arcscan moving USDC out and EURC in, then the EURC transfer to the
payee, both signed.

## 2. What exists

- **The rate.** `src/lib/fx/quote.ts` asks the Stablecoin Service (`GET /v1/stablecoinKits/quote`, no
  key) what an EURC amount is worth in USDC. The AP stage weighs a EURC payable at that value.
- **The balance.** `EurcFunds` reads the wallet's EURC once per stage and tracks what this stage spent.
- **The refusal.** `enforceApGuardrails` refuses `pay` when `eurcShort`.
- **Probed 2026-10-01:**
  - `POST /v1/stablecoinKits/swap` answers without a key, and is rate-limited (429).
  - USDC→EURC on `Arc_Testnet` routes through LI.FI (tool "fly"). 1 USDC gave 0.8229 EURC; EURC→USDC
    gave 1.216081, so the round trip is close to fair.
  - The route comes and goes: "No route available" (`331001`) three times, then a quote a minute later.
- **The swap's answer** is `transaction: { executionParams: { instructions, tokens, execId, deadline,
  metadata }, signature }`. App Kit's adapters send it as `execute(executeParams, tokenInputs,
  signature)` to the Adapter contract that App Kit's chain definition names. For Arc testnet that is
  `@circle-fin/app-kit/chains` `ArcTestnet.kitContracts.adapter`, `0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b`.
  With the `approve` allowance strategy, the token input is `{ permitType: 0 (NONE), token: USDC,
  amount, permitCalldata: "0x" }`, after an ordinary `approve` of the adapter for the amount.

## 3. Design

### S1. When a swap is offered

Code quotes a swap for a payable only when all of these hold:
- it is in EURC;
- it is paid on Arc testnet (not cross-chain);
- the workspace is live and the wallet's EURC balance was read;
- the payable has a USDC value;
- the provider can swap (`provider.swapForEurc`).

The swap must cover the EURC the payment needs now, after any early-payment discount, less the EURC
the wallet holds:

`short = amountToPay(amount, discount, now).amountPaid − eurcBalance`

If `short ≤ 0` no swap is quoted.

**Sizing.** The service swaps an exact input. Code asks for `usdcIn` such that the swap's **minimum**
output (its 3% slippage floor) covers `short`:
1. Guess `usdcIn = ceil6(short × usdcPerEurc / 0.97)`, where `usdcPerEurc` is the EURC→USDC rate
   the payable was already weighed at.
2. Quote USDC→EURC for that `usdcIn` (`GET /v1/stablecoinKits/quote`).
3. If the quote's minimum is below `short`, scale `usdcIn` by `short / minimum × 1.005` and quote once
   more.
4. Still short, or no route after one retry: no swap is offered, and the facts say why.

Anything above `short` stays in the wallet as EURC; it is not spent.

**The offer:**

`SwapOffer { usdcIn, eurcEstimated, eurcMinimum, usdcPerEurc, costPercent, provider }`

- `costPercent = (usdcIn / eurcEstimated / fx.rate − 1) × 100`, rounded to 2 places: what each EURC
  costs through the swap, above the rate the payable is weighed at.
- `provider` is the route's provider as the quote names it (e.g. `lifi`).

### S2. What the model is shown and answers

- **Treasury facts.** For a EURC payable they become `{ eurcBalance, usdcBalance, usdcDueWithin7Days,
  reserveBalance: 0 }`:
  - `usdcBalance` is the operating balance;
  - `usdcDueWithin7Days` is `obligationsBy(today + 7 days, today, "USDC").total`.
- **New facts:**
  - `swap: SwapOffer | null`;
  - `swapUnavailable: string | null`, the reason when the wallet is short and no offer could be made.
- **The response shape** gains `fundWithSwap: boolean`: "true only to pay now by first swapping as
  `swap` describes".
- **The system prompt's EURC rule** gains: "When the wallet's EURC is short of a payment and `swap` is
  given, you may pay by swapping first: answer pay with fundWithSwap true. Code swaps swap.usdcIn USDC
  for at least swap.eurcMinimum EURC through Circle's Stablecoin Service, then pays in EURC; EURC left
  over stays in the wallet. Weigh swap.costPercent, and whether that USDC is needed for what falls due
  in USDC in the next 7 days. Code refuses a swap that costs more than 3% or that leaves the USDC
  balance below usdcDueWithin7Days."
- **The schema.** `apDecisionSchema` accepts `fundWithSwap` as an optional boolean; nullish is false.

### S3. Timing

With an offer, the EURC available to the timing plan is `eurcBalance + swap.eurcMinimum`. So the
planner does not report a shortfall the swap would cover. When the planner picks a later day (a
discount deadline, the due date), the payable is **scheduled** and nothing is swapped. On that day,
the cycle quotes afresh.

### S4. The reference policy

- **Pay with a swap.** The fallback pays with `fundWithSwap: true` when all of these hold:
  - it would pay now;
  - the wallet is short;
  - there is an offer;
  - the offer passes both caps (S5).
- **Hold.** When the wallet is short and there is no usable offer, it holds, and its reasoning names
  why: no route, the cost cap, or USDC needed for obligations.
- **Scoring.** `sameApDecision` also compares `fundWithSwap` when the action is `pay`.

### S5. Guardrails (`enforceApGuardrails`, `input.swap`)

For `pay` on a EURC payable whose EURC is short:

| Condition | Rule |
|---|---|
| `fundWithSwap` false | `treasury.insufficient_eurc` (unchanged) |
| `fundWithSwap` true and no offer | `treasury.insufficient_eurc`; the note says no swap was available |
| `offer.costPercent > 3` | `fx.swap_cost_above_cap` |
| `usdcBalance − offer.usdcIn < usdcDueWithin7Days` | `fx.swap_usdc_short` |

- `fundWithSwap` on a payable that is not short is ignored: nothing is swapped.
- Every other guardrail runs as before. The limit check stays on the payable's USDC value.

### S6. Running the swap (`src/lib/fx/swap.ts`)

**Order of work.** In the AP stage's pay branch the swap runs inside the pause check, before
`payInvoice`. `payApInvoiceIfNotPaused` gains `swap?: SwapOffer`:

1. Paused → held, nothing swapped.
2. `swapForPayment()`.
3. On success, `payInvoice` as before.
4. On failure → held with `guardrailRule: "fx.swap_failed"`, and the reason in the reasoning.

**`swapForPayment({ invoiceId, offer, short })`:**
1. **Open swap.** An invoice with an open `submitted` row was resumed before its decision (S7), so it
   never reaches this step with one.
2. **Create.** `POST /v1/stablecoinKits/swap` for `offer.usdcIn`, `fromAddress = toAddress =` the
   operating wallet, with 300 bps slippage. If the answer's minimum output is below `short`, the swap
   fails ("the rate moved") and nothing is sent.
3. **Record first.** The calldata is encoded with viem from the Adapter ABI: `execute(executeParams,
   [{ permitType: 0, token: USDC, amount: usdcIn, permitCalldata: "0x" }], signature)`. The row is then
   inserted, before anything is sent, with:
   - `state = submitted`;
   - the offer's figures;
   - the adapter address, the calldata and the deadline.

   A partial unique index allows one `submitted` row per invoice; losing that race fails the swap.
4. **Approve.** `approve(adapter, usdcIn)` on USDC, through `createContractExecutionTransaction` under
   the key `swapStepKey(org/invoice/swapId/approve)`, then settled.
5. **Execute.** The adapter is called with the stored `callData` under `swapStepKey(…/execute)`, then
   settled.
6. **Read the balance.** The EURC balance is read; `eurcReceived` is the rise since step 2.
7. **Close the row.** It becomes `confirmed` with the tx hashes and `eurcReceived`, or `failed` with
   Circle's state.
8. **Ledger.** One `fx_swap` entry, actor `agent`, domain `treasury`, for both outcomes:
   - `summary`: "SWAP 2.45 USDC for 2.01 EURC to pay {counterparty}'s invoice", or "SWAP failed: …";
   - `detail`: `{ invoiceId, swapId, state, usdcIn, eurcMinimum, eurcEstimated, eurcReceived,
     usdcPerEurc, costPercent, provider, adapter, approveTxHash, swapTxHash, reasoning }`.

**What the provider adds.** It does steps 4–5 only, as `swapForEurc({ fromAccountId, adapter, usdcIn,
callData, keys })`. The method is optional on `ChainProvider`; the simulate provider leaves it out, so
a sandbox is never offered a swap, and has no EURC balance to make one needed (E7).

**Keeping the stage's figures true.** After a confirmed swap the AP stage's `EurcFunds` adds
`eurcReceived`, and `operatingBalance` drops by `usdcIn`. Later payables in the same cycle see both.

### S7. Recovery

Keys are fixed per swap id, and the calldata is stored. Resuming a `submitted` row therefore re-sends
the same two calls under the same keys, and Circle returns the transactions it already has. Only a
call it never received is created now.

- If the service's deadline has passed by then, the execute reverts on chain and the row fails. No
  USDC moves; the approval stays.
- **Before** a EURC payable is decided, an open row for it is resumed. Its balance read then sees the
  EURC that swap brought, so a swap whose answer was lost is never followed by a second one.
- A paused agent resumes nothing; the row stays open until a cycle runs unpaused.
- A confirmed resume adds `eurcReceived` to the stage's EURC and appends the `fx_swap` entry the lost
  answer never wrote.
- A row whose resumed swap is still pending at Circle holds the payable: "a swap for it is in flight".

### S8. Data: migration `0048_fx_swaps.sql`

- **`fx_swaps`.** The money columns are `numeric(20,6)`:
  - `id uuid pk`, `org_id`, `invoice_id references invoices on delete cascade`;
  - `state` check: `submitted`, `confirmed` or `failed`;
  - `usdc_in`, `eurc_minimum`, `eurc_estimated`, `eurc_received`, `usdc_per_eurc`;
  - `cost_percent numeric(9,4)`, `provider`, `adapter`, `call_data`, `deadline timestamptz`;
  - `approve_tx_id`, `approve_tx_hash`, `swap_tx_id`, `swap_tx_hash`, `failure`;
  - `created_at`, `updated_at`.
- **Access.** Tenant RLS like `escrow_contracts`.
- **Unique index** on `(invoice_id) where state = 'submitted'`.
- **Idempotent**, as every migration is.
- **Without 0048**, a missing table (`42P01`) means "no swaps": no swap is offered, and EURC payables
  behave as today.

### S9. UI

- **The decision card** for a EURC payable paid after a swap gets a row: "Funded by swap: 2.45 USDC →
  2.01 EURC" with the swap's tx link. It reads from `ap_pay` `detail.swap`, which is
  `{ swapId, usdcIn, eurcReceived, swapTxHash }` or `null`.
- **The guardrail band** names the three new rules:
  - `fx.swap_cost_above_cap`: the cost against 3%;
  - `fx.swap_usdc_short`: USDC after the swap against what falls due;
  - `fx.swap_failed`: the swap's failure.

### S10. Docs

- **Guide.** `first-payment.mdx` "Invoices in EURC" gains a "Paid from USDC by a swap" bullet.
- **Changelog** (2026-10-01): the `fx_swap` action in the `treasury` domain and its `detail`;
  `ap_pay` `detail.swap`; the new `guardrailRule` values; the `fundWithSwap` field in a decision.
- **Privacy page.** Circle's Stablecoin Service also builds the swap, for the operating wallet's
  address.

## 4. Rulings

- **R1. The swap rails, not `kit.swap()`.** `kit.swap()` with `@circle-fin/adapter-circle-wallets`
  would send the approval and the swap under keys it makes itself. A retry after a lost answer could
  then swap twice, and nothing would let us find out. Calling the same service and the same Adapter
  contract through our own keyed contract executions keeps the rule every payment here follows: a
  retry is the same request.

  App Kit still supplies the chain definition and the Adapter address (`@circle-fin/app-kit/chains`).
  If App Kit moves the adapter, this moves with it.

  Cost if wrong: more code than one call; a change to the Adapter's ABI breaks it loudly (the swap
  reverts and the payable is held).
- **R2. Only for paying now.** A swap made days ahead would bet on the testnet pool's rate and leave
  EURC idle. Scheduling plans with the EURC the swap would bring, and swaps on the day.

  Cost if wrong: a pay-day without a route holds the payable for a person, as today.
- **R3. 3% cost cap.** The probe's round trip was within 0.1%. 3% leaves room for the testnet pool
  and still refuses a broken quote.
- **R4. The leftover EURC stays.** Sizing to the slippage floor buys up to about 3% more EURC than
  needed. It is not swapped back; it pays the next EURC invoice.
- **R5. viem as a direct dependency.** It is already installed through App Kit (2.56.8). It encodes
  the Adapter call. The tests decode it with the same ABI.

## 5. Tests

- **Sizing:** the scale-up quote; no route after the retry; `costPercent`.
- **The facts:** the prompt carries `swap`, `swapUnavailable` and the treasury figures. The schema
  accepts `fundWithSwap` and treats nullish as false.
- **Each guardrail row in S5**, and `fundWithSwap` ignored when the payable is not short.
- **The reference:** pays with a swap, or holds for each reason; `sameApDecision` on `fundWithSwap`.
- **`swapForPayment`**, over a fake client and a fake service:
  - the happy path: row, keys, calldata, ledger;
  - the rate moved;
  - a failed execute;
  - resume with the same keys;
  - the unique-index race;
  - the pending hold.
- **The calldata**, decoded with the Adapter ABI, equals the service's answer and the token input.
- **AP stage:**
  - a short EURC payable paid after a swap: balances carried, `ap_pay` `detail.swap`;
  - a paused agent swaps nothing;
  - a failed swap holds with `fx.swap_failed`;
  - without 0048 the payable behaves as today.
- **Migration** (PGlite): the table, RLS, the index, idempotent re-run, and the inventories.
- **Docs tests:** the changelog and the privacy page name what they must.

## 6. Rollout

1. The partner applies 0048 from the branch, then the PR merges.
2. In testnet-2, with the wallet's EURC below a new EURC invoice and the agent not paused, add the
   invoice: due today, PO, goods received, within the limit, payee confirmed. Example: 3 EURC to a
   payee on Arc testnet.
3. Record:
   - the `fx_swap` entry, and its tx on arcscan: USDC out of the operating wallet, EURC in;
   - the `ap_pay` entry with `detail.swap`;
   - the EURC transfer to the payee.
