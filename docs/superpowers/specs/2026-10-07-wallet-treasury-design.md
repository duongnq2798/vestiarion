# Your own wallet as the treasury: a workspace that pays from a wallet its owner holds

Decided on 2026-10-07 by the implementer, under the partner's standing instruction and their choice of this option the same day ("Chọn C đi, bạn cứ làm cho tới khi hoàn thành"). Each decision states its reason.

## 1. Why

- **The only way onto Arc mainnet today is the customer's own Circle production account.** The owner must:
  - upgrade a Circle developer account to production, with payment details;
  - paste a `LIVE_API_KEY` into Go live;
  - register and keep an entity secret.

  Few businesses will do that.
- **A hosted mainnet wallet is not the answer.** Vestiarion would hold the entity secret of every customer's wallet, which makes it the custodian of their money. The tenancy design rejected that (decision D6, 2026-09-27). Testnet hosting is fine only because no real money moves.
- **Circle has no non-custodial agent wallet on Arc mainnet** (checked 2026-10-07):
  - Agent Wallets with spending policies list no Arc mainnet.
  - Modular Wallets (passkey smart accounts) run on Arc testnet only.
- **The treasury can instead stay in a wallet the owner holds.** Vestiarion already has a contract that lets an agent pay from a wallet within daily and 7-day figures: `contracts/VestiarionSpendingLimit.sol`, running on Arc testnet since the on-chain spending limit work.
  - Its `pay(to, amount, ref)` may be called only by the agent.
  - It moves USDC with `transferFrom(treasury, to, amount)` and refuses what passes either figure.
  - Only the treasury itself can change the figures.
  - It has no owner change, no upgrade and no withdraw, and money never sits in it.

## 2. What it builds

A workspace's owner can choose **Your own wallet** in Go live:

1. They connect a wallet from their browser, such as MetaMask, Rabby or Coinbase Wallet, and sign a message that proves it is theirs.
2. Vestiarion creates the workspace's **agent wallet**: a Circle developer-controlled wallet in Vestiarion's own Circle account, which holds no USDC of the customer's.
3. The owner deploys the workspace's spending-limit contract **from their own wallet**, with their daily and 7-day figures, then approves it to move their USDC.
4. On Arc mainnet, where the agent pays its own gas, the owner sends the agent 0.50 USDC for gas.
5. The owner goes live, typing `mainnet` on Arc mainnet as today.

From then on:
- Every payment Vestiarion sends goes through the contract: the agent's own, and the ones people approve. The contract's figures bound everything Vestiarion can move.
- The USDC stays in the owner's wallet until a payment moves it.
- The owner can stop every payment at once by revoking the approval from their wallet.
- No one in the workspace needs a Circle account or any key.

## 3. Decisions

- **W1. A third wallet host, `external`.**
  - `orgs.wallet_host` gains `external` beside `own` and `hosted`.
  - It is chosen only while the workspace has no Circle credentials and no wallets. Once chosen it is fixed, as hosted is (hosted wallets H4).
  - Connecting a Circle account and choosing hosted both refuse an `external` workspace.
- **W2. Where it runs.** Each network profile gains `walletTreasury: boolean`, true on Arc mainnet only for now.
  - It runs only where the profile allows it and the deployment holds agent credentials for that network (W4).
  - Arc testnet would need its reserve, escrow, Gateway and swap to tell a wallet treasury apart, and Arc mainnet has none of them, so testnet comes later (section 7).
- **W3. The owner's wallet is proven by a signature.** The browser wallet signs (EIP-191) a message naming the workspace, its network, the address and the time.
  - The server checks the signature recovers to that address, and that the message is the one expected for this workspace, signed in the last 10 minutes.
  - It checks the address has no code: an EOA. A smart-contract wallet such as a Safe needs its own transaction flow, which is out of scope.
  - The operating account's `address` becomes the wallet's; its `circle_wallet_id` stays null.
  - The ledger records `treasury_wallet_proven` with the address, the message and the signature. Anyone can check them again.
- **W4. Agent wallets live in Vestiarion's own Circle account for the network.**
  - On Arc mainnet it is a new pair, `MAINNET_AGENT_CIRCLE_API_KEY` and `MAINNET_AGENT_CIRCLE_ENTITY_SECRET`: a production key (`LIVE_API_KEY:`, refused otherwise) and the entity secret registered for it.
  - These wallets hold only gas, never a customer's USDC.
  - `orgConfig` gives an `external` workspace this pair, as it gives a hosted one the hosted pair. Mainnet's switch and allowlist apply unchanged.
