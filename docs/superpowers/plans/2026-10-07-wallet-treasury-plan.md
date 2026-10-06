# Your own wallet as the treasury: implementation plan, part 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Arc mainnet, an owner takes a workspace live with their own browser wallet as its treasury, and every payment Vestiarion sends goes through the workspace's spending-limit contract from an agent wallet that holds only gas.

**Architecture:**
- A third wallet host, `external`. Its Circle credentials are Vestiarion's own mainnet agent account. Its provider (`WalletTreasuryProvider`) wraps the live Circle provider for the agent's contract calls, and reads the owner's wallet over the network's RPC.
- The owner's browser wallet signs and sends transactions the server builds. The server checks each result on chain before trusting it.

**Tech stack:** Next.js server actions, Supabase/PostgREST, Circle developer-controlled wallets SDK, viem 2.57 (server reads, and a browser wallet client over EIP-1193), vitest, pglite.

**Spec:** `docs/superpowers/specs/2026-10-07-wallet-treasury-design.md` (W1–W17). This plan covers its order-of-work steps 1–3 and 6. Part 2 covers steps 4–5: money in from logs, figures and stopping from the wallet, agent gas in the console, and cleanup and deletion beyond the migration.

## Global constraints

- **Network:** Arc mainnet only. `walletTreasury` is true on `ARC_MAINNET`, false on `ARC_TESTNET` (W2).
- **Env pair:** `MAINNET_AGENT_CIRCLE_API_KEY` must start `LIVE_API_KEY:`. Unset, mistyped or missing its secret, the choice is not offered (W4). `ARC_MAINNET_RPC_URL` is optional.
- **Migration** `0082_wallet_treasury.sql` is idempotent. The partner runs it with `npm --prefix E:/APP2028/hackathon-project-writeapi2 run db:migrate`.
- **Secrets:** no secret, key, token, password, wallet id or cipher appears in a Go live status or a panel prop (`tests/go-live-panel.test.tsx` L375-391).
- **Copy:** names the network from its profile `label` only. `tests/network-copy-ratchet.test.ts` counts must be updated when a count moves.
- **Docs:** every `GoLiveError` code gets a row in the guide's failure table (`tests/docs-guides.test.ts`), and the changelog gets an entry (AGENTS.md).
- **Commits:** plain, neutral messages ending with the Co-Authored-By line.

## Review focus

1. **A transaction hash the owner hands back that is not mined yet, or was replaced or dropped.** Each record step answers `pending`. A later call with the same or a new hash completes it. Nothing is recorded twice.
2. **An owner who deploys the contract twice**, for example after a page reload. The step must be idempotent: a second verified deployment replaces an earlier unapproved one, never an approved one.
3. **An address whose letters differ only in case** (checksummed or lower case) must match everywhere: proof, receipt `from`, contract getters, accounts row.
4. **Approve and pay for an `external` workspace while the contract is not yet enforced, or was revoked.** It is refused by name before any claim. Nothing is sent and nothing is left in `processing`.
5. **The cycle on an `external` workspace with the contract enforced.** The agent's payment carries `spendingLimit`, the provider refuses any transfer without it, and the operating balance has no gas carved out.

Tests pinning each: 1 and 2 in Task 7; 3 in Tasks 6 and 7; 4 in Task 10; 5 in Tasks 5 and 10.

---

### Task 1: Profile, configuration, RPC

**Files:**
- Modify: `src/lib/network.ts` (interface `NetworkProfile`; `ARC_TESTNET`, `ARC_MAINNET`)
- Modify: `src/lib/config.ts` (`ChainConfig`, `configFromEnv`, new `walletTreasuryAvailable`)
- Modify: `src/lib/circle/arcFees.ts` (`networkRpcUrl`)
- Modify: `.env.example`
- Test: `tests/wallet-treasury-config.test.ts`

**Interfaces:**
- **Produces:**
  - `NetworkProfile.walletTreasury: boolean`.
  - `ChainConfig.mainnetAgentCircleApiKey?: string`, `mainnetAgentCircleEntitySecret?: string`, `arcMainnetRpcUrl?: string`.
  - `walletTreasuryAvailable(config: VestiarionConfig, network: NetworkProfile): boolean`.
  - `networkRpcUrl(network)` returns `ARC_MAINNET_RPC_URL` for Arc mainnet when set.

