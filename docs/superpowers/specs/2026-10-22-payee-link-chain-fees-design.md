# What each network costs, on a payee link's chain choice

Date: 2026-10-22. Status: accepted.

## Why

A payee link can let a vendor choose where they are paid: the workspace's own network, or another chain through CCTP
(docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md P2). The vendor chooses blind:
- nothing says that sending to another chain costs the business a fee;
- nothing says the vendor is paid in full either way.

A vendor who would as gladly take USDC on Arc, or on the cheaper of two chains, cannot tell.

## What

**CF1. Each choice says its fee.**
- The workspace's own network: "No fee to send it here."
- Another chain: "Acme pays about 0.055 USDC to send it here.", with the business's name and the fee rounded to three
  decimals.
- Below the choices: "You get the full amount on any of them: no fee is taken from what you are paid."

**CF2. The fee is Circle's quote when the page opens.**
- `payeeLinkStatus` reads `bridgeFee` for each offered chain but the first, in the paying workspace's scope. These are
  read together, on the network of the chains offered.
- It quotes for what is owed to the payee in USDC and not paid yet, since only USDC crosses chains. With nothing owed,
  it quotes the forwarding fee alone.
- The fees go out with the status as `chainFees`.

**CF3. Never a figure that was not read.**
- Each fee read waits at most 3 seconds.
- A fee Circle does not give in time, or refuses, is null. Its choice then says "Acme pays a small fee to send it here."
- The choice itself is never held back for a fee.

## Not in this change

- Showing the fee on the console's payee link dialog.
- Ranking or preselecting the cheapest chain.

## Tests

- `tests/payee-links.test.ts`:
  - the fees read with the choices, for the USDC owed and not paid;
  - null when Circle refuses or is slow.
- `tests/payee-journey.test.ts`: `chainFeeNote`'s words.
- `tests/payee-links-actions.test.tsx`: the page shows each choice's fee and that the payee is paid in full.
