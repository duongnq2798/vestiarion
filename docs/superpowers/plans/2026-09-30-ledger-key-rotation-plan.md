# Ledger Key Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner rotates a workspace's ledger signing key from Settings; every entry before and after keeps verifying (Audit log, `/api/ledger/verify`, the exported file).

**Architecture:** Retired public keys move onto the workspace (`orgs.ledger_retired_keys`, migration 0035) and flow through `orgConfig` into the keyring that `verifyChain`, `detectKeyRotation` and the audit export already use. `rotateLedgerKey` swaps the sealed signing key and appends the old public key in one conditional update, then writes `ledger_key_rotated` (with `by`) from a fresh scope that holds the new key.

**Tech Stack:** Postgres migration (PGlite tests), supabase-js via `platformDb()`/`db()`, Node `crypto` Ed25519, `encryptSecret`/`decryptSecret` (src/lib/secrets.ts), Next.js 16 server actions, React server rendering tests.

**Spec:** `docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (AGENTS.md).
- Column: `orgs.ledger_retired_keys jsonb not null default '[]'`, items `{ id, publicKeyPem, retiredAt }` — public material only.
- Ledger entry: `system/ledger_key_rotated`, actor `"human"` when an owner rotates, detail exactly `{ from, to, by }`, summary `Ledger signing key rotated: ${from} retired, ${to} now signs`; signed by the new key.
- Rotation is owner-only (`org.administer`), refused while a cycle is running (`CYCLE_IN_PROGRESS_MS` from src/lib/agent/balances.ts) and when the current key cannot be opened; the swap is one update conditional on `ledger_signing_key_enc->>iv`.
- The old private key is never stored, logged, returned, or put in an error message.
- UI strings (exact): panel title "Ledger signing key"; "Current key"; "Retired keys"; "No key has been retired yet."; button "Rotate signing key"; confirm title "Rotate the ledger signing key?"; confirm description "New entries are signed by a new key. Entries already written keep verifying with the old public key, which stays listed here. The old private key is discarded and cannot sign again."; confirm label "Rotate key"; non-owner note "An owner of this workspace can rotate the key."; success "Signing key rotated: <from> retired, <to> now signs."
- Error messages (exact): cycle_running "A cycle is running. Try again in a minute, once it has finished."; key_unreadable "The current signing key cannot be read, so it cannot be retired safely. Nothing was changed."; conflict "The signing key changed a moment ago. Reload and check it before rotating again."
- No `/api/v1` change, no changelog entry (spec K7). Every exported server action awaits `authorize` first and works inside `inOrg` (tests/access-gates.test.ts). UI uses `src/components/ui/*` primitives.
- Commit messages neutral, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Subagents never touch production.

## Review Focus

1. **The fresh scope after the swap** — a server action runs inside `inOrg` with the OLD configuration; if the rotation entry is written through `inScopeOf` (which reuses the current scope for the same org) it is signed by the old key and says nothing true. Expect `withOrg` to be entered afresh and the entry to verify against the NEW key (Task 3 pins the signature against the new public key).
2. **Two owners rotating at once** — the second update must match nothing and write nothing (Task 3).
3. **A malformed retired entry in the column** — the read path must skip it with a warning, never 500 the Audit log page (Task 2).
4. **The founding workspace** — its environment bundle must keep verifying after the column is added, joined with the column (Task 2).
5. **Secrets hygiene** — no private PEM in any recorded request body except inside the sealed envelope, none in the returned value or any log (Task 3).

---

### Task 1: Migration 0035 — `orgs.ledger_retired_keys`

**Files:** Create `supabase/migrations/0035_ledger_retired_keys.sql`; Test `tests/ledger-retired-keys-migration.test.ts`.

- [ ] **Step 1: Failing test** (PGlite; follow tests/counterparty-address-migration.test.ts / tests/go-live-migration.test.ts for setup and for how the tenant role and service role are exercised):
  - the column exists as `jsonb`, not null, default `'[]'::jsonb`; an org created by `createOrg` reads `[]`;
  - the service role can set it to `[{"id":"abc","publicKeyPem":"-----BEGIN PUBLIC KEY-----…","retiredAt":"2026-09-30T00:00:00Z"}]`;
  - the tenant role cannot update `orgs` at all (it never could; assert the update is refused or matches nothing, whichever the existing orgs grants give — check tests/tenancy-migration.test.ts for how orgs access by the tenant role is asserted and mirror it).
- [ ] **Step 2:** `npx vitest run tests/ledger-retired-keys-migration.test.ts` → FAIL (column missing).
- [ ] **Step 3: Migration:**

```sql
-- Ledger key rotation (docs/superpowers/specs/2026-09-30-ledger-key-rotation-design.md).
--
-- The public halves of the keys a workspace signed with before its current one,
-- in the order they were retired: [{ id, publicKeyPem, retiredAt }]. Public
-- material, so no envelope; read with the rest of the org row by orgConfig and
-- written only by the service role, in the same update that replaces
-- ledger_signing_key_enc (K1, K2). Additive: old code never selects it.
alter table public.orgs add column if not exists ledger_retired_keys jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.orgs'::regclass and conname = 'orgs_ledger_retired_keys_is_array'
  ) then
    alter table public.orgs add constraint orgs_ledger_retired_keys_is_array check (jsonb_typeof(ledger_retired_keys) = 'array');
  end if;
end $$;
```

  Add a test that a non-array value is refused by `orgs_ledger_retired_keys_is_array`.
- [ ] **Step 4:** run the test plus `tests/tenancy-migration.test.ts tests/rls.test.ts tests/go-live-migration.test.ts` → PASS.
- [ ] **Step 5: Commit** `Keep a workspace's retired ledger keys on the workspace`.

---

### Task 2: `orgConfig` reads a workspace's retired keys

**Files:** Modify `src/lib/dal/org-config.ts`; Test `tests/org-config.test.ts` (extend).

**Interfaces:**
- `OrgRow` gains `ledger_retired_keys?: unknown` (optional, so existing test literals keep compiling; the loader selects it).
- `ORG_SECRET_COLUMNS` appends `, ledger_retired_keys`.
- `export function retiredKeyBundle(value: unknown, warnings: string[]): string | undefined` — joins the `publicKeyPem` of every well-formed item (an object with string `id`, string `publicKeyPem` containing `-----BEGIN PUBLIC KEY-----`) with `\n`; pushes `ledger_retired_keys entry <n> is not a public key; skipped` for each malformed item; `undefined` when none.
- `orgConfig` sets `ledgerRetiredPublicKeys` to: for the founding org, the environment bundle and the column bundle joined with `\n` (either may be absent); for every other org, the column bundle. Update the comment that said only the founding chain rotates.

- [ ] **Step 1: Failing tests** in tests/org-config.test.ts (read the file first and reuse its org-row builder):
  - a non-founding org with two retired items gets both PEMs in `config.ledgerRetiredPublicKeys`, and `ledgerKeyring(config).retired` has two keys whose ids match the items';
  - a non-founding org with none gets `undefined`;
  - the founding org with an env bundle and one column item gets both;
  - a malformed item (`{ id: 1 }`, a private PEM, a string) is skipped and named in `warnings`; the good ones still load;
  - `ORG_SECRET_COLUMNS` contains `ledger_retired_keys`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement as specified. A private PEM must never reach `ledgerRetiredPublicKeys` (`retiredPublicKeys` in ledger-keys.ts throws on one — skipping it here keeps the read path from throwing).
- [ ] **Step 4:** `npx vitest run tests/org-config.test.ts tests/ledger-keys.test.ts tests/org-scope.test.ts tests/dal.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `Read each workspace's retired ledger keys into its keyring`.

---

### Task 3: `recordLedgerKeyRotation` and `rotateLedgerKey`

**Files:** Modify `src/lib/ledger.ts`; Create `src/lib/platform/ledger-key.ts`; Tests `tests/ledger-key-rotation.test.ts`.

**Interfaces:**
- In src/lib/ledger.ts: `export async function recordLedgerKeyRotation(by: string): Promise<LedgerEntry | null>` — in the scope of the org; reads the head exactly as `recordKeyRotationIfAny` does, runs `detectKeyRotation(head, ledgerVerificationKeyring())`, and when a rotation is found appends through `appendSigned` (bypassing the automatic check) `{ actor: "human", domain: "system", action: "ledger_key_rotated", summary: \`Ledger signing key rotated: ${from} retired, ${to} now signs\`, detail: { from, to, by } }` with the scope's signing key (resolve it the same way `appendLedgerEntry` does). Extract the head read + detection shared with `recordKeyRotationIfAny` into one private helper rather than duplicating it.
- In src/lib/platform/ledger-key.ts:
  - `export type LedgerKeyErrorCode = "cycle_running" | "key_unreadable" | "conflict"`; `export class LedgerKeyError extends Error { code }` with the exact messages from Global Constraints.
  - `export async function rotateLedgerKey(input: { orgId: string; actorId: string; now?: Date }): Promise<{ from: string; to: string }>`:
    1. inside the org's scope (enter `withOrg(input.orgId, …, { userId })` if not already scoped to it — the check may reuse the current scope), refuse `cycle_running` if `cycle_runs` has a `running` row started within `CYCLE_IN_PROGRESS_MS`;
    2. `platformDb().from("orgs").select("ledger_signing_key_enc, ledger_retired_keys").eq("id", orgId).single()`;
    3. `decryptSecret(envelope, { orgId, column: "ledger_signing_key_enc" }, masterKeysFromEnv())` → on any failure (or a null envelope) throw `key_unreadable`; derive the old public key and `from = ledgerKeyId(...)`;
    4. `crypto.generateKeyPairSync("ed25519")`; `to = ledgerKeyId(newPublic)`; seal the new PKCS#8 PEM with `encryptSecret(pem, { orgId, column: "ledger_signing_key_enc" }, keys)`;
    5. `retired = [...(Array.isArray(row.ledger_retired_keys) ? row.ledger_retired_keys : []), { id: from, publicKeyPem: <old SPKI PEM>, retiredAt: now.toISOString() }]`;
    6. `platformDb().from("orgs").update({ ledger_signing_key_enc: envelope, ledger_retired_keys: retired }).eq("id", orgId).eq("ledger_signing_key_enc->>iv", <old envelope iv>).select("id")` → zero rows → throw `conflict`;
    7. **enter a fresh scope** — `withOrg(input.orgId, () => recordLedgerKeyRotation(input.actorId), { userId: input.actorId })`, never `inScopeOf` — so the new configuration (new key, old key retired) is read; if it throws, log `ledger key rotation: the rotation entry could not be written` with the org id and the error message, and still return (automatic detection records it on the next append);
    8. return `{ from, to }`.
  - `export async function ledgerKeyStatus(orgId: string): Promise<{ current: string | null; retired: Array<{ id: string; retiredAt: string }> }>` — `current` from `ledgerPublicKeyId()` in the org's scope; `retired` from the column (well-formed items only), newest first.

- [ ] **Step 1: Failing tests** (tests/ledger-key-rotation.test.ts; model the fake on tests/go-live-lib.test.ts `database()` — a stateful org row the fake reads and PATCHes, honouring `eq.` filters on `id` and `ledger_signing_key_enc->>iv`; ledger RPC appends recorded; `ledger_entries` head reads answered from recorded appends):
  - rotation: the PATCH body's `ledger_signing_key_enc` opens (with the test master keys) to a private key whose id is the returned `to`; `ledger_retired_keys` ends with `{ id: from, publicKeyPem: <old public PEM>, retiredAt: now }` after any existing items; the PATCH carries `ledger_signing_key_enc->>iv=eq.<old iv>`;
  - the recorded `append_ledger_entry` call is `ledger_key_rotated`, actor `human`, detail `{ from, to, by: ACTOR }`, `p_signing_key_id` = `to`, and its signature verifies against the NEW public key (`crypto.verify(null, Buffer.from(p_body_hash, "hex"), newPublic, Buffer.from(p_signature, "hex"))`);
  - the rotation works when called from inside an existing `withOrg` scope for the same org (as the server action does) and the entry is still signed by the new key (Review Focus 1);
  - a PATCH matching nothing → `conflict`, no append;
  - a running cycle → `cycle_running`, no PATCH;
  - an envelope sealed with other master keys → `key_unreadable`, no PATCH;
  - a failing append after the swap → the function still returns `{ from, to }` and logs (spy on console.error, assert no PEM in the logged arguments);
  - no recorded request body or params contains `PRIVATE KEY` (the new key travels only inside the envelope) and the returned value holds only ids;
  - `recordLedgerKeyRotation` returns null and appends nothing when the head is already signed by the current key;
  - end to end in memory: `buildChain` (tests/support/ledger-chain.ts) signed by A with A's id, then `continueChain` by B with B's id; `verifyChain(rows, { active: B, retired: [A] })` is valid; `exportFromRows` of it passes `public/tools/verify-ledger-export.mjs` (spawn it as tests/ledger-export-verifier.test.ts does) with exit 0, and with only B pinned exits 2.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npx vitest run tests/ledger-key-rotation.test.ts tests/ledger.test.ts tests/ledger-keys.test.ts tests/ledger-parity.test.ts && npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5: Commit** `Rotate a workspace's ledger signing key`.

---

### Task 4: The Settings panel, the action, and retired keys on the Audit log page

**Files:** Create `src/app/actions/ledger-key.ts`, `src/components/LedgerKeyPanel.tsx`; Modify `src/app/o/[slug]/settings/page.tsx`, `src/app/o/[slug]/audit/page.tsx`; Tests `tests/ledger-key-actions.test.ts`, `tests/ledger-key-panel.test.tsx`.

**Interfaces:**
- `rotateLedgerKeyAction(previous: { ok: boolean; message: string }, formData: FormData)` — `authorize(formData.get("orgSlug"), "org.administer")` first, then `inOrg(auth, …)`, calls `rotateLedgerKey({ orgId: auth.membership.orgId, actorId: auth.user.id })`, `revalidateOrgPages()`, answers `Signing key rotated: ${from} retired, ${to} now signs.`; a `LedgerKeyError` shows its own message; anything else logs and answers "That did not work. Try again in a moment." (mirror src/app/actions/sample-data.ts and its test tests/sample-data-actions.test.ts).
- `LedgerKeyPanel({ orgSlug, status, canAdminister })` — client component, a Card section titled "Ledger signing key" (heading + `aria-labelledby`, as GoLivePanel/WebhooksPanel do): "Current key" with the id in mono (or "—"), "Retired keys" as a list of `id · retired <utcMinute(retiredAt)>` (use the date formatter the app already uses for "Sep 30, 2026, 05:07 UTC" — find `utcMinute`) or "No key has been retired yet."; for owners a form with a `ConfirmDialog` (tone danger, title/description/confirm label exact from Global Constraints) whose trigger is the "Rotate signing key" button; for others the note "An owner of this workspace can rotate the key."; the result message via `FormMessage`/toast as other panels do.
- Settings page: `ledgerKeyStatus(membership.orgId)` joins its `Promise.all`, and `<LedgerKeyPanel orgSlug={slug} status={ledgerKey} canAdminister={canAdminister} />` renders after the API keys and webhooks panels, before the danger zone.
- Audit log page: in the public-key `Disclosure`, when `ledgerVerificationKeyring().retired` is non-empty, list each retired key under the active one using `exportKeys()` from src/lib/ledger-export.ts (id + PEM in the same `<pre>` style), under a small heading "Retired keys", and change the Disclosure summary to append ` · N retired` when N > 0.

- [ ] **Step 1: Failing tests:** action (refusal passthrough, permission literal `org.administer`, LedgerKeyError message, generic error, success message and revalidation); panel via `renderToStaticMarkup` (owner sees "Rotate signing key" and — the confirm content is in a portal and not in static markup, so assert the strings exist in the component source instead, as other tests do for dialogs; admin/viewer see the note and no button; retired ids render; empty state text); a source assertion that the Audit page imports `exportKeys` and renders "Retired keys" only when there are some.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run tests/ledger-key-actions.test.ts tests/ledger-key-panel.test.tsx tests/access-gates.test.ts tests/ui-consistency.test.ts tests/audit-export-ui.test.tsx && npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5: Commit** `Offer ledger key rotation in Settings and list retired keys`.

---

### Task 5: The guide

**Files:** Modify `content/docs/guides/audit-export.mdx`, `tests/docs-guides.test.ts`.

- [ ] **Step 1:** add to `QUOTED["guides/audit-export"]`: `["Ledger signing key", <LedgerKeyPanel path>]`, `["Rotate signing key", <panel>]`, `["Retired keys", <panel>]`, `["An owner of this workspace can rotate the key.", <panel>]`, `["Settings", APP_NAV]` (if not already present). Run → FAIL.
- [ ] **Step 2:** add a section `## 5. After a key rotation` (renumber nothing else): an owner can replace the workspace's signing key in **Settings** → **Ledger signing key** → **Rotate signing key**, for a suspected leak or as routine; the old public key stays listed under **Retired keys** there and on the **Audit log** page; the ledger records the change as `ledger_key_rotated` with both key ids and who rotated; entries keep verifying; to pin keys for an export of a rotated workspace, pass every key listed (repeat `--public-key` or put them in one file). Keep "Arc testnet" plain if named; no disclaimers.
- [ ] **Step 3:** `npx vitest run tests/docs-guides.test.ts tests/docs-content.test.ts tests/docs-headings.test.ts tests/docs-markdown.test.ts && npm run verify` → PASS.
- [ ] **Step 4: Commit** `Describe ledger key rotation in the audit export guide`.

---

## Rollout (the controller)

1. The partner applies 0035 (`npm run db:migrate`; the classifier refuses it to the controller) → the controller probes the column read-only.
2. PR, green, merge. 3. The partner rotates in a sandbox (Settings) and runs a cycle; the controller checks the `ledger_key_rotated` entry, `verifyLedger` valid, the export's two keys, the verifier VALID with both / NOT CHECKED with only the new one; records the result in spec §5; arc-canteen update.