- [ ] **Step 1: Failing tests**
  ```ts
  it("offers a wallet treasury on Arc mainnet only", () => {
    expect(ARC_MAINNET.walletTreasury).toBe(true);
    expect(ARC_TESTNET.walletTreasury).toBe(false);
  });
  it("is available only with a live agent key and its secret", () => {
    const base = configFromEnv({ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "LIVE_API_KEY:a:b", MAINNET_AGENT_CIRCLE_ENTITY_SECRET: "s" });
    expect(walletTreasuryAvailable(base, ARC_MAINNET)).toBe(true);
    expect(walletTreasuryAvailable(base, ARC_TESTNET)).toBe(false);
    expect(walletTreasuryAvailable(configFromEnv({ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "TEST_API_KEY:a:b", MAINNET_AGENT_CIRCLE_ENTITY_SECRET: "s" }), ARC_MAINNET)).toBe(false);
    expect(walletTreasuryAvailable(configFromEnv({ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "LIVE_API_KEY:a:b" }), ARC_MAINNET)).toBe(false);
  });
  it("reads Arc mainnet over ARC_MAINNET_RPC_URL when set, and never Arc testnet's override", () => {
    // runWith a config holding arcRpcUrl and arcMainnetRpcUrl
    expect(networkRpcUrl(ARC_MAINNET)).toBe("https://keyed.example/arc");
    expect(networkRpcUrl(ARC_TESTNET)).toBe("https://testnet-keyed.example");
  });
  ```
- [ ] **Step 2:** Run `npx vitest run tests/wallet-treasury-config.test.ts`. Expected: FAIL (undefined export or field).
- [ ] **Step 3: Implement.**
  - Add `walletTreasury` to the interface, documented as W2. Set it to `false` in `ARC_TESTNET` and `true` in `ARC_MAINNET`, after `goLiveOpen`.
  - In the config, read `MAINNET_AGENT_CIRCLE_API_KEY`, `MAINNET_AGENT_CIRCLE_ENTITY_SECRET` and `ARC_MAINNET_RPC_URL` with `trimmed`.
  - `walletTreasuryAvailable` is `network.walletTreasury && network.id === "arc-mainnet" && key?.startsWith(network.circleKeyPrefix) && Boolean(secret)`. It reads `config.chain` before `orgConfig` strips the pair, so `orgConfig` also passes a boolean `walletTreasuryAvailable` on the org's chain (Task 3).
  - `networkRpcUrl`: Arc testnet uses `arcRpcUrl`; Arc mainnet uses `arcMainnetRpcUrl`, falling back to the profile's.
  - Add the three variables to `.env.example` with one comment block, after `MAINNET_ALLOWLIST`.
- [ ] **Step 4:** Rerun Task 1's test plus `tests/network.test.ts`, `tests/network-mainnet-dry-run.test.ts` and `tests/network-copy-ratchet.test.ts`. Expected: PASS. Update the ratchet only if a count moved.
- [ ] **Step 5:** Commit "Offer a wallet treasury on Arc mainnet when the deployment has an agent account".

### Task 2: Migration 0082

**Files:**
- Create: `supabase/migrations/0082_wallet_treasury.sql`
- Test: `tests/wallet-treasury-migration.test.ts`. Mirror `tests/spending-limit-migration.test.ts`: `createDatabase`, `applyMigrations`, `asTenant`/`asServiceRole` from `tests/support/pglite.ts`.

**What the migration does:**
- **`orgs`:**
  - Drop and re-add `orgs_wallet_host_check` as `wallet_host is null or wallet_host in ('own','hosted','external')`.
- **`spending_limit_contracts`:**
  - `treasury_kind text not null default 'circle'`, with check `in ('circle','external')`.
  - `treasury_address text`, with the address-format check, and `treasury_kind <> 'external' or treasury_address is not null`.
  - `approve_tx_hash text`, with check `approve_tx_hash is null or approve_tx_hash ~ '^0x[0-9a-fA-F]{64}$'`.
  - Drop and re-add `spending_limit_contracts_enforced_check` as `not enforced or (address is not null and agent_address is not null and (approve_tx_id is not null or approve_tx_hash is not null))`.
- **`accounts`:** add `inbound_from_block bigint` (part 2 reads it; added now so the partner runs one migration).
- **`delete_sandbox_org(p_org_id, p_inactive_before)`:** redefined as in 0030, plus a refusal before the deletes:
  ```sql
  if v_org.wallet_host = 'external' and exists (select 1 from public.spending_limit_contracts where org_id = p_org_id and approve_tx_hash is not null) then
    raise exception 'has_wallet_approval: % has an approval from its wallet, and such a sandbox is never deleted automatically', v_org.slug;
  end if;
  ```
- **Footer:** `notify pgrst, 'reload schema';` and a commented rollback.