- **W5. One agent wallet per workspace.**
  - It is created in the wallet set `vestiarion-agents`, under a deterministic idempotency key per workspace, with the profile's account type: an EOA on Arc mainnet, which pays its own gas in USDC.
  - **Why one per workspace:**
    - An EOA sends its transactions in nonce order, so one stuck payment holds back every later one from that wallet. A wallet per workspace keeps one customer's stuck payment from stopping another's.
    - The contract's agent is immutable, so replacing an agent touches one workspace.
- **W6. The contract is the existing one, unchanged, and the owner deploys it.**
  - The constructor takes `(USDC, owner's wallet, agent, daily, weekly)`.
  - The figures start at the workspace's agent spending limit. On Arc mainnet that is 50 USDC a day and 150 in 7 days unless changed, and the owner may change them before deploying.
  - **Deploying from the owner's wallet** keeps the contract theirs from its first block. It needs no Smart Contract Platform on Vestiarion's side, and the deployment costs cents of the owner's gas.
- **W7. The server builds every transaction; the browser wallet signs and sends it; the server checks the result on chain.**
  - Each step's action returns `{ to?, data, value? }`. The page asks the wallet to send it, then hands the transaction hash back. The server reads the receipt from the network's RPC, waiting up to 45 seconds, and answers `pending` when it is not mined yet.
  - **Why:** the browser carries no ABI or bytecode, and nothing the page could alter is trusted.
- **W8. A deployment is checked before it is trusted.** The receipt must be successful, from the owner's wallet, and creating a contract.
  - The code at that address must equal what the network's RPC returns for the same deployment simulated: `eth_call` with no `to`, the artifact's creation code, and USDC, the owner's wallet and the workspace's agent as arguments. Both Arc RPCs answer this (checked 2026-10-07).
  - That code embeds the token, treasury, owner and agent as immutables, so an equal code proves the wiring. The figures, which are storage, are read with `dailyLimit()` and `weeklyLimit()`.
  - The row gets `address` and `deploy_tx_hash`, and the ledger records `spending_limit_deployed`.
- **W9. The approval is checked on chain.**
  - The owner's wallet approves the contract on USDC (`0x3600…`).
  - The default is unlimited, because the contract's figures bound each day and week; the owner may set a cap.
  - The receipt must be a successful call from the owner's wallet to USDC, and `allowance(owner, contract)` must be at least 1 USDC.
  - The row gets `approve_tx_hash` and `enforced: true`, and the ledger records `spending_limit_enforced` with `treasury: "external"`.
- **W10. The agent's gas on Arc mainnet.**
  - The owner sends the agent 0.50 USDC: a plain send from their wallet, which the page builds.
  - Going live needs the agent to hold at least the profile's `gasReserveUsdc` (0.10).
  - The console says when the agent holds less, and offers the same send. Each payment costs the agent well under 0.01 USDC.
- **W11. Every payment goes through the contract.**
  - For an `external` workspace, the provider refuses a transfer that does not carry the contract with `PaymentsDisabledError`: "This workspace pays only through its wallet's spending limit contract." Nothing is sent.
  - The agent's payments already carry it when the contract is enforced.
  - A person's Approve and pay, and a held milestone's Pay now, now carry it too. This replaces, for this host alone, the rule that a person's payment never goes through the contract (on-chain spending limit R6). The contract's figures are what bound Vestiarion's reach over the owner's wallet.
  - Before sending, a person's payment is checked with the contract's own answer (`spendingLimitVerdict`). One over a figure is refused with the figure, the amount and what is left, and nothing is sent.
  - EURC, and payouts to other chains, cannot go through the contract and are refused by name.
- **W12. Balances.**
  - The operating balance of an `external` workspace is what the agent can move: the lesser of the wallet's USDC and its allowance to the contract, read over RPC.
  - No gas is set aside from it, because the agent pays the gas.
  - The reconcile stage, Refresh, the funds checks of a person's payment and Go live read it through the provider.
  - The console shows the wallet's USDC beside it.
- **W13. Money in.**
  - The receipts stage reads USDC arriving at the owner's wallet from Arc's logs.
  - It uses the `Transfer` logs of the system emitter `0xffff…fffE` (EIP-7708, 18 decimals), which every USDC send and ERC-20 transfer emits once. The ERC-20 contract's own log is not read, so nothing is counted twice.
  - It scans from a block cursor on the operating account (`inbound_from_block`), set to the head when the wallet is proven, in chunks of at most 10,000 blocks, advancing only past what it read.
  - Each transfer is keyed `onchain:<txHash>:<logIndex>` in `incoming_transfers.circle_tx_id`, so matching receivables and pay links works unchanged.
- **W14. Changing the figures and stopping, from the owner's wallet.**
  - The spending-limit panel of an `external` workspace builds `setLimits(daily, weekly)` and `approve(contract, 0)` for the owner's wallet to sign.
  - After confirmation:
    - new figures are written to `agent_budgets`, with `agent_budget_changed` and the transaction;
    - a revoked approval sets `enforced: false` and records `spending_limit_unenforced`.
  - Only the wallet's holder can do either. Vestiarion cannot raise a figure.
