# Test USDC for shadow mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shadow-mode workspace on Arc testnet takes the test USDC its open bills need from one platform float wallet, in one click, recorded in its ledger.

**Architecture:** A float wallet in the platform's hosted Circle entity (`SHADOW_FLOAT_WALLET_ID`). Pure functions in `src/lib/test-usdc.ts` work out the amount (shortfall from `cashOutlook`, weekly cap, float cap) and the console view; `addTestUsdc` sends the transfer through Circle with an idempotency key derived from the workspace's grant count, signs a `test_usdc_added` ledger entry, and the server action raises an event cycle. The receipts stage never matches money from the float to a receivable.

**Tech Stack:** Next.js 16 server actions, TypeScript, vitest, `@circle-fin/developer-controlled-wallets`, Supabase (fake client in tests).

**Spec:** `docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md`

## Global Constraints

- Arc testnet only; never on Arc mainnet, never in a sandbox, never outside shadow mode.
- The code never spends real USDC and never calls TestMint.
- Weekly limit default 5,000 USDC (`SHADOW_FLOAT_WEEKLY_LIMIT`), any 7 days, counted from the workspace's own `test_usdc_added` entries.
- Amount rounded up to the cent, at least 1 USDC.
- Ledger: actor `human`, domain `treasury`, action `test_usdc_added`, detail `{ by, amount, from, to, transferId, txHash, status, shortfall, weeklyLimit }`.
- Product copy says "Arc testnet" plainly, no disclaimers; commits neutral, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every change to docs goes in the same commit as its code (guide, changelog, `.env.example`, ARCHITECTURE).
- Read `node_modules/next/dist/docs/` before touching Next APIs (AGENTS.md): this Next version differs from training data.
- Run single test files with `npx vitest run tests/<file>`; the whole gate is `npm run verify` (lockfile check, typecheck, lint, tests).

## Review Focus

- A second click while the first transfer is still in flight: both compute the same ordinal, so Circle gets the same idempotency key and makes one transfer (Task 2 test "two calls that counted the same entries send under one key").
- A stale page: the button said 480 but bills changed; the server recomputes and adds what is needed now, or "Nothing to add" (Task 2 test "works out the amount again at the moment of adding").
- A float transfer whose amount equals an open receivable with a pay link must not settle it (Task 3 receipts test).
- The platform stop switch on: refused before any Circle call (Task 2 test "refuses while payments are off").
- Circle answers the transfer but settlement is still pending: the entry is written with `txHash: null`, `status: "pending"`, and the weekly limit counts it (Task 2 test "records a transfer still processing").

---

### Task 1: Configuration, the platform accessor and the pure rules

**Files:**
- Modify: `src/lib/config.ts` (interface `VestiarionConfig`, `configFromEnv`)
- Modify: `src/lib/context.ts` (add `currentPlatformConfig`)
- Create: `src/lib/test-usdc-rules.ts`
- Modify: `.env.example` (after the `HOSTED_CIRCLE_ENTITY_SECRET=` line)
- Test: `tests/test-usdc-rules.test.ts`, `tests/config.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `VestiarionConfig.shadowFloat?: { walletId?: string; weeklyLimit: number }`
  - `currentPlatformConfig(): VestiarionConfig` (throws outside a DAL-built org scope, like `currentOrgConfig`)
  - `export const DEFAULT_WEEKLY_LIMIT = 5000`
  - `export const WEEK_MS = 7 * 86_400_000`
  - `export function ceilCents(value: number): number`
  - `export type TestUsdcRefusal = "nothing_needed" | "limit_reached" | "float_empty"`
  - `export function testUsdcAmount(input: { safeToSpend: number; takenThisWeek: number; weeklyLimit: number; floatBalance: number }): { amount: number; shortfall: number } | { refused: TestUsdcRefusal; shortfall: number }`
  - `export interface GrantEntry { ts: string; detail: { amount?: unknown } }`
  - `export function takenInWindow(entries: GrantEntry[], now: number): number`
  - `export function testUsdcKey(orgId: string, ordinal: number): string`
  - `export type TestUsdcView = { need: number; action: "add"; amount: number } | { need: number; action: "limit"; weeklyLimit: number } | { need: number; action: null }`
  - `export function testUsdcView(input: { safeToSpend: number; takenThisWeek: number; weeklyLimit: number; available: boolean; canAdd: boolean }): TestUsdcView | null`

- [ ] **Step 1: Write the failing tests**

`tests/test-usdc-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { walletIdempotencyKey } from "@/lib/circle/provision";
import { ceilCents, takenInWindow, testUsdcAmount, testUsdcKey, testUsdcView, WEEK_MS } from "@/lib/test-usdc-rules";

/** Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T3, T4, T8): the pure rules. */

describe("ceilCents", () => {
  it("rounds up to the cent, and leaves a whole cent alone", () => {
    expect(ceilCents(480.001)).toBe(480.01);
    expect(ceilCents(480.1)).toBe(480.1);
    expect(ceilCents(0.3)).toBe(0.3);
  });
});

describe("testUsdcAmount", () => {
  const base = { takenThisWeek: 0, weeklyLimit: 5000, floatBalance: 10_000 };
  it("adds what the open bills need: minus safe to spend, rounded up to the cent", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -480.004 })).toEqual({ amount: 480.01, shortfall: 480.01 });
  });
  it("adds at least 1 USDC", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -0.25 })).toEqual({ amount: 1, shortfall: 0.25 });
  });
  it("adds nothing when the wallet covers the bills", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: 0 })).toEqual({ refused: "nothing_needed", shortfall: 0 });
    expect(testUsdcAmount({ ...base, safeToSpend: 12 })).toEqual({ refused: "nothing_needed", shortfall: 0 });
  });
  it("stops at what the workspace may still take this week", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, takenThisWeek: 4000 })).toEqual({ amount: 1000, shortfall: 3000 });
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, takenThisWeek: 4999.5 })).toEqual({ refused: "limit_reached", shortfall: 3000 });
  });
  it("stops at what the float holds, and adds nothing from a float under 1 USDC", () => {
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, floatBalance: 1200.5 })).toEqual({ amount: 1200.5, shortfall: 3000 });
    expect(testUsdcAmount({ ...base, safeToSpend: -3000, floatBalance: 0.9 })).toEqual({ refused: "float_empty", shortfall: 3000 });
  });
});

describe("takenInWindow", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  it("adds the amounts of the last 7 days' entries and ignores older ones and nonsense", () => {
    const entries = [
      { ts: "2026-10-08T11:00:00Z", detail: { amount: 480.01 } },
      { ts: new Date(now - WEEK_MS + 60_000).toISOString(), detail: { amount: "20" } },
      { ts: new Date(now - WEEK_MS - 60_000).toISOString(), detail: { amount: 1000 } },
      { ts: "2026-10-08T10:00:00Z", detail: { amount: "abc" } },
      { ts: "2026-10-08T10:00:00Z", detail: {} },
    ];
    expect(takenInWindow(entries, now)).toBeCloseTo(500.01, 6);
  });
});

