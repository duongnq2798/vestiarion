# Arc mainnet behind a switch: phase 2a of the mainnet plan

Date: 2026-10-06. Status: designed under the standing autonomy grant, on the partner's "tiếp đi" after phase 1b (#218).
This is phase 2 of the mainnet plan (artifact "Vestiarion Mainnet Plan", version 2, option A). It follows:

- the network foundation (#207, `2026-10-05-network-foundation-design.md`);
- every module on its workspace's network (#218, `2026-10-05-network-threading-design.md`);
- payment safety (#205, #206), two approvals (#208) and payment integrity (#214).

Nothing in this phase moves money on Arc mainnet, and nothing uses real funds. Rulings carry their cost if wrong.

## 1. Why

- **Where #218 left it.**
  - Every module reads its workspace's network.
  - Rule N3 still keeps any workspace on Arc mainnet from paying: no path creates one, and one set by hand gets no
    Circle credentials.
- **What a business needs before it can pay real USDC on Arc mainnet, and does not have:**
  - Nothing creates a mainnet workspace, and nothing takes one live.
  - The treasury wallets are smart accounts (SCA) whose gas Circle Gas Station pays.
    - On mainnet, Circle bills Gas Station to a card.
    - It refuses to create an SCA until a paymaster policy exists (Circle error 155509).
  - A payment's token is chosen by its symbol. Circle lists two "USDC" entries for every Arc wallet:
    - the native token (18 decimals, no contract address);
    - the ERC-20 at `0x3600…0000` (6 decimals).

    Read from an Arc testnet wallet on 2026-10-06. A token anyone deploys and names "USDC" would pass the same test:
    as the token sent, as the balance read, or as money received.
  - A workspace with Circle credentials pays before it goes live. This is finding 1 of the mainnet plan: real money
    follows credentials, not `orgs.mode`.
  - The database refuses `ARC` as a payee's chain, and two link functions name `ARC-TESTNET`.
  - The public API's `chain` enum has no `ARC`.
- **Done when:**
  - The dry run works:
    - On a deployment where `MAINNET_ENABLED` is on, a person on the allowlist creates a workspace on Arc mainnet.
    - They connect its own live Circle account, create its wallet, and read its balance.
    - Nothing is sent.
  - Such a workspace pays only after an owner on the allowlist takes it live by typing "mainnet".
  - Arc testnet behaves exactly as it does today.

## 2. Rulings

- **M1. Two platform settings.**
  - `MAINNET_ENABLED` turns Arc mainnet on.
    - It is read like `PAYMENTS_DISABLED`: only `1`, `true` or `yes` turns it on.
    - Unset, or anything else, leaves it off.
  - `MAINNET_ALLOWLIST` lists the people who may open a mainnet workspace and take one live.
    - It holds email addresses, separated by commas or spaces, compared without regard to case.
    - Empty means nobody.
  - `mayUseMainnet(email)` is true when Arc mainnet is on and the address is listed.
  - *Cost if wrong:* adding a person needs an environment change and a redeploy, a few minutes. The pilot has two or
    three people.
- **M2. A workspace's network is chosen when it is created.**
  - The create form offers "Arc mainnet" beside Arc testnet only to a person `mayUseMainnet` allows.
    - The server action checks again, and otherwise refuses: "Arc mainnet is not open to this account yet."
  - `createWorkspace({ network })` sets the row's network right after `create_org`, before any account exists. Then it
    creates the accounts for that network:
    - **Arc testnet:** the two simulated accounts, as today.
    - **Arc mainnet:** one account, "Operating", on `ARC`, with a balance of 0.
      - There is no simulated balance.
      - There is no reserve: USYC does not run on mainnet, and the treasury stage runs only where a reserve account
        exists.
  - `org_created` records the network.
  - Every existing workspace stays on Arc testnet. No step moves a workspace between networks (option A).
- **M3. The network is fixed once a workspace has an account** (migration 0078).
  - The lock (0075 N2) also refuses a change once any account exists. `createWorkspace` sets the network before the
    first one.
  - This closes the hand-flip path: a sandbox whose account rows say `ARC-TESTNET` can no longer be moved to mainnet.
- **M4. Arc mainnet moves money only while it is switched on, and only once its workspace is live.**
  - `orgConfig` gives a mainnet workspace a hold (`chain.networkHold`):
    - **Switched off:** "Arc mainnet is switched off on this deployment."
      - Its Circle credentials are also withheld, as N3 did, so no Circle call is made at all.
    - **On, not live:** "This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live."
  - The platform's stop switch reads the hold first.
    - `paymentsHold()` returns the workspace's hold, or else the platform's.
    - `PaymentsDisabledError` carries that reason.
    - Every gate the stop switch built (payment safety S2–S5) then refuses with it:
      - the provider's money methods;
      - every direct Circle write that moves money or sets a contract: escrow, Gateway funding and the spending
        limit;
      - the agent's cycle;
      - Approve and pay, Pay now, Bring cash back and Fund Gateway.
    - The stop switch's audit, which found no path that moves money around it, covers the hold too.
  - Reads keep working while the hold stands, such as the balance on the Go live step. So does creating the wallets,
    which moves nothing.
- **M5. Arc mainnet never simulates.**
  - A mainnet workspace with no Circle account connected is never given the simulator. It gets no provider at all
    (`credentialsUnreadable`): "This workspace on Arc mainnet has no Circle account connected yet."
  - Sample data is refused there, since it exists to simulate payments.
  - The hybrid provider's simulated reserve refuses, by name, on a network without USYC.
- **M6. On Arc mainnet the operating wallet is an EOA.**
  - The profile gains `operatingWallet`:
    - **Arc testnet: `SCA`.** Gas Station pays its gas, free on testnet.
    - **Arc mainnet: `EOA`.** It pays its own gas in USDC, so there is no Gas Station bill.
  - `createTreasuryWallets` asks Circle for the profile's account type, on the workspace's own chain.
    - An account stored on another chain is refused: it is never given a wallet.
  - What needs a smart account refuses, by name, on a network whose operating wallet is an EOA:
    - **A batch** throws `BatchNotSentError`, so each payment goes alone, as today when a batch cannot be built.
    - **Escrow and the spending-limit contract** throw `FeatureOffError` at setup.
  - **Gas.** The operating balance that the agent and people spend from keeps the profile's `gasReserveUsdc` aside, so
    a payment never leaves the wallet unable to pay its gas.
    - Arc mainnet keeps 0.10 USDC. Arc testnet keeps 0, since its gas is sponsored.
  - *Cost if wrong:* if Circle will not create an EOA on `ARC`, the dry run stops at Create wallets and nothing else
    changes. That is the first thing the dry run proves.
- **M7. A stablecoin is chosen by its contract, never by its symbol** (both networks).
  - **USDC** is Arc's native token, or the ERC-20 at the profile's USDC address.
  - **EURC** is the ERC-20 at the profile's EURC address.
  - This applies to:
    - the token a transfer sends;
    - the balance read;
    - which inbound transfers count as money received.
  - Circle's order is kept. On Arc testnet the first matching entry is the one chosen today, so nothing changes there.
  - Any other token named "USDC" or "EURC" is ignored.
- **M8. Going live on Arc mainnet.**
  - **Who may.** Connect Circle, Create wallets and Go live on a mainnet workspace each need `mayUseMainnet` for the
    person doing it. Otherwise: "Arc mainnet is not open to this account yet."
  - **The key check names both networks.** A test key is refused on a mainnet workspace, as a live key is on a testnet
    one.
  - **The word.** Go live needs "mainnet" typed, trimmed and in any case: "Type mainnet to confirm that this workspace
    pays real USDC."
  - **The record.** `workspace_went_live` records the network.
  - **The panel** speaks the workspace's network:
    - no faucet;
    - a live key;
    - one wallet, an EOA;
    - the typed word;
    - "Real USDC moves when the agent pays."
- **M9. The agent starts tight on Arc mainnet.**
  - A new mainnet workspace starts with the agent's spending limit at 50 USDC a day and 150 USDC in 7 days.
  - On Arc mainnet a figure always stays. Removing both is refused: "A workspace on Arc mainnet keeps a daily or 7-day
    limit."
  - A cap on what one person may approve comes in phase 2b, before any workspace goes live on mainnet.
- **M10. Chats do not approve mainnet payments** (mainnet plan, step 8).
  - Approve from Slack or Telegram refuses a payable on Arc mainnet: "It is on Arc mainnet, where payments are
    approved in Vestiarion."
- **M11. The database takes Arc mainnet's chain** (migration 0078).
  - `counterparties_chain_check` accepts `ARC`, for any role.
  - 0044's rewrite of unknown chains keeps `ARC`. `db:migrate` runs every file each time, so without this an `ARC`
    payee would be rewritten to `ARC-TESTNET` on the next run.
  - `pay_link_preview` pays into the operating account on the workspace's own chain, and names that chain.
  - `payee_link_status` names the workspace's own chain for a payee that has none.
- **M12. The public API takes `ARC`.**
  - `chain` accepts every network's chains.
  - A chain off the workspace's network is refused in plain words, as the form refuses it: "ARC is not a chain this
    workspace pays on."
  - The changelog says so.
- **M13. Pages say which network.**
  - On a mainnet workspace, the workspace's layout shows a banner:
    - **Live:** "Arc mainnet: payments here move real USDC."
    - **Held:** the hold's reason.
  - In the shell, the Payments line names the network. The Yield line shows only on a network with USYC.
  - The workspace list marks a mainnet workspace.
  - Other copy that names Arc testnet moves in phase 2c.

## 3. Not in this phase

- **2b. Before any workspace goes live on mainnet:**
  - a cap on what one person may approve, and dual control above it;
  - a required limit for every payee;
  - a ceiling for one invoice.
- **2c. Copy.** "Arc testnet" appears 131 times in pages and messages.
- **2d. Stuck transfers.** An alert for a transfer that has not settled within N minutes.
- **The pilot (phase 3)** waits for the partner's decision, a production Circle account, and real USDC.

## 4. Testing

- **The settings:** `MAINNET_ENABLED` and `MAINNET_ALLOWLIST` as read, and `mayUseMainnet`.
- **Creating a workspace:**
  - the mainnet choice is offered and accepted only for an allowed person;
  - mainnet's one account on `ARC`, with no reserve and the budget's figures;
  - testnet's accounts as today.
- **The hold:**
  - `orgConfig` for a mainnet workspace in three states: switched off, on and not live, on and live;
  - each gate refuses with the hold's reason;
  - a live testnet workspace is unchanged.
- **Never simulating:** no provider without credentials, sample data refused, and the hybrid's reserve refused.
- **Wallets:** an EOA on mainnet, an SCA on testnet, an account on another chain refused, the gas reserve, a batch,
  escrow and the spending limit refused on an EOA network.
- **Tokens:** a fake "USDC" ignored for the token sent, the balance and inbound transfers; testnet's chosen ids
  unchanged.
- **Go live:** who may, the typed word, the key check's two messages, and the record.
- **Chats, the API enum and the banner.**
- **The migration (PGlite):**
  - `ARC` accepted;
  - 0044's rewrite keeping `ARC`;
  - the lock refusing a change once an account exists;
  - both link functions on a mainnet workspace.
- **The mainnet dry run** (`tests/network-mainnet-dry-run.test.ts`) gains the enabled path:
  - create, connect, wallet and balance;
  - every send refused until live;
  - the typed word.
- **Both ratchets** stay at or below their counts.

## 5. Rollout

- **Migration `0078_mainnet_go_live.sql`.** The partner runs it before the merge. Until `MAINNET_ENABLED` is on, the
  code works with or without it, since only a mainnet workspace reads what it changes.
- **The code merges with `MAINNET_ENABLED` unset.** Production does not change: no mainnet choice is offered, and
  testnet-2 pays as before.
- **Proof on Arc testnet:**
  - testnet-2 runs a cycle and pays as before;
  - the token id it sends is the one it sent before;
  - the create form offers no mainnet choice.
- **The dry run (partner, after Circle's "Upgrade to Prod"):**
  1. Set `MAINNET_ENABLED=1` and `MAINNET_ALLOWLIST` to the partner's address, then redeploy.
  2. Create a workspace on Arc mainnet.
  3. Connect the live key and its entity secret.
  4. Create the wallet.
  5. Read its balance, 0.

  Nothing is sent, and going live waits for phase 2b.
- **Rollback:** unset `MAINNET_ENABLED`, which holds every mainnet workspace at once, or revert the merge.
