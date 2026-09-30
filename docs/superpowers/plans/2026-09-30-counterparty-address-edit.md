# Counterparty Address Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners and admins can set or change a counterparty's Arc address. The next payment to a changed address waits for a person to confirm it.

**Architecture:**
- A migration adds `address_changed_at` and `address_confirmed_at`.
- A library module `src/lib/counterparty-address.ts` owns validation, the compare-and-set edit, the confirmation, and `addressUnconfirmed()`.
- The AP guardrail gains a rule. The contractor stage skips unconfirmed milestones.
- `approveAndPay` checks the posted address and confirms it.
- Two server actions and a small client dialog go on the Counterparties page.

**Tech Stack:** Next.js server actions, supabase-js through the DAL, PGlite and vitest.

**Spec:** docs/superpowers/specs/2026-09-30-counterparty-address-edit-design.md

## Global Constraints

- The EVM address regex is `/^0x[0-9a-fA-F]{40}$/`, applied after trimming. An empty string means clearing the address.
- Messages, verbatim:
  - "Enter an Arc address: 0x followed by 40 hex characters."
  - "That is already this counterparty's address."
  - "Someone else changed this address a moment ago."
  - "This counterparty's address changed after this page loaded. Check the new address and try again."
  - "Counterparty not found."
- Ledger actions:
  - `counterparty_address_changed`, domain `compliance`, detail `{ by, counterpartyId, from, to }`;
  - `counterparty_address_confirmed`, domain `compliance`, detail `{ by, counterpartyId, address, via }`.
- The guardrail rule is `counterparty.address_unconfirmed`, with status `held`.
- Actions start with `const auth = await authorize(formData.get("orgSlug"), "<literal>")`, then `return inOrg(auth, async () =>` (tests/access-gates.test.ts).
- Product copy says "Arc testnet" plainly, with no "no real money" disclaimers.

## Review Focus

1. **A stale page.** A person approves or confirms after someone else changed the address. They must be refused, never allowed to confirm an address they did not see.
2. **A counterparty created with an address** (`address_changed_at` null) must never be held by the new rule. Otherwise every existing workspace's payments would stop.
3. **Clearing an address and setting it again** is still a change that needs confirmation.
4. **A milestone waiting on confirmation** must not burn a model call, or write a ledger entry, every cycle.
5. **Mixed case.** An edit to the same address with different letter case (EVM checksum case) is the same address, so it is refused as unchanged.

---

### Task 1: Migration 0033 and the address library

**Files:**
- Create: `supabase/migrations/0033_counterparty_address_change.sql`
- Create: `src/lib/counterparty-address.ts`
- Test: `tests/counterparty-address-migration.test.ts`, `tests/counterparty-address.test.ts`

**Produces:**
- `ARC_ADDRESS = /^0x[0-9a-fA-F]{40}$/`
- `parseAddressInput(raw: string): { ok: true; address: string | null } | { ok: false; message: string }`
- `addressUnconfirmed(changedAt: string | null, confirmedAt: string | null): boolean`
- `class CounterpartyAddressError extends Error { code: "invalid" | "unchanged" | "conflict" | "not_found" | "stale" }`
- `changeCounterpartyAddress(input: { actorId: string; counterpartyId: string; raw: string }): Promise<{ name: string; from: string | null; to: string | null }>`
- `confirmCounterpartyAddress(input: { actorId: string; counterpartyId: string; shownAddress: string; via: "approval" | "confirm" }): Promise<boolean>`, which returns whether it confirmed anything.

Steps:
- [ ] Write the migration test (column types; the tenant can update its own row's columns and not another org's; replay is idempotent), then run it and see it fail.
- [ ] Write the migration: two `add column if not exists`, `notify pgrst`, a rollback comment, and a header explaining the 0018 grant covers them.
- [ ] Write the library tests against `fakeSupabase`:
  - parse: good, bad, empty, whitespace;
  - unchanged, including a case-only difference;
  - the edit's update filters on the old address (`address=eq.<old>` or `address=is.null`) and sets `address_changed_at`;
  - no rows returned gives `conflict`;
  - the ledger entry body;
  - confirm: guarded on `address` and `address_changed_at`, a stale shown address gives `stale`, an already-confirmed counterparty returns false and writes no entry.