describe("testUsdcKey", () => {
  it("is a Circle idempotency key derived from the workspace and the grant's ordinal", () => {
    const org = "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a";
    expect(testUsdcKey(org, 3)).toBe(walletIdempotencyKey(org, "test-usdc:3"));
    expect(testUsdcKey(org, 3)).not.toBe(testUsdcKey(org, 4));
  });
});

describe("testUsdcView", () => {
  const base = { takenThisWeek: 0, weeklyLimit: 5000, available: true, canAdd: true };
  it("shows nothing when safe to spend is not below zero", () => {
    expect(testUsdcView({ ...base, safeToSpend: 0 })).toBeNull();
  });
  it("offers the shortfall to someone who may add it", () => {
    expect(testUsdcView({ ...base, safeToSpend: -480.004 })).toEqual({ need: 480.01, action: "add", amount: 480.01 });
  });
  it("offers what is left of the week when the shortfall is larger", () => {
    expect(testUsdcView({ ...base, safeToSpend: -3000, takenThisWeek: 4500 })).toEqual({ need: 3000, action: "add", amount: 500 });
  });
  it("says the week's limit is used", () => {
    expect(testUsdcView({ ...base, safeToSpend: -3000, takenThisWeek: 5000 })).toEqual({ need: 3000, action: "limit", weeklyLimit: 5000 });
  });
  it("shows the need alone without the float, or to someone who may not add it", () => {
    expect(testUsdcView({ ...base, safeToSpend: -10, available: false })).toEqual({ need: 10, action: null });
    expect(testUsdcView({ ...base, safeToSpend: -10, canAdd: false })).toEqual({ need: 10, action: null });
  });
});
```

Add to `tests/config.test.ts` (inside its top-level `describe` for `configFromEnv`, following the file's style):

```ts
it("reads the shadow mode float: its wallet id and a weekly limit of 5,000 USDC unless set", () => {
  const db = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };
  expect(configFromEnv(db).shadowFloat).toEqual({ walletId: undefined, weeklyLimit: 5000 });
  expect(configFromEnv({ ...db, SHADOW_FLOAT_WALLET_ID: " w-1 ", SHADOW_FLOAT_WEEKLY_LIMIT: "2500" }).shadowFloat).toEqual({ walletId: "w-1", weeklyLimit: 2500 });
  expect(configFromEnv({ ...db, SHADOW_FLOAT_WEEKLY_LIMIT: "-4" }).shadowFloat?.weeklyLimit).toBe(5000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/test-usdc-rules.test.ts tests/config.test.ts`
Expected: FAIL, "Cannot find module '@/lib/test-usdc-rules'" and `shadowFloat` undefined.

- [ ] **Step 3: Implement**

`src/lib/config.ts`, in `VestiarionConfig` after `mainnetAllowlist`:

```ts
  /**
   * Vestiarion's test USDC float for shadow mode (SHADOW_FLOAT_WALLET_ID, SHADOW_FLOAT_WEEKLY_LIMIT; test USDC T1, T3):
   * a wallet on Arc testnet in the platform's hosted Circle account, and what one workspace may take from it in 7 days.
   * Without a wallet id, or without the hosted pair, nothing is offered.
   */
  shadowFloat?: { walletId?: string; weeklyLimit: number };
```

In `configFromEnv`'s returned object, after `mainnetAllowlist`:

```ts
    shadowFloat: { walletId: trimmed(env.SHADOW_FLOAT_WALLET_ID), weeklyLimit: positiveNumber(env.SHADOW_FLOAT_WEEKLY_LIMIT, 5000) },
```

`src/lib/context.ts`, after `currentSecretWarnings`:

```ts
/**
 * The platform configuration the organization in scope was built from, guarded like its configuration. Only what the
 * platform itself owns is read through it: Vestiarion's test USDC float pays from the hosted Circle account whichever
 * account the workspace pays from (test USDC T1). A workspace's own configuration never carries that pair (R4).
 */
export function currentPlatformConfig(): VestiarionConfig {
  return organizationContext().platformConfig as VestiarionConfig;
}
```

`src/lib/test-usdc-rules.ts`:

```ts
import { walletIdempotencyKey } from "./circle/provision";

/**
 * Test USDC for shadow mode, the rules (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T3, T4, T8). Pure:
 * how much a workspace takes from Vestiarion's float, what it took this week, the key that keeps two clicks to one
 * transfer, and what the console says.
 */

export const DEFAULT_WEEKLY_LIMIT = 5000;
export const WEEK_MS = 7 * 86_400_000;
const MINIMUM = 1;

/** Up to the next cent; a figure already on a cent stays. */
export function ceilCents(value: number): number {
  return Math.ceil(Math.round(value * 1e6) / 1e4) / 100;
}

export type TestUsdcRefusal = "nothing_needed" | "limit_reached" | "float_empty";

/** What to add: the shortfall (minus safe to spend), at least 1 USDC, within the week's limit and the float's USDC. */
export function testUsdcAmount(input: {
  safeToSpend: number;
  takenThisWeek: number;
  weeklyLimit: number;
  floatBalance: number;
}): { amount: number; shortfall: number } | { refused: TestUsdcRefusal; shortfall: number } {
  if (!(input.safeToSpend < 0)) return { refused: "nothing_needed", shortfall: 0 };
  const shortfall = ceilCents(-input.safeToSpend);
  const left = Math.floor((input.weeklyLimit - input.takenThisWeek) * 100) / 100;
  if (left < MINIMUM) return { refused: "limit_reached", shortfall };
  const float = Math.floor(input.floatBalance * 100) / 100;
  if (float < MINIMUM) return { refused: "float_empty", shortfall };
  return { amount: Math.min(Math.max(shortfall, MINIMUM), left, float), shortfall };
}

export interface GrantEntry {
  ts: string;
  detail: { amount?: unknown };
}

/** The USDC a workspace's `test_usdc_added` entries took in the 7 days before `now`. */
export function takenInWindow(entries: GrantEntry[], now: number): number {
  return entries.reduce((sum, entry) => {
    const at = Date.parse(entry.ts);
    const amount = Number(entry.detail?.amount);
    return Number.isFinite(at) && at > now - WEEK_MS && Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  }, 0);
}

/** Circle's idempotency key for a workspace's grant number `ordinal`: two clicks that counted the same entries share it. */
export function testUsdcKey(orgId: string, ordinal: number): string {
  return walletIdempotencyKey(orgId, `test-usdc:${ordinal}`);
}

export type TestUsdcView =
  | { need: number; action: "add"; amount: number }
  | { need: number; action: "limit"; weeklyLimit: number }
  | { need: number; action: null };

/** What the console's shadow mode section says about test USDC; nothing when safe to spend is not below zero. */
export function testUsdcView(input: {
  safeToSpend: number;
  takenThisWeek: number;
  weeklyLimit: number;
  available: boolean;
  canAdd: boolean;
}): TestUsdcView | null {
  if (!(input.safeToSpend < 0)) return null;
  const need = ceilCents(-input.safeToSpend);
  if (!input.available || !input.canAdd) return { need, action: null };
  const left = Math.floor((input.weeklyLimit - input.takenThisWeek) * 100) / 100;
  if (left < MINIMUM) return { need, action: "limit", weeklyLimit: input.weeklyLimit };
  return { need, action: "add", amount: Math.min(Math.max(need, MINIMUM), left) };
}
```

`.env.example`, after `HOSTED_CIRCLE_ENTITY_SECRET=`:

```
# Test USDC for shadow mode (docs/guides/shadow-mode): a wallet on Arc testnet in the hosted Circle account above,
# filled from TestMint or Circle's faucet. `npm run shadow-float -- setup` makes it and prints its id. Unset, the
# console offers no test USDC. A workspace takes at most SHADOW_FLOAT_WEEKLY_LIMIT USDC in any 7 days (default 5000).
SHADOW_FLOAT_WALLET_ID=
# SHADOW_FLOAT_WEEKLY_LIMIT=5000
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/test-usdc-rules.test.ts tests/config.test.ts`
Expected: PASS. If `ceilCents(480.1)` fails from float error, keep the `Math.round(value * 1e6) / 1e4` pre-rounding as written.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts src/lib/context.ts src/lib/test-usdc-rules.ts .env.example tests/test-usdc-rules.test.ts tests/config.test.ts
git commit -m "Work out how much test USDC a shadow workspace may take"
```

---

### Task 2: Adding test USDC from the float

**Files:**
- Modify: `src/lib/circle/liveProvider.ts` (export `sendToCircle`)
- Create: `src/lib/test-usdc.ts`
- Test: `tests/test-usdc.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces; `cashOutlook` (`src/lib/cash-outlook.ts`); `listAccounts`, `listInvoices`, `listMilestones` (`src/lib/queries.ts`); `getChainProvider()` (`src/lib/circle`); `readShadowMode(db())`; `appendLedgerEntry`; `assertPaymentsEnabled` (`src/lib/payments-switch.ts`); `awaitSettlement` (`src/lib/circle/settlement.ts`); `stablecoinEntry` (`src/lib/circle/stablecoins.ts`); `workspaceNetwork()`; `txUrl` (`src/lib/payee-chains.ts`).
- Produces:
  - `export type TestUsdcErrorCode = "not_in_shadow" | "mainnet" | "not_live" | "unavailable" | "nothing_needed" | "limit_reached" | "float_empty"`
  - `export class TestUsdcError extends Error { code: TestUsdcErrorCode }` (message per the spec's table; `limit_reached` names the limit)
  - `export type FloatClient = Pick<CircleDeveloperControlledWalletsClient, "createTransaction" | "getTransaction" | "getWalletTokenBalance" | "getWallet">`
  - `export type FloatClientFactory = (credentials: { apiKey: string; entitySecret: string }) => FloatClient`
  - `export function testUsdcAvailable(config?: VestiarionConfig): boolean` (org config: `shadowFloat.walletId` set and `chain.hostedAvailable`)
  - `export interface TestUsdcWeek { takenThisWeek: number; weeklyLimit: number; latest: { amount: number; at: string; txHash: string | null } | null }`
  - `export async function readTestUsdcWeek(now?: number): Promise<TestUsdcWeek>`
  - `export interface TestUsdcAdded { amount: number; status: "confirmed" | "pending" | "failed"; txHash: string | null; txUrl: string | null }`
  - `export async function addTestUsdc(input: { actorId: string }, deps?: { circle?: FloatClientFactory; now?: number; settle?: typeof awaitSettlement }): Promise<TestUsdcAdded>`

- [ ] **Step 1: Write the failing tests**

`tests/test-usdc.test.ts` (follow `tests/mirror-address.test.ts`: mock `@/lib/ledger`'s `appendLedgerEntry`, use `fakeSupabase` + `orgTestContext`; mock `@/lib/circle`'s `getChainProvider` to return a fake provider `{ mode: "live", network: ARC_TESTNET, getTokenBalance: vi.fn(async () => ({ accountId: "op", chain: "ARC-TESTNET", token: "USDC", balance })) }`; mock `@/lib/payments-switch`'s `assertPaymentsEnabled`):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { addTestUsdc, readTestUsdcWeek, TestUsdcError, type FloatClientFactory } from "@/lib/test-usdc";
import { testUsdcKey } from "@/lib/test-usdc-rules";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/** Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T2–T5). */

const { ledgerMock, providerMock, paymentsMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), providerMock: vi.fn(), paymentsMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/circle", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle")>()), getChainProvider: providerMock }));
vi.mock("@/lib/payments-switch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/payments-switch")>()), assertPaymentsEnabled: paymentsMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a";
const MEMBER = "a1b2c3d4-0000-4000-8000-0000000002a1";
const FLOAT = "0xf10a7000000000000000000000000000000000f1";
const OPERATING = "0x0be2a7000000000000000000000000000000000a";
const base = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  HOSTED_CIRCLE_API_KEY: "hosted-key",
  HOSTED_CIRCLE_ENTITY_SECRET: "hosted-secret",
  SHADOW_FLOAT_WALLET_ID: "float-wallet",
});
const config: VestiarionConfig = { ...base, chain: { ...base.chain, hostedAvailable: true } };
const NOW = Date.parse("2026-10-08T12:00:00Z");
const USDC_TOKEN = { id: "usdc-token", symbol: "USDC", tokenAddress: "0x3600000000000000000000000000000000000000", blockchain: "ARC-TESTNET", isNative: false };

function circle(floatUsdc = "10000") {
  const createTransaction = vi.fn(async () => ({ data: { id: "tx-1" } }));
  const client = {
    getWallet: vi.fn(async () => ({ data: { wallet: { id: "float-wallet", address: FLOAT } } })),
    getWalletTokenBalance: vi.fn(async () => ({ data: { tokenBalances: [{ token: USDC_TOKEN, amount: floatUsdc }] } })),
    createTransaction,
    getTransaction: vi.fn(),
  };
  const factory = vi.fn(() => client) as unknown as FloatClientFactory;
  return { factory, client, createTransaction };
}
const settled = (status: "confirmed" | "pending", txHash?: string) =>
  vi.fn(async () => (status === "confirmed" ? { status, transaction: { id: "tx-1", txHash, state: "CONFIRMED" } } : { status })) as never;

/** One open payable of `bill` USDC due tomorrow, the operating account, shadow mode on, and `grants` earlier entries. */
function workspace(over: { shadow?: boolean; bill?: number; grants?: Array<{ ts: string; detail: Record<string, unknown> }>; operating?: boolean } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/shadow_modes") return { body: over.shadow === false ? [] : [{ currency: "USDC", started_at: "2026-10-07T00:00:00Z", started_by: MEMBER }] };
    if (r.path === "/rest/v1/accounts")
      return { body: over.operating === false ? [] : [{ id: "op", name: "Operating", kind: "operating", chain: "ARC-TESTNET", token: "USDC", address: OPERATING, circle_wallet_id: "op-wallet", balance: "999", apy: "0" }] };
    if (r.path === "/rest/v1/invoices")
      return { body: [{ id: "inv-1", direction: "payable", counterparty_name: "Firm Studio", amount: String(over.bill ?? 500), currency: "USDC", due_date: "2026-10-09", status: "pending", scheduled_for: null }] };
    if (r.path === "/rest/v1/milestones") return { body: [] };
    if (r.path === "/rest/v1/ledger_entries") return { body: over.grants ?? [] };
    return { body: [] };
  };
}

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>, c: VestiarionConfig = config) => runWith(orgTestContext({ config: c, client: fake.client, orgId: ORG, userId: MEMBER }), fn);
const provider = (operatingUsdc: number) => ({
  mode: "live",
  network: { id: "arc-testnet", circleBlockchain: "ARC-TESTNET" },
  getTokenBalance: vi.fn(async () => ({ accountId: "op", chain: "ARC-TESTNET", token: "USDC", balance: operatingUsdc })),
});

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  providerMock.mockReset().mockReturnValue(provider(20));
  paymentsMock.mockReset().mockResolvedValue(undefined);
});
```

Then these cases (write each in full, in the style above):

1. "sends what the open bills need from the float to the operating wallet, and signs it": `bill: 500`, operating 20 → the outlook's safe to spend is `20 - 500 - cushion`. Assert `createTransaction` called with `walletId: "float-wallet"`, `tokenId: "usdc-token"`, `destinationAddress: OPERATING`, `amount: [expected.toFixed(6)]` where `expected` is `ceilCents(-cashOutlook(...).safeToSpend)` computed in the test from the same rows with `cashOutlook` imported (do not hard-code the cushion), `idempotencyKey: testUsdcKey(ORG, 1)`, fee level MEDIUM. Assert the factory received `{ apiKey: "hosted-key", entitySecret: "hosted-secret" }`. Assert `ledgerMock` called with `actor: "human"`, `domain: "treasury"`, `action: "test_usdc_added"`, and `detail` `{ by: MEMBER, amount: expected, from: FLOAT, to: OPERATING, transferId: "tx-1", txHash: "0xabc", status: "confirmed", shortfall: expected, weeklyLimit: 5000 }`. Result `{ amount: expected, status: "confirmed", txHash: "0xabc", txUrl: "https://explorer.testnet.arc.io/tx/0xabc" }` (use `txUrl("arc-testnet", "0xabc")` rather than the literal).
2. "works out the amount again at the moment of adding, from the chain's balance": provider balance 600 with `bill: 500` → refused `nothing_needed` when 600 covers bill + cushion (pick operating USDC so `safeToSpend >= 0`; compute it with `cashOutlook` in the test); no `createTransaction`, no ledger entry. Note the `accounts` row says `balance: "999"` but the live read decides.
3. "counts this week's grants: the key's ordinal and the limit": `grants` = two entries within 7 days of amounts 2000 and 2900 and one older entry of 4000 → `createTransaction` amount is `100.000000` (5000 − 4900) when the shortfall is larger, key `testUsdcKey(ORG, 4)` (three entries in all, any age: the ordinal counts every grant ever).
4. "two calls that counted the same entries send under one key": run `addTestUsdc` twice with the same `grants` reply → both `createTransaction` calls carry the same `idempotencyKey`.
5. "records a transfer still processing": `settle: settled("pending")` → ledger detail `txHash: null`, `status: "pending"`; result `status: "pending"`, `txUrl: null`.
6. Refusals, each asserting `rejects.toMatchObject({ code })` and no `createTransaction`:
   - `not_in_shadow` (`shadow: false`);
   - `unavailable` (config without `SHADOW_FLOAT_WALLET_ID`; and config whose `chain.hostedCircleApiKey` is undefined);
   - `not_live` (`providerMock.mockReturnValue({ ...provider(0), mode: "simulate" })`; and `operating: false`);
   - `mainnet` (`config` with `network: "arc-mainnet"`);
   - `limit_reached` (grants totalling 5000 this week) with message containing "5,000";
   - `float_empty` (`circle("0.5")`);
   - payments off: `paymentsMock.mockRejectedValue(new PaymentsDisabledError(...))` → rejects with that error (import `PaymentsDisabledError` from `@/lib/payments-switch`), before `getWalletTokenBalance` is called.
7. `readTestUsdcWeek`: grants (newest first, as the query orders them) `[{ ts: "2026-10-08T11:00:00Z", detail: { amount: 480.01, txHash: "0xabc" } }, { ts: "2026-09-20T00:00:00Z", detail: { amount: 100 } }]` → `{ takenThisWeek: 480.01, weeklyLimit: 5000, latest: { amount: 480.01, at: "2026-10-08T11:00:00Z", txHash: "0xabc" } }`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/test-usdc.test.ts`
Expected: FAIL, "Cannot find module '@/lib/test-usdc'".

- [ ] **Step 3: Implement**

In `src/lib/circle/liveProvider.ts`, change `async function sendToCircle(` to `export async function sendToCircle(`.

`src/lib/test-usdc.ts`:

```ts
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { cashOutlook } from "./cash-outlook";
import { getChainProvider } from "./circle";
import { sendToCircle } from "./circle/liveProvider";
import { awaitSettlement } from "./circle/settlement";
import { stablecoinEntry } from "./circle/stablecoins";
import type { VestiarionConfig } from "./config";
import { currentOrgConfig, currentOrgId, currentPlatformConfig } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntry } from "./ledger";
import { txUrl } from "./payee-chains";
import { assertPaymentsEnabled } from "./payments-switch";
import { listAccounts, listInvoices, listMilestones } from "./queries";
import { readShadowMode } from "./shadow-mode";
import { DEFAULT_WEEKLY_LIMIT, takenInWindow, testUsdcAmount, testUsdcKey, type GrantEntry } from "./test-usdc-rules";
import { workspaceNetwork } from "./workspace-network";

/**
 * Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md). A workspace in shadow mode
 * pays each bill a person agrees to in USDC on Arc testnet, at the bill's real amount, so its operating wallet needs
 * that USDC first; Circle's faucet gives 20 every two hours. Vestiarion keeps a float of test USDC in a wallet of its
 * own, in the hosted Circle account, and a workspace takes from it what its open bills need: minus safe to spend, at
 * least 1 USDC, within its weekly limit and the float's USDC. One signed `test_usdc_added` entry per grant; the
 * grants counted so far key the transfer, so two clicks together make one. Runs inside an organization scope; who
 * may ask for it (`records.write`) is the caller's check.
 */

export type TestUsdcErrorCode = "not_in_shadow" | "mainnet" | "not_live" | "unavailable" | "nothing_needed" | "limit_reached" | "float_empty";

const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

function message(code: TestUsdcErrorCode, weeklyLimit: number): string {
  switch (code) {
    case "not_in_shadow":
      return "Test USDC is for shadow mode. An owner turns it on in Settings.";
    case "mainnet":
      return "Test USDC is for Arc testnet. On Arc mainnet the agent pays your real bills.";
    case "not_live":
      return "Go live on Arc testnet first: test USDC goes to the operating wallet.";
    case "unavailable":
      return "Vestiarion's test USDC float is not set up on this deployment.";
    case "nothing_needed":
      return "Nothing to add: the operating wallet covers your open bills.";
    case "limit_reached":
      return `This workspace took its ${number(weeklyLimit)} test USDC for this week.`;
    case "float_empty":
      return "Vestiarion's test USDC float is empty just now.";
  }
}

export class TestUsdcError extends Error {
  constructor(
    readonly code: TestUsdcErrorCode,
    weeklyLimit: number = DEFAULT_WEEKLY_LIMIT
  ) {
    super(message(code, weeklyLimit));
    this.name = "TestUsdcError";
  }
}

export type FloatClient = Pick<CircleDeveloperControlledWalletsClient, "createTransaction" | "getTransaction" | "getWalletTokenBalance" | "getWallet">;
export type FloatClientFactory = (credentials: { apiKey: string; entitySecret: string }) => FloatClient;
const defaultFloatClient: FloatClientFactory = (credentials) => initiateDeveloperControlledWalletsClient(credentials);

/** Whether this deployment offers test USDC: a float wallet, and the hosted account it lives in. */
export function testUsdcAvailable(config: VestiarionConfig = currentOrgConfig()): boolean {
  return Boolean(config.shadowFloat?.walletId && config.chain.hostedAvailable);
}

const weeklyLimitOf = (config: VestiarionConfig) => config.shadowFloat?.weeklyLimit ?? DEFAULT_WEEKLY_LIMIT;

type GrantRow = GrantEntry & { detail: { amount?: unknown; txHash?: unknown } };

/** Every grant this workspace took, newest first. */
async function grants(): Promise<GrantRow[]> {
  return unwrap(
    await db().from("ledger_entries").select("ts, detail").eq("action", "test_usdc_added").order("seq", { ascending: false })
  ) as GrantRow[];
}

export interface TestUsdcWeek {
  takenThisWeek: number;
  weeklyLimit: number;
  latest: { amount: number; at: string; txHash: string | null } | null;
}

export async function readTestUsdcWeek(now: number = Date.now()): Promise<TestUsdcWeek> {
  const rows = await grants();
  const newest = rows[0];
  return {
    takenThisWeek: takenInWindow(rows, now),
    weeklyLimit: weeklyLimitOf(currentOrgConfig()),
    latest: newest
      ? { amount: Number(newest.detail.amount), at: newest.ts, txHash: typeof newest.detail.txHash === "string" ? newest.detail.txHash : null }
      : null,
  };
}

/** Safe to spend today as the console works it out, with the operating wallet's USDC read from the chain. */
async function safeToSpendNow(operatingUsdc: number, now: number): Promise<number> {
  const [accounts, invoices, milestones] = await Promise.all([listAccounts(), listInvoices(), listMilestones()]);
  return cashOutlook({
    now,
    operatingUsdc,
    reserveUsdc: Number(accounts.find((account) => account.kind === "reserve")?.balance ?? 0),
    payables: invoices
      .filter((invoice) => invoice.direction === "payable")
      .map((invoice) => ({ id: invoice.id, counterparty: invoice.counterparty_name, amount: invoice.amount, currency: invoice.currency ?? null, due_date: invoice.due_date, status: invoice.status, scheduled_for: invoice.scheduled_for ?? null })),
    milestones: milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, contractor: milestone.contractor_name, amount: milestone.amount, status: milestone.status, escrow_state: milestone.escrow_state ?? null })),
    receivables: invoices
      .filter((invoice) => invoice.direction === "receivable")
      .map((invoice) => ({ id: invoice.id, counterparty: invoice.counterparty_name, amount: invoice.amount, currency: invoice.currency ?? null, due_date: invoice.due_date, status: invoice.status })),
  }).safeToSpend;
}

