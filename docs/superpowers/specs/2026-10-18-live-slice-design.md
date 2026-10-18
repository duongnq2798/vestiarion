# Start the live slice: from shadow mode to the first real payment

Date: 2026-10-18. Status: built. Branch `feat/live-slice`. No migration.

## Why

Shadow mode lets a business try the agent on its real bills while it keeps paying them its own way. The guide and the
report then say to move a small share of the bills to a workspace on Arc mainnet, which pays real USDC. Until now that
meant starting from nothing: a new workspace, every supplier typed in again with its address, limit and notice email.
That is where a business that trusts the agent stops. The first real payment should be a few presses away from the
shadow workspace it has been watching.

## The rules (decided here)

- **L1. Where.** The workspace report's **Before a live slice**, in shadow mode. An owner chooses the vendors to pay for
  real, then **Open the live slice on Arc mainnet**. Every other member reads the steps.
- **L2. What it makes.**
  - A new Arc mainnet workspace, owned by the same person and named after the shadow one ("… live slice"), made by the usual
    `createWorkspace`. The usual rules hold:
    - the mainnet allowlist;
    - at most 3 workspaces per person per network;
    - the starting agent spending limit (50 USDC a day, 150 per 7 days);
    - two approvals above 100 USDC.
  - It is not live: going live (an own or passkey wallet, the spending limit contract, funding) is the business's next
    step, from Settings.
- **L3. What it carries.** Each chosen vendor is added to the new workspace with `createCounterparty`: its name, payment
  limit, notice email, purchase-order setting and jurisdiction. Nothing else is carried: no bill, no history, no verdict.
  - **The address** is carried only when it is the vendor's own: a mirror address (shadow mode S7) is a wallet in the
    shadow workspace's Circle wallets on Arc testnet, and is never carried.
  - A carried address waits for a person to confirm it in the new workspace, as an address from the API does, and the
    first payment to it still needs two people behind it.
  - A vendor with no address of its own is added without one. Its page in the new workspace offers a payee link, so it
    adds its own address or makes a passkey wallet.
  - A vendor with no payment limit is not carried (a vendor needs one).
- **L4. Signed.** The shadow workspace signs `live_slice_started` with who started it, the new workspace's id and slug,
  and each vendor carried with how its address came (`own`, `mirror` or `none`). Each vendor's `create_counterparty` in
  the new workspace says `via: "live_slice"` with the shadow workspace's and vendor's ids.
- **L5. Ticked.** The report's last step, a workspace on Arc mainnet for the slice, links the new workspace and ticks
  once it is live.
- **L6. Refused.**
  - Outside shadow mode.
  - On Arc mainnet.
  - By anyone but an owner.
  - With no vendor chosen, or more than 25.
  - When Arc mainnet is not open to the person.
  - At the workspace limit.
  - While a slice made earlier is still there: its link is shown instead.

## What it does not do

- Move bills. The business adds the bills it wants paid for real in the new workspace; the shadow workspace keeps
  running alongside it.
- Decide whether paying in USDC is lawful for the business or accepted by the supplier: the report says to check both.
- Copy limits a person changed in the shadow workspace: the new workspace starts from the mainnet starting limits.
