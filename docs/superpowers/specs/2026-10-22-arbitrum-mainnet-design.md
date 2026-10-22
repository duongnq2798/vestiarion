# Paying a vendor on Arbitrum from Arc mainnet

Date: 2026-10-22. Status: accepted.

## Why

Arc mainnet pays a vendor on Base through CCTP since Oct 19, with two real payouts as proof
(docs/superpowers/specs/2026-10-19-mainnet-base-payouts-design.md). Arbitrum is the other chain where many contractors
and crypto-native suppliers hold USDC. Circle's CCTP V2 serves Arc mainnet (domain 26) to Arbitrum One (domain 3) with
the forwarding service, so the payout code needs no new path, only the chain.

## What

**AR1. Arbitrum is one of Arc mainnet's payee chains.**
- Circle's blockchain name `ARB`, CCTP domain 3.
- Circle's native USDC on Arbitrum, `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`.
- The node `arb1.arbitrum.io/rpc`, and Arbiscan for transactions.
- These are the same USDC, domain and node Arc mainnet already brings USDC in from on Arbitrum.
- A vendor can be given an Arbitrum address, or choose Arbitrum on its payee link.
- A bill to it is paid like one to Base, from the operating wallet of a workspace on its own Circle account: burn on Arc
  with the forwarding hook, Circle mints on Arbitrum, the fee on top.
- Its receipt checks the mint on Arbitrum.
- A live slice carries an Arbitrum Sepolia vendor over as a vendor on Arbitrum, with no address, as Base Sepolia's goes
  to Base.
- Iris quoted the fast forwarded route on 2026-10-22: 0 bps, about 0.077 USDC to forward (Base: about 0.055). Under the
  10% fee cap, a bill under about 0.77 USDC is held for a person.

**AR2. The database allows it.** `counterparties_chain_check` takes `ARB` for a vendor only, like `BASE`. 0078 owns the
check, and 0044's first-run rewrite lists it too, since `db:migrate` re-runs both. A contractor is never on Arbitrum: a
milestone is paid on Arc only.

**AR3. A contract pays only the chains it was deployed for.**
- Version 2 of the spending limit contract fixes its `allowedDomains` when it is deployed, from the network's payee
  chains then. One deployed from now pays Base and Arbitrum; one deployed between Oct 19 and Oct 22, 2026 pays Base only,
  and refuses Arbitrum with `DomainNotAllowed`.
- Vestiarion reads the bitmask from the contract (`allowedDomains()`, once per contract, since it never changes), and
  offers a payee on a path C workspace only the chains its contract pays. While the read fails, it offers no choice.
- The agent's verdict is the contract's own `eth_call`, which already holds such a payout: "it was not deployed to pay
  that chain".
- Approve and pay refuses it by name: "Your wallet's contract was deployed before it could pay Arbitrum, so it refuses
  this payout; nothing was paid. Pay this vendor on a chain it pays, or from your own Circle account."

**AR4. The proof.** One real payout of 1 USDC from a team test workspace on its own Circle account to an Arbitrum
address, approved by a person. Its burn and its mint are recorded with the PR, as Base's were, and labelled a team
test, not traction.

## Not in this change

- Ethereum, Optimism, Polygon and Avalanche on Arc mainnet (D8, D10).
- Redeploying an older version 2 contract with Arbitrum.
- Gateway payouts on Arc mainnet.

## Tests

- `tests/payee-chains-network.test.ts`: Arbitrum in Arc mainnet's chains, equal to its inbound source.
- `tests/network-mainnet-dry-run.test.ts`: Arc mainnet pays ARC, BASE and ARB, and no Sepolia chain.
- `tests/mainnet-migration.test.ts`: an Arbitrum vendor accepted, a contractor refused, kept when 0044 and 0078 run
  again.
- `tests/payee-chain-choice.test.ts`: the chains a version 2 contract was deployed for, and none while unreadable.
- `tests/spending-limit-onchain.test.ts`: `contractAllowedDomains`, read once, null on no answer.
- `tests/wallet-treasury-person-payment.test.ts`: Approve and pay's words for `DomainNotAllowed`.
- `tests/live-slice.test.ts`: an Arbitrum Sepolia vendor goes over on Arbitrum.
