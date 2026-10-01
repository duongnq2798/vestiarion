# Cross-chain payouts through CCTP

Date: 2026-10-01. Status: approved for implementation. It was decided under the standing autonomy grant, and each ruling carries its cost if wrong.

## 1. Why

The treasury lives on Arc, but a payee may want its USDC on another chain. Circle's CCTP V2 moves USDC natively: it burns on Arc and mints on the destination. With the **Forwarding Service**, Circle submits the mint itself, so neither we nor the payee need a wallet or gas on the destination chain.

The fee depends on the route. Measured on 2026-10-01 from `GET /v2/burn/USDC/fees/26/{domain}?forward=true`, for a fast transfer:

| Arc testnet → | Forwarding fee (USDC) |
|---|---|
| Base Sepolia (6) | 0.054 |
| Arbitrum Sepolia (3) | 0.12 to 0.13 |
| Ethereum Sepolia (0) | 1.5 to 2.2 |

Whether a 2 USDC invoice is worth a 1.85 USDC fee is exactly the kind of judgement the agent should make, and code should bound.

## 2. Behaviour

- **X1: a payee's chain.** `counterparties.chain` is one of `ARC-TESTNET` (the default), `BASE-SEPOLIA`, `ARB-SEPOLIA` or `ETH-SEPOLIA`.
  - The counterparty form's **Chain** field becomes a select.
  - Migration 0044 adds the check.
  - The address is the same EVM address format on every one.