export interface TestUsdcAdded {
  amount: number;
  status: "confirmed" | "pending" | "failed";
  txHash: string | null;
  txUrl: string | null;
}

export async function addTestUsdc(
  input: { actorId: string },
  deps: { circle?: FloatClientFactory; now?: number; settle?: typeof awaitSettlement } = {}
): Promise<TestUsdcAdded> {
  const now = deps.now ?? Date.now();
  const config = currentOrgConfig();
  const weeklyLimit = weeklyLimitOf(config);
  if (!(await readShadowMode(db()))) throw new TestUsdcError("not_in_shadow");
  const network = workspaceNetwork();
  if (network.id !== "arc-testnet") throw new TestUsdcError("mainnet");
  const platform = currentPlatformConfig();
  const walletId = platform.shadowFloat?.walletId;
  const { hostedCircleApiKey: apiKey, hostedCircleEntitySecret: entitySecret } = platform.chain;
  if (!walletId || !apiKey || !entitySecret) throw new TestUsdcError("unavailable");

  const provider = getChainProvider();
  const operating = (await listAccounts()).find((account) => account.kind === "operating");
  if (provider.mode !== "live" || !operating?.address) throw new TestUsdcError("not_live");
  // Money moves on chain, so the platform's stop switch stops it as it stops a payment (T2).
  await assertPaymentsEnabled();

  const [balance, earlier] = await Promise.all([provider.getTokenBalance(operating.id, "USDC"), grants()]);
  const safeToSpend = await safeToSpendNow(balance.balance, now);
  const client = (deps.circle ?? defaultFloatClient)({ apiKey, entitySecret });
  const floatBalances = await client.getWalletTokenBalance({ id: walletId, includeAll: true });
  const usdc = stablecoinEntry(floatBalances.data?.tokenBalances, "USDC", network, network.circleBlockchain);
  const decided = testUsdcAmount({ safeToSpend, takenThisWeek: takenInWindow(earlier, now), weeklyLimit, floatBalance: Number(usdc?.amount ?? 0) });
  if ("refused" in decided) throw new TestUsdcError(decided.refused, weeklyLimit);
  if (!usdc?.token?.id) throw new TestUsdcError("float_empty", weeklyLimit);

  const float = await client.getWallet({ id: walletId });
  const from = float.data?.wallet?.address ?? null;
  const transferId = await sendToCircle(
    client.createTransaction({
      walletId,
      tokenId: usdc.token.id,
      destinationAddress: operating.address,
      amount: [decided.amount.toFixed(6)],
      // Every grant ever counted, so two clicks that read the same entries send one transfer (T4).
      idempotencyKey: testUsdcKey(currentOrgId(), earlier.length + 1),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    }),
    "createTransaction",
    "the test USDC transfer"
  );
  const settlement = await (deps.settle ?? awaitSettlement)(client, transferId);
  const txHash = settlement.transaction?.txHash ?? null;
  const status = settlement.status === "confirmed" ? "confirmed" : settlement.status === "failed" ? "failed" : "pending";
  await appendLedgerEntry({
    actor: "human",
    domain: "treasury",
    action: "test_usdc_added",
    summary: `Added ${number(decided.amount)} test USDC on Arc testnet to the operating wallet, from Vestiarion's test USDC float, for shadow mode`,
    detail: { by: input.actorId, amount: decided.amount, from, to: operating.address, transferId, txHash, status, shortfall: decided.shortfall, weeklyLimit },
  });
  return { amount: decided.amount, status, txHash, txUrl: txHash ? txUrl(network.id, txHash) : null };
}
```

Adjust only where the compiler says the real types differ (for example `Settlement.status` names, `createTransaction`'s parameter type needing a cast as in `liveProvider.ts`, or `stablecoinEntry`'s entry type exposing `amount`). Keep the order of the checks: shadow, network, float configured, live, stop switch, balances.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/test-usdc.test.ts tests/test-usdc-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/circle/liveProvider.ts src/lib/test-usdc.ts tests/test-usdc.test.ts
git commit -m "Add test USDC from the platform float to a shadow workspace's operating wallet"
```

