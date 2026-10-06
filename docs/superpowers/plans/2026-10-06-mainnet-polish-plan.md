# Mainnet Polish (Phase 2e) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing a person sees on a workspace on Arc mainnet names Arc testnet or offers what Arc mainnet lacks, and the transfer watch visits only what can hold a live payment.

**Architecture:** Small, independent fixes, in three tasks:
- link pages get their own preview card (E1);
- five copy and refusal fixes read the profile or the outlook (E2–E5, E8);
- the transfer watch narrows its visits and prefers Circle's answer (E6, E7).

**Tech Stack:** Next.js (App Router, `next/og`), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-mainnet-polish-design.md` (rulings E1–E8).

## Global Constraints

- **Arc testnet reads as before**, except:
  - the contractor-chain refusal (E4);
  - the callout without a reserve (E3);
  - "0.10" (E8);
  - the link pages' cards (E1).
- **No migration.** The watch never moves money.
- **The copy ratchet stays green.** Its `intake-validation.ts` allowance is removed.
- **Each task ends with `npm run verify` green.** The last also runs `npx next build`.

## Review Focus

1. **A link card must never carry a link's details.** The image routes read no token data.
2. **The org filter must not drop a workspace that holds a live payment.** Hosted and own-credential workspaces are both kept.
3. **A refusal reordered in E5 must still refuse a testnet sandbox** with the old "take it live first" text.

---

### Task 1: Link pages get their own preview card (E1)

**Files:**
- Modify: `src/app/_og/SocialPreview.tsx`. `renderSocialImage` takes `network?: string`, defaulting to "Arc testnet", for the footer. It adds `linkPreviewImage(badge: string)`, which renders the platform card with that badge and network "Arc".
- Create: `src/app/pay/[token]/opengraph-image.tsx`, `src/app/pay/[token]/twitter-image.tsx`, and the same pair under `src/app/payee/[token]/` and `src/app/receipt/[token]/`. Each calls `linkPreviewImage` and exports `alt`, `size` and `contentType`.
- Test: `tests/link-preview-images.test.tsx`. It mocks `next/og`'s `ImageResponse` to capture the element tree, then asserts:
  - each of the six routes renders "Arc", and never "Arc testnet";
  - each carries its badge;
  - none imports a reader of link data (source check).

### Task 2: What a mainnet page and form still say wrong (E2–E5, E8)

**Files:**
- `src/components/intake/CounterpartyIntake.tsx` (E2), with a test in its form test.
- `src/components/vx/CashOutlook.tsx` (E3), with a test in its test.
- `src/lib/intake-validation.ts` (E4). The ratchet's allowance for this file drops.
- `src/app/actions/escrow.ts` and `src/app/actions/treasury.ts` (E5), each with a test on a mainnet sandbox.
- `src/lib/getting-started.ts` (E8), and `content/docs/api/get-status.mdx` (E8).

### Task 3: The watch visits less and believes Circle (E6, E7)

**Files:**
- `src/lib/agent/transfer-watch.ts`:
  - the orgs read filters with `.or("wallet_host.not.is.null,circle_api_key_enc.not.is.null")`;
  - the entry's `txHash` is `answer.txHash ?? row.tx_hash`;
  - a provider whose `mode !== "live"` counts as not asked.
- `tests/transfer-watch.test.ts`, with cases for each of the three.
- `ARCHITECTURE.md`: the transfer watch's line on which workspaces it visits.