- **X2: the route.**
  - A payee on Arc is paid by a direct transfer, as today.
  - A payee on another chain is paid through CCTP V2, as a fast transfer with the Forwarding Service, from the operating wallet on Arc. That takes two Circle contract executions:
    1. `approve(TokenMessengerV2, amount + maxFee)` on Arc's USDC (`0x3600…0000`);
    2. `depositForBurnWithHook(amount + maxFee, domain, recipient, USDC, 0x0, maxFee, 1000, forwardHook)` on TokenMessengerV2 (`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, Arc domain 26).
  - The payee is minted the invoice amount, and the fee comes on top, from the operating wallet.
- **X3: the fee.** The fee is read from Iris, the endpoint above, at finality threshold 1000:
  - `fee = forwardFee.high + amount × minimumFee (bps)`;
  - `maxFee` is that fee.

  It is read before the decision, for the agent, and again just before the burn.
- **X4: the agent weighs it.**
  - The prompt carries `payout: { chain, route: "cctp", feeUsdc, feePercent, expectedSeconds }`.
  - The system prompt says that a cross-chain payout costs the fee on top of the invoice, and that the fee should be worth paying.
  - Code holds a payment whose fee is above 10% of the amount (`bridge.fee_above_cap`).
- **X5: no fee, no payment.** When Iris does not answer, the payable is held (`bridge.fee_unavailable`).
- **X6: only USDC crosses.** A EURC payable to a payee on another chain is held (`bridge.unsupported_token`).
- **X7: limits and money.**
  - The counterparty's limit applies to the invoice amount; the fee is ours.
  - The money available to pay it is the operating USDC less the fee.
- **X8: in flight, then paid.**
  - Once the burn confirms on Arc, the invoice is `matched` ("Payment in flight"). The intent holds the burn.
  - Each reconciliation asks Iris for the message by the burn's transaction hash. A `forwardTxHash` means the mint happened: the invoice is `paid`, and the intent records the mint transaction and the destination chain.
  - An Iris that does not answer leaves the invoice `matched`.
- **X9: never two burns.**
  - The approve and the burn each carry a Circle idempotency key derived from the payment attempt's key, so a resubmission after an ambiguous outcome reuses them, and Circle creates neither transaction twice.
  - The provider id of a bridge is `cctp:<burn transaction id>`. Reconciliation reads the burn from it, and never sends again.
- **X10: sandbox.** A simulated workspace simulates the bridge. Both the burn and the mint are `sim_` references, and the payment is confirmed at once.
- **X11: shown and recorded.**
  - The decision card links the burn on arcscan and the mint on the destination chain's explorer.
  - The counterparty card names the chain.
  - The ledger detail carries `payout: { chain, route, domain, feeUsdc, maxFee }`, and the reconcile entry carries `mintTxHash`.
  - `/open` counts a bridged payment like any other settled payment, because the burn is on Arc. The amount is the invoice's; the fee is not paid out.

## 3. Pieces

- **`supabase/migrations/0044_cctp_payouts.sql`:**
  - `counterparties_chain_check`;
  - `payment_intents.destination_chain`, `mint_tx_hash` and `bridge_fee`.
- **`src/lib/circle/cctp.ts`:**
  - domains, contracts and the forwarding hook;
  - `bridgeFee(chain, amount)`, read from Iris;
  - the call encodings;
  - `forwardedMint(burnTxHash)`, read from Iris.
- **The providers:**
  - `TransferParams.destinationChain`;
  - the live provider's bridge path through `createContractExecutionTransaction`, and its reconcile for `cctp:` ids;
  - the simulate provider's simulated bridge.
- **`payments.ts` and `pay.ts`:** the destination chain, carried through, and the intent's new columns.
- **The AP stage and approvals:** the fee, the prompt facts, the three rules, the money check, and the ledger detail.
- **The counterparty form and card, and the decision card.**
- **Docs:** a "Pay a payee on another chain" section, and the changelog.

## 4. Rulings

- **R1: the Forwarding Service, not our own mint.** Without it, we would need a wallet and gas on every destination chain, plus an attestation poll. Cost if wrong: the forwarding fee on each payout.
- **R2: raw CCTP through Circle's contract execution, not Bridge Kit.** Bridge Kit takes no idempotency key for a whole bridge, so a retried call could burn twice. Our own calls carry keys derived from the payment attempt. Cost if wrong: more code to keep in step with CCTP.
- **R3: `maxFee` from `forwardFee.high`.** A fee that rises between the quote and the burn still mints, and any part of the fee not charged is minted to the payee. Cost if wrong: a payee can receive a few cents more than the invoice, at most the gap between the high and the actual fee (0.0003 USDC to Base Sepolia on 2026-10-01).
- **R4: a 10% fee cap.** Above that, the payout is held for a person. Cost if wrong: a person approves what the agent would not pay alone.
- **R5: paid on the mint, not on the burn.** The payee has the money only once it is minted. Until then the invoice is in flight. Cost if wrong: a payment shows as in flight for up to a cycle longer than needed.
- **R6: the payee chooses nothing through a payee link yet.** A payee link still sets an address only. The chain is set by a member. Cost if wrong: one more step for a member.

## 5. Tests

- **The CCTP module:**
  - the fee from Iris's answer (high, plus bps), and Iris failing;
  - the encodings against known calldata (bytes32 recipient, hook data);
  - the forwarded mint found, and not yet.
- **The live provider (fake Circle client):**
  - approve, then burn, each with its own key derived from the attempt;
  - the result is `pending` with `cctp:` id and the burn hash;
  - reconcile turns `confirmed` with the mint hash once Iris has `forwardTxHash`, stays `pending` before then, and never creates a transaction.
- **The simulate provider:** a confirmed simulated bridge.
- **The AP stage:**
  - a Base Sepolia payee is paid through the bridge, and the ledger has the payout;
  - an expensive route is held (`bridge.fee_above_cap`) even when the model says pay;
  - no fee answer means a hold;
  - a EURC payable to Base is held;
  - an Arc payee is unchanged;
  - the money check includes the fee.
- **Migration (PGlite):** the chain check, and the new columns.
- **UI:** the chain select, the card, and the decision card's two links.

## 6. Rollout

1. The partner runs `npm run db:migrate` (0044).
2. In testnet-2, add a payee on Base Sepolia with an address the partner controls, and a limit, then add a 1 USDC payable due today.
3. Watch the burn on arcscan and the forwarded mint on Base Sepolia. Record both here.

## 7. Rollout record

- **2026-10-01: 0044 applied, #89 merged as 090ff36.** Checked read-only before the merge:
  - `counterparties_chain_check` is in place: four chains, and another chain only for a vendor.
  - The intent's three new columns exist.
  - `payee_link_chain` is a definer and only the service role can run it.
  - 0038, 0040, 0042 and 0043 are intact.
  - All 11 counterparties were on Arc testnet.
- **The first payout across chains, in testnet-2.**
  - At 03:41:23 UTC the vendor Gozo was added on Base Sepolia: limit 5 USDC, address `0x19801dAA…Fdd12`, the partner's own wallet.
  - At 03:42:03 a 1 USDC payable due that day, with PO-107 and goods received, was added.
  - The event cycle started at 03:42:09. Iris quoted a fee of 0.05482 USDC, 5.48% of the amount.
  - The model (DeepSeek) and the written policy both decided to pay. The model's reasoning cites the route, the fee against the 10% hold threshold, and the 30-second settlement.
  - At 03:42:41 the payment confirmed and the invoice was paid. The decision came 40 s after the payable was added, and covers the approve, the burn and the forwarded mint.
  - Ledger #512 `ap_pay` carries `payout: { chain: "BASE-SEPOLIA", route: "cctp", domain: 6, feeUsdc: 0.05482 }`, and the mint in `execution`.
- **On chain (public RPCs):**
  - **Burn on Arc testnet:** tx `0xbc1961bbe2896e7e91d452498b595f1a1de8d45f34b7db8b3fd9d873d908d49c`, block 64884383, status 1. It was submitted through the ERC-4337 entry point for the operating SCA.
    - 1.054821 USDC moved from the operating wallet `0x97f8…6b6` to the TokenMinter and was burned: the amount plus a `maxFee` of 0.054821.
    - TokenMessengerV2 emitted its deposit event.
  - **Mint on Base Sepolia:** tx `0x6c749323f9e36efe21fcd5c33df2e55ba5db82040dbd06ff2a8872045c6fef9a`, block 47528935, status 1. Base Sepolia USDC minted:
    - **1.0** to the payee `0x19801daa…fdd12`;
    - 0.054821 to the Forwarding Service's fee recipient.
  - The payee got the invoice amount exactly; R3's "any part of the fee not charged" was nil here.