- [ ] Implement, get the tests green, commit.

### Task 2: The guardrail and the orchestrator

**Files:**
- Modify: `src/lib/agent/guardrails.ts`, `src/lib/agent/orchestrator.ts` (AP select ~1162, guardrail call ~1355, ledger `observed`; contractor select ~1484 and loop)
- Test: `tests/guardrails.test.ts`, and the orchestrator's contractor test file (find the one that exercises `milestone_release`)

Steps:
- [ ] Guardrail tests:
  - an unconfirmed pay is held with the rule and a reasoning naming the date;
  - confirmed after the change is not held;
  - never changed is not held;
  - a duplicate or high risk still wins;
  - non-pay actions pass through.
- [ ] Add optional `addressChangedAt` and `addressConfirmedAt` to `ApGuardrailInput`, and the rule after high risk and before the limit, using `addressUnconfirmed`.
- [ ] Orchestrator AP:
  - select `address_changed_at, address_confirmed_at` in the embedded counterparty;
  - pass them to the guardrail;
  - add `addressUnconfirmed` to `observed`.
- [ ] Orchestrator contractors: select the same columns. Before `decide`, when unconfirmed, push the line `${name}: "${title}" waiting for someone to confirm its new address` and `continue`, with no status change and no ledger entry. The in-flight reconcile path is untouched, because a release already sent is reconciled.
- [ ] A contractor test: an unconfirmed milestone stays `verified`, with no model call and no ledger entry. Commit.

### Task 3: Approve-and-pay checks and confirms

**Files:**
- Modify: `src/lib/agent/approvals.ts`, `src/app/actions/approvals.ts`, `src/components/ApprovalCard.tsx`, `src/app/docs-shots/shots.tsx` (the `HELD` sample gains `address`)
- Test: `tests/approvals.test.ts`, `tests/approvals-actions.test.ts`, the ApprovalCard test

Steps:
- [ ] `WaitingPayable` gains `address: string | null`, and `listWaitingPayables` selects it.
- [ ] `approveAndPay` takes `shownAddress: string`. After the early refusals and before the claim, it raises `address_changed` when `(invoice.address ?? "").toLowerCase() !== shownAddress.trim().toLowerCase()`. After the claim succeeds, it calls `confirmCounterpartyAddress({ via: "approval" })` best effort: log on failure, never fail the payment.
- [ ] The action passes `formString(formData, "address")`.
- [ ] The card shows "Pays to <address>" (or "No address set") in mono, and posts `<input type="hidden" name="address">`.
- [ ] Tests: stale refused before the claim; a matching address confirms; a missing address with none shown is fine. Commit.

### Task 4: Actions and the Counterparties UI

**Files:**
- Modify: `src/app/actions/intake.ts` (add `updateCounterpartyAddressAction` with `records.write`, and `confirmCounterpartyAddressAction` with `approval.decide`), `src/app/o/[slug]/counterparties/page.tsx`
- Create: `src/components/intake/CounterpartyAddressEdit.tsx` (client: an "Edit address" dialog, and a "Confirm address" button with its ConfirmDialog)
- Modify: `content/docs/guides/first-payment.mdx` (a "Changing an address" section)
- Test: `tests/intake-action.test.ts` (or a new `tests/counterparty-address-actions.test.ts`), plus a component render test

Steps:
- [ ] Action tests: the permission literals (checked by access-gates too), the messages mapped from `CounterpartyAddressError`, revalidation.
- [ ] The page:
  - "Edit address" on each card when `canWrite`;
  - an "Address changed <date> · not yet confirmed" badge when unconfirmed;
  - "Confirm address" when `viewerCan(slug, "approval.decide")` and unconfirmed.
- [ ] The guide section: an edit holds the next payment until someone approves it or presses "Confirm address".
- [ ] Commit.

### Task 5: Verification and ship

- [ ] Run `npm test`, `npx tsc --noEmit` and `npm run lint`, all green.
- [ ] Headless Edge render of the Counterparties card states, through the docs-shots route when practical.
- [ ] Apply 0033 to production before the merge (additive and nullable).
- [ ] PR, merge on green, then record it in the roadmap memory.
