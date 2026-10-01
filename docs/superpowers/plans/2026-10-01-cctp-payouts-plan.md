# Cross-chain payouts through CCTP: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Pay a payee on Base, Arbitrum or Ethereum Sepolia from the Arc operating wallet through CCTP V2 with the Forwarding Service. The agent weighs the fee, code bounds it, and the intent tracks both the burn and the mint.

**Spec:** `docs/superpowers/specs/2026-10-01-cctp-payouts-design.md` (X1–X11, R1–R6).

## Global constraints

- Arc testnet is CCTP domain 26.
- TokenMessengerV2 is `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` on every testnet.
- Arc's USDC ERC-20 is `0x3600000000000000000000000000000000000000`, with 6 decimals.
- The forwarding hook is `0x636374702d666f72776172640000000000000000000000000000000000000000`.
- Iris is `https://iris-api-sandbox.circle.com`: `/v2/burn/USDC/fees/26/{domain}?forward=true` for the fee, and `/v2/messages/26?transactionHash=` for the mint.
- Domains: `BASE-SEPOLIA` 6, `ARB-SEPOLIA` 3, `ETH-SEPOLIA` 0.
- Only USDC crosses. EURC to another chain is held.
- Copy says "Arc testnet" plainly.
- Migration 0044 redefines no function, and is idempotent.

## Review focus

- A resubmission after an ambiguous bridge outcome must create no second approve or burn: the keys are derived and reused.
- A bridge whose burn confirmed but whose mint is unknown stays `matched`, and is never sent again.
- A Base Sepolia payee whose fee is above 10% of the amount is held, even when the model says pay.
- The money check counts the fee.
- An Arc payee is paid exactly as before.

---

### Task 1: The payee's chain (X1) and migration 0044

**Files:**
- `supabase/migrations/0044_cctp_payouts.sql`
- `tests/cctp-migration.test.ts`
- `src/lib/intake-validation.ts` (`PAYEE_CHAINS`)
- `src/components/intake/CounterpartyIntake.tsx` (a Chain select)
- the counterparty card (shows a non-Arc chain)
- tests: intake, counterparty card

Steps:
- [ ] Tests:
  - the check refuses `POLYGON-AMOY`;
  - the new columns exist;
  - the schema accepts the four chains, and refuses others with "Choose a chain Vestiarion can pay on";
  - the form has a select named `chain` with ARC-TESTNET as the default.
- [ ] RED, then implement, then GREEN, then commit.

### Task 2: `src/lib/circle/cctp.ts`

**Produces:**
- `CCTP_DOMAINS`
- `bridgeFee(chain, amount, { fetch? }): Promise<{ feeUsdc, maxFeeUnits, minimumFeeBps }>`, which throws `BridgeFeeError`
- `burnCalls(...)`, returning the approve and burn `{ contractAddress, abiFunctionSignature, abiParameters }`
- `toBytes32(address)`
- `forwardedMint(burnTxHash, { fetch? }): Promise<{ mintTxHash } | null>`

Steps:
- [ ] Tests:
  - the fee is high plus bps;
  - an Iris failure is `BridgeFeeError`;
  - the encodings: a lower-cased bytes32 recipient, the hook, and the total = amount + maxFee;
  - the mint is found, or null before.
- [ ] RED, then implement, then GREEN, then commit.

### Task 3: The providers and the intent

**Files:**
- `src/lib/circle/types.ts`: `TransferParams.destinationChain?`; `TransferResult.mintTxHash?` and `destinationChain?`.
- `src/lib/circle/liveProvider.ts`:
  - when `destinationChain` is not Arc, fetch the fee, then create the approve and burn with keys `${key}:approve` and `${key}:burn`, and await both;
  - return `pending` with `providerTxId: "cctp:<burnId>"`;
  - `reconcileTransfer("cctp:…")` reads the burn, then the mint.
- `src/lib/circle/simulateProvider.ts`: a simulated bridge.
- `src/lib/payments.ts`: ensure writes `destination_chain`, and `recordResult` writes `mint_tx_hash` and `bridge_fee`.
- `src/lib/agent/pay.ts`: `PayInvoiceInput.destinationChain`.

Steps:
- [ ] Tests (fake Circle client):
  - approve, then burn, with derived keys, and a pending `cctp:` result;
  - reconcile pending, then confirmed with the mint;
  - a retried transfer reuses the keys;
  - the simulate provider confirms;
  - `payInvoice` passes the chain.
- [ ] RED, then implement, then GREEN, then commit.

### Task 4: The AP decision and approvals (X3–X7, X11)

**Files:** `orchestrator.ts` (`decideApPayable`, reconcile), `guardrails.ts` (`bridge.fee_above_cap`, `bridge.fee_unavailable`, `bridge.unsupported_token`), `approvals.ts`, the privacy page (new prompt field `payout`), `tests/cctp-ap.test.ts`.

Steps:
- [ ] Tests:
  - a Base payee is paid through the bridge, with the payout in the prompt and the ledger;
  - a fee above 10% is held;
  - no fee is held;
  - a EURC payable to Base is held;
  - the money check includes the fee;
  - an Arc payee is unchanged;
  - reconcile turns a bridged payment paid once the mint is found.
- [ ] RED, then implement, then GREEN, then commit.

### Task 5: UI and docs

**Files:**
- `map.ts`: the decision card's mint link
- explorer URLs per chain
- `content/docs/guides/first-payment.mdx` ("Pay a payee on another chain")
- `content/docs/changelog.mdx`

Steps:
- [ ] Tests: the decision card links both transactions; the docs tests pass.
- [ ] Then `npm run verify` passes, then commit.
