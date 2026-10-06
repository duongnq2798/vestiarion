# Two People Above a Figure on Arc Mainnet (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every mainnet workspace pays above 100 USDC only with two people, the figure cannot be turned off there, mainnet receipts read native USDC, and 2a's eight deferred minors are fixed; Arc testnet unchanged.

**Architecture:** `createWorkspace` writes an `approval_policies` row on mainnet and records the starting limits; `changeTwoApprovals` refuses turning it off on mainnet; the profile's ARC payee chain gains its native USDC emitter; small fixes in the status route, the Go live badge, the banner, the reconcile line, `liveOperatingBalance`, the provider's token id, and a comment-only migration 0079.

**Tech Stack:** Next.js, TypeScript, Supabase, vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-10-06-mainnet-limits-design.md` (L1–L9).

## Global Constraints

- Messages verbatim: "A workspace on Arc mainnet keeps two approvals above a figure."
- Mainnet starting figure: 100 USDC. Starting limits detail: `startingLimits: { dailyUsdc: 50, weeklyUsdc: 150, twoApprovalsAbove: 100 }`.
- Native USDC emitter: `0xfffffffffffffffffffffffffffffffffffffffe` (Arc docs, EIP-7708; mainnet since genesis).
- `goLiveOpen` stays false on Arc mainnet (L9).
- Every task ends with `npm run verify` green.

## Review Focus

1. A testnet workspace's balance after this change: byte-identical to before 2a for any 18-decimal on-chain value with gas reserve 0.
2. The mainnet figure row written at creation must not be counted as an owner's tightening (no two-approver requirement), and must not appear for testnet workspaces.
3. The status route for every network state (testnet sandbox, testnet live, mainnet unconnected, mainnet off) says what is true.

---

### Task 1: Two approvals from the start on Arc mainnet, kept there (L1, L2, L4)

**Files:** `src/lib/platform/workspace.ts`, `src/lib/approval-policy.ts`; tests `tests/workspace.test.ts`, `tests/approval-policy*.test.ts` (whichever covers `changeTwoApprovals`).

- [ ] **Step 1: failing tests**
  - `createWorkspace({ network: "arc-mainnet" })` posts `/rest/v1/approval_policies` with `{ two_approvals_above: 100, updated_by: USER }`, and `org_created` detail has `startingLimits: { dailyUsdc: 50, weeklyUsdc: 150, twoApprovalsAbove: 100 }`; on Arc testnet neither.
  - `changeTwoApprovals({ value: "" })` in a mainnet scope with a stored figure rejects `{ code: "mainnet_keeps_figure", message: "A workspace on Arc mainnet keeps two approvals above a figure." }` and writes nothing; raising (`"500"`) is accepted; on testnet turning off is accepted as before.
- [ ] **Step 2: run, see them fail.** `npx vitest run tests/workspace.test.ts tests/approval-policy*.test.ts`
- [ ] **Step 3: implement.** `MAINNET_STARTING_TWO_APPROVALS = 100` beside `MAINNET_STARTING_BUDGET`; insert the row in the mainnet branch; `startingLimits` in `org_created`'s detail; `ApprovalPolicyErrorCode` gains `mainnet_keeps_figure`; in `changeTwoApprovals`, after parsing, `if (to === null && workspaceNetwork().id === "arc-mainnet") throw new ApprovalPolicyError("mainnet_keeps_figure")`.
- [ ] **Step 4: run, see them pass; `npm run verify`; commit** "Start every mainnet workspace with two approvals above 100 USDC, and keep a figure there".

### Task 2: Mainnet receipts read native USDC, and the platform's token id stays on testnet (L5, L6)

**Files:** `src/lib/network.ts`, `src/lib/circle/liveProvider.ts` (or `src/lib/dal/org-config.ts`); tests `tests/network.test.ts`, receipts' on-chain test, `tests/circle-live-provider.test.ts`.

- [ ] **Step 1: failing tests** — the mainnet profile's ARC entry has `nativeUsdc: "0xfffffffffffffffffffffffffffffffffffffffe"`; `readOnChain` for an ARC receipt counts a `Transfer` log from that emitter; a `LiveProvider` on `ARC_MAINNET` with `chain.usdcTokenId` set still looks USDC up by contract (calls `getWalletTokenBalance` and sends the matched id).
- [ ] **Step 2: run, fail. Step 3: implement** — add the field; in `LiveProvider`'s constructor take `chain.usdcTokenId` only when `options.network.id === "arc-testnet"`. **Step 4: pass, verify, commit** "Read native USDC on mainnet receipts, and keep the platform's token id to Arc testnet".

### Task 3: Pages and books that tell the truth about a held mainnet workspace (L7, L8)

**Files:** `src/app/api/v1/status/route.ts`, `src/components/GoLivePanel.tsx`, `src/components/MainnetBanner.tsx`, `src/lib/agent/balances.ts`, `supabase/migrations/0079_network_comment.sql`; tests: the status route test, `tests/go-live-panel.test.tsx`, `tests/mainnet-banner.test.tsx`, `tests/balance-sync.test.ts`, a PGlite test for the comment.

- [ ] **Step 1: failing tests**
  - status: a mainnet workspace with no credentials answers payments `unavailable` (mirror the route's unreadable-credentials case).
  - panel: `status({ network: "arc-mainnet", mainnetOff: true, step: "live" })` badge text contains "Arc mainnet switched off" and not "paying".
  - banner: built from `networkHold` (same three texts; assert the component imports nothing but the hold: render equals `networkHold(...)` text).
  - balances: the reconcile change note for a mainnet operating account reads `on-chain 5 less 0.1 gas reserve`; `liveOperatingBalance(x, r, 0)` equals the pre-2a formula for 10,000 random 18-decimal `x` (inline the old formula in the test).
  - migration: `col_description` of `orgs.network` names "once it has an account".
- [ ] **Step 2: fail. Step 3: implement. Step 4: pass, verify, `next build`, commit** "Tell the truth about a held mainnet workspace in the API, the panel and the books".

### Task 4: Docs

- [ ] README, ARCHITECTURE (the 2a section gains the two approvals and the receipt emitter), the go-live guide's "On Arc mainnet" (two approvals above 100), changelog if the status API's answer changes (it does: `unavailable` for a mainnet workspace), spec status. Commit "Document two approvals on Arc mainnet".
