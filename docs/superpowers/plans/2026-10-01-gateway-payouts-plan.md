# Payouts from a Gateway balance: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** a workspace funds a Circle Gateway balance on Arc. A payout to a payee on another chain then goes through Gateway, which is instant and minted by Circle's Forwarding Service, when the balance and the fee allow; otherwise it goes through CCTP. The route never changes for a payment once chosen.

**Spec:** `docs/superpowers/specs/2026-10-01-gateway-payouts-design.md`

## Global constraints

- Never hold a key. The Gateway signer is a Circle EOA, and it signs through `signTypedData`.
- Use the EIP-712 types and domain exactly as in Circle's reference (`transfer-evm-delegate.md`).
- USDC has 6 decimals in Gateway values. Use the testnet API `https://gateway-api-testnet.circle.com/v1`.
- The route is written on the payment intent at its first attempt and is never changed (spec G2).
- Migrations are idempotent, and none redefines another migration's function.
- A ledger or payload change gets a changelog entry.
- Copy says "Arc testnet" plainly.

## Review focus

1. **Double payment.**
   - A Gateway transfer whose POST got no answer, followed by any later attempt: the same route and salt are used, never CCTP.
   - An approval of an intent already on the Gateway route.
2. **A salt that differs between attempts of the same intent.** It must not happen. A salt that is the same across attempts of different invoices must not happen either.
3. **Funding run twice, or concurrently.** It creates one signer and adds one delegate, and each deposit is keyed by its request.
4. **The Gateway API.**
   - It is down: route to CCTP before an intent exists; hold after.
   - The estimate is above the fee ceiling: nothing is sent.
   - The status is `expired` or `failed`: the payment failed, and the invoice is held.
5. **Tenancy.** `gateway_signers` is visible only to its workspace, and a workspace's signer is never used for another.

---

### Task 1: migration 0045 and the DAL

**Files:**
- Create `supabase/migrations/0045_gateway.sql`.
- Modify `src/lib/dal/index.ts` (`TENANT_TABLES`).
- Test in `tests/gateway-migration.test.ts` (PGlite).

**The migration:**
- `gateway_signers`:
  - `id` uuid pk, `org_id` uuid not null, a foreign key to orgs on delete cascade, unique;
  - `circle_wallet_id` text not null and `address` text not null (`^0x[0-9a-fA-F]{40}$`);
  - `delegate_tx_id` text, `delegate_tx_hash` text;
  - `created_by` uuid, a foreign key to auth.users on delete set null;
  - `created_at`.
- RLS with `tenant_isolation` and `tenant_isolation_guard`, written as 0018 writes them.
- Grant select, insert and update to `vestiarion_tenant`, and all to `service_role`.
- `payment_intents.payout_route` text null, with check in (`cctp`, `gateway`).
- Notify pgrst.

**Tests:**
- the table and its unique org;
- a tenant sees only its own row;
- `payout_route` refuses `wire`;
- a re-run of the migration is clean.

### Task 2: the Gateway module (`src/lib/circle/gateway.ts`)

**Produces:**
- `GATEWAY_WALLET`, `GATEWAY_MINTER`, `GATEWAY_API`, and `USDC_BY_CHAIN` for the four payee chains.
- `gatewaySalt(attemptKey): \`0x${string}\``, which is sha256 of `${attemptKey}:gateway`.
- `burnIntent({ depositor, signer, recipient, chain, amount, salt, maxFee, maxBlockHeight })`.
- `burnIntentTypedData(intent)`.
- `estimateGateway({ depositor, signer, recipient, chain, amount, salt }, { fetch }) → { maxFee: bigint; maxBlockHeight: string; feeUsdc: number }`.
- `gatewayBalance(depositor, { fetch }) → number`, summed over the domains in the response.
- `submitGatewayTransfer(intent, signature, { fetch }) → string` (the transferId).
- `gatewayTransferStatus(id, { fetch }) → { status: "pending" | "confirmed" | "failed"; mintTxHash: string | null; failureReason: string | null }`. `finalized` counts as confirmed, and `expired` as failed.
- `GatewayError`.

**Tests** (in `tests/gateway.test.ts`):
- the salt is deterministic, and differs per key;
- the typed data has Circle's exact types and domain;
- the estimate is parsed from the body we measured: `{ body: [{ burnIntent: { maxFee, maxBlockHeight } }], fees: { total } }`;
- a balance;
- the transfer id;
- each status mapping;
- an HTTP error becomes `GatewayError`.

