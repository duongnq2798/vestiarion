# What Approve and pay costs, on the approval card

Date: 2026-10-22. Status: accepted.

## Why

Before anyone approves a payment, they should see what it costs in all. Today the approval card shows the invoice's
amount. For a payee on another chain, the route's fee appears only in the confirm dialog, as a sentence. A discount that
still applies is named there too, and what the payee will receive is not said at all. A person deciding on 140 USDC to a
payee on Base cannot see, on the card, that about 140.21 USDC leaves the wallet and that the payee receives 140 USDC.

## What

**TC1. A cost box on every card waiting for Approve and pay.**
- Under "Pays to", each card shows what Approve and pay would cost if chosen now.
- It is not shown for a payment already sent, one in flight, one the agent is paying (processing), or a bank payout. A
  bank payout's card already says what the vendor receives in pesos and BlindPay's fees.

**TC2. Its lines.**
- **Invoice**: the invoice's amount.
- **Early-payment discount**: its percent and deadline, and what it takes off. Only while it still applies, by the same
  `amountToPay` rule Approve and pay pays by.
- **CCTP fee, about** or **Gateway fee, about**: for a payee on another chain, the fee of the route Approve and pay would
  take, as read for the page. "not read just now" when it was not read.
- **Leaves the operating wallet** (or **Leaves the Gateway balance**, for a Gateway payout, which pays the amount and its
  fee from there): what is paid plus the fee. This is the line to decide on. With a fee not read, it gives the amount
  "and the fee".
- **<Payee> receives**: what is paid, on their chain. For a CCTP payout, "at least" that much: what Circle does not charge
  of the most the fee could be is minted to the payee too.

**TC3. Arc's network fee.** Where the workspace's wallets pay their own gas (Arc mainnet's EOAs), it is a note under the
lines: about 0.00319 USDC a transaction (`ARC_FEE_USD`, measured from settled transfers). It is never read before the
transfer, so it is not added to the total. There is no note:
- on Arc testnet, where Circle's Gas Station pays it;
- for a Gateway payout, which sends no transaction of the wallet's on Arc.

## Not in this change

- A bank payout's cost lines.
- Reading the network fee before paying.
- Changing what the confirm dialog says.

## Tests

- `tests/approval-cost.test.ts`: the lines for a payee on Arc, with and without a discount; CCTP and Gateway, with the fee
  read and not; EURC; the network fee note on mainnet only, never for Gateway.
- `tests/approval-card-cost.test.tsx`:
  - the card shows the box;
  - it hides the box for a payment sent, in flight, processing, or to a bank account.