- **W15. Notices of payments.**
  - Circle's notifications for an agent's payments come from Vestiarion's agent account. `circle:subscribe` and agent creation make sure that account is subscribed.
  - The notification route already matches by Circle's transaction id. It checks the signature with the workspace's credentials, which for `external` are the agent pair.
  - The transfer watch already visits every workspace with a host.
- **W16. Cleanup and deletion.**
  - A sandbox whose wallet approved its contract is never deleted automatically (`delete_sandbox_org` refuses `has_wallet_approval`).
  - An owner deleting such a workspace is told to revoke the approval first, and given the transaction to do it.
- **W17. Nothing else changes.**
  - Payments keep their policy: guardrails, two approvals, new payees, the outflow budget and cash holds.
  - Ledger signing, receipts, explorer links and the transfer watch work unchanged: a payment through the contract emits the same `Transfer` to the payee.
  - Testnet's own-account and hosted paths are as they were.

## 4. Security

- **Vestiarion never holds the owner's USDC.** The agent wallet holds gas only.
- **If Vestiarion's agent account were compromised,** an attacker could pay any address up to what each contract's figures leave for the day and the 7 days, until owners revoke. On Arc mainnet those figures start at 50 USDC a day and 150 in 7 days. The new-payee and two-approvals rules are Vestiarion's own policy, not the contract's.
  - A payee allowlist in the contract would cap this further. It would cost the owner a signature for every new payee, so it is left for later (section 7).
- **Each payment's `ref` can be paid once** (`AlreadyPaid`).
- **Checks that make a workspace live:**
  - the owner's signature proves the address;
  - the deployment check proves it is Vestiarion's contract, wired to the right token, treasury and agent;
  - the approval check proves the allowance.
- **No secret reaches the browser,** and the page sends nothing the server did not build. Every result is read back from the chain by the server.

## 5. Components

- `supabase/migrations/0082_wallet_treasury.sql`:
  - `orgs.wallet_host` allows `external`.
  - `spending_limit_contracts` gains `treasury_kind` (`circle` | `external`, default `circle`), `treasury_address` and `approve_tx_hash`. Its enforced check accepts `approve_tx_hash` in place of `approve_tx_id`.
  - `accounts` gains `inbound_from_block`.
  - `delete_sandbox_org` gains its refusal.
- `src/lib/network.ts`: `walletTreasury`.
- `src/lib/config.ts`: `MAINNET_AGENT_CIRCLE_API_KEY`, `MAINNET_AGENT_CIRCLE_ENTITY_SECRET`, and `ARC_MAINNET_RPC_URL` (optional, for a keyed RPC).
- `src/lib/dal/org-config.ts`: the agent pair for `external`.
- `src/lib/treasury/rpc.ts`: the reads (receipts, code, balances, allowance, logs) on the network's RPC.
- `src/lib/treasury/verify.ts`: the deployment and approval checks.
- `src/lib/treasury/wallet-treasury.ts`: the steps (prove, create agent, prepare and record deployment, approval and gas) and the status.
- `src/lib/circle/wallet-treasury-provider.ts`: the provider for `external` (W11–W13).
- `src/app/actions/wallet-treasury.ts`: owner-only server actions (`org.administer`).
- `src/components/treasury/*`: the browser wallet (EIP-6963 discovery, `window.ethereum` fallback, adding or switching to the network) and the Go live steps.
- Approve and pay (`src/lib/agent/approvals.ts`) and Pay now (`src/lib/agent/milestone-decisions.ts`): the contract for `external`.
- Console: tiles, getting started, the spending-limit panel (W12, W14).
- Docs: the Go live guide's new path, ARCHITECTURE, the changelog (new ledger actions), README and `.env.example`.

## 6. Order of work

1. **Foundation:** migration, profile, config, org config, provider (payments and balances), deployment and approval checks.
2. **Setup:** the steps' library and actions, the browser wallet, the Go live path, going live.
3. **People's payments** through the contract.
4. **Money in** from logs.
5. **Figures and stopping** from the wallet, agent gas in the console, cleanup and deletion.
6. **Docs.**

Each step is its own commit and test set. One pull request carries steps 1–3 and 6, so a workspace can go live and pay. A second carries steps 4–5.

## 7. Not in scope

- A wallet treasury on Arc testnet (W2).
- Smart-contract wallets (Safe) and WalletConnect or mobile wallets.
- A payee allowlist in the contract.
- Moving an existing own or hosted workspace to its own wallet.
- EURC payouts from a wallet treasury.
