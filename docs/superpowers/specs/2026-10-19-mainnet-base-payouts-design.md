# Pay a payee on Base from Arc mainnet

Date: 2026-10-19. Status: built. Branch `feat/mainnet-cctp-base`. Migration: edits to 0044 and 0078 (re-run by
`db:migrate`), no new file.

## Why

The businesses most likely to make a first real payment on Arc mainnet pay a contractor who already wants USDC. That
contractor's wallet is almost never on Arc. Most hold USDC on Base, where Coinbase and most wallets put it. Today Arc
mainnet pays only Arc addresses (`payeeChains: [ARC]`, `cctp: null`), so such a bill cannot be paid. The only reason
written down was that CCTP was not verified on Arc mainnet (network threading P3).

It is verified now. Circle's CCTP tables list Arc as domain 26, with TokenMessengerV2 `0x28b5a0e9…cf5d` and
MessageTransmitterV2 `0x81D40F21…4B64` on mainnet, the same addresses as on Base. On 2026-10-19 Iris answered
`/v2/burn/USDC/fees/26/6?forward=true` with a fast forwarded route: minimum fee 0 bps, forwarding fee about 0.054 USDC.
A Standard Transfer from Arc is free; the forwarding fee pays the mint on Base.

## The rules (decided here)

- **B1. Base, on Arc mainnet, through CCTP V2 with the Forwarding Service.**
  - Arc mainnet's payee chains become Arc mainnet (domain 26) and Base (`BASE`, domain 6, USDC
    `0x833589fC…02913`).
  - Its `cctp` is domain 26, Iris `https://iris-api.circle.com` and TokenMessengerV2 `0x28b5a0e9…cf5d`.
  - One chain on purpose: Base is where contractors' USDC is. Others can follow once one real payout is proven.
- **B2. The same payout code as Arc testnet** (CCTP payouts R1-R8, X2, X7-X9):
  - the operating wallet approves and burns with the forwarding hook, each step under a key derived from the attempt;
  - Circle submits the mint, so there is no wallet or gas on Base;
  - the fee is read before the decision and again before the burn, and is paid on top of the invoice, so the payee
    gets the full amount;
  - it counts as paid on the mint;
  - above 10% of the invoice it is held (`bridge.fee_above_cap`); with no quote, `bridge.fee_unavailable`;
  - USDC only.
  On Arc mainnet the operating wallet is an EOA that pays its own gas in USDC. The approve and the burn are two
  ordinary contract executions from it.
- **B3. Only from the workspace's own Circle account (`wallet_host = 'own'`).** A workspace paying from the owner's own
  wallet through the spending-limit contract (`'external'`) cannot pay another chain yet. Its contract only does
  `transferFrom(treasury, payee)`, and USDC sent to TokenMessenger is not burned but lost. Every existing refusal
  stays and is named:
  - the agent holds such a bill under `workspace.onchain_limit_route` (onchain spending limit R4);
  - a person's payment is refused before anything is claimed ("Only USDC on Arc mainnet can be paid from your
    wallet's contract.");
  - the wallet provider refuses it (`WALLET_CONTRACT_ONLY`).

  The agent wallet never carries customer USDC to burn it (wallet treasury W4). A contract version with
  `payAcrossChains` is the follow-up. Approve and pay refuses it by name first, before any fee is asked for or the
  funds are counted (review of this change).
- **B4. Vendors only, and bills only**, as on Arc testnet (CCTP payouts review C1). A milestone is released on Arc,
  so a milestone for a vendor on another chain would send USDC on Arc to that vendor's address on the other chain,
  where it may never arrive. This was found in review. It was already true for Base Sepolia on Arc testnet, and with
  Base on Arc mainnet it would be real money. So:
  - such a milestone is refused when it is made (`another_chain`, on the console, the API and MCP);
  - Contractors does not offer such a vendor;
  - a release of one made earlier is held, and nothing is sent. An unreadable chain counts as another chain.
- **B5. The Chain field says it.** On Arc mainnet its help reads: "Another chain is paid from Arc through CCTP, for a
  fee, from your own Circle account; a workspace paying from your own wallet holds it for now". On Arc testnet it
  stays: "Another chain is paid from Arc through CCTP, for a fee".
- **B6. Database.** `counterparties_chain_check` allows `BASE` for a vendor. `db:migrate` re-runs every file, so both
  places change:
  - 0044 keeps `BASE` in its rewrite of unknown chains, which would otherwise turn a Base payee into ARC-TESTNET on
    every run;
  - 0078 adds it to the constraint, which would otherwise refuse the row on its next run.
- **B7. The live slice keeps Base, never the address** (live slice L3). A shadow workspace's address on another chain
  is a testnet address, so it is never carried. A vendor on Base Sepolia goes over as a vendor on Base with no address,
  so the Base address a person adds later is paid on Base and never on Arc. Any other chain goes over as Arc mainnet's
  own. The Base address waits for a person's confirmation, as any new address does.
- **B8. 0044's rewrite runs once.** The rewrite of unknown chains now runs only on the first application, before the
  check exists, so a later run of this file never rewrites a chain added since. A branch cut before this change still
  carries the old 0044, which would turn a Base vendor into ARC-TESTNET. Once Base vendors exist, migrations run only
  from origin/main, as `migrate-latest.ps1` does.

## What it does not do

- Pay through the spending-limit contract, or from a passkey or browser wallet. That needs a new contract.
- Pay EURC across chains, or any chain but Base.
- Change who may approve, the limits, or the fee cap.

## Proof

A 1 USDC bill to a Base address the partner holds, paid from an Arc mainnet workspace on its own Circle account. The
proof is the burn on Arc, the mint on Base, and the signed `ap_pay` with `payout.chain: "BASE"`. Money is moved only by
the partner.

## Cost if wrong

- If Iris has no fast forwarded route, the bill is held with `bridge.fee_unavailable`; nothing is sent.
- If the burn is confirmed but the mint is slow, the payment stays in flight until reconciliation reads the mint, and
  the stuck alert fires after 15 minutes. The money is not lost: the attested burn is minted to the payee.
