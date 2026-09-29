# Go Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner turns a sandbox workspace live from Settings, in three steps: connect Circle (checked, encrypted), create the treasury wallets, then go live. A connected sandbox is never auto-deleted.

**Architecture:**
- `src/lib/circle/check.ts` checks an API key with one Circle read under a deadline.
- `src/lib/circle/provision.ts` holds the wallet provisioning that `scripts/bootstrap-circle.ts` does today, now as an idempotent library function.
- `src/lib/platform/go-live.ts` stores credentials (envelopes bound to the org and column), runs provisioning in the org's scope, and flips `mode` with a conditional update. Every step appends an ids-only ledger entry.
- Server actions gate on `org.administer`. `GoLivePanel` shows the status to everyone and the steps to owners.
- Migration `0029` keeps `delete_sandbox_org` away from a sandbox that holds Circle credentials.

**Tech Stack:** Next.js 16.3.6 server actions, Supabase with PGlite tests, `@circle-fin/developer-controlled-wallets` (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-go-live-design.md` (L1–L9)

## Global Constraints

- **Next.js.** Read `node_modules/next/dist/docs/` before writing Next code. Server actions live in `src/app/actions/`. Each one first awaits `authorize(slug, "org.administer")`, then works inside `return inOrg(auth, async () => …)`; `tests/access-gates.test.ts` enforces that shape. Every page calls `requireMembership` itself.
- **Data access.** Tenant data goes through `db()`. The `orgs` columns (`circle_api_key_enc`, `circle_entity_secret_enc`, `mode`) go through `platformDb()`. Migrations are idempotent, and `scripts/migrate.ts` replays every file from `0001`.
- **Secrets.** Store them with `encryptSecret(value, { orgId, column: "circle_api_key_enc" | "circle_entity_secret_enc" }, masterKeysFromEnv())`. A secret is never:
  - logged;
  - returned from an action;
  - put in a ledger entry;
  - put in React props;
  - put in an error message.

  Messages are fixed strings.
- **Circle calls** each run under `withDeadline` from `src/lib/circle/settlement.ts`: 10 s for the key check, 15 s per wallet call.
- **The ledger** records ids only: `circle_connected` / `circle_reconnected` `{ by }`, `treasury_wallets_created` `{ by, accounts }`, and `workspace_went_live` `{ by }`.
- **UI.** Use the primitives in `src/components/ui/` and no colour literals. It must work at 360 px. Secret inputs are `type="password"` with `autoComplete="off"`, `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore="true"` and `spellCheck={false}`.
- **No new dependencies.**
- **Commits.** A neutral subject, then a blank line, then the Co-Authored-By trailer. Check that `git branch --show-current` is `feat/go-live` before every commit. `npm run verify` must be green at every commit.
- **Safety.** Never run anything against production (the controller applies `0029`). Never read `.env.local` values, and never start a dev server.

## Review Focus

1. **A secret in the wrong place.** A secret must never reach the RSC payload, a thrown error's message, or the action's returned state. That includes an SDK error whose message quotes the request.
2. **A sandbox that went quiet after connecting.** A sandbox that connected Circle but never went live, and has been inactive for months, is not deleted. A sandbox that never connected still is.
3. **A double submit on "Create wallets".** Clicking twice, or two owners at once, must not mint two sets of wallets, or at worst must write only one wallet per account. The provisioning update is conditional on `circle_wallet_id is null`.
4. **The founding workspace.** It is already live, with credentials and wallets, so it shows the status and no steps. No action on it can change `mode`, and none can re-provision.
5. **Credentials replaced while live.** Replacing a live workspace's credentials with a different Circle entity's key must be refused. The existing wallets belong to the old entity, so payments would fail. Refuse with "This workspace is live; its wallets belong to the connected Circle account." Reconnecting with the same entity is allowed: prove it by listing the stored wallet set.

---

### Task 1: Migration 0029 and cleanup

**Files:** create `supabase/migrations/0029_go_live.sql`; modify `src/lib/platform/cleanup.ts`; test `tests/go-live-migration.test.ts` and `tests/cleanup.test.ts`.

- `0029`: `create or replace function public.delete_sandbox_org(...)`. Keep the same signature and body as `0022`'s current definition (read it first, including any later redefinitions), plus a refusal:

  ```sql
  if v_org.circle_api_key_enc is not null then
    raise exception 'has_circle_credentials: % holds Circle credentials, and a connected sandbox is never deleted automatically', v_org.slug;
  end if;
  ```

  Keep the grants exactly as they are.
- `cleanup.ts`: the listing of inactive sandboxes adds `.is("circle_api_key_enc", null)`.
- **Tests on PGlite** (tests/support/pglite.ts):
  - an inactive sandbox with credentials is refused with `has_circle_credentials`;
  - an inactive sandbox without credentials is still deleted;
  - replay is idempotent;
  - the grants are unchanged.
- **The cleanup test:** the listing filter is present, using the fake-supabase recorder.
- Run `npm run verify`, then commit with the subject `feat(db): a sandbox holding Circle credentials is never deleted automatically`.

### Task 2: Circle key check and wallet provisioning

**Files:** create `src/lib/circle/check.ts` and `src/lib/circle/provision.ts`; modify `scripts/bootstrap-circle.ts`; test `tests/circle-check.test.ts` and `tests/circle-provision.test.ts`.

**Interfaces:**
- `export type CircleCheck = "ok" | "rejected" | "unreachable"`
- `export async function checkCircleApiKey(apiKey: string, entitySecret: string, client?: CircleClientFactory): Promise<CircleCheck>`
  - It makes one `listWalletSets()` call under a 10 s deadline.
  - A 401 or 403 status on the SDK error means `rejected`. A timeout, a network error or a 5xx means `unreachable`. The SDK error's shape comes from `response?.status`; read the SDK's error types.
  - The injectable factory defaults to `initiateDeveloperControlledWalletsClient`.
- `export interface ProvisionResult { created: number; skipped: number }`
- `export class EntitySecretRejected extends Error {}`
- `export async function createTreasuryWallets(options?: { client?: CircleClientFactory }): Promise<ProvisionResult>`
  - It runs inside an organization scope, and uses `currentOrgConfig().chain.circleApiKey` and `.circleEntitySecret`.
  - It finds or creates the wallet set `vestiarion-treasury`.
  - For each account whose `circle_wallet_id` is null, it creates one SCA wallet on the account's chain, then writes it with `update accounts set circle_wallet_id, address, name = <name without " (simulated)"> where id = $1 and circle_wallet_id is null` (Review Focus 3). If that update matches 0 rows, another run won, and the created wallet is left unused; say so in a comment. The wallet is empty, so nothing is lost.
  - Every call runs under a 15 s deadline.
  - A 401 or 403 from a create call throws `EntitySecretRejected`. The entity-secret ciphertext is what a create call adds.
- **`bootstrap-circle.ts`:** the accounts section calls `createTreasuryWallets()`. The counterparty minting stays in the script.
- **Tests:**
  - the three check outcomes, with a fake client and a fake error shape;
  - provisioning skips provisioned accounts, creates one wallet per missing account, renames "(simulated)" and reuses an existing set;
  - the conditional update: a concurrent winner means 0 rows, and nothing throws;
  - an entity-secret rejection throws `EntitySecretRejected`, and wallets written before it are kept;
  - no log line contains the key or secret.
- Run `npm run verify`, then commit with the subject `feat(circle): check an API key and provision treasury wallets as a library`.

### Task 3: The Go-live library and actions

**Files:** create `src/lib/platform/go-live.ts` and `src/app/actions/go-live.ts`; test `tests/go-live-lib.test.ts` and `tests/go-live-actions.test.ts`.

**Interfaces:**
- `export type GoLiveStep = "connect" | "wallets" | "go_live" | "live"`
- `export interface GoLiveStatus { step: GoLiveStep; connected: boolean; wallets: Array<{ accountName: string; kind: string; address: string }>; liveSince: string | null; credentialsUnreadable: boolean }`
- `export async function goLiveStatus(orgId: string): Promise<GoLiveStatus>`
  - It reads `mode` and the presence of both `*_enc` columns (never their values) through `platformDb`, and the accounts through `db()`.
  - `liveSince` is the ts of the latest `workspace_went_live` ledger entry, or null.
  - For a live org with no such entry (the founding workspace), `liveSince` is null and `step` is `"live"`.
- `export async function connectCircle(input: { orgId: string; actorId: string; apiKey: string; entitySecret: string; check?: typeof checkCircleApiKey }): Promise<void>`
  - Trim both values, and reject empty or longer than 512 characters with `GoLiveError("invalid")`.
  - Check the key: `rejected` becomes `GoLiveError("key_rejected")`, `unreachable` becomes `GoLiveError("unreachable")`.
  - If the org is live (Review Focus 5), verify it is the same entity: with the new credentials, `listWalletSets()` must include the stored wallet set `vestiarion-treasury` and the operating account's wallet must be listable (`getWallet({ id })`). Otherwise throw `GoLiveError("different_entity")`.
  - Encrypt both values and update `orgs` in one update.
  - Append `circle_connected`, or `circle_reconnected` if credentials were already stored, with `{ by }`, via `appendLedgerEntryBestEffort`.
- `export async function createWallets(input: { orgId: string; actorId: string }): Promise<ProvisionResult>`
  - It refuses without credentials (`GoLiveError("not_connected")`) and when the org is live (`GoLiveError("already_live")`).
  - It runs `createTreasuryWallets()` in the org's scope. The org config must be rebuilt from the freshly stored credentials; check how `withOrg` loads org secrets, so a connect followed by a create in a new request picks them up.
  - `EntitySecretRejected` becomes `GoLiveError("entity_secret_rejected")`.
  - It appends `treasury_wallets_created` `{ by, accounts: created }` when `created > 0`.
- `export async function goLive(input: { orgId: string; actorId: string }): Promise<void>`
  - Credentials must be stored and the operating account must have a wallet. Otherwise throw `not_connected` or `no_wallets`.
  - It updates `orgs` with `mode = 'live'` where `id` matches and `mode = 'sandbox'`. Zero rows means `GoLiveError("already_live")`.
  - It appends `workspace_went_live` `{ by }`.
- **`GoLiveError` codes and their fixed messages:**
  - `invalid`: "Paste both the API key and the entity secret."
  - `key_rejected`: "Circle did not accept this API key."
  - `unreachable`: "Could not reach Circle; try again."
  - `different_entity`: "This workspace is live; its wallets belong to the connected Circle account."
  - `not_connected`: "Connect Circle first."
  - `entity_secret_rejected`: "Circle did not accept the entity secret; reconnect with the right one."
  - `no_wallets`: "Create the treasury wallets first."
  - `already_live`: "This workspace is already live."
- **The actions** in `src/app/actions/go-live.ts`: `connectCircleAction`, `createWalletsAction` and `goLiveAction`, all `authorize(slug, "org.administer")`.
  - They return `{ ok, message }`: a `GoLiveError`'s message, or "Something went wrong; try again." for anything else, logged by action name only.
  - They call `revalidatePath` on the settings page.
  - Form data is read and never returned.
- **Tests:**
  - every code path above;
  - the envelopes decrypt back with their bindings;
  - the ledger bodies hold ids only;
  - the conditional update on `mode`;
  - the founding case: live with no ledger entry gives step `live`;
  - Review Focus 5, both same and different entity;
  - the actions' permission literal and messages;
  - console spies on every level contain no key or secret.
- Run `npm run verify`, then commit with the subject `feat(go-live): connect Circle, create treasury wallets, and go live, owner only`.

### Task 4: The panel, Settings, and docs

**Files:** create `src/components/GoLivePanel.tsx`; modify `src/app/o/[slug]/settings/page.tsx` (fetch `goLiveStatus`, render the panel first, pass `canAdminister`), `README.md` (replace the operator-only go-live instructions with the Settings flow, keeping the scripts documented for the founding workspace and the demo seed), and `ARCHITECTURE.md` (one paragraph); test `tests/go-live-panel.test.tsx`.

- **The panel** is a `section` titled "Go live", with a status line: "Sandbox · simulated payments" or "Live · paying on Arc testnet".
- **The owner's view,** by step:
  - **connect:** two password inputs and a Connect button. It says where the values come from (the Circle developer console) and that they are encrypted and never shown again.
  - **wallets:** a Create treasury wallets button, and the note about counterparty addresses (L9), linked to the counterparties page.
  - **go_live:**
    - the operating wallet's address with `CopyButton`;
    - the faucet link `https://faucet.circle.com`, with the note "select Arc Testnet";
    - the live balance line, fetched from `/o/[slug]` data or a small `refreshBalance` action. Use the provider's `getBalance`, inside the org scope, under its deadline.
    - a Go live button that opens `ConfirmDialog` with the three consequences from spec §2.
  - **live:** the wallet addresses, "Live since …" when known, and "Runs every 6 hours; pause the agent from the console to stop it."
- **Non-owners** see the status line and, when live, the addresses. They never see a form.
- **Replacing credentials:** a small "Replace Circle credentials" disclosure for owners in the `wallets`, `go_live` and `live` steps, using the same form.
- If `credentialsUnreadable` is true, show a `Callout` warning, and no steps.
- **Tests** use `renderToStaticMarkup` (the repo has no DOM environment):
  - each step's markup for an owner;
  - the non-owner view;
  - the live view;
  - no form without `canAdminister`;
  - inputs carry the ignore attributes;
  - no prop contains anything secret: the panel's props type has no secret fields at all.
- Run `npm run verify` and `npm run build`, then commit with the subject `feat(go-live): the Go live section in Settings`.
