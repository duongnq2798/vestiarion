# Network foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every workspace a network (Arc testnet now, Arc mainnet later) and show `/open` per network, without
changing how anything runs on testnet.

**Architecture:**
- **Data:** `orgs.network` and `payment_intents.network`, with triggers that lock the first and fill the second. Three
  open functions take a network.
- **Code:** one profile per network in `src/lib/network.ts`, which today's testnet constants read from. `orgConfig`
  carries the network and refuses mainnet. Go live refuses a key for the other network. `/open` renders a section per
  network.

**Tech stack:** Next.js 16, Supabase Postgres (PGlite in tests), vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-network-foundation-design.md`

## Global constraints

- Network ids are `arc-testnet` and `arc-mainnet`; the default everywhere is `arc-testnet`.
- Migration `0074_network.sql` is idempotent: `scripts/migrate.ts` re-runs every file.
- No value used on Arc testnet today changes.
- Copy says "Arc testnet" and "Arc mainnet" plainly, with no disclaimers.
- The migration is the partner's to run, before the merge.

## Review focus

1. A workspace on Arc mainnet must not move money through any path: provider, direct Circle writers, hosted wallets.
2. An intent inserted by any path (single, batch member, milestone) gets its workspace's network.
3. `/open` totals never add mainnet to testnet. That includes people, wallets and the first payments.
4. A failed read of one network's section leaves the other intact.
5. A sandbox with no wallet may still change network; one that went live or holds a wallet may not.

---

### Task 1: Migration 0074 (N1, N2, N4, N7 SQL)

**Files:** Create `supabase/migrations/0074_network.sql`, `tests/network-migration.test.ts`.

- [ ] Write PGlite tests:
  - the default and the check;
  - the lock for a live workspace and for one holding a wallet, while a sandbox with no wallet may change;
  - an intent's network taken from its workspace even when the insert names another;
  - `open_numbers`, `open_first_payments` and `open_outcomes` with `p_network` counting only that network's
    workspaces, people, payments and wallets;
  - the one-argument versions unchanged.
- [ ] Run them and watch them fail (no column, no functions).
- [ ] Write the migration. The two-argument functions copy the latest bodies (0040, 0042, 0049) with an `o.network`
  filter in the org CTE and a `p.network` filter on payments; the wallet chain follows the network. Grant them to
  `service_role` only, then `notify pgrst, 'reload schema'`.
- [ ] Run the tests: green. Commit.

### Task 2: The network profile (N6)

**Files:**
- Create `src/lib/network.ts` and `tests/network.test.ts`.
- Modify `src/lib/payee-chains.ts`, `src/lib/circle/cctp.ts`, `src/lib/circle/gateway.ts`, `src/lib/fx/quote.ts`,
  `src/lib/circle/arcFees.ts`, `src/lib/circle/usyc.ts` and `src/lib/x402/offer.ts`.

- [ ] Test that the testnet profile equals today's constants, field by field; that the mainnet facts are as read; that
  the features not verified for mainnet are off there; and `currentNetwork()`.
- [ ] Watch it fail, then write `network.ts`, and point each constant at the testnet profile (values unchanged).
- [ ] Run the full suite: green. Commit.

### Task 3: The network in org config, and mainnet refused (N3)

**Files:** Modify `src/lib/config.ts`, `src/lib/dal/org-config.ts` (OrgRow, ORG_SECRET_COLUMNS) and
`tests/org-config.test.ts`; test through `tests/chain-provider.test.ts`.

- [ ] Test:
  - a testnet organization's config says `arc-testnet`;
  - a row without the column is testnet;
  - a mainnet organization gets no Circle credentials and `credentialsUnreadable` naming mainnet, so
    `getChainProvider` refuses and `chainModes` reports simulate.
- [ ] Implement, then run green. Commit.

### Task 4: The key matches the network (N5)

**Files:** Modify `src/lib/platform/go-live.ts` (`key_network`) and `content/docs/guides/go-live.mdx` (its error
table); test in `tests/go-live.test.ts` and `tests/docs-guides.test.ts`.

- [ ] Test: a `LIVE_API_KEY:` key for a testnet workspace is refused with `key_network` before Circle is called or
  anything is stored; a `TEST_API_KEY:` key goes on as before.
- [ ] Implement, add the message to the guide, then run green. Commit.

### Task 5: `/open` per network (N7)

**Files:**
- Modify `src/lib/platform/open-numbers.ts`, `src/app/open/page.tsx`, `src/components/open/*.tsx` and
  `scripts/open-numbers.ts`.
- Test in `tests/open-numbers.test.ts` and `tests/open-page.test.tsx`.

- [ ] Loader tests:
  - `readOpenNumbers(period, now, network)` asks the two-argument functions with `p_network`;
  - the memory is kept per network;
  - testnet is the default.
- [ ] Page tests:
  - an Arc mainnet section before the Arc testnet one, each with its figures;
  - an empty network says so;
  - one network failing leaves the other;
  - row labels without the network name;
  - the method says the networks are counted apart.
- [ ] Implement, then run green. Commit.

### Task 6: The ratchet (N8)

**Files:** Create `tests/network-ratchet.test.ts`.

- [ ] Count the testnet identifiers per file in `src/`, skipping comments and `src/lib/network.ts`, and pin today's
  counts. A self-test checks that the scan finds an identifier and skips a comment.
- [ ] Run it green. Commit.

### Task 7: Docs and verify

- [ ] Update README (the open numbers, and the network), ARCHITECTURE (the network section, and the open numbers),
  the go-live guide, and the roadmap note in the spec.
- [ ] Run `npx tsc --noEmit`, `npx eslint` and `npx vitest run`: all green. Commit, push, open the PR, and give the
  partner the migration command.
