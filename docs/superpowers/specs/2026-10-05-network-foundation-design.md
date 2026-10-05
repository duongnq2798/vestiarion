# A network for every workspace: the foundation for Arc mainnet, built on testnet

Date: 2026-10-05. Status: designed under the standing autonomy grant. This is phase 1 of the mainnet plan (artifact
"Vestiarion Mainnet Plan", version 2, option A: the network is chosen at go-live and locked, and mainnet is a workspace
of its own). The partner's brief of 2026-10-05 asked for this: keep Arc testnet primary, prepare for mainnet, and split
`/open` into Mainnet and Testnet so the figures are never mixed. Rulings carry their cost if wrong.

## 1. Why

- Nothing in the product knows which network it is on.
  - Real payments follow readable Circle credentials, not `orgs.mode`.
  - Every chain fact is a constant for Arc testnet, spread over about 65 files: chain ids, RPC and explorer hosts,
    token addresses, Gateway and CCTP endpoints, the swap adapter, and the "ARC-TESTNET" blockchain name.
- `/open` counts every live, confirmed Circle payment, whatever the network.
  - A mainnet payment would be added to testnet ones the day the first one happens.
- A mainnet workspace must never run on testnet constants, and a testnet one must never hold a mainnet key.
  - Either mistake moves real money wrongly, or loses it.

## 2. Rulings

- **N1. A workspace has a network.**
  - `orgs.network` is `arc-testnet` or `arc-mainnet`, with `arc-testnet` the default.
  - Every workspace today is on Arc testnet, so the default is the truth for all of them.
- **N2. The network is locked.**
  - Once a workspace has gone live, or holds a Circle wallet, its network never changes: a database trigger refuses it
    (`network_locked`).
  - Mainnet is a new workspace (option A), so no wallet, balance or ledger entry ever crosses networks.
- **N3. Mainnet pays nothing yet.**
  - No path in this phase sets `arc-mainnet`.
  - Should a workspace be on it anyway (set by hand), `orgConfig` marks its credentials unusable, and its chain provider
    refuses: it pays nothing until mainnet support ships (phase 2).
- **N4. A payment records its network.**
  - `payment_intents.network` is filled from the workspace when the intent is created, by a database trigger, so no
    caller can mislabel one.
  - Every existing intent is `arc-testnet`.
- **N5. The Circle key matches the network.**
  - A testnet workspace takes only a Circle test key (`TEST_API_KEY:`); a mainnet key (`LIVE_API_KEY:`) is refused with
    a plain message before anything is stored or called.
  - Hosted wallets are testnet only.
- **N6. One profile per network** (`src/lib/network.ts`).
  - Each network's facts live in one place: its name in copy, Circle's blockchain name, chain id, RPC, explorer, token
    addresses, CCTP domain, Gateway and Iris hosts, and what it supports.
  - The Arc testnet constants that exist today read their values from the testnet profile, unchanged.
  - Mainnet facts come from docs.arc.io and developers.circle.com as read on 2026-10-04: chain id 5042,
    `rpc.mainnet.arc.io`, `explorer.arc.io`, USDC `0x3600…0000`, EURC `0xbEf5…21c1`. They are checked again before
    phase 2 uses them; this phase moves no money with them.
  - Facts not yet verified for mainnet are null, and the features that need them (USYC, Gateway, CCTP, the swap,
    hosted wallets) are off there.
- **N7. `/open` shows each network apart.**
  - Arc mainnet comes first, then Arc testnet. Nothing is ever added across the two.
  - The three open functions gain a network argument (`open_numbers`, `open_first_payments`, `open_outcomes`, each
    `(p_since, p_network)`).
    - Workspaces count by their network; payments, by theirs.
    - The one-argument versions stay as they are, so the page keeps working whichever of the code and the migration
      lands first.
  - A network with no live workspace and no payment says so instead of a table of zeros.
  - Row labels drop "Arc testnet", since each section names its network. The method notes say the networks are counted
    apart.
  - `npm run numbers` prints both networks.
- **N8. No new testnet constants.**
  - A ratchet test lists the source files that still hold a testnet identifier, with how many each holds. A new one
    fails the test; moving one into the profile lowers the count.
  - The identifiers are `ARC-TESTNET`, the testnet RPC and explorer hosts, `5042002`, Gateway's and Iris's testnet
    hosts, the testnet EURC address and the swap's `Arc_Testnet` / `ArcTestnet`.
  - Copy that says "Arc testnet" is not counted yet.

## 3. Not in this phase

- **Phase 1b:** threading the workspace's network through every module.
  - This covers the provider, wallet creation, fee and balance reads, receipts, notices, explorer links, the payee
    chains list, and the copy.
  - Until then, only Arc testnet runs, which N3 enforces.
- **Phase 2:** going live on mainnet.
  - Live keys, an EOA operating wallet, an allowlist and `MAINNET_ENABLED`.
  - Tighter default limits, a cap for a person's approval, and dual control.

## 4. Testing

- **The migration (PGlite):**
  - the default, and the check;
  - the lock for a live workspace and for one holding a wallet, while a sandbox with no wallet may still change;
  - an intent's network taken from its workspace, even when the insert names another;
  - each open function counting one network only, with the one-argument versions unchanged.
- **`orgConfig`:** a mainnet workspace gets unusable credentials, and its provider refuses.
- **Go-live:** a live key refused for a testnet workspace, before anything is stored.
- **The profile:** the testnet values equal today's constants, and the mainnet facts are as read.
- **`/open`:**
  - two sections, mainnet first;
  - an empty network says so;
  - the loader keeps each network's figures apart;
  - row labels without the network name.
- **The ratchet:** today's counts, and a self-test that it finds an identifier.

## 5. Rollout

- Migration `0075_network.sql`, run by the partner before the merge. The code reads `orgs.network` with every
  workspace's settings, as it read `usyc_live_at` after 0054.
- It is additive: a column with a default on two tables, a trigger for each, and three new functions. The one-argument
  open functions stay.
- Rollback: revert the code. The columns' defaults leave every row as it was, and nothing else reads them.
- A section of `/open` that cannot be read says so on its own, and the other still shows.
- Proof on testnet:
  - `/open` shows an empty Arc mainnet section above the Arc testnet figures, which equal today's;
  - testnet-2 runs a cycle and pays as before, and its new intent says `arc-testnet`;
  - pasting a live key on Go live is refused.
