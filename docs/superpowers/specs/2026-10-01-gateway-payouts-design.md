# Payouts from a Gateway balance

Date: 2026-10-01. Status: approved for implementation. It was decided under the standing autonomy grant, and each ruling carries its cost if wrong.

## 1. Why

A payee on another chain is paid today through CCTP:
- Vestiarion burns on Arc, and Circle forwards the mint.
- That takes two Circle transactions from the operating wallet and about 30 seconds.

Circle Gateway holds a unified USDC balance that can be spent on any supported chain at once. Once a workspace has deposited USDC into Gateway on Arc, a payout is a signed request, and Circle's Forwarding Service mints on the payee's chain.

The fees are close to CCTP's. Measured on 2026-10-01 from `POST /v1/estimate?enableForwarder=true`, for 1 USDC:

| From Arc testnet to | Gateway | CCTP |
|---|---|---|
| Base Sepolia | 0.0567 | 0.054 |
| Arbitrum Sepolia | 0.1053 | 0.12–0.13 |
| Ethereum Sepolia | 1.3269 | 1.5–2.2 |

What Gateway changes is the speed, and a balance that has to be put there first. Both are judgements for the agent, bounded by code.

## 2. Behaviour

### G1. A Gateway balance

A live workspace's owner or admin funds a Gateway balance from **Treasury → Gateway balance** with an amount. This is a deliberate move of treasury cash, made by a person, never by the agent.
1. Vestiarion creates a Circle EOA wallet on Arc testnet in the workspace's wallet set: the **Gateway signer**.
   - Its idempotency key comes from the workspace and the word "gateway-signer", so a retry returns the same wallet.
   - An SCA cannot sign Gateway's requests (EIP-1271 is refused), so an EOA the SCA authorises signs them. Circle holds its key; Vestiarion never sees it.
2. Once, the operating SCA calls `addDelegate(USDC, signer)` on the GatewayWallet contract (`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`).
3. The operating SCA calls `approve(GatewayWallet, amount)` on Arc's USDC, then `deposit(USDC, amount)` on GatewayWallet. Each call carries a key derived from the funding request.

Each step is a ledger entry: `gateway_signer_created`, `gateway_delegate_added` and `gateway_deposit`, with the transaction hashes.

The signer is stored in a table of its own, `gateway_signers`, created by migration 0045 with the same tenancy as `payee_links`. A row holds:
- `circle_wallet_id` and `address`;
- the transaction that added it as a delegate.

It is not an account. Every reader of `accounts` (the balance refresh, the treasury sums, provisioning) would otherwise treat the signer's empty wallet as treasury cash. The Gateway balance is read when it is needed, from `POST /v1/balances` with the operating wallet as depositor.

### G2. The route

For a payable to a payee on another chain, code chooses the route:
- **Gateway**, when the workspace has a Gateway account, its balance covers the amount plus Gateway's estimated fee, and that fee is no higher than CCTP's (or CCTP gave none).
- **CCTP** otherwise, as today.

The model sees the route that was chosen:

```
payout: { chain, route: "gateway" | "cctp", feeUsdc, feePercent, expectedSeconds }
```

`expectedSeconds` is 5 for Gateway and 30 for CCTP.

**The route is kept on the payment intent from its first attempt** (`payment_intents.payout_route`, migration 0045). Every later attempt for that invoice uses it, whatever the balances say then. Otherwise a Gateway transfer whose answer was lost would leave the Gateway balance lower, the next attempt would choose CCTP, and the payee would be paid twice. An intent on the Gateway route that the balance can no longer cover is held for a person, who can fund Gateway again.

The guardrails stand as they are:
- `bridge.fee_above_cap` (10%);
- `bridge.fee_unavailable`;
- `bridge.unsupported_token`.

### G3. Paying through Gateway

1. Build a burn intent:
   - `sourceDepositor`: the operating SCA;
   - `sourceSigner`: the Gateway signer;
   - `destinationRecipient`: the payee;
   - `value`: the amount;
   - `salt`: sha256 of the attempt's key and "gateway".

   A retried attempt therefore asks for the same transfer, and GatewayWallet spends a salt only once.
