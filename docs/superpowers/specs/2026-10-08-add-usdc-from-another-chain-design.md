# Add USDC from another chain

**Status:** design, 2026-10-08. Shadow mode SM5 (the mainnet slice): a person outside the team opens a workspace on Arc
mainnet, holds its treasury in a passkey wallet or their own wallet, and pays a real bill. Every step of that is
self-serve except one: getting USDC onto Arc mainnet. The go-live guide says "send USDC on Arc mainnet … from an exchange
or another wallet", and few people hold USDC on Arc yet. Most hold it on Ethereum, Base, Arbitrum or another chain CCTP
reaches.

## What it does

Wherever Go live asks for USDC on Arc, the page offers **Add USDC from another chain**: the person's browser wallet
sends USDC it holds on another chain to the workspace's wallet on Arc, through CCTP V2 with Circle's Forwarding Service.
Circle attests the burn and submits the mint on Arc itself, so the wallet on Arc needs no gas for it, which matters
because a new passkey wallet holds nothing. The person pays the other chain's gas, in its own currency, from the wallet
that holds the USDC. Vestiarion's server takes no part and holds nothing: the browser builds two transactions, the
person's wallet signs them, and Iris, Circle's attestation API, reports the mint.

The same Forwarding Service already pays payees on other chains from Arc testnet (CCTP payouts, 2026-10-01): this is the
same burn with the hook, in the other direction, from a wallet in the browser.

## Requirements

- **B1. Sources per network.** A network's profile lists where USDC can come from: CCTP's domain for the network, Iris,
  and the source chains, each with its chain id, CCTP domain, USDC contract, TokenMessengerV2, RPC, explorer and the
  currency its gas is paid in. Arc mainnet: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, Linea, Unichain and
  World Chain. Arc testnet: their Sepolia, Fuji and Amoy testnets. The values are Circle's own, checked in a test against
  App Kit's chain table (`@circle-fin/bridge-kit/chains`), so a typo in a contract address fails CI.
- **B2. The fee, before anything is signed.** Iris's fee for a fast, forwarded transfer from the source's domain to
  Arc's (`/v2/burn/USDC/fees/{source}/{arc}?forward=true`): the forwarding fee's high estimate plus the protocol's
  minimum fee in basis points of the amount, rounded up. That is the burn's `maxFee`. The page says it as "at most", and
  what arrives as "at least" the amount less it. An amount at or below the fee is refused, as is a moment Iris does not
  answer or lists no fast forwarded route.
- **B3. Two transactions.** `approve(TokenMessengerV2, amount)` on the source's USDC, skipped when the allowance covers
  the amount, then `depositForBurnWithHook(amount, arcDomain, recipient, usdc, 0, maxFee, 1000, "cctp-forward")`.
  The wallet is switched to the source chain first, and asked its chain again just before each send: a wallet moved to
  another chain sends nothing. The approval is confirmed on chain before the burn is asked for.
- **B4. Checks before the wallet asks.** The wallet's USDC on the source chain is read first; an amount above it is
  refused in words, before any prompt. Amounts are USDC with at most 6 decimals, above 0.
- **B5. On its way, across reloads.** Once the wallet answers with the burn's hash, it is kept in the browser
  (`localStorage`, keyed by network and recipient) until Iris reports the mint. The page then says it is on its way,
  links the burn on the source chain's explorer, and asks Iris every 5 seconds. A reload or a second visit resumes the
  same transfer. Once minted, the page links the mint on Arc's explorer and reads the wallet's balance again. A burn the
  source chain refused is forgotten and said. A transfer still not minted after 30 minutes can be forgotten by the
  person; nothing is sent again.
- **B6. Where it shows.** Collapsed behind one secondary button, wherever Go live asks for USDC on the network:
  the passkey route's **Add USDC to your wallet** step; the own-wallet route's setup steps, whose transactions pay gas in
  USDC on Arc; step 3 and a live workspace's details, for the treasury wallet (path C) or the operating wallet (paths A
  and B). The recipient is named as the page names it: "Your wallet", "the operating wallet". On Arc testnet the faucet
  stays the first way; the control is there for testnet USDC held on another testnet.
- **B7. Words.** A wallet's refusal is said as elsewhere ("You declined it in your wallet."). A source chain that refused
  a transaction says so and that the USDC did not leave the wallet. No copy says "no real money": on Arc mainnet it is
  real USDC, and the page says "Arc mainnet".
- **B8. Docs.** The go-live guide gets a section **Add USDC from another chain**, linked from path C's two routes and
  from "Step 3 has no faucet"; ARCHITECTURE.md a bullet. No API or webhook changes, so no changelog entry.

## Not in this slice

- Buying USDC with a card (Circle's onramp needs a partner API key).
- Sources that are not EVM chains (Solana needs another wallet).
- Recording money brought in on the ledger: a deposit into the treasury is the owner's own money moving, and the
  balance is read from the chain as before.
- Topping up the agent's gas wallet from another chain.

## Tests

- Pure: the sources against App Kit's chain table; amount parsing; the fee from Iris rows (exact units, rounding up,
  refusals); the two calls decoded back; the mint from Iris messages; the kept transfer per network and recipient.
- The send, over a stand-in EIP-1193 wallet: approval skipped when allowed; approve, its receipt, then burn; a chain
  mismatch refused before any send; a refused burn forgotten; the hash kept before its receipt is read.
- Markup: each placement renders the button, and none renders on a network without sources.
- `tests/cctp.test.ts` unchanged and green: the payout code shares the hook, the fee rows and the mint lookup.