### Task 3: funding (`src/lib/platform/gateway-funding.ts`, plus an action in `src/app/actions/treasury.ts`)

**Produces:**
- `fundGateway({ actorId, amount, requestId }, deps)` → `{ signerAddress, depositTxHash, balance }`, which does each of these:
  - ensure the signer: `createWallets` EOA on ARC-TESTNET, with key `walletIdempotencyKey(org, "gateway-signer")`, in the workspace's set, then upsert the row;
  - ensure the delegate: if `delegate_tx_hash` is null, execute `addDelegate(address,address)` with key from `(org, "gateway-delegate")`, await settlement, and store the tx;
  - approve and deposit, each keyed by `(requestId, step)`, awaiting settlement.

  It writes the ledger entries `gateway_signer_created` (once), `gateway_delegate_added` (once) and `gateway_deposit`.
- `fundGatewayAction(prev, formData)`: authorize `treasury.manage` (or the role check the treasury actions use), check live mode, a positive amount, and an amount within the operating balance.

**Tests:** run it twice and get one signer and one delegate; the keys; the ledger; a sandbox is refused; a viewer is refused.

### Task 4: the provider

**Files:**
- Modify `src/lib/circle/types.ts` to add `TransferParams.route?: "cctp" | "gateway"` and `TransferResult.route?`.
- Modify `liveProvider.ts`:
  - `gatewayPayout` reads the signer from `gateway_signers`, then: salt, estimate (with the fee ceiling), `signTypedData`, submit, then poll status up to `bridgeMintWaitMs`. The provider id is `gateway:<id>`.
  - `reconcileTransfer` handles the `gateway:` prefix.
- Modify `simulateProvider.ts`: a `gateway` route is simulated like `cctp`.

**Tests** (fake client and fetch):
- confirmed with the mint;
- pending is matched;
- a fee above the ceiling sends nothing;
- no signer gives an error that sends nothing;
- reconcile reads it and never sends;
- `TransferResult.chain` is the destination chain and `txHash` is the mint.

### Task 5: the sticky route in `payments.ts`

- `PaymentRequest.route?`, and `PaymentIntent.route`, read from `payout_route`.
- `ensure()` writes `payout_route` when the payment is across chains.
- `executePayment` passes `intent.route ?? request.route` to `transfer`.

**Tests:**
- the first attempt writes `gateway`;
- an intent already on `gateway` stays on `gateway` when the request says `cctp`, and the reverse.

### Task 6: the AP stage and approvals

**AP stage:**
- `ctx.gatewayQuote?: (chain, amount) => Promise<{ feeUsdc: number; balanceUsdc: number } | null>`, injected like `bridgeFee`. In production, it returns null without a signer, or in a sandbox.
- The route: Gateway if the quote covers amount plus fee, and its fee is at most CCTP's or CCTP gave none. `fee` is the chosen route's fee, so the guardrails apply to it.
- `payout.route` and `expectedSeconds`. The ledger records `payout.route` and `feeUsdc`.
- The pay step passes `route`. `mintOverdue` covers `gateway:`.

**Approvals:** an intent with a route keeps it (the sticky route). A new one is CCTP (R7).

**Tests:**
- Gateway is chosen;
- CCTP when the balance is short, when the fee is higher, or when the quote is null;
- the ledger route;
- the fee cap is applied to the Gateway fee;
- overdue `gateway:` is held.

### Task 7: UI and /open

**Files:**
- Create `src/components/GatewayPanel.tsx` and add it to the Treasury page:
  - the balance, read live, with "—" when it cannot be read;
  - the signer's address;
  - the funding form for an owner or admin in a live workspace.
- Modify the decision card to show the route ("through Gateway" or "through CCTP").
- Modify `src/components/open/OurPayments.tsx` to link by `payeeChain(chain).explorerTx` when the chain is not Arc.

**Tests:** the panel's states; the card's route; the /open link for a Base Sepolia payment.

### Task 8: docs

**Files:**
- The first-payment guide's "Pay a payee on another chain" gains Gateway: funding, the route rule, and what the card shows.
- The changelog: `payout.route` can be `gateway`; the new ledger actions; the intent's chain and tx for a Gateway payout.
- The privacy page: Gateway receives the payout's addresses and amount.
- QUOTED strings in `tests/docs-guides.test.ts`.

**Tests:** the docs tests, then `npm run verify`.