---

### Task 3: Money from the float is not a client paying; the action; the event

**Files:**
- Modify: `src/lib/agent/receipts.ts` (skip matching for transfers from a float address)
- Modify: `src/lib/agent/cycle-soon.ts` (event kind)
- Create: `src/app/actions/test-usdc.ts`
- Test: `tests/receipts.test.ts` (add a case), `tests/test-usdc-action.test.ts`

**Interfaces:**
- Consumes: `addTestUsdc`, `TestUsdcError` (Task 2); `authorize`, `inOrg`, `revalidateOrgPages`, `raiseCycleEvent`.
- Produces:
  - `CycleEventKind` gains `"test_usdc_added"`.
  - `export interface TestUsdcActionResult { ok: boolean; message: string; txUrl?: string }`
  - `export async function addTestUsdcAction(previous: TestUsdcActionResult, formData: FormData): Promise<TestUsdcActionResult>`

- [ ] **Step 1: Write the failing tests**

In `tests/receipts.test.ts`, add a case next to the existing `recordIncomingTransfers` cases, built from that file's own fixtures: an unmatched incoming transfer from `0xf10a7000000000000000000000000000000000f1` whose amount equals an open receivable that has a live pay link (a case that matches by amount today), and a `ledger_entries` reply `[{ detail: { from: "0xF10A7000000000000000000000000000000000F1" } }]` for the request filtered on `action=eq.test_usdc_added`. Assert no `incoming_transfers` PATCH and no `invoices` PATCH happen, and `matched` is 0. Name it "never matches money from Vestiarion's test USDC float to a receivable".