- [ ] **Step 1: Failing tests:**
  - an `external` host is accepted, and `'custodial'` is refused;
  - an external row needs `treasury_address`;
  - an external row can be enforced with `approve_tx_hash` and no `approve_tx_id`;
  - a circle row still needs `approve_tx_id` to be enforced;
  - `delete_sandbox_org` refuses `has_wallet_approval`, and still deletes a plain sandbox;
  - replaying every migration twice leaves the same constraints.
- [ ] **Step 2:** Run `npx vitest run tests/wallet-treasury-migration.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run that test, `tests/spending-limit-migration.test.ts`, `tests/delete-org-migration.test.ts`, `tests/rls.test.ts` and `tests/hosted-wallets-migration.test.ts` if it exists. Expected: PASS.
- [ ] **Step 5:** Commit "Add the wallet host for an owner's own wallet, and keep its approved sandbox from cleanup".

### Task 3: Org configuration

**Files:**
- Modify: `src/lib/dal/org-config.ts` (`OrgRow.wallet_host`, `orgConfig`)
- Modify: `src/lib/config.ts` (`ChainConfig.walletHost` union, `walletTreasuryAvailable?: boolean`)
- Modify: `src/lib/platform/go-live.ts` (`OrgState.walletHost` and `GoLiveStatus.host` unions; `orgState` keeps `external`)
- Modify: `src/lib/circle/provision.ts` (`walletSetName` gives `vestiarion-agents` for `external`)
- Test: `tests/wallet-treasury-org-config.test.ts`

**Interfaces:**
- **Produces:**
  - `walletHost: "own" | "hosted" | "external" | null` everywhere it is typed.
  - `WALLET_TREASURY_NOT_CONFIGURED` (`src/lib/dal/org-config.ts`): `"Vestiarion's agent account on Arc mainnet is not configured on this deployment"`.
  - `AGENT_WALLET_SET = "vestiarion-agents"` (`provision.ts`).

**Rules:**
- The mainnet agent pair is stripped from `platformChain` exactly as the hosted pair is. `walletTreasuryAvailable` is passed instead, computed from the base config.
- `walletHost === "external"`:
  - On Arc mainnet with the pair present (and a live prefix), `circleApiKey`/`circleEntitySecret` are the agent pair.
  - Otherwise `credentialsUnreadable` is `WALLET_TREASURY_NOT_CONFIGURED` (mainnet), or `FeatureOffError("Paying from your own wallet", profile).message` (a network without `walletTreasury`).
  - The workspace's own credential columns are never opened.
- The mainnet switch (`MAINNET_OFF`) withholds the agent pair too.

- [ ] **Step 1: Failing tests:**
  - an external mainnet org gets the agent pair;
  - an `own` or `hosted` org never holds it, under any key: walk the config like the hosted R4 test;
  - an external org on a deployment without the pair is unreadable with the message;
  - Arc mainnet switched off withholds it;
  - `walletSetName(org, "external")` is `vestiarion-agents`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run that test, `tests/org-config*.test.ts`, `tests/hosted-*.test.ts`, `tests/go-live-lib.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit "Give a workspace paying from its own wallet Vestiarion's agent account, and only that".

### Task 4: Chain reads for a wallet treasury

**Files:**
- Create: `src/lib/treasury/chain.ts`
- Test: `tests/wallet-treasury-chain.test.ts`, with a fake `fetch` answering JSON-RPC by method.

**Interfaces:**
- **Produces:**
  ```ts
  export interface TreasuryReceipt { status: "success" | "reverted"; from: Hex; to: Hex | null; contractAddress: Hex | null }
  export interface TreasuryChain {
    receipt(hash: Hex): Promise<TreasuryReceipt | null>;   // null while not mined
    code(address: Hex): Promise<Hex>;                      // "0x" for none
    simulateDeploy(input: { from: Hex; data: Hex }): Promise<Hex>; // eth_call with no `to`: the runtime code
    read(to: Hex, data: Hex): Promise<Hex>;                // eth_call; throws on revert
    usdcBalance(owner: Hex): Promise<bigint>;              // 6 decimals, the profile's USDC
    allowance(owner: Hex, spender: Hex): Promise<bigint>;  // 6 decimals
    nativeBalance(address: Hex): Promise<bigint>;          // 18 decimals
  }
  export function treasuryChain(network: NetworkProfile, options?: { rpcUrl?: string; fetch?: typeof fetch }): TreasuryChain;
  ```
  Built on viem `createPublicClient({ transport: http(rpcUrl ?? networkRpcUrl(network), { fetchFn, timeout: 10_000 }) })`. `receipt` maps viem's `TransactionReceiptNotFoundError` to null.

