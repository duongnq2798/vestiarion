# Every module on its workspace's network: phase 1b of the mainnet plan

Date: 2026-10-05. Status: designed under the standing autonomy grant, on the partner's "okay merge xong đi rồi triển khai
viết spec luôn". This is phase 1b of the mainnet plan. It follows:

- the network foundation (#207, `2026-10-05-network-foundation-design.md`);
- two approvals (#208);
- payment integrity (#214).

Rulings carry their cost if wrong.

## 1. Why

- **What phase 1 did.** It gave each workspace a network (`orgs.network`) and each network a profile
  (`src/lib/network.ts`). It also stops a mainnet workspace from paying (N3).
- **What it left.** The modules still use Arc testnet's facts:
  - 63 literal identifiers in 32 files, counted by the ratchet (`tests/network-ratchet.test.ts`);
  - about 120 uses, in 47 files, of constants named for testnet: `ARC_TESTNET_USDC`, `ARC_TESTNET_EURC`,
    `ARC_TESTNET_RPC_URL`, `ARC_TESTNET_DOMAIN`, `ARC_TESTNET_USYC`, `ARC_TESTNET_CHAIN_ID`, `ARC_NATIVE_USDC`,
    `USDC_BY_CHAIN` and `PAYEE_CHAINS`.
- **What goes wrong if N3 is lifted today.** A mainnet workspace would run on testnet facts:
  - its escrow and spending-limit wallets would be created on ARC-TESTNET;
  - its fees and balances would be read from the testnet RPC;
  - its receipts would be checked against testnet;
  - its links would open the testnet explorer;
  - its payees' home chain would read ARC-TESTNET.
- **Done when.** No code that acts for a workspace, or for a record of one, reads a testnet fact. It reads its
  workspace's profile, or its record's. Arc testnet behaves exactly as it does today.

## 2. Rulings

- **P1. Where the network comes from.**
  - **Code that acts for a workspace** reads the workspace's profile from its scope, through `workspaceNetwork()`.
    - This covers the agent's cycle, server actions, the API and per-workspace jobs.
    - `workspaceNetwork()` is the profile of `currentOrgConfig().network`.
    - Outside a workspace's scope it throws, as `currentOrgConfig()` does. There is no default.
  - **Code that handles a record** reads the network the record carries.
    - A payment intent has `network` (0075).
    - Anything that names a chain is on that chain's network. A chain id belongs to exactly one network's payee list,
      so `networkOfChain` answers. For example, a payee link's status says `ARC-TESTNET`.
    - This covers receipts, explorer links, notices, GitHub comments and the public payee and pay pages.
  - **Client components** get what they need from the profile as props from their server page. `network.ts` stays
    pure data.
  - *Why:* the scope is how a workspace's Circle credentials reach its provider. Reading the network from the same
    place means the two never disagree. A record's own network outlives the scope it was made in.
  - *Cost if wrong:* a module that runs outside any scope throws where it read testnet before. The test suite finds
    those, and they are given the record's network.
- **P2. A provider is built for one network.**
  - `LiveProvider`, `SimulateProvider` and the hybrid are built with the profile. `getChainProvider()` passes the
    workspace's.
  - Every chain fact they use comes from that profile:
    - the transfer's chain name;
    - USDC's and EURC's addresses;
    - the RPC for fees, balances and contract reads;
    - CCTP's domain and Iris;
    - Gateway's API;
    - the USYC contracts;
    - the swap's chain and adapter.
- **P3. A workspace's home chain is its network's.**
  - **The home chain** is where a payee is paid directly: the profile's `circleBlockchain`, `ARC-TESTNET` or `ARC`.
    - A counterparty, payee link or intent with no chain is on its workspace's home chain.
  - **The payee chains move into the profile** (`payeeChains`).
    - Each entry carries its id, label, CCTP domain, USDC address, RPC and transaction explorer.
    - Arc testnet's list is itself, then the three Sepolia chains that CCTP and Gateway pay to.
    - Arc mainnet's list is `ARC` alone, since CCTP and Gateway are not verified there.
  - **Who reads the workspace's list:**
    - `payeeChain` and `paidAcrossChains`;
    - the intake's chain select and its validation;
    - the API's default chain;
    - the payee link;
    - Pay a freelancer;
    - GitHub bounties;
    - the sample data;
    - the agent's cross-chain checks.
  - **A chain not on the workspace's network** is refused in plain words: "ARB-SEPOLIA is not a chain this workspace
    pays on."
  - **An unknown chain** is refused, rather than read as Arc testnet. Today, `payeeChain` reads any unknown value as
    Arc testnet.
    - The exception is a row from before 0044, whose chain is null. It is on the home chain.
  - *Cost if wrong:* a value written before 0044 that is neither null nor a known id now throws.
    - 0044 rewrote every such value to `ARC-TESTNET`, and its check refuses new ones, so none exist.
- **P4. Wallets are created on the workspace's chain.** Circle is asked for the profile's blockchain by:
  - escrow;
  - the spending limit's agent wallet;
  - Gateway funding;
  - a new workspace's simulated accounts.
- **P5. A feature its network lacks refuses, by name.**
  - The features: CCTP and Gateway payouts, the real USYC reserve, the EURC swap, the agent's x402 purchases, hosted
    wallets and passkey wallets.
  - Each reads its part of the profile. Where that part is null, it refuses with "<feature> does not run on
    <network> yet".
  - The agent and the pages leave such a feature out:
    - no other chain is offered;
    - no swap is proposed;
    - no service is bought;
    - the real reserve cannot be turned on.
  - No module falls back to testnet's values.
- **P6. A link names its network.**
  - `arcTxUrl(network, hash)` and `arcAddressUrl(network, address)` take the network:
    - in the app, where pages pass the workspace's network down;
    - in Telegram, Slack, emails and GitHub comments, from the intent or the workspace in scope.
- **P7. What stays Arc testnet on purpose.** Each is listed in the ratchets, with its reason:
  - **Demo data** that exists only on testnet: the founding seed (`seed.ts`), the design page's fixtures and the docs
    screenshots.
  - **`/open`**, which shows both networks by design.
  - **The platform's own x402 service** (the payee history it sells) and the Gateway facilitator it settles through.
    They are a testnet service of the platform, not of a workspace.
  - **The passkey wallet page `/wallet`**, since Arc testnet is the one network with Modular Wallets here.
    - A payee link offers that wallet only when the paying workspace's profile has `modularWallets`.
  - **The public API's chain enum.** It keeps today's testnet values (see §3).
- **P8. Two ratchets.**
  - **The identifier ratchet (N8)** falls to the P7 files only.
  - **A second ratchet** counts imports of the testnet profile and of the constants named for it outside
    `network.ts` and the tests. The names are `ARC_TESTNET`, `ARC_TESTNET_*`, `ARC_NATIVE_USDC`, `USDC_BY_CHAIN` and
    `PAYEE_CHAINS`.
    - The named constants are deleted.
    - The count falls to the P7 files.
  - Each ratchet lists, for each file it allows, why.
- **P9. Testnet unchanged, and mainnet still pays nothing.**
  - N3 stays: a mainnet workspace gets no Circle credentials, so its provider refuses.
  - Every existing test passes. Where a test named a constant this phase deletes, it reads the profile instead, with
    the same value.
  - **A mainnet dry run.** It builds the modules with the mainnet profile, with Circle and the RPC faked, and checks
    that each asks for mainnet's facts or refuses by name:
    - wallets are created on `ARC`;
    - fee, balance and receipt reads go to `rpc.mainnet.arc.io`;
    - links point to `explorer.arc.io`;
    - the home chain is `ARC`, and the Sepolia chains are refused;
    - CCTP, Gateway, USYC, the swap, x402 buying, hosted wallets and passkey wallets refuse by name.

## 3. Not in this phase

- **The database's testnet facts**, which go in phase 2's migration:
  - `counterparties_chain_check` lists the testnet chains only;
  - `pay_link_preview` (0050) and `payee_link_status` (0053) name `ARC-TESTNET`.
  - None of them matters while N3 holds, since no mainnet workspace has a counterparty.
- **Copy (phase 1c).** "Arc testnet" appears in pages and messages 131 times, in 69 files.
  - The sentences this phase adds name the network from the profile.
  - The rest moves with phase 2's pages.
- **The public API's chain enum.** It keeps `ARC-TESTNET` and the Sepolia chains.
  - A mainnet workspace leaves `chain` out and gets its home chain.
  - Phase 2 adds `ARC`, with its changelog entry. Nothing in `/api/v1` changes now, so no changelog entry is due.
- **Going live on mainnet (phase 2):** lifting N3, live keys, an EOA operating wallet, an allowlist and
  `MAINNET_ENABLED`.

## 4. Testing

- **The profile:**
  - testnet's payee chains equal today's `PAYEE_CHAINS`, its USDC addresses equal `USDC_BY_CHAIN`, and its RPCs equal
    the receipt reader's;
  - mainnet's list is `ARC` alone;
  - the swap's adapter equals `ArcTestnet.kitContracts.adapter` in `@circle-fin/app-kit`, so drift is caught.
- **The helpers:**
  - `workspaceNetwork()` reads the scope and throws outside one;
  - `networkOfChain` finds each chain's network and refuses an unknown one;
  - `homeChain`, `payeeChain` and `paidAcrossChains` work per network;
  - links work for each network.
- **Each module's existing tests**, unchanged in what they assert.
- **The mainnet dry run (P9)**, one file, one case per module.
- **Both ratchets**, with self-tests.

## 5. Rollout

- Code only: no migration, no environment variable, and nothing for the partner to run.
- Proof on Arc testnet:
  - testnet-2 runs a cycle and pays as before;
  - a new receipt, notice and link point to Arc testnet;
  - `/open` is unchanged;
  - CI runs the full suite and both ratchets.
- Rollback: revert the merge. No data was written differently.
