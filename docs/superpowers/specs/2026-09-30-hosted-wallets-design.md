# Hosted testnet wallets: a real Arc wallet in one click, no Circle account

This spec follows the go-live design (`2026-09-29-go-live-design.md`). Go live lets an owner connect their own Circle account. Most people trying Vestiarion do not have one, so this design lets Vestiarion create the workspace's wallets in a Circle testnet account the platform runs. The owner funds the wallet from Circle's faucet, and the agent pays real testnet USDC on Arc. It was decided on 2026-09-30 by the implementer under the partner's standing instruction. Each decision states its reason.

## 1. What this builds

- **The connect step in Go live offers two choices:**
  - **Use a Vestiarion testnet wallet.** This is the default. It is one click, and needs no Circle account.
  - **Connect your own Circle account.** This is the existing form.
- **Choosing the hosted wallet.** The workspace is marked `wallet_host = 'hosted'`. The next step, Create treasury wallets, creates its wallets in the platform's hosted Circle account, in a wallet set of its own. The rest is unchanged: fund from the faucet, see the live balance, go live, pause.
- **The landing page** replaces "No wallet, no real funds" with a true line about a real Arc testnet wallet funded from Circle's faucet.

## 2. Decisions

- **H1. Hosted is explicit, never a fallback.** `orgConfig` today never gives a workspace the platform's Circle credentials, so that a sandbox cannot move the founding organization's money. That rule stays: a workspace gets the hosted credentials only when its own row says `wallet_host = 'hosted'`, which an owner sets.
  - A workspace's `accounts` rows, which are org-scoped under RLS and written only by provisioning, are the only wallets it can pay from. Even inside a shared Circle entity, a workspace therefore cannot spend another workspace's wallet.
- **H2. The hosted credentials are a platform secret pair in the environment:** `HOSTED_CIRCLE_API_KEY` and `HOSTED_CIRCLE_ENTITY_SECRET`, set by the partner in Vercel as sensitive variables.
  - They should be a Circle testnet account separate from the founding workspace's, so a mistake in hosted handling cannot touch founding's wallets.
  - When they are unset, the hosted choice is hidden and the page says nothing about it: a deployment without them behaves exactly as today.
- **H3. Each hosted workspace has its own wallet set,** named `vestiarion-${orgId}`, created on first provisioning. The set name identifies the workspace's wallets inside the shared entity.
  - Provisioning keeps its deterministic idempotency key per (org, account).
  - The go-live same-entity proof applies to own-account workspaces only. For hosted workspaces the entity is the platform's by construction.
- **H4. Choosing hosted and own.**
  - An owner can choose hosted only while the workspace has no Circle credentials and no wallets.
  - They can switch from hosted to their own account only while the workspace has no wallets.
  - Once wallets exist, the choice is fixed. Moving a funded wallet between Circle accounts is out of scope, and "start a new workspace" is the answer.
  - Choosing hosted records `hosted_wallet_chosen` with `{ by }`.
- **H5. Testnet only, with platform limits.**
  - At most `HOSTED_WORKSPACE_LIMIT` hosted workspaces (default 100). Checked when hosted is chosen, under an advisory lock, in a database function `choose_hosted_wallet(p_org_id, p_limit)`.
  - The hosted choice is labelled "Hosted by Vestiarion · Arc testnet · no real money".
  - The existing per-payment guardrails apply unchanged.
- **H6. Cleanup.** A sandbox with `wallet_host = 'hosted'` and wallets is not deleted automatically, the same as a connected sandbox (0029): its wallet may hold faucet funds the owner is using. Migration `0030` extends the refusal and the cleanup listing.
- **H7. The provider** is chosen by `orgConfig`: for a `hosted` org it fills `chain.circleApiKey` and `circleEntitySecret` from the platform's hosted pair. `getChainProvider()` and everything downstream (reconcile, pay, settlement, deadlines) is unchanged.
- **H8. The landing copy** says only what is true: "Email sign-in, a workspace of your own, and a real Arc testnet wallet in one click. Fund it with testnet USDC from Circle's faucet; no real money moves."

## 3. Components

```
supabase/migrations/0030_hosted_wallets.sql   orgs.wallet_host ('own'|'hosted'|null), choose_hosted_wallet(), cleanup refusal
src/lib/config.ts                             hostedCircleApiKey / hostedCircleEntitySecret / hostedWorkspaceLimit from env
src/lib/dal/org-config.ts                     a hosted org gets the hosted pair (explicit), OrgRow gains wallet_host
src/lib/circle/provision.ts                   wallet set name per host: own → vestiarion-treasury, hosted → vestiarion-<orgId>
src/lib/platform/go-live.ts                   chooseHostedWallet(); status gains host + hostedAvailable; guards per H4
src/app/actions/go-live.ts                    chooseHostedWalletAction (org.administer)
src/components/GoLivePanel.tsx                the two-choice connect step; hosted labels
src/components/landing/*                      the copy line (H8)
```

## 4. Testing

- **PGlite:**
  - `choose_hosted_wallet` enforces the limit under concurrency, and refuses when credentials or wallets exist;
  - the cleanup refusal for hosted sandboxes with wallets;
  - replay.
- **`orgConfig`:**
  - a hosted org gets the hosted pair;
  - an own org gets its own;
  - an org with neither gets none, never the hosted pair;
  - hosted when the env pair is unset gives `credentialsUnreadable`-style refusal, never silent simulation.
- **Provisioning** uses the per-org set name for hosted workspaces.
- **The flow:** choose hosted, create wallets, go live; the switching rules of H4; the hosted choice hidden when the env pair is unset.
- **Secrets:** the hosted pair never reaches props, logs or the ledger.

## 5. Rollout

1. The partner adds `HOSTED_CIRCLE_API_KEY` and `HOSTED_CIRCLE_ENTITY_SECRET` in Vercel. Ideally they come from a fresh Circle testnet account; its entity secret must be registered in that account's console.
2. Apply `0030`, then merge.
3. A new account signs in, creates a workspace, chooses the hosted wallet, creates wallets, funds 20 USDC from the faucet, adds a counterparty with the partner's own test address and an invoice, then goes live or runs a cycle by hand. Check the transaction on the Arc explorer.
4. Record the outcome here.

## 6. Out of scope

- Mainnet.
- Moving funds between hosted and own accounts.
- A faucet built into the product.
- Daily per-workspace payment caps beyond the existing guardrails.