- [ ] **Step 1: Failing tests:**
  - each method sends the expected JSON-RPC method and decodes the answer;
  - an unmined receipt is `null`;
  - a reverted `read` throws;
  - `simulateDeploy` sends `eth_call` with no `to`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Read an owner's wallet and contract over the network's RPC".

### Task 5: The provider for a wallet treasury

**Files:**
- Create: `src/lib/circle/wallet-treasury-provider.ts`
- Modify: `src/lib/circle/types.ts`: `ChainProvider.treasury?: "circle" | "external"`, absent meaning circle.
- Modify: `src/lib/circle/index.ts`: `getChainProvider` builds it for `walletHost === "external"`; `hasNoProvider` is unchanged, since the pair is present.
- Modify: `src/lib/agent/pay.ts` (`syncOperatingBalance`) and `src/lib/agent/balances.ts` (`liveOperatingBalance` callers; `syncOnChainBalances` `walletsOnly`; `refreshOnChainBalances`).
- Test: `tests/wallet-treasury-provider.test.ts`, `tests/wallet-treasury-balances.test.ts`

**Interfaces:**
- **Consumes:** `TreasuryChain` (Task 4); `LiveProvider` (`src/lib/circle/liveProvider.ts`); `readSpendingLimitContract()` (`src/lib/circle/spending-limit-setup.ts`).
- **Produces:**
  ```ts
  export const WALLET_CONTRACT_ONLY = "This workspace pays only through its wallet's spending limit contract.";
  export class WalletTreasuryProvider implements ChainProvider {
    readonly treasury = "external";
    constructor(live: LiveProvider, network: NetworkProfile, deps?: { chain?: TreasuryChain; treasuryOf?: (accountId: string) => Promise<{ address: Hex; contract: Hex | null }> });
  }
  ```

**Rules:**
- `transfer(params)` without `params.spendingLimit` throws `new PaymentsDisabledError(WALLET_CONTRACT_ONLY)` and sends nothing. With it, it delegates to `live.transfer`. `reconcileTransfer` delegates.
- `findTransferByRef` delegates only with `options.walletId`, and is null without it.
- `getBalance(id)` is `min(usdcBalance(address), allowance(address, contract))` in USDC (6 decimals). With no contract yet the allowance is 0.
- `getTokenBalance(id, "EURC")` is the wallet's EURC `balanceOf`, as display only.
- `depositToEarn` and `withdrawFromEarn` reject with `FeatureOffError("The reserve", network)`. No `batchTransfer`, `swapForEurc` or `listInboundTransfers` (part 2).
- `mode` is `"live"`, `earnMode` is `"simulate"`, and `network` and `estimatedFeeUsd` come from `live`.
- **Gas set aside from the operating balance:** `syncOperatingBalance` and `syncOnChainBalances` set aside `0` when `provider.treasury === "external"`, else `network.gasReserveUsdc` as now. The notional-reserve carve-out is skipped too.
- **Accounts that count as having a wallet:** `walletsOnly` and `refreshOnChainBalances` count an operating account with an `address` as a wallet for an `external` workspace.

