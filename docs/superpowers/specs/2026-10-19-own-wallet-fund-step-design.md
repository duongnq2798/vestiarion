# Fund it with USDC, for the owner's own wallet

Date: 2026-10-19. Status: built. Branch `fix/own-wallet-fund-step`. No migration.

## Why

On Oct 19, during the first live payment from an owner's passkey wallet through spending limit contract version 2, the
console's Get started checklist said, right after **Go live**: "Your wallet holds no USDC the agent can move, so the
agent cannot pay." Settings, on the same workspace at the same time, said "The agent can move 1.394558 USDC".

Both were right about what they read. The checklist's **Fund it with USDC** step reads the operating account's stored
`balance` (getting-started design G2). For a workspace paying from its owner's own wallet (wallet treasury W12), nothing
writes that figure before the agent's first cycle or the console's balance tile has read the chain. Settings reads the
chain itself (`walletTreasuryStatus`: the lesser of the wallet's USDC and its approval to the contract). The balance tile
does refresh the stored figure when the console opens, but it takes the answer itself and does not render the page again
(`refreshOnChainBalanceAction`), so the checklist rendered beside it keeps the stale 0 until the next visit.

## The rules (decided here)

- **F1. What the step counts.** For the owner's own wallet, the step is done once the agent can move USDC: the lesser
  of the wallet's USDC and its approval to the contract, as Settings shows it and as the provider's `getBalance` counts
  it. Before the contract exists, the agent can move nothing, as before.
- **F2. Read only when it matters.** The console reads it from the chain (`agentMovableUsdc`, two `eth_call`s over the
  network's RPC, no Circle call) only for the owner's checklist, only for a workspace paying from its owner's own wallet
  with the wallet chosen, and only while the stored figure is 0 or less, the one case where the step would say there is
  nothing. A funded workspace makes no extra read. The read runs alongside the checklist's own marks, so it adds no
  wait of its own beyond theirs.
- **F3. The chain's answer wins when read.** `GettingStartedInput.movableUsdc` carries it; when present, the step uses
  it instead of the stored figure. Null or absent (not read, not readable, or not an own wallet), the stored figure
  counts, as before.
- **F4. Best effort.** A read that fails or times out (the treasury chain's one-try RPC timeout) leaves the stored
  figure, so the console renders as it did. Nothing is written: the stored figure stays the balance tile's and the
  cycle's to write, compare-and-set, as before.
- **F5. Copy.** The step's text does not change. The Go live guide's own-wallet section says the step ticks from the
  same figure the console's cash shows.

## Considered and not done

- Writing the stored balance whenever Settings reads the chain. Settings is a page render; the stored figure has one
  writer outside a cycle (the balance tile's refresh, with its cooldown, its claim and its compare-and-set), and a
  second one on a page read would race it.
- Revalidating the console after the balance tile's refresh. The tile is kept out of revalidation on purpose: a
  revalidated page lands in the same render as the action's result and unmounts what was waiting on it.

## Tests

- `tests/getting-started.test.ts`: a live own-wallet workspace whose stored balance is 0 and whose chain read is
  1.394558 has **Fund it with USDC** done; a stored 0 with no chain read stays undone; a chain read of 0 stays undone
  whatever is stored; a Circle-hosted workspace ignores `movableUsdc`.
- `tests/wallet-treasury-steps.test.ts`: `agentMovableUsdc` answers the lesser of balance and allowance, 0 before the
  contract, null for a workspace not paying from its own wallet, and null when the chain cannot be read.
