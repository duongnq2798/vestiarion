# Passkey treasury Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner on Arc mainnet with no browser wallet creates a passkey wallet in Go live and sets it up as the treasury with one confirmation, while an owner with MetaMask or Rabby is led straight to it.

**Architecture:**
- A passkey wallet is a Circle Smart Account on Arc mainnet (chain `arc`), owned by a WebAuthn passkey.
- The server records it as the treasury (`wallet_host = 'external'`, `treasury_signer = 'passkey'`).
- The server builds the setup's three calls. The browser rebuilds and checks them, then sends them as one user operation through Circle's bundler.
- The server records the result from the chain, as the wallet route does.
- A recovery phrase is registered, or explicitly skipped, before going live.

**Tech Stack:** Next.js (repo's own), viem 2.57, `@circle-fin/modular-wallets-core` 1.0.16, Supabase/PostgREST, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-passkey-treasury-design.md` (K1–K12), on top of `docs/superpowers/specs/2026-10-07-wallet-treasury-design.md` (W1–W17).

## Global Constraints

- Arc mainnet only: `ARC_MAINNET.modularWallets = { chain: "arc" }`; the payee passkey wallet's `PASSKEY_WALLET_NETWORK` stays `ARC_TESTNET`.
- Env:
  - `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY`;
  - `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL`, optional, default `https://modular-sdk.circle.com/v1/rpc/w3s/buidl`.
- Migration `0083_passkey_treasury.sql` is idempotent and run by the partner with `npm --prefix E:/APP2028/hackathon-project-writeapi2 run db:migrate`.
- Every server action awaits `authorize(orgSlug, "org.administer")` first and returns `inOrg(auth, async () => …)` (tests/access-gates.test.ts).
- Nothing secret reaches the browser. The recovery words never leave it.
- Copy names the network from the profile `label`.
- Every `GoLiveError` code has a row in the guide. The changelog gets a dated entry.
- Commits: plain, neutral, ending with the Co-Authored-By line.

## Review Focus

1. **Server calls the browser did not expect.** A setup call list that differs in any byte from what the browser rebuilds must not be signed: another `to`, data, value, or an extra call.
2. **A setup sent whose recording was lost.** The same contract address is used again. The deploy call is left out when the code is there, and recording twice records once.
3. **A passkey that owns another wallet.** Logging in with the wrong passkey is refused by name before anything is signed.
4. **Going live on the passkey route without recovery decided** is refused, and the status says why.
5. **The wallet route unchanged but for the agent made with the choice.** Choosing a wallet still asks for its signed proof, and `treasury_signer` is `'wallet'`.

Tests pinning each: 1 in Task 3; 2 in Tasks 3 and 4; 3 in Task 6; 4 in Task 5; 5 in Task 2.

---

### Task 1: Profile, configuration and migration

**Files:**
- Modify: `src/lib/network.ts` (`ARC_MAINNET.modularWallets`).
- Create: `src/lib/passkey-treasury.ts`, browser-safe; only its config to start.
- Create: `supabase/migrations/0083_passkey_treasury.sql`.
- Tests:
  - `tests/passkey-treasury-config.test.ts`;
  - `tests/passkey-treasury-migration.test.ts`;
  - update `tests/network.test.ts` and `tests/passkey-wallet.test.ts`.

**Produces:**
- `passkeyTreasuryConfig(env?: { key; url }): PasskeyWalletConfig | null`. Null without the key. The default URL applies when none is given. Trailing slashes are dropped.
- Columns on `spending_limit_contracts`:
  - `treasury_signer text not null default 'wallet' check (treasury_signer in ('wallet','passkey'))`;
  - `recovery_address text check (null or 0x + 40 hex)`;
  - `recovery_skipped_at timestamptz`.

- [ ] **Step 1: Write the failing tests.**
  - Config: the key alone gives the default URL; a given URL wins; both empty gives null.
  - Migration (pg-mem, as `tests/wallet-treasury-migration.test.ts`): the three columns, the checks, and that a replay is idempotent.
  - `ARC_MAINNET.modularWallets` is `{ chain: "arc" }`, and payee passkeys stay offered on Arc testnet only.
- [ ] **Step 2:** Run `npx vitest run tests/passkey-treasury-config.test.ts tests/passkey-treasury-migration.test.ts tests/network.test.ts tests/passkey-wallet.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Read the mainnet passkey client key, and add the treasury's signer and recovery to its contract row".

### Task 2: The choice, the agent with it, and the status

**Files:**
- Modify: `src/lib/treasury/wallet-treasury.ts`.
- Test: `tests/passkey-treasury-steps.test.ts` (new), reusing `tests/support/wallet-treasury-world.ts`. Extend the world with the new columns and a contract-row POST/upsert.

**Produces:**
- `choosePasskeyTreasury(input: { orgId; actorId; actorEmail?; address }): Promise<void>`:
  - admit, as W3;
  - host null or external;
  - no credentials;
  - an address format check;
  - fixed once a contract is deployed;
  - the host is set and the operating address placed as W3 does;
  - the contract row upserted with `treasury_kind 'external'`, `treasury_address`, `treasury_signer 'passkey'`;
  - ledger `treasury_wallet_chosen` `{ by, address, signer: "passkey", network }`.
- `chooseWalletTreasury` also upserts the row with `treasury_signer 'wallet'`; nothing else changes.
- `WalletTreasuryStatus` gains:
  - `signer: "wallet" | "passkey"`;
  - `recovery: "registered" | "skipped" | null`;
  - `setupNeedsUsdc: number`: 0.55 on the passkey route (0.50 gas plus a 0.05 fee estimate), 0 otherwise.
- `WalletTreasuryStep` gains `"recovery"`: a passkey treasury that is enforced, whose agent has gas, and whose recovery is undecided.

- [ ] **Step 1: Write the failing tests.**
  - The passkey choice: places the address and records the signer and the ledger entry; refused once deployed; refused for a workspace with credentials or another host; refused when not admitted.
  - The wallet choice writes `treasury_signer 'wallet'` (Review Focus 5).
  - Status: a passkey treasury past gas without recovery is at `recovery`; with `recovery_address` or `recovery_skipped_at` it is `ready`; `setupNeedsUsdc` is 0.55 for passkey and 0 for wallet.
- [ ] **Step 2:** Run `npx vitest run tests/passkey-treasury-steps.test.ts tests/wallet-treasury-steps.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Choose a passkey wallet as the treasury, and say where its setup stands".

### Task 3: The setup's calls, built and checked

**Files:**
- Create: `src/lib/spending-limit/deployment.ts`, browser-safe. `deploymentData` moves here and is re-exported from `verify.ts`.
- Modify: `src/lib/passkey-treasury.ts`:
  - `DEPLOYMENT_PROXY`;
  - `spendingLimitSalt(orgId)`;
  - `passkeySetupCalls(…)`;
  - `checkPasskeySetup(server, expected)`.
- Modify: `src/lib/treasury/wallet-treasury.ts`: `preparePasskeySetup`.
- Tests:
  - `tests/passkey-treasury-calls.test.ts` (new);
  - `tests/passkey-treasury-steps.test.ts`.

**Produces:**
- `passkeySetupCalls(input: { usdc; treasury; agent; dailyUnits; weeklyUnits; capUnits: bigint | null; salt: Hex; deployed: boolean; gasWei: bigint }): { contract: Hex; calls: SetupCall[] }`, where `SetupCall = { to: Hex; data: Hex; value: bigint }`.
  - Calls in order: the proxy deploy (left out when `deployed`); `approve(contract, cap ?? max)` on USDC; the gas to the agent.
  - `contract` is `getContractAddress({ opcode: "CREATE2", from: DEPLOYMENT_PROXY, salt, bytecode: deploymentData(...) })`.
- `checkPasskeySetup(server: { contract; calls }, expected: { contract; calls })`: throws `Error("The setup Vestiarion sent is not the one this page expected; nothing was signed.")` on any difference.
- `preparePasskeySetup(input: { orgId; dailyUsdc; weeklyUsdc; capUsdc }): Promise<{ contract: Hex; calls: Array<{ to; data; value: string }>; chainId }>`:
  - requires the passkey signer, the agent, and no approval yet;
  - figures from `deploymentFigures`;
  - the cap validated as W9;
  - `deployed` is true where the code at the computed address is Vestiarion's for this wallet and agent.

- [ ] **Step 1: Write the failing tests.**
  - The three calls, byte for byte, for known inputs.
  - The contract address matches viem's CREATE2.
  - With `deployed`, two calls.
  - A capped approval.
  - `checkPasskeySetup` refuses (Review Focus 1):
    - another `to`;
    - other data;
    - another value;
    - an extra call;
    - a missing call;
    - another contract address.
  - `preparePasskeySetup`:
    - refuses a wallet signer;
    - refuses before the agent exists;
    - refuses after approval;
    - leaves the deploy out when the code is already there (Review Focus 2).
- [ ] **Step 2:** Run `npx vitest run tests/passkey-treasury-calls.test.ts tests/passkey-treasury-steps.test.ts tests/wallet-treasury-verify.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `verify.ts` re-exports `deploymentData`; its tests stay green.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Build a passkey wallet's setup as three calls the browser can check".

### Task 4: Recording the setup and the recovery from the chain

**Files:**
- Modify:
  - `src/lib/treasury/verify.ts`: `verifyDeployedAt`;
  - `src/lib/treasury/chain.ts`: the receipt already carries `status`;
  - `src/lib/treasury/wallet-treasury.ts`: `recordPasskeySetup`, `recordRecovery`, `skipRecovery`.
- Tests:
  - `tests/wallet-treasury-verify.test.ts`;
  - `tests/passkey-treasury-steps.test.ts`.

**Produces:**
- `verifyDeployedAt(chain, { contract; usdc; treasury; agent }): Promise<ChainCheck<{ dailyUnits; weeklyUnits }>>`:
  - no code: pending;
  - no creation code from the node: throws (unreadable);
  - other code: refused.
- `recordPasskeySetup(input: { orgId; actorId; txHash; contract }): Promise<"pending" | "verified">`:
  - a same-hash re-record answers "verified" and records nothing;
  - the receipt must be a success;
  - checks `verifyDeployedAt`, an allowance of at least 1 unit, and the agent's gas against its minimum (pending below it);
  - writes `address`, `deploy_tx_hash`, `approve_tx_hash = txHash` and `enforced = true` while `approve_tx_hash` is null;
  - the ledger, as the wallet route: `agent_budget_changed` when the figures differ, `spending_limit_deployed`, and `spending_limit_enforced` with `walletHost: "external"`, `signer: "passkey"`.
- `recordRecovery(input: { orgId; actorId; recoveryAddress; txHash })`: the receipt must be a success; writes `recovery_address`; ledger `treasury_recovery_registered` `{ by, recoveryAddress, txHash }`; once.
- `skipRecovery(input: { orgId; actorId })`: writes `recovery_skipped_at`; ledger `treasury_recovery_skipped` `{ by }`; once.
- Both require the passkey signer and an enforced contract.

- [ ] **Step 1: Write the failing tests.**
  - `verifyDeployedAt`: pending, refused and unreadable.
  - `recordPasskeySetup`:
    - pending until mined;
    - refused for a failed transaction;
    - refused for someone else's code;
    - refused with no allowance;
    - pending while the agent's gas is short;
    - records once, with the entries in the wallet route's shape (Review Focus 2).
  - Recovery and skip: once each; refused before setup; refused for the wallet route.
- [ ] **Step 2:** Run `npx vitest run tests/wallet-treasury-verify.test.ts tests/passkey-treasury-steps.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Record a passkey wallet's setup and recovery from the chain, once".

### Task 5: Actions and going live

**Files:**
- Modify:
  - `src/app/actions/wallet-treasury.ts`;
  - `src/lib/platform/go-live.ts`, only if the status's `recovery` step needs a message.
- Tests:
  - `tests/wallet-treasury-actions.test.ts`;
  - `tests/wallet-treasury-go-live.test.ts`.

**Produces:**
- `choosePasskeyTreasuryAction(orgSlug, address)`.
- `preparePasskeySetupAction(orgSlug, { dailyUsdc, weeklyUsdc, capUsdc })`.
- `recordPasskeySetupAction(orgSlug, { txHash, contract })`, returning a `RecordActionResult` with `chainUnreadable`.
- `recordRecoveryAction(orgSlug, { recoveryAddress, txHash })`.
- `skipRecoveryAction(orgSlug)`.
- Choosing, on both routes, creates the agent's wallet in the same action. Its failure leaves the choice and says: "Your wallet is this workspace's treasury. The agent's wallet was not created yet; create it below."
- `goLive` for a passkey treasury at `recovery` is refused as `wallet_treasury_unfinished` (Review Focus 4).

- [ ] **Step 1: Write the failing tests.**
  - Each action is owner only and passes the person and the workspace.
  - The agent is created with both choices.
  - An agent failure keeps the choice.
  - `goLive` refuses at `recovery`.
- [ ] **Step 2:** Run `npx vitest run tests/wallet-treasury-actions.test.ts tests/wallet-treasury-go-live.test.ts tests/access-gates.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Offer the passkey route's steps as owner-only actions, and make the agent with the choice".

### Task 6: The browser's passkey route

**Files:**
- Create: `src/lib/passkey-treasury-sdk.ts`, browser only: the SDK and viem bound to Arc mainnet, loaded on demand, plus recovery actions.
- Modify: `src/lib/passkey-treasury.ts`:
  - `openPasskeyTreasury`;
  - `keptCredential`, `keepCredential`, `forgetCredential`;
  - `passkeyTreasuryFailure`.
- Modify: `src/lib/passkey-wallet.ts`:
  - `PasskeyBundler.sendUserOperation` takes calls with an optional `value`, and `paymaster?: true`;
  - an optional `recovery` on `PasskeySdk`.
- Create: `src/components/treasury/PasskeyTreasurySteps.tsx`.
- Tests:
  - `tests/passkey-treasury-open.test.ts` (fake SDK);
  - `tests/go-live-panel.test.tsx`.

**Produces:**
- `openPasskeyTreasury(input: { config; sdk; mode: "Register" | "Login" | "Kept"; username?; kept?; expected?: string }): Promise<PasskeyTreasury>`:
  - `PasskeyTreasury = { address; credential; balance(): Promise<bigint>; send(calls): Promise<SendOutcome>; registerRecovery(address): Promise<SendOutcome> }`;
  - with `expected`, refuses another wallet: "This passkey owns another wallet (0x…), not this workspace's treasury (0x…). Use the passkey you made for it."
- Credential keeping: `localStorage` key `vestiarion.passkey-treasury.<orgSlug>`. Only the id, public key and rpId are kept, and only in a parseable shape.
- `PasskeyTreasurySteps({ orgSlug, status, network })` renders by state:
  - **create:** "Create a wallet with a passkey", or "Use the passkey you made";
  - **fund:** the address, a copy button, the USDC, what setup needs, and polling;
  - **setup:** the figures, the cap, the three calls in words, and "Set up with your passkey";
  - **recovery:** make the words, "I saved these words", "Register with your passkey", "Skip";
  - **ready:** the summary, as the wallet route shows it.

- [ ] **Step 1: Write the failing tests.**
  - `openPasskeyTreasury`:
    - registers or logs in;
    - refuses another wallet (Review Focus 3);
    - `send` passes the calls without a paymaster and maps the receipt to sent, reverted or unconfirmed;
    - `registerRecovery` calls the SDK's recovery with the address.
  - Credential keeping: round trip; a malformed value is ignored; a refusing storage is harmless.
  - Failures: a cancelled prompt and an unsupported browser.
  - The panel's markup for fund, setup, recovery and ready from the status.
- [ ] **Step 2:** Run `npx vitest run tests/passkey-treasury-open.test.ts tests/go-live-panel.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Set up a passkey wallet as the treasury from Go live".

### Task 7: A choice that leads with what the browser has

**Files:**
- Create: `src/components/treasury/WalletTreasuryChoice.tsx`, moved out of `WalletTreasurySteps.tsx` and rebuilt.
- Modify: `src/components/GoLivePanel.tsx`.
- Tests:
  - `tests/go-live-panel.test.tsx`;
  - `tests/passkey-treasury-config.test.ts` for the pure `choiceLead`.

**Produces:**
- `choiceLead(input: { wallets: number | null; passkeys: boolean }): "wallet" | "passkey" | "both-pending"`.
- Markup: both cards when passkeys can work, and no "No wallet was found" error before a click.

- [ ] **Step 1: Write the failing tests.**
  - `choiceLead`:
    - 0 wallets with passkeys gives "passkey";
    - one wallet or more gives "wallet";
    - wallets unknown gives "both-pending";
    - no passkeys gives "wallet".
  - The panel renders both cards on Arc mainnet with the passkey config, and only the wallet card without it.
- [ ] **Step 2:** Run `npx vitest run tests/go-live-panel.test.tsx tests/passkey-treasury-config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit "Lead Go live's choice with the wallet the browser has, or a passkey".

### Task 8: Docs and screenshots

**Files:**
- `content/docs/guides/go-live.mdx`: path C gains the passkey route. Quote its buttons. Add failure rows for its messages.
- `content/docs/changelog.mdx`, dated 2026-10-07:
  - `treasury_wallet_chosen`;
  - `treasury_recovery_registered`;
  - `treasury_recovery_skipped`;
  - `signer` on `spending_limit_enforced`.
- `README.md` and `.env.example`: the two client key variables.
- `ARCHITECTURE.md`: the passkey route.
- `src/app/docs-shots/shots.tsx` and `scripts/docs-screenshots.mjs`: shots of the choice with no wallet, the fund step, the setup step and the recovery step. Take the PNGs with `npm run docs:screenshots -- <names>` and look at each.
- `tests/docs-guides.test.ts`: the quotes.

- [ ] **Step 1:** Write the docs, and take the shots.
- [ ] **Step 2:** Run `npx vitest run tests/docs-guides.test.ts tests/docs-screenshots.test.tsx`. Expected: PASS.
- [ ] **Step 3:** Commit "Document the passkey route to the treasury".

### Finish

- [ ] `npm run verify` green, then a fresh whole-branch review on the most capable model. One fix pass for Critical and Important findings, each with a test.
- [ ] Open the PR. Give the partner the `db:migrate` command for 0083. After the migration and a read-only probe, merge on green.
- [ ] The partner tries the passkey route with a few USDC on Arc mainnet.
