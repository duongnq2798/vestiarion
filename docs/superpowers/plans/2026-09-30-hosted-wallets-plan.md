# Hosted Testnet Wallets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can choose "Use a Vestiarion testnet wallet" in Go live. Vestiarion then creates the workspace's wallets in the platform's hosted Circle testnet account, and the rest of Go live is unchanged. The landing copy says a real testnet wallet is one click away.

**Architecture:**
- `orgs.wallet_host` (`'own'`, `'hosted'` or null) records the choice. It is set through a definer function that enforces the platform-wide hosted limit under an advisory lock.
- `orgConfig` gives a hosted org the platform's hosted Circle pair from the environment. This is explicit, never a fallback.
- Provisioning names the wallet set per host.
- Go live gains a `chooseHostedWallet` step and a two-choice connect UI. The same-entity proof applies to own-account workspaces only.

**Tech Stack:** Next.js 16.3.6, Supabase with PGlite tests, `@circle-fin/developer-controlled-wallets`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-hosted-wallets-design.md` (H1–H8)

## Global Constraints

- **Next.js.** Read `node_modules/next/dist/docs/` before writing Next code. Actions first await `authorize(slug, "org.administer")`, then `return inOrg(auth, async () => …)`; `access-gates` enforces this.
- **Data access.** `orgs` goes through `platformDb()`, and the tenant `accounts` table through `db()`. Migrations are idempotent, and `scripts/migrate.ts` replays from `0001`.
- **Secrets.** `HOSTED_CIRCLE_API_KEY` and `HOSTED_CIRCLE_ENTITY_SECRET` are read only in `src/lib/config.ts`. They never reach logs, errors, ledger entries, props or action state. Raw Circle SDK errors are never logged or rethrown, because their Axios config holds the key; use `circleCall` / `CircleCallFailed`.
- **Never a fallback (H1).** A workspace with `wallet_host` null or `'own'` never gets the hosted pair. A hosted workspace whose platform pair is unset refuses to pay: `credentialsUnreadable`-style, never simulate silently.
- **The ledger records ids only:** `hosted_wallet_chosen` with `{ by }`.
- **UI.** Use the primitives in `src/components/ui/`, no colour literals, and it must work at 360 px. The hosted label is "Hosted by Vestiarion · Arc testnet · no real money".
- **No new dependencies.**
- **Commits.** A neutral subject, then a blank line, then the Co-Authored-By trailer. Check that `git branch --show-current` is `feat/hosted-wallets` before every commit. `npm run verify` must be green at every commit.
- **Safety.** Never run anything against production (the controller applies `0030`), never read `.env.local` values, never call Circle for real, and never start a dev server.

## Review Focus

1. **Not a fallback.** An own-account workspace whose own credentials are missing or unreadable must never pay with the hosted pair.
2. **The limit under concurrency.** Two owners choosing hosted at once at the limit: exactly one succeeds.
3. **Switching after wallets exist.** Hosted to own, or own to hosted, once any wallet exists, is refused (H4). Connecting own credentials on a hosted workspace with wallets is refused.
4. **Isolation inside the shared entity.** A hosted workspace can only pay from its own `accounts` rows, and its wallet set name contains its own org id.
5. **The deployment has no hosted pair.** The hosted choice is not offered, and any hosted workspace shows the unreadable warning instead of steps.

---

### Task 1: Data and configuration

**Files:** create `supabase/migrations/0030_hosted_wallets.sql`; modify `src/lib/config.ts`, `src/lib/dal/org-config.ts` (`OrgRow`, `ORG_SECRET_COLUMNS`, `orgConfig`) and `src/lib/platform/cleanup.ts`; tests `tests/hosted-wallets-migration.test.ts`, `tests/org-config.test.ts` (extend, or create if absent) and `tests/cleanup.test.ts`.

- **0030:**
  - `alter table orgs add column if not exists wallet_host text check (wallet_host in ('own', 'hosted'))`, nullable.
  - `choose_hosted_wallet(p_org_id uuid, p_limit int) returns void`: definer, `search_path = ''`, service role only. It takes an advisory lock on the key `'vestiarion_hosted_wallets'`, then:
    - refuses when the org has Circle credentials (`circle_api_key_enc is not null`) or any account with a wallet: raise `hosted_not_allowed`;
    - is a no-op when already `'hosted'`;
    - raises `hosted_limit_reached` when the count of `'hosted'` orgs is at or above `p_limit`;
    - otherwise sets `wallet_host = 'hosted'`.
  - Redefine `delete_sandbox_org` (copy the latest body, from 0029) so it also refuses when `wallet_host = 'hosted'` and any account has a wallet: `has_hosted_wallet`. Keep the grants.
- **`cleanup.ts`:** the listing excludes hosted sandboxes with wallets. The simplest safe way is to exclude every `wallet_host = 'hosted'` org from the listing, which errs on the side of keeping; the function refusal stays authoritative. Test it.
- **`config.ts`:** add `hostedCircleApiKey`, `hostedCircleEntitySecret` and `hostedWorkspaceLimit` (`HOSTED_WORKSPACE_LIMIT`, integer, default 100), all trimmed.
- **`orgConfig`:**
  - When `org.wallet_host === 'hosted'`, set `chain.circleApiKey` and `chain.circleEntitySecret` from `base.chain.hostedCircleApiKey` and `hostedCircleEntitySecret`.
  - If either is missing, set `credentialsUnreadable = "the hosted Circle account is not configured on this deployment"`, and push a warning.
  - Otherwise the existing behaviour is exactly unchanged.
- **Tests:**
  - the migration: the column check; the function's limit, refusals and idempotence; concurrency with two sequential sessions at the limit, since PGlite is single-connection (note that in the file header); the cleanup refusal; replay; grants;
  - `orgConfig`: the four cases of Review Focus 1 and 5 (own, own-missing, hosted with the pair, hosted without the pair), and that null never gets the hosted pair;
  - the cleanup listing filter.
- Run `npm run verify`, then commit with the subject `feat(hosted): a hosted wallet choice per workspace, the platform limit, and explicit hosted credentials`.

### Task 2: Provisioning, the go-live library and the action

**Files:** modify `src/lib/circle/provision.ts`, `src/lib/platform/go-live.ts` and `src/app/actions/go-live.ts`; tests extending `tests/circle-provision.test.ts`, `tests/go-live-lib.test.ts` and `tests/go-live-actions.test.ts`.

- **Provision:** the wallet set name is `vestiarion-${orgId}` when the current org's `wallet_host` is `'hosted'`, else `vestiarion-treasury`. Pass the host in explicitly, or read it in scope, and test both. The deterministic idempotency key is unchanged.
- **go-live.ts:**
  - `GoLiveStatus` gains `host: "own" | "hosted" | null` and `hostedAvailable: boolean` (the platform pair is set).
  - **`chooseHostedWallet({ orgId, actorId })`:**
    - It refuses unless `hostedAvailable` (`GoLiveError("hosted_unavailable")`: "Hosted testnet wallets are not available on this deployment.").
    - It calls the RPC with `config.hostedWorkspaceLimit`, mapping `hosted_not_allowed` to `GoLiveError("hosted_not_allowed")` ("A workspace with its own Circle account or wallets cannot switch to a hosted wallet.") and `hosted_limit_reached` to `GoLiveError("hosted_limit_reached")` ("All hosted testnet wallets are taken; connect your own Circle account instead.").
    - It records `hosted_wallet_chosen` `{ by }`.
  - **Step logic:** a hosted workspace with no wallets is at `wallets`, because connect is done by the choice.
  - **`connectCircle` on a hosted workspace:**
    - it is allowed only while it has no wallets, and then sets `wallet_host = 'own'` in the same update as the credentials;
    - it refuses with `GoLiveError("hosted_has_wallets")` ("This workspace's wallets are hosted by Vestiarion; start a new workspace to use your own Circle account.") once wallets exist.
  - An own-account connect sets `wallet_host = 'own'`.
  - **The same-entity proof** is skipped for hosted workspaces: the entity is the platform's by construction. `goLive` for hosted checks the hosted pair is readable (`credentialsUnreadable` from the scope) and the operating wallet exists, then does the same conditional update. Bind it to the `wallet_host` value instead of the envelope iv, since hosted has no envelope.
  - `createWallets` for hosted uses the scope's hosted pair through `orgConfig`, with no other change.
- **The action:** `chooseHostedWalletAction`, `org.administer`, returns `{ ok, message }` and revalidates the org layout.
- **Tests:** every new code path, the H4 switching rules (Review Focus 3), the hosted set name (Review Focus 4), the proof skipped for hosted only, the `goLive` hosted path, the action's shape and messages, and console spies for the hosted pair.
- Run `npm run verify`, then commit with the subject `feat(hosted): choose a hosted testnet wallet, provisioned in a wallet set of its own`.

### Task 3: The panel, landing copy and docs

**Files:** modify `src/components/GoLivePanel.tsx`, `src/components/landing/Hero.tsx`, `README.md` and `ARCHITECTURE.md`; test `tests/go-live-panel.test.tsx` and the landing test if one pins the copy.

- **The connect step,** for an owner, when `hostedAvailable`, shows two choices:
  - **"Use a Vestiarion testnet wallet"**, first and recommended, with the label "Hosted by Vestiarion · Arc testnet · no real money". It is one button: `chooseHostedWalletAction`.
  - **"Connect your own Circle account"**: the existing form, in a `Disclosure` or a second card.

  Without `hostedAvailable`, only the existing form shows, unchanged.
- **Hosted workspaces:**
  - the status line: "Sandbox · hosted testnet wallet" in `wallets` and `go_live`, and "Live · hosted testnet wallet on Arc" in `live`;
  - the wallets step text says the wallets are created in Vestiarion's testnet account;
  - no "Replace Circle credentials" disclosure: `hosted_has_wallets` applies, so show one line instead: "To use your own Circle account, start a new workspace."
- **Hero.tsx:** replace the copy with H8's line exactly: "Email sign-in, a workspace of your own, and a real Arc testnet wallet in one click. Fund it with testnet USDC from Circle's faucet; no real money moves."
- **README:** a paragraph on hosted testnet wallets and the two env vars (names only). **ARCHITECTURE:** one paragraph on H1 and H3.
- **Tests:** the two-choice step, hosted status lines, no replace-disclosure for hosted, the choice hidden without `hostedAvailable`, and the Hero copy.
- Run `npm run verify` and `npm run build`, then commit with the subject `feat(hosted): offer a hosted testnet wallet in Go live, and say so on the landing page`.