2. `POST /v1/estimate?enableForwarder=true` gives `maxFee` and `maxBlockHeight`. A fee above what this payment may pay sends nothing.
3. The signer signs the burn intent's EIP-712 typed data through Circle's `signTypedData`, with domain `GatewayWallet` v1. The types are Circle's, unchanged.
4. `POST /v1/transfer?enableForwarder=true` returns a `transferId`. The intent's provider id is `gateway:<transferId>`.
5. `GET /v1/transfer/{id}` is polled for up to 20 s:
   - `confirmed` or `finalized`: the payment is confirmed, and the mint is the response's `transactionHash` on the payee's chain;
   - `failed` or `expired`: the payment failed, and nothing was minted;
   - otherwise: pending, which is `matched` ("Payment in flight").

### G4. Reconciliation

- A `gateway:` intent is read again with `GET /v1/transfer/{id}`. It never sends.
- The two-hour hold for a mint that has not come applies to `gateway:` as it does to `cctp:`.
- An attempt whose `POST /v1/transfer` gave no answer has no transfer id. The next attempt sends the same burn intent, with the same salt, on the same route.
  - Gateway either accepts it once or refuses it as already used.
  - A refusal is recorded, and the invoice is held for a person, who checks with Circle.
  - The salt can never be spent twice, and the route never changes, so nothing can pay twice.

### G5. Recorded and shown

- The intent records `destination_chain`, `mint_tx_hash`, and `bridge_fee` as Gateway's fee.
  - `tx_hash` is the mint on the payee's chain. Gateway burns on Arc later, in a batch, so no Arc transaction belongs to one payout.
  - `chain` is the payee's chain, so /open links the mint to that chain's explorer.
- The ledger's `payout` carries `route: "gateway"`, the fee, and the transfer id.
- The decision card names the route and links the mint.
- The Treasury page shows the Gateway balance, the signer's address, and the funding form.

### G6. Sandbox

A sandbox workspace has no Gateway account, so its payouts across chains stay on simulated CCTP.

## 3. Rulings

- **R1: code chooses the route, and the model weighs the fee as before.** Cost if wrong: the model does not compare routes itself.
- **R2: a person funds Gateway; the agent never moves treasury cash into it.** Cost if wrong: a balance that runs dry, after which payouts fall back to CCTP.
- **R3: the operating wallet is the depositor; there is no separate Gateway wallet.** Cost if wrong: the Gateway balance and the operating balance are separate figures to read.
- **R4: an EOA delegate created through Circle, never a key Vestiarion holds.** Cost if wrong: none known.
- **R5: a salt derived from the attempt's key, and the route kept on the intent.** A transfer whose POST gave no answer is sent again unchanged, or held for a person. Cost if wrong: one person's check in a rare case.
- **R7: a person's Approve and pay uses the intent's route.** An intent that has none yet (it was held before any attempt) is paid through CCTP. Cost if wrong: a held payout that could have gone through Gateway goes through CCTP.
- **R6: no withdrawal from Gateway in this version.** Cost if wrong: funds stay in Gateway until they are paid out.

## 4. Tests

- **The Gateway module:**
  - the burn intent and its typed data match Circle's reference;
  - the salt is derived from the attempt;
  - the estimate is parsed, with forwarding fees;
  - the balance is read;
  - transfer status is read in each state.
- **The live provider (fake Circle client and fetch):**
  - a payout signs and submits, and is confirmed with the mint hash;
  - one still pending is matched;
  - a fee above the ceiling sends nothing;
  - reconciliation reads it and never sends.
- **The AP stage:**
  - Gateway is chosen when the balance and fee allow;
  - CCTP is chosen otherwise;
  - the ledger records the payout route;
  - the guardrails stand.
- **Funding:**
  - the signer is created once;
  - the delegate is added once;
  - approve and deposit carry keys;
  - each step is a ledger entry;
  - only an owner or admin can fund, in a live workspace.
- **Migration (PGlite):**
  - `gateway_signers` and its tenancy;
  - `payment_intents.payout_route` and its check.
- **The payment intent:** the route is written on the first attempt, and a later attempt keeps it even when the balances would choose otherwise.
- **UI:**
  - the Treasury card;
  - the decision card's route.

## 5. Rollout

1. The partner runs `npm run db:migrate` for 0045.
2. In testnet-2, the partner funds a Gateway balance of 3 USDC.
3. The partner adds a 1 USDC payable to the Base Sepolia vendor.
4. Record the transfer id, the mint on Base Sepolia, and the ledger entries here.