- [ ] **Step 1: Failing tests:**
  - refuses a transfer without the contract, and the live transfer is never called;
  - delegates one with it;
  - the balance is the lesser of the balance and the allowance;
  - no allowance before a contract means 0;
  - earn is refused by name;
  - `getChainProvider()` in an external org's scope is a `WalletTreasuryProvider`;
  - `syncOperatingBalance` stores 5, not 4.9, for 5 USDC on an external treasury;
  - refresh works for an operating account with an address and no Circle wallet.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run those tests, `tests/circle-*.test.ts`, `tests/balances*.test.ts` and `tests/pay*.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit "Pay from an owner's wallet only through its contract, and read its balance from the chain".

### Task 6: Checks on the owner's proof, the deployment and the approval

**Files:**
- Create: `src/lib/treasury/verify.ts`
- Test: `tests/wallet-treasury-verify.test.ts`. Uses a fake `TreasuryChain`, plus a real viem account (`privateKeyToAccount` with a fixed test key) to sign the proof.

**Interfaces:**
- **Consumes:** `TreasuryChain`; the artifact (`src/lib/spending-limit/artifact.json`); `SPENDING_LIMIT_ABI`.
- **Produces:**
  ```ts
  export function walletProofMessage(input: { orgSlug: string; network: NetworkProfile; address: Hex; issuedAt: string }): string;
  export async function verifyWalletProof(input: { message: string; signature: Hex; address: Hex; orgSlug: string; network: NetworkProfile; now?: number }): Promise<{ ok: true; issuedAt: string } | { ok: false; reason: string }>;
  export function deploymentData(input: { usdc: Hex; treasury: Hex; agent: Hex; dailyUnits: bigint; weeklyUnits: bigint }): Hex;
  export type ChainCheck<T> = { state: "pending" } | { state: "refused"; reason: string } | ({ state: "verified" } & T);
  export async function verifyDeployment(chain: TreasuryChain, input: { txHash: Hex; usdc: Hex; treasury: Hex; agent: Hex }): Promise<ChainCheck<{ contract: Hex; dailyUnits: bigint; weeklyUnits: bigint }>>;
  export async function verifyApproval(chain: TreasuryChain, input: { txHash: Hex; usdc: Hex; treasury: Hex; contract: Hex; minimumUnits: bigint }): Promise<ChainCheck<{ allowanceUnits: bigint }>>;
  ```

**Rules:**
- **The proof message**, exactly these lines:
  ```
  Vestiarion: pay from this wallet
  Workspace: <orgSlug>
  Network: <label> (chain <chainId>)
  Wallet: <checksummed address>
  Issued: <ISO time>
  ```
  `verifyWalletProof` rebuilds it from the issued time it parses, and requires an exact match. The time must be within the last 10 minutes and not more than 1 minute ahead. `recoverMessageAddress` must equal the address, ignoring case.
- **The deployment:**
  - `null` receipt is pending; reverted is refused.
  - `from` must equal the treasury, ignoring case, and `contractAddress` must be present.
  - The contract's code must equal `chain.simulateDeploy({ from: treasury, data: deploymentData({ usdc, treasury, agent, dailyUnits: 1n, weeklyUnits: 1n }) })`, ignoring case.
  - The figures are read by `dailyLimit()` and `weeklyLimit()`.
- **The approval:**
  - `null` receipt is pending; reverted is refused.
  - `from` must equal the treasury, and `to` must be USDC.
  - `allowance(treasury, contract)` must be at least the minimum.

- [ ] **Step 1: Failing tests:**
  - **The proof:** accepts the owner's fresh signature; refuses another wallet's, a stale one, an altered workspace and a future time; mixed-case addresses match.
  - **The deployment:**
    - pending while unmined;
    - refused when reverted, sent by another wallet, or creating no contract;
    - refused when the code differs: another agent gives another runtime in the simulate fake;
    - verified with its figures.
  - **The approval:** pending; refused when sent by another wallet, sent to another contract, or below the minimum; verified.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Check an owner's proof, their contract's deployment and their approval on chain".

### Task 7: The setup steps

**Files:**
- Create: `src/lib/treasury/wallet-treasury.ts`
- Modify: `src/lib/circle/provision.ts`: `walletSetIdNamed(client, name)` is extracted from `treasuryWalletSetId`, which calls it.
- Modify: `scripts/circle-subscribe.ts`: also subscribes the mainnet agent account (`MAINNET_AGENT_CIRCLE_*`), when set (W15).
- Test: `tests/wallet-treasury-steps.test.ts`. Uses the fake supabase as `tests/go-live-lib.test.ts` does, a fake Circle client, and a fake `TreasuryChain`.

**Interfaces:**
- **Consumes:** Tasks 3, 4 and 6; `createWallet`, `walletIdempotencyKey`, `circleCall` (provision.ts); `defaultCircleClient`; `appendLedgerEntryBestEffort`; `withOrg`/`inScopeOf` pattern; `requireMainnetAccess` (exported from go-live.ts for reuse).
- **Produces:**
  ```ts
  export type WalletTreasuryStep = "wallet" | "agent" | "deploy" | "approve" | "gas" | "ready";
  export interface WalletTreasuryStatus {
    step: WalletTreasuryStep;
    wallet: string | null; agent: string | null; contract: string | null;
    dailyUsdc: number | null; weeklyUsdc: number | null;   // the contract's, once deployed
    walletUsdc: number | null; spendableUsdc: number | null; agentGasUsdc: number | null; // null when not read
    agentGasMinimumUsdc: number;                              // network.gasReserveUsdc
  }
  export class WalletTreasuryError extends Error { constructor(readonly code: WalletTreasuryErrorCode, message?: string) }
  export type WalletTreasuryErrorCode = "unavailable" | "not_allowed" | "proof_refused" | "not_an_eoa" | "wrong_step" | "invalid_figures" | "chain_refused" | "chain_unreadable" | "agent_failed";
  export interface PreparedTransaction { to: string | null; data: string; value: string /* wei, decimal */; chainId: number }
  export function walletTreasuryStatus(orgId: string, deps?): Promise<WalletTreasuryStatus>;
  export function proofMessage(input: { orgId: string; address: string }): Promise<string>;
  export function chooseWalletTreasury(input: { orgId: string; actorId: string; actorEmail?: string | null; address: string; message: string; signature: string }, deps?): Promise<void>;
  export function createAgentWallet(input: { orgId: string; actorId: string; actorEmail?: string | null }, deps?): Promise<void>;
  export function prepareDeployment(input: { orgId: string; dailyUsdc: number | null; weeklyUsdc: number | null }): Promise<PreparedTransaction>;
  export function recordDeployment(input: { orgId: string; actorId: string; txHash: string }, deps?): Promise<"pending" | "verified">;
  export function prepareApproval(input: { orgId: string; capUsdc: number | null }): Promise<PreparedTransaction>;
  export function recordApproval(input: { orgId: string; actorId: string; txHash: string }, deps?): Promise<"pending" | "verified">;
  export function prepareAgentGas(input: { orgId: string }): Promise<PreparedTransaction>; // 0.50 USDC native
  ```

**Rules:**
- Every step checks, in order: mainnet access, `walletTreasuryAvailable`, the workspace not live, and the expected host and step. `wrong_step` names the step it is on.
- **`chooseWalletTreasury`:**
  - The host must be null, with no credentials and no operating Circle wallet.
  - The proof must pass (`proof_refused` with its reason), and the address must have no code (`not_an_eoa`).
  - Then, conditionally (`wallet_host is null`), it sets `wallet_host='external'`.
  - It sets the operating account's `address` (where `circle_wallet_id is null`) and `inbound_from_block`. `inbound_from_block` is null in part 1; part 2 sets it.
  - Ledger: `treasury_wallet_proven` `{ by, address, message, signature, network }`.
- **`createAgentWallet`:** host `external` with a proven wallet.
  - The agent account's client creates an EOA in `vestiarion-agents`, with idempotency key `walletIdempotencyKey(orgId, "wallet-treasury-agent")`.
  - It upserts `spending_limit_contracts` `{ treasury_kind: "external", treasury_address, agent_wallet_id, agent_address, created_by }`, keeping a row that already has an agent.
  - Ledger: `agent_wallet_created` `{ by, address }`.
  - On production it ensures the agent account's notification subscription, best effort, within 10 s.
- **`prepareDeployment`:**
  - The figures are null or above 0; at least one is set; weekly is at least daily when both are set (`invalid_figures`).
  - The defaults are the workspace's `agent_budgets`.
  - `to: null`, `data: deploymentData(...)`, `value: "0"`.
- **`recordDeployment`:**
  - Pending passes through.
  - A refusal is `chain_refused` with the reason.
  - Verified, it writes `address` and `deploy_tx_hash` only where `approve_tx_hash is null`. A redeploy before approval replaces the address; after approval it is `wrong_step`.
  - It upserts `agent_budgets` with the contract's figures.
  - Ledger: `spending_limit_deployed` `{ by, contract, txHash, dailyUsdc, weeklyUsdc }`.
- **`prepareApproval`:** `to` is USDC; `data` is `approve(contract, cap ? usdcUnits(cap) : MAX_ALLOWANCE)`.
- **`recordApproval`:**
  - The minimum is 1 USDC, or the cap when it is less than 1.
  - Verified, it sets `approve_tx_hash` and `enforced: true`.
  - Ledger: `spending_limit_enforced` `{ by, contract, approveTxHash, treasury: "external", allowanceUsdc }`, where `allowanceUsdc` is null when unlimited.
- **`walletTreasuryStatus`:**
  - `wallet` when no address; `agent` when no agent; `deploy` when no contract; `approve` when not enforced.
  - `gas` when the agent holds less than the minimum. Read failures leave numbers null and keep the step.
  - Otherwise `ready`.

- [ ] **Step 1: Failing tests:**
  - **Proving the wallet:**
    - proves and records (the conditional writes and the ledger detail);
    - refuses a host already chosen, a contract address, and a bad proof.
  - **The agent wallet:** created once; a second call keeps the first agent.
  - **Preparing the deployment:** builds the data with the defaults and with given figures; refuses invalid figures.
  - **Recording the deployment:**
    - pending writes nothing;
    - verified writes the row, the budget and the ledger;
    - a second verified deployment before approval replaces the address, and after approval is refused.
  - **The approval:** prepared with a cap and unlimited; recorded, enforcing the row.
  - **The status:** walks every step.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Let an owner prove their wallet, deploy and approve its contract, and give its agent gas".

### Task 8: Go live

**Files:**
- Modify: `src/lib/platform/go-live.ts`
- Modify: `tests/docs-guides.test.ts` (`GO_LIVE_ERRORS`, `MESSAGES`)
- Test: `tests/go-live-lib.test.ts`, `tests/go-live-panel.test.tsx` (prop key-set)

**Interfaces:**
- **Produces:**
  - `GoLiveStatus.walletTreasuryAvailable: boolean` and `GoLiveStatus.walletTreasury: WalletTreasuryStatus | null`.
  - `GoLiveErrorCode` gains `"external_wallet"`: "This workspace pays from its owner's wallet; it takes no Circle account." It also gains `"wallet_treasury_unfinished"`: "Finish setting up the wallet first: its contract must be approved and its agent must hold gas."

**Rules:**
- **`goLiveStatus`:** for host `external`, the step is `wallets` until `walletTreasury.step === "ready"`, then `go_live`.
- **`connectCircle`** and **`chooseHostedWallet`** refuse an `external` host.
- **`goLive`** for `external`:
  - It needs `walletTreasuryStatus().step === "ready"` and the typed word.
  - It writes `mode: "live"` where `mode = 'sandbox'` and `wallet_host = 'external'`.
  - Ledger: `workspace_went_live` `{ by, network, treasury: "external" }`.

- [ ] **Step 1: Failing tests:**
  - status for each external stage;
  - connect and hosted refused;
  - go live refused while unfinished and done when ready.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Take a workspace live on its owner's wallet once its contract is approved and its agent has gas".

### Task 9: Server actions, the browser wallet, the Go live path

**Files:**
- Create: `src/app/actions/wallet-treasury.ts` (`"use server"`; each action `authorize(orgSlug, "org.administer")`, then `inOrg`, returning `{ ok, message, ... }` as `src/app/actions/go-live.ts` does)
- Create: `src/lib/browser-wallet.ts`. Client-safe, no server imports:
  - `discoverWallets(win)`: EIP-6963 announce/request, with a `window.ethereum` fallback named "Browser wallet".
  - `connect(provider)`: `eth_requestAccounts`.
  - `ensureNetwork(provider, profile)`: `wallet_switchEthereumChain`; on 4902, `wallet_addEthereumChain` with `{ chainId: 0x13b2, chainName: profile.label, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [profile.rpcUrl], blockExplorerUrls: [profile.explorer] }`.
  - `signMessage(provider, address, message)`: `personal_sign`.
  - `sendPrepared(provider, address, tx)`: `eth_sendTransaction` with hex value and data; returns the hash.
- Create: `src/components/treasury/WalletTreasurySteps.tsx` (client): one card per step, the wallet chooser, figures form, cap field, and pending re-check every 5 s for up to 2 min.
- Modify: `src/components/GoLivePanel.tsx`:
  - On the connect step, where `walletTreasuryAvailable`, a "Your own wallet" choice is shown first (Recommended), with the Circle form in a disclosure.
  - Host `external` renders `WalletTreasurySteps` on the wallets step, then the existing go-live step.
  - `ReplaceCredentials` and `HostedOwnAccount` are hidden for `external`.
- Test: `tests/browser-wallet.test.ts` (a fake EIP-1193 provider object), `tests/wallet-treasury-actions.test.ts` (owner-only, errors as messages), `tests/go-live-panel.test.tsx` (markup per step).

- [ ] **Step 1: Failing tests:**
  - discovery prefers EIP-6963 announcements and falls back to `window.ethereum`;
  - `ensureNetwork` adds Arc mainnet on 4902;
  - `sendPrepared` sends hex value and data with no `to` for a deployment;
  - actions refuse a non-owner and map `WalletTreasuryError` to its message;
  - the panel shows "Your own wallet" on mainnet with the pair, each step's heading, and no secret-like key.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Then check the page in the preview with a stubbed `window.ethereum`: discovery, connect, sign, and error paths render.
- [ ] **Step 5:** Commit "Set up an owner's wallet as the treasury from Go live".

### Task 10: People's payments through the contract

**Files:**
- Create: `src/lib/treasury/person-payment.ts`
- Modify: `src/lib/agent/approvals.ts` (`approveAndPay`: before the claim; `payInvoice` input)
- Modify: `src/lib/agent/milestone-decisions.ts` (`payHeldMilestone`: before the claim) and `src/lib/agent/orchestrator.ts` (`releaseHeldMilestone` takes an optional `spendingLimit`)
- Test: `tests/wallet-treasury-person-payment.test.ts`; additions to `tests/approvals.test.ts` and `tests/milestone-decisions.test.ts`

**Interfaces:**
- **Produces:**
  ```ts
  export class ContractRefusal extends Error {}
  export async function personPaymentThroughContract(input: { sourceType: "invoice" | "milestone"; sourceId: string; to: string | null; amount: number; currency: Stablecoin; crossChain: boolean }, deps?: { verdict?: typeof spendingLimitVerdict }): Promise<SpendingLimitPayment | null>;
  ```

**Rules:**
- It returns null unless `currentOrgConfig().chain.walletHost === "external"`.
- **Refusals** (`ContractRefusal`, by name):
  - EURC, or another chain: "Only USDC on <label> can be paid from your wallet's contract."
  - Not enforced: "This workspace's wallet has not approved its spending limit contract, so nothing can be paid from it."
  - `OverDailyLimit`/`OverWeeklyLimit`: "Paying <amount> USDC would pass the contract's <day|7-day> limit of <limit> USDC: <spent> USDC paid so far."
  - Another refusal: "The contract on <label> refused this payment (<error>)."
  - Unreadable: "The contract on <label> could not be read; nothing was paid. Try again in a moment."
- On the allowed path it returns `{ contract, agentWalletId, ref: spendingLimitRef(sourceType, sourceId) }`.
- **Approve and pay** calls it before the claim and maps `ContractRefusal` to `ApprovalError("payments_off", message)`. On success, `payInvoice` gets `spendingLimit`. **Pay now** does the same with `MilestoneDecisionError("payments_off", message)`, and `releaseHeldMilestone` passes it on.

- [ ] **Step 1: Failing tests:**
  - null for an own workspace;
  - each refusal message;
  - allowed returns the payment;
  - Approve and pay on an external org refuses over the limit with nothing claimed, and pays with `spendingLimit` set;
  - Pay now the same.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `tests/approvals.test.ts`, `tests/milestone-decisions.test.ts` and `tests/spending-limit-*.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit "Send a person's payment from an owner's wallet through its contract, within its figures".

