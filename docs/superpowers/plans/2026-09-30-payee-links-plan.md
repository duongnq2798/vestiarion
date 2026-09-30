# Payee Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner or admin sends a payee a one-time link. The payee enters their own Arc address without an account, and the address waits for a member's confirmation like any other address change.

**Architecture:** A platform table `payee_links`, like `api_keys`, holds only a hash of each token. Definer RPCs create, preview, claim, release and revoke links. `src/lib/platform/payee-links.ts` wraps them. The public page `/payee/[token]` and its session-less action call the library, which enters the workspace scope only to make the address change through the existing `changeCounterpartyAddress`.

**Tech Stack:** Postgres (PGlite in tests), Next.js App Router, server actions, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-payee-links-design.md`

## Global Constraints

- The migration is `0039_payee_links.sql`: idempotent, with a commented rollback.
  - Definer functions use `search_path = ''`, and only `service_role` may execute them.
  - The table has RLS on, no policies, and `revoke all` from anon and authenticated.
- A token is `vxp_` followed by 43 base64url characters (32 random bytes). Only `sha256(secret)` is stored, as hex.
- A link expires 7 days after it is created and works once. A new link for a payee revokes the old unused one.
- Every unusable link shows the same page text: "This link is no longer valid. Ask the business that sent it for a new one." The page names no workspace.
- A payee's submission always stamps `address_changed_at`, so payments wait for a member's confirmation. Ledger `via: "payee_link"`.
- Analytics see `/payee/:token`. The page is `noindex`.
- Commit messages are neutral. The changelog gets an entry.

## Review Focus

- The same token submitted twice at once: one change. The other submission sees the invalid-link message.
- A payee submitting the address already on file: the link is used, and they are told so.
- A Circle-style checksummed address, or one with surrounding spaces: accepted and trimmed. A 41-character one: refused, and the link is not used.
- A link created for a counterparty in another workspace: refused in the database.
- Revoking a link that was already used: it stays used, and nothing changes.

---

### Task 1: Migration 0039 (PGlite test first)

`tests/payee-links-migration.test.ts` covers:
- the grants, for anon, authenticated and the tenant role;
- create revokes the previous unused link;
- create refuses a foreign counterparty;
- claim works once, and never on an expired or revoked link;
- release makes a link claimable again;
- preview returns no row for an unusable link;
- revoke is scoped to its workspace and never touches a used link;
- cascade on counterparty delete.

Also update `tests/account-deletion.test.ts`'s foreign-key inventory with `payee_links.created_by` (set null). Commit: "Store one-time payee address links".

### Task 2: `src/lib/platform/payee-links.ts`, and `changeCounterpartyAddress` for a payee

Interfaces:
- `generatePayeeLinkToken(random?) → { token, secretHash }`
- `parsePayeeLinkToken(token) → secret | null`
- `createPayeeLink({ orgId, actorId, counterpartyId }) → { link: { id, counterpartyId, expiresAt }, token }`
  - It appends `payee_link_created`.
- `listActivePayeeLinks(orgId) → Map<counterpartyId, { id, expiresAt }>`
- `revokePayeeLink({ orgId, actorId, linkId }) → boolean`
  - It appends `payee_link_revoked` when it revoked something.
- `previewPayeeLink(token) → { orgName, counterpartyName, expiresAt } | null`
- `submitPayeeAddress(token, raw) → { ok: true; orgName; unchanged: boolean } | { ok: false; reason: "invalid_address" | "invalid_link" }`
  - The address is parsed first, and an empty address is refused.
  - Then the link is claimed. Then `withOrg(orgId, () => changeCounterpartyAddress({ actor: { payeeLinkId }, ... }))`.
  - `unchanged` resolves as ok with `unchanged: true`.
  - Any other error releases the link and throws.

`changeCounterpartyAddress` changes its input from `actorId: string` to `actor: { userId: string } | { payeeLinkId: string }`. Update its callers. The ledger detail is `by: userId`, or `by: null, via: "payee_link", linkId`.

Tests in `tests/payee-links.test.ts` use a fake Supabase and a mocked `withOrg`. Extend `tests/counterparty-address.test.ts` for the payee actor. Commit: "Create, preview, claim and revoke payee links".

### Task 3: Actions and the public page

- `src/app/actions/payee-links.ts`: `createPayeeLinkAction(formData)` and `revokePayeeLinkAction(formData)`, both needing `records.write`. The token is returned only by create.
- `src/app/payee/[token]/actions.ts`: `submitPayeeAddressAction(prev, formData)`, with no session.
- `src/app/payee/[token]/page.tsx`: the three states (form, done, invalid), `robots: { index: false }`, `dynamic = "force-dynamic"`.
- `src/lib/analytics/redact.ts`: the `/payee/` rule.
- Tests:
  - the actions (authorize mocked);
  - the page renders with the library mocked;
  - `tests/analytics-redact.test.ts`.

Commit: "Let a payee enter their own address through a one-time link".

### Task 4: The card control and docs

- `src/components/intake/PayeeLinkControl.tsx`:
  - **Ask for address** opens a dialog, which creates the link and shows it once with `CopyButton`.
  - While a link is active, the card shows "Address link sent · expires *date*" and **Revoke**.
  - `counterparties/page.tsx` loads the active links through `listActivePayeeLinks` and passes them in, only for `records.write`.
- Docs:
  - a section in `content/docs/guides/first-payment.mdx`;
  - `content/docs/changelog.mdx`.
- Tests: the component renders; the docs guide pins.
- `npm run verify`. Commit: "Ask a payee for their address from the counterparty card".

### Task 5: Ship

- A final whole-branch review. Then the partner migrates 0039, the PR is opened, CI goes green, and it is merged.
- The rollout check from spec §7. Record it in §8, and set roadmap row T2 to DONE.
