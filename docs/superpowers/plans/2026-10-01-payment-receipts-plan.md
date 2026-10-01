# Payment receipts: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an owner or admin shares a link to a receipt for a live payment. The public page proves three things:
- the workspace signed the receipt;
- its ledger recorded the payment;
- the chain shows the transfer.

**Architecture:**
- A new signed `receipt_shared` ledger entry carries only public-safe facts (spec R1).
- `payment_receipts` holds one hashed link per invoice, with the public keys.
- One isomorphic verifier, written in Web Crypto, runs on the server and again in the browser (R5).
- An on-chain matcher reads the transaction receipt from public RPCs.

**Tech stack:**
- Next.js 16 App Router: server actions and a dynamic public page.
- Supabase Postgres with RLS, and the platform service-role client for the public read.
- Web Crypto: SHA-256 and Ed25519.
- vitest and PGlite.

**Spec:** `docs/superpowers/specs/2026-10-01-payment-receipts-design.md`

## Global constraints

- **Copy:** no names on the public page. Say "Arc testnet" plainly. No disclaimers about money being fictional.
- **Tokens:** `vxr_` followed by 43 base64url characters. Store only the SHA-256 of the secret.
- **Permission:** `records.write`, for owners and admins.
- **Changelog:** new ledger actions get a dated entry in `content/docs/changelog.mdx`, newest first.
- **Tests:** never touch the network.

## Review focus

1. **Privacy.** A receipt body or page that leaks a counterparty or business name, reasoning, or a user id.
2. **Forgery.** Can a receipt be made to pass with a body, key or `records` entry from another workspace, or with a mismatched hash?
3. **The on-chain match on Arc.** The native USDC system-address log at 18 decimals, against the ERC-20 interface at 6 decimals. A gas-fee `Transfer` to the bundler must not count as the payment.
4. **Dead links.** A revoked or replaced link must reveal nothing, and its response must match an unknown token's.
5. **CCTP before its mint.** Such a payout must be refused, not shared with the burn as the payee's transaction.

---

### Task 1: migration and inventories

**Files:**
- Create: `supabase/migrations/0046_payment_receipts.sql`, `tests/receipts-migration.test.ts`.
- Modify:
  - `src/lib/dal/index.ts` (`TENANT_TABLES`);
  - `tests/support/pglite.ts`;
  - the delete-org, auth-FK and RLS inventories.

Steps:
- [ ] Write the migration test (RED): the table, its constraints and RLS, and the tenant grants.
- [ ] Write the migration (GREEN).
- [ ] Update the inventories until the suite is green.
- [ ] Commit.

### Task 2: receipt facts and tokens

**Files:**
- Create: `src/lib/receipts/facts.ts`, `src/lib/receipts/token.ts`, `tests/receipts-facts.test.ts`.

**Produces:**

```ts
generateReceiptToken(random?): { token; secretHash }
receiptTokenHash(token): string | null
buildReceipt({ invoice, intent, entries }): { ok: true; facts: ReceiptFacts; records: { seq: number; hash: string } } | { ok: false; reason: string }
receiptSummary(facts): string
```

Cases, each RED then GREEN:
- direct USDC and direct EURC;
- CCTP after the mint, and refused before it;
- Gateway;
- refused: simulated, unpaid, not live, or no entry recording it;
- `records` picks the newest entry containing `txHash`, else `sourceTxHash`.

### Task 3: isomorphic verifier

**Files:**
- Create: `src/lib/canonical-json.ts`, moved out of `ledger.ts` and re-exported from it; `src/lib/receipts/verify.ts`; `tests/receipts-verify.test.ts`.

**Produces**, all over Web Crypto:

```ts
verifyEntry(row: LedgerRow, keys: Record<string, string>): Promise<{ ok: boolean | null; reason?: string }>
recordsTransaction(row, hash, txHashes): boolean
```

- `ok: null` means the key was not known, or the browser has no Ed25519.
- Tests: valid; tampered body; bad signature; bad chain hash; unknown key id. Fixture entries are signed with Node's `crypto`.

### Task 4: on-chain matcher

**Files:**
- Create: `src/lib/receipts/onchain.ts`, `tests/receipts-onchain.test.ts`.

**Produces:**

```ts
matchTransfer(facts, receipt): { state: "matches"; block: number } | { state: "mismatch"; reason }
readOnChain(facts, { fetch, timeoutMs }): Promise<OnChainCheck>
```

`OnChainCheck` adds `{ state: "unreadable" }`. Tests:
- Arc native USDC (`0xff…fe`, 18 decimals) and ERC-20 USDC (6 decimals);
- EURC;
- a Base mint;
- wrong amount, wrong recipient, status `0x0`, or a missing receipt;
- an RPC error (unreadable);
- a fee transfer to the bundler alone does not match.

### Task 5: share, stop sharing, read by token

**Files:**
- Create:
  - `src/lib/receipts/share.ts` (in-org): `shareReceipt`, `stopSharingReceipt`, `sharedReceipts`;
  - `src/lib/platform/receipts.ts`: `readReceipt(token)`, returning a `ReceiptView` with the facts, the entry, the keys and three checks, or null;
  - `tests/receipts-share.test.ts`, `tests/receipts-read.test.ts`.

Behaviour:
- **First share:** appends `receipt_shared`, then inserts the row.
- **Re-share or new link:** rotates `token_hash`, clears `revoked_at`, and appends `receipt_link_renewed`.
- **Stop sharing:** sets `revoked_at` and appends `receipt_revoked`.
- **Read by token:** returns null when the link is revoked or unknown.

### Task 6: actions and the Invoices control

**Files:**
- Create: `src/app/actions/receipts.ts`, `src/components/ReceiptControl.tsx`, `tests/receipts-actions.test.ts`.
- Modify: `src/components/vx/DecisionCard.tsx` (a footer slot), `src/app/o/[slug]/invoices/page.tsx`.

### Task 7: the public page

**Files:**
- Create:
  - `src/app/receipt/[token]/page.tsx`;
  - `src/components/receipt/ReceiptView.tsx`, a server-renderable view;
  - `src/components/receipt/BrowserCheck.tsx` (client), which runs `verifyEntry` again;
  - `tests/receipts-page.test.tsx`.

The page shows no names and is `noindex`. A dead link shows the one sentence.

### Task 8: docs

**Files:**
- Modify:
  - `content/docs/changelog.mdx`;
  - the guide, `content/docs/guides/first-payment.mdx`, which gains a "Share a receipt" section;
  - the privacy page, if a receipt's public facts need a line;
  - `tests/docs-guides.test.ts` QUOTED strings.