### Task 11: Console, checklist and the spending-limit panel

**Files:**
- Modify: `src/components/vx/Treasury.tsx` (`balanceTileMode`): live with an external operating address.
- Modify: `src/lib/getting-started.ts`: the wallet step counts an external address; the fund step names the owner's wallet.
- Modify: `src/components/AgentBudgetPanel.tsx` and `src/app/actions/agent.ts`: for `external`, the On Arc section shows the contract's figures and spending read-only, with "Change them from your wallet" pointing to part 2. `enforceSpendingLimitAction` and `turnOffSpendingLimitAction` refuse `external` by name.
- Test: additions to `tests/agent-budget-panel.test.tsx`, `tests/getting-started.test.ts` and `tests/treasury-tiles.test.ts` (or wherever `balanceTileMode` is tested).

- [ ] **Step 1:** Write failing tests for each.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit "Show an owner's wallet as the treasury on the console".

### Task 12: Docs

**Files:**
- `content/docs/guides/go-live.mdx`:
  - a "Path C: Your own wallet" section with each step's button text quoted;
  - the "On Arc mainnet" section saying either path;
  - failure table rows for the new error codes and `WalletTreasuryError` messages the page shows.
- `ARCHITECTURE.md`: a "Wallet treasury" section (W1–W17 in short), and the `wallet_host` values.
- `content/docs/changelog.mdx`, dated 2026-10-07: the new ledger actions and their details, and `workspace_went_live.detail.treasury`.
- `README.md` and `.env.example`: the agent account variables.
- `tests/docs-guides.test.ts` quotes and counts; `tests/network-copy-ratchet.test.ts` if counts moved.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `npx vitest run tests/docs-*.test.ts tests/network-copy-ratchet.test.ts`. Expected: PASS.
- [ ] **Step 3:** Commit "Document paying from your own wallet".

### Finish

- [ ] `npm run verify` green, then a fresh whole-branch review on the most capable model. Fix Critical and Important findings in one pass, each with a test.
- [ ] Open the PR. Give the partner:
  - the `db:migrate` command;
  - the two env variables to set in Vercel as sensitive: `MAINNET_AGENT_CIRCLE_API_KEY` and `MAINNET_AGENT_CIRCLE_ENTITY_SECRET`, from a Circle production account used only for agent wallets, with its Wallets product unlocked;
  - optionally `ARC_MAINNET_RPC_URL`.
- [ ] After the migration and a read-only probe, merge on green. The partner then tries it with a few USDC on Arc mainnet.