`tests/test-usdc-action.test.ts` (follow `tests/mirror-address-ui.test.tsx` or another action test for how `authorize` and `inOrg` are mocked; grep `vi.mock("@/lib/auth/authorize"` to find one):

- owner/admin path: `addTestUsdc` mocked to resolve `{ amount: 480.01, status: "confirmed", txHash: "0xabc", txUrl: "https://explorer.testnet.arc.io/tx/0xabc" }` → result `{ ok: true, message: "Added 480.01 test USDC to the operating wallet.", txUrl: "https://explorer.testnet.arc.io/tx/0xabc" }`; `raiseCycleEvent` called with `"test_usdc_added"`; `revalidateOrgPages` called.
- pending: `status: "pending"`, `txUrl: null` → message "Added 480.01 test USDC to the operating wallet. Arc testnet is still confirming it." and no `txUrl`.
- refusal: `addTestUsdc` rejects `new TestUsdcError("nothing_needed")` → `{ ok: false, message: "Nothing to add: the operating wallet covers your open bills." }`, no event.
- `authorize` refuses → its message, `addTestUsdc` not called; it was asked for `"records.write"`.
- unknown error → `{ ok: false, message: "That did not work. Try again in a moment." }`; a `PaymentsDisabledError` → its own message.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/receipts.test.ts tests/test-usdc-action.test.ts`
Expected: the receipts case FAILS (the transfer is matched); the action test FAILS (module missing).

- [ ] **Step 3: Implement**

`src/lib/agent/receipts.ts`, after `if (unmatched.length === 0) return { ...none, recorded: transfers.length };`:

```ts
  // Test USDC from Vestiarion's float is money in, owed by no client (test USDC T6): never matched, whatever its amount.
  const fromFloat = new Set(
    (unwrap(await orgDb.from("ledger_entries").select("detail").eq("action", "test_usdc_added")) as Array<{ detail: { from?: unknown } }>)
      .map((entry) => (typeof entry.detail?.from === "string" ? entry.detail.from.toLowerCase() : null))
      .filter((address): address is string => address !== null)
  );
