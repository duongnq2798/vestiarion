# EURC Invoices, Phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pieces of EURC invoices that the payment-timing branch does not touch: the Stablecoin Service quote, EURC transfers and balance reads in the providers, and migration 0040.

**Architecture:**
- `src/lib/fx/quote.ts` is a small fetcher with a deadline, a Zod-checked answer and a 5-minute cache.
- The providers gain a `Stablecoin` token parameter, which defaults to USDC everywhere.
- 0040 constrains the currency, records a token on each payment intent, and keeps EURC out of every USDC figure in `open_numbers`.

**Tech Stack:** fetch with AbortSignal.timeout, Zod, Circle developer-controlled wallets SDK, Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-eurc-invoices-design.md` (Phase 1 of §3).

## Global Constraints

- EURC on Arc testnet is `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, and USDC's ERC-20 interface is `0x3600000000000000000000000000000000000000`. Both have 6 decimals. The chain is `Arc_Testnet`.
- The quote is `GET https://api.circle.com/v1/stablecoinKits/quote`. Parameters: `tokenInAddress`, `tokenInChain`, `tokenOutAddress`, `tokenOutChain`, `fromAddress`, `toAddress`, `amount` (base units), `slippageBps`. The answer is `quote.estimatedAmount` and `quote.minAmount`, in base units.
- The token defaults to `"USDC"` in every signature, so existing callers are unchanged.
- The migration is `0040_eurc.sql`: idempotent, with a commented rollback.
- `open_numbers` keeps its jsonb shape. `usdcPaid` and `usdcInWallets` count USDC only; `payments` counts every token.

## Review Focus

- A quote answer in base units with more than 6 digits, or `"0"`: parsed exactly, never as a float that loses cents.
- The quote service down or slow: an error within the deadline, never a hang in a cycle.
- A wallet that has never held EURC: the transfer fails with "fund EURC first", not an undefined token id.
- A historical payment intent with no token: counted as USDC.

---

### Task 1: `src/lib/fx/quote.ts`

- `quoteEurcInUsdc(amountEurc: number, opts?: { fromAddress: string; now?: number; fetch?: typeof fetch })` returns `{ usdcEstimated: number; usdcMinimum: number; rate: number; source: "circle-stablecoin-quote"; quotedAt: string }`.
- Errors are thrown as `FxQuoteError("unavailable" | "no_route" | "malformed")`.
- The cache is keyed by the amount in base units and lasts 5 minutes.
- Tests use a faked fetch: request shape, parse, base units, the 10 s deadline, no route (`code 331001`), malformed, cache, and a negative or zero amount.

### Task 2: Provider token support

- `types.ts`: `export type Stablecoin = "USDC" | "EURC"`; `TransferParams.token?: Stablecoin`; `ChainProvider.getTokenBalance(accountId, token)`.
- `liveProvider.ts`: `resolveTokenId(walletId, token)`, with USDC keeping `usdcTokenId`, and EURC found by symbol in the wallet's token list and remembered per wallet. `transfer` uses the resolved id, and `getTokenBalance` reads the given symbol.
- `simulateProvider.ts`: an EURC transfer is simulated like a USDC one but never moves the stored USDC balance, and `getTokenBalance` for EURC is 0.
- Tests extend `tests/circle-live-provider.test.ts` and `tests/chain-provider.test.ts`.

### Task 3: Migration 0040

- `invoices.currency` check: `('USDC','EURC')`.
- `payment_intents.token` is `text not null default 'USDC'`, with a check `('USDC','EURC')`.
- `open_numbers` is redefined from 0037 with the `pay` CTE carrying `token`:
  - `usdcPaid` sums `token = 'USDC'` only;
  - `ourPayments` carries `token`;
  - `wallet` already filters on `token = 'USDC'`.
- The PGlite test goes in `tests/eurc-migration.test.ts`, and `tests/open-numbers-migration.test.ts` stays green.
