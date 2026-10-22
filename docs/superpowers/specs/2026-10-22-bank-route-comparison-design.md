# USDC or a bank payout: what the vendor receives

Date: 2026-10-22. Status: accepted.

## Why

A vendor paid to a bank account in Mexico through BlindPay receives pesos after BlindPay's fees. BlindPay's quote takes
those fees from what the vendor receives (`cover_fees: false`, docs/superpowers/specs/2026-10-16-bank-payouts-design.md
B5). The same vendor paid in USDC to a wallet would receive the full amount: on Arc, nothing is taken from a transfer.
The approval card states the pesos, but not this comparison, which is often worth a message to the vendor.

The approval card's cost box (docs/superpowers/specs/2026-10-22-approval-total-cost-design.md) left bank payouts out.
This adds theirs.

## What

**BR1. A bank payout's card has a cost box.**
- **Invoice**: the invoice's amount.
- **BlindPay's fees, taken from it**: BlindPay's `feesSender`, as its quote for the listing read them.
- **Leaves the operating wallet**: the invoice's amount, since the fees come out of what the vendor receives.
- A note: "Paid in USDC to a wallet instead, Taller Norte would receive the full 100.00 USDC, with no fee taken: ask
  them for a wallet address with a payee link."

What the vendor receives in pesos stays where it was, in the line above the box.

**BR2. Only with a quote that matches.**
- No box without BlindPay's quote: not set up, below its 10 USDC minimum, EURC, not read, or already sent. The line
  above says why.
- No box while an early-payment discount applies: the listing reads its quote for the invoice's full amount.

**BR3. A comparison, not a choice.** Approve and pay still pays the bank account on file. Paying in USDC instead takes
the vendor's wallet address, through a payee link, and a person's confirmation like any new address.

## Not in this change

- A traditional bank wire's fees beside BlindPay's (Wise, if its public comparison API serves, D24).
- A public calculator.

## Tests

- `tests/approval-cost.test.ts`: `bankPayoutCost`'s lines and note; none without a quote or while a discount applies.
- `tests/approval-card-cost.test.tsx`: a bank payout's card shows the box with the comparison.