```

and at the top of the `for (const row of unmatched)` loop body:

```ts
    if (row.from_address && fromFloat.has(row.from_address.toLowerCase())) continue;
```

Extend the module comment's last sentence: "…which owe nothing to a receivable, nor does test USDC from Vestiarion's float."

`src/lib/agent/cycle-soon.ts`, in `CycleEventKind` after `"cash_returned"`:

```ts
  /** Test USDC came in from Vestiarion's float: a payable held for cash may be paid now (test USDC T7). */
  | "test_usdc_added"
```

`src/app/actions/test-usdc.ts`:

```ts
"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { addTestUsdc, TestUsdcError } from "@/lib/test-usdc";

/**
 * Adds test USDC from Vestiarion's float to the operating wallet, from the console's shadow mode section
 * (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T2, T7, T8): someone who may add records asks; the
 * library works out the amount, sends it and signs it; the agent then decides again on what waited for cash.
 */

export interface TestUsdcActionResult {
  ok: boolean;
  message: string;
  txUrl?: string;
}

const amount = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

export async function addTestUsdcAction(_previous: TestUsdcActionResult, formData: FormData): Promise<TestUsdcActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const added = await addTestUsdc({ actorId: auth.user.id });
      raiseCycleEvent(auth, "test_usdc_added");
      revalidateOrgPages();
      const said = `Added ${amount(added.amount)} test USDC to the operating wallet.`;
      return added.txUrl ? { ok: true, message: said, txUrl: added.txUrl } : { ok: true, message: `${said} Arc testnet is still confirming it.` };
    } catch (error) {
      if (error instanceof TestUsdcError || error instanceof PaymentsDisabledError) return { ok: false, message: error.message };
      console.error("test USDC failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
```

Check `authorize`'s return type: if `raiseCycleEvent` needs `membership.mode`, `auth` already has it (other actions pass `auth`).

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/receipts.test.ts tests/test-usdc-action.test.ts tests/cycle-soon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/receipts.ts src/lib/agent/cycle-soon.ts src/app/actions/test-usdc.ts tests/receipts.test.ts tests/test-usdc-action.test.ts
git commit -m "Let an owner add test USDC from the console, and never read it as a client paying"
```

---

### Task 4: The console line and button

**Files:**
- Create: `src/components/TestUsdcControl.tsx`
- Modify: `src/components/ShadowModeSummary.tsx`
- Modify: `src/app/o/[slug]/console/page.tsx`
- Test: `tests/shadow-mode-summary.test.tsx` (add cases)

**Interfaces:**
- Consumes: `testUsdcView`, `TestUsdcView` (Task 1); `readTestUsdcWeek`, `testUsdcAvailable`, `TestUsdcWeek` (Task 2); `addTestUsdcAction`, `TestUsdcActionResult` (Task 3); `txUrl`.
- Produces: `ShadowModeSummary` takes optional `testUsdc?: { view: TestUsdcView | null; latest: TestUsdcWeek["latest"]; operatingAddress: string | null; latestTxUrl: string | null }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/shadow-mode-summary.test.tsx` (the control is a client component; `renderToStaticMarkup` renders its initial state, so mock `@/app/actions/test-usdc` with `vi.mock("@/app/actions/test-usdc", () => ({ addTestUsdcAction: vi.fn() }))` at the top):

```tsx
const withTestUsdc = (testUsdc: Parameters<typeof ShadowModeSummary>[0]["testUsdc"]) =>
  html(<ShadowModeSummary orgSlug="northstar" mode={MODE} summary={{ agreed: 0, disagreed: 0, waiting: 0 }} testUsdc={testUsdc} />);

it("says how much the open bills need beyond the wallet, and offers to add it", () => {
  const words = text(withTestUsdc({ view: { need: 480.01, action: "add", amount: 480.01 }, latest: null, operatingAddress: "0xabc", latestTxUrl: null }));
  expect(words).toContain("Your open bills need 480.01 USDC more than the operating wallet holds.");
  expect(words).toContain("Add 480.01 test USDC");
  expect(words).toContain("From Vestiarion's test USDC float, on Arc testnet.");
});

it("says the week's limit is used, and where to buy more", () => {
  const markup = withTestUsdc({ view: { need: 3000, action: "limit", weeklyLimit: 5000 }, latest: null, operatingAddress: "0xabc", latestTxUrl: null });
  expect(text(markup)).toContain("This workspace took its 5,000 test USDC for this week. For more, buy testnet USDC from TestMint and send it to the operating wallet: 0xabc");
  expect(markup).toContain('href="https://testmint.myproceeds.xyz"');
  expect(text(markup)).not.toContain("Add ");
});

it("shows the need alone to someone who may not add it", () => {
  const words = text(withTestUsdc({ view: { need: 10, action: null }, latest: null, operatingAddress: null, latestTxUrl: null }));
  expect(words).toContain("Your open bills need 10 USDC more than the operating wallet holds.");
  expect(words).not.toContain("Add 10 test USDC");
});

it("says what was added last, with its transaction", () => {
  const markup = withTestUsdc({ view: null, latest: { amount: 480.01, at: "2026-10-08T11:00:00Z", txHash: "0xabc" }, operatingAddress: null, latestTxUrl: "https://explorer.testnet.arc.io/tx/0xabc" });
  expect(text(markup)).toContain("Last added: 480.01 test USDC on Oct 8.");
  expect(markup).toContain('href="https://explorer.testnet.arc.io/tx/0xabc"');
  expect(text(markup)).toContain("View transaction");
});

it("says nothing about test USDC without it", () => {
  expect(text(panel({ agreed: 1, disagreed: 0, waiting: 0 }))).not.toContain("test USDC");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/shadow-mode-summary.test.tsx`
Expected: FAIL (prop ignored, text missing).

- [ ] **Step 3: Implement**

`src/components/TestUsdcControl.tsx`:

```tsx
"use client";

import { Coins } from "lucide-react";
import { addTestUsdcAction, type TestUsdcActionResult } from "@/app/actions/test-usdc";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

/**
 * Adds test USDC from Vestiarion's float to the operating wallet, in the console's shadow mode section
 * (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T8). The amount on the button is the page's; the server
 * works it out again when pressed.
 */

const INITIAL: TestUsdcActionResult = { ok: false, message: "" };
const add = withSuccessToast(addTestUsdcAction);
const usdc = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

export default function TestUsdcControl({ orgSlug, amount }: { orgSlug: string; amount: number }) {
  const { state, formProps, pending } = useActionForm(add, INITIAL);
  return (
    <form {...formProps} className="space-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton size="sm" variant="secondary" icon={<Coins />} pendingLabel="Adding it…" disabled={pending}>
        {`Add ${usdc(amount)} test USDC`}
      </SubmitButton>
      <p className="text-xs text-ink-3">From Vestiarion&apos;s test USDC float, on Arc testnet.</p>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>
        {state.ok && state.txUrl ? (
          <a href={state.txUrl} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-2 hover:underline">
            View transaction
          </a>
        ) : state.ok ? null : (
          state.message
        )}
      </FormMessage>
    </form>
  );
}
```

Check `lucide-react` has `Coins` (`grep -r "Coins" node_modules/lucide-react/dist/lucide-react.d.ts | head -1`); if not, use `Wallet`.

`src/components/ShadowModeSummary.tsx`: add the prop and, inside the `Card` before the closing `<p className="text-xs text-ink-3">Each payment…`:

```tsx
        {testUsdc?.view && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-sm text-ink-2">{`Your open bills need ${usdc(testUsdc.view.need)} USDC more than the operating wallet holds.`}</p>
            {testUsdc.view.action === "add" && <TestUsdcControl orgSlug={orgSlug} amount={testUsdc.view.amount} />}
            {testUsdc.view.action === "limit" && (
              <p className="text-sm text-ink-2">
                {`This workspace took its ${usdc(testUsdc.view.weeklyLimit)} test USDC for this week. For more, buy testnet USDC from `}
                <a href={TESTMINT} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-2 hover:underline">
                  TestMint
                </a>
                {` and send it to the operating wallet: ${testUsdc.operatingAddress ?? "Settings lists its address"}`}
              </p>
            )}
          </div>
        )}
        {testUsdc?.latest && (
          <p className="text-xs text-ink-3">
            {`Last added: ${usdc(testUsdc.latest.amount)} test USDC on ${day(testUsdc.latest.at)}.`}{" "}
            {testUsdc.latestTxUrl && (
              <a href={testUsdc.latestTxUrl} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-2 hover:underline">
                View transaction
              </a>
            )}
          </p>
        )}
```

with, at module level:

```tsx
import TestUsdcControl from "@/components/TestUsdcControl";
import type { TestUsdcWeek } from "@/lib/test-usdc";
import type { TestUsdcView } from "@/lib/test-usdc-rules";

const TESTMINT = "https://testmint.myproceeds.xyz";
const usdc = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
```

Use the border/colour tokens the file and its siblings already use (`grep -n "border-" src/components/ShadowModeSummary.tsx src/components/ShadowModePanel.tsx`); the ui-consistency test fails on raw colours. If importing `TestUsdcWeek` from `@/lib/test-usdc` pulls server-only modules into the client bundle, move `TestUsdcWeek` into `src/lib/test-usdc-rules.ts` and re-export it from `test-usdc.ts`.

`src/app/o/[slug]/console/page.tsx`: where `shadowSummary` is read, read the week too, best effort, only in shadow mode:

```tsx
    const testUsdcWeek = shadow
      ? await readTestUsdcWeek().catch((error: unknown) => {
          console.error("console: test USDC not loaded", access.membership.orgId, error instanceof Error ? error.message : error);
          return null;
        })
      : null;
```

After `outlook` is computed:

```tsx
    const operatingAccount = accountsRows.find((account) => account.kind === "operating");
    const testUsdc =
      shadow && testUsdcWeek
        ? {
            view: testUsdcView({
              safeToSpend: outlook.safeToSpend,
              takenThisWeek: testUsdcWeek.takenThisWeek,
              weeklyLimit: testUsdcWeek.weeklyLimit,
              available: testUsdcAvailable() && Boolean(operatingAccount?.address),
              canAdd: can(access.membership.role, "records.write"),
            }),
            latest: testUsdcWeek.latest,
            operatingAddress: operatingAccount?.address ?? null,
            latestTxUrl: testUsdcWeek.latest?.txHash ? txUrl(network.id, testUsdcWeek.latest.txHash) : null,
          }
        : undefined;
```

and pass `testUsdc={testUsdc}` to `<ShadowModeSummary … />`. Use the `network` variable the page already has (check its name and type with `grep -n "network" "src/app/o/[slug]/console/page.tsx" | head`); if it is a profile, pass `network.id`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/shadow-mode-summary.test.tsx` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/TestUsdcControl.tsx src/components/ShadowModeSummary.tsx "src/app/o/[slug]/console/page.tsx" tests/shadow-mode-summary.test.tsx
git commit -m "Offer test USDC in the console's shadow mode section when open bills need it"
```

---

### Task 5: The float script and the documentation

**Files:**
- Create: `scripts/shadow-float.ts`
- Modify: `package.json` (`"shadow-float": "tsx scripts/shadow-float.ts"` next to `traction-digest`)
- Modify: `content/docs/guides/shadow-mode.mdx`, `content/docs/changelog.mdx`, `ARCHITECTURE.md`
- Test: existing docs tests (`tests/docs-content.test.ts`, `tests/docs-guides.test.ts`, `tests/docs-links.test.tsx`, the ui-consistency test)

**Interfaces:**
- Consumes: `configFromEnv`, `createWallet`, `walletSetIdNamed` (`src/lib/circle/provision.ts`), `defaultCircleClient`, `stablecoinEntry`, `networkProfile("arc-testnet")`.

- [ ] **Step 1: Write the script**

Read `scripts/traction-digest.ts` and `scripts/circle-doctor.ts` first for how scripts load `.env.local` and print. Then `scripts/shadow-float.ts`:

- `setup`: requires `HOSTED_CIRCLE_API_KEY` and `HOSTED_CIRCLE_ENTITY_SECRET`; `walletSetIdNamed(client, "vestiarion-shadow-float")` (it creates the set when missing; check its behaviour and use the creating variant if it only reads); `createWallet(client, { walletSetId, chain: "ARC-TESTNET", accountType: "SCA", idempotencyKey: walletIdempotencyKey("platform", "shadow-float") })`; print `SHADOW_FLOAT_WALLET_ID=<id>` and `address <address>` and the TestMint line "Buy on https://testmint.myproceeds.xyz: destination Arc Testnet, recipient <address>".
- `status`: requires `SHADOW_FLOAT_WALLET_ID` too; prints the float's address and USDC (via `getWallet` and `getWalletTokenBalance` + `stablecoinEntry`), then reads `ledger_entries` with the service-role client for `action = test_usdc_added` across workspaces (select `org_id, ts, detail`, join `orgs(slug)` or a second query) and prints per workspace slug: taken in the last 7 days, taken in all, grants. ASCII only.
- Neither prints a secret.

Run `npx tsx scripts/shadow-float.ts` with no argument: it prints usage and exits 1.

- [ ] **Step 2: Update the guide**

`content/docs/guides/shadow-mode.mdx`:
- "Before you start", first bullet: replace "so keep it funded from Circle's faucet." with "so keep it funded: with test USDC from Vestiarion's float, for what your open bills need (below), or from Circle's faucet, 20 USDC every two hours."
- New section after "## 2. Add your bills as you do today" and before "## 3.", titled "## Fund it for your real amounts", saying: when the console's **Safe to spend today** is below zero, the **Shadow mode** section says "Your open bills need N USDC more than the operating wallet holds." An owner or admin chooses **Add N test USDC**: Vestiarion sends that much test USDC on Arc testnet from its own float to the operating wallet, worked out again when you press it, at least 1 USDC, at most 5,000 in any 7 days per workspace. A notice says **Added N test USDC to the operating wallet.**, and the section then says "Last added: N test USDC on <day>." with **View transaction**. The agent decides again within seconds on what waited for cash. Test USDC has no value; Vestiarion fills the float from TestMint, which sells testnet USDC. When the week's limit is used, buy testnet USDC from [TestMint](https://testmint.myproceeds.xyz) yourself: destination Arc Testnet, recipient the operating wallet's address.
- Renumbering: keep the existing numbered headings as they are (the new section is unnumbered) so existing anchors stay.
- "What the ledger records": add "- `test_usdc_added` when test USDC came in from Vestiarion's float: who asked, the amount, the float's address and the operating wallet's, Circle's transfer id, the transaction hash once Arc testnet confirmed it, the shortfall and the weekly limit."
- Error table rows, in the spec's words: "Test USDC is for shadow mode. An owner turns it on in Settings." / "Go live on Arc testnet first: test USDC goes to the operating wallet." / "Vestiarion's test USDC float is not set up on this deployment." / "Nothing to add: the operating wallet covers your open bills." / "This workspace took its 5,000 test USDC for this week." / "Vestiarion's test USDC float is empty just now." each with what to do (faucet or TestMint for the last three).

- [ ] **Step 3: Changelog and ARCHITECTURE**

`content/docs/changelog.mdx`, new top entry under the intro line:

```md
## 2026-10-08: Test USDC for shadow mode

- A workspace in shadow mode can take the test USDC its open bills need from Vestiarion's float, on Arc testnet. Its ledger gains **`test_usdc_added`**, actor `human`, domain `treasury`, sent to webhook endpoints as `ledger.appended`: `{ by, amount, from, to, transferId, txHash, status, shortfall, weeklyLimit }`. `from` is the float's address, `to` the operating wallet's; `txHash` is `null` and `status` `pending` while Arc testnet still confirms the transfer.
- Money from the float is never matched to a receivable. Nothing else in `/api/v1` changes.
```

Keep the changelog's colour-check rule in mind (memory: a quote or apostrophe before `#` on one line fails ui-consistency); the text above has none.

`ARCHITECTURE.md`: in the section that describes hosted wallets (near the lines mentioning the hosted pair), add a short paragraph: the hosted pair has one other use, Vestiarion's test USDC float for shadow mode (`SHADOW_FLOAT_WALLET_ID`, `src/lib/test-usdc.ts`): read through `currentPlatformConfig()`, never put into a workspace's configuration; it only sends from that one wallet to a shadow workspace's operating wallet on Arc testnet.

- [ ] **Step 4: Run the docs tests and the full gate**

Run: `npx vitest run tests/docs-content.test.ts tests/docs-guides.test.ts tests/docs-links.test.tsx` then `npm run verify`
Expected: PASS. Fix any docs test that names a rule (it states what it wants).

- [ ] **Step 5: Commit**

```bash
git add scripts/shadow-float.ts package.json content/docs/guides/shadow-mode.mdx content/docs/changelog.mdx ARCHITECTURE.md
git commit -m "Document test USDC for shadow mode and add the float's setup script"
```
