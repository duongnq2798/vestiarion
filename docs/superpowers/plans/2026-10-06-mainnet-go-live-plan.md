# Arc Mainnet Behind a Switch (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person on the allowlist, on a deployment with `MAINNET_ENABLED`, can create a workspace on Arc mainnet, connect its own live Circle account, create its EOA wallet and read its balance with nothing sent; such a workspace moves money only once an owner takes it live by typing "mainnet"; Arc testnet behaves exactly as today.

**Architecture:** Two platform settings gate Arc mainnet. `orgConfig` turns a mainnet workspace's state into a hold reason that the platform stop switch's existing gates already enforce (`paymentsHold()`), withholds credentials while mainnet is off, and never hands a mainnet workspace the simulator. The network profile gains the wallet account type, a gas reserve and two feature flags; stablecoins are matched by contract. Migration 0078 lets the database hold `ARC` and fixes the network at creation.

**Tech Stack:** Next.js (this repo's version, see AGENTS.md), TypeScript, Supabase (PostgREST + Postgres), vitest, PGlite for migration tests, Circle Developer-Controlled Wallets SDK.

**Spec:** `docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md` (rulings M1–M13).

## Global Constraints

- Arc testnet behaviour is unchanged: every existing test passes; where a test's fake must now name a token's contract, it names the one Circle lists today.
- Nothing calls Circle or an RPC on Arc mainnet in tests: every client and fetch is faked.
- `MAINNET_ENABLED` is read like `PAYMENTS_DISABLED`: only `1`, `true` or `yes` (any case, trimmed) turns it on.
- `MAINNET_ALLOWLIST`: addresses split on commas, semicolons or whitespace, trimmed, lower-cased, empties dropped.
- Messages, verbatim:
  - `MAINNET_NOT_OPEN` = "Arc mainnet is not open to this account yet."
  - `MAINNET_OFF` = "Arc mainnet is switched off on this deployment."
  - `MAINNET_NOT_LIVE` = "This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live."
  - `MAINNET_NOT_CONNECTED` = "This workspace on Arc mainnet has no Circle account connected yet."
  - Go live's word: "Type mainnet to confirm that this workspace pays real USDC."
  - Budget: "A workspace on Arc mainnet keeps a daily or 7-day limit."
  - Chat: "It is on Arc mainnet, where payments are approved in Vestiarion."
  - Sample data: "Sample data runs on Arc testnet only: a workspace on Arc mainnet never simulates payments."
  - Banner, live: "Arc mainnet: payments here move real USDC."
- Mainnet profile facts: `walletAccountType: "EOA"`, `gasReserveUsdc: 0.1`, `escrow: false`, `spendingLimitContract: false`, `usdcIsNative: true`. Testnet: `"SCA"`, `0`, `true`, `true`, `true`.
- New mainnet workspace: one account `{ name: "Operating", kind: "operating", chain: "ARC", balance: 0 }`; agent budget `daily_usdc 50, weekly_usdc 150`.
- Copy rules: name the network plainly ("Arc mainnet", "Arc testnet"); no disclaimers about money being fake; commit messages neutral.
- Every task ends with `npm run verify` green (typecheck, lint, all tests).
- The two ratchets (`tests/network-ratchet.test.ts`, `tests/network-constants-ratchet.test.ts`) may only go down.

## Review Focus

1. A mainnet workspace in any state (off, on and not connected, on and connected but sandbox, live) reached through a path that does not call `assertPaymentsEnabled`/`paymentsHold` — e.g. a direct provider call from a stage the stop switch's audit missed: it must not move money before live. Tested in Task 3 by driving the provider's money methods directly.
2. A testnet workspace whose wallet lists the ERC-20 USDC before the native one: the token id chosen must still be a real USDC (either entry), never a spoof. Tested in Task 2 with both orders.
3. `db:migrate` re-running 0044 after 0078: a counterparty on `ARC` must survive. Tested in Task 5 by running 0044's file again.
4. A person not on the allowlist reaching mainnet through the API or a crafted form post (network field set by hand): refused server-side. Tested in Task 6 (action) and Task 7 (lib).
5. The gas reserve never makes a testnet balance differ from today's (gasReserveUsdc 0), and never yields a negative spendable on mainnet. Tested in Task 4.

---

### Task 1: The profile's new facts and the two platform settings

**Files:**
- Modify: `src/lib/network.ts` (NetworkProfile + both profiles)
- Modify: `src/lib/config.ts` (VestiarionConfig + configFromEnv)
- Create: `src/lib/mainnet.ts`
- Test: `tests/mainnet-settings.test.ts`; `tests/network.test.ts` (profile facts)

**Interfaces:**
- Produces:
  - `NetworkProfile.walletAccountType: "SCA" | "EOA"`, `.gasReserveUsdc: number`, `.escrow: boolean`, `.spendingLimitContract: boolean`, `.usdcIsNative: boolean`.
  - `VestiarionConfig.mainnetEnabled?: boolean`, `.mainnetAllowlist?: readonly string[]`.
  - `src/lib/mainnet.ts`: `MAINNET_NOT_OPEN`, `MAINNET_OFF`, `MAINNET_NOT_LIVE`, `MAINNET_NOT_CONNECTED`, `mayUseMainnet(email: string | null | undefined, config?: Pick<VestiarionConfig, "mainnetEnabled" | "mainnetAllowlist">): boolean`, `networkHold(network: Network, mode: "sandbox" | "live", config: Pick<VestiarionConfig, "mainnetEnabled">): string | null`.

- [ ] **Step 1: Write the failing tests**

`tests/mainnet-settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { MAINNET_NOT_LIVE, MAINNET_OFF, mayUseMainnet, networkHold } from "@/lib/mainnet";

const env = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };

describe("MAINNET_ENABLED (mainnet go-live M1)", () => {
  it.each([["1", true], ["true", true], [" YES ", true], ["0", false], ["on", false], ["", false], [undefined, false]])("reads %j as %s", (value, on) => {
    expect(configFromEnv({ ...env, MAINNET_ENABLED: value }).mainnetEnabled).toBe(on);
  });
});

describe("MAINNET_ALLOWLIST (M1)", () => {
  it("splits on commas, semicolons and spaces, lower-cases and drops empties", () => {
    expect(configFromEnv({ ...env, MAINNET_ALLOWLIST: " Owner@Acme.test, b@x.test;c@y.test\n\n d@z.test ," }).mainnetAllowlist).toEqual([
      "owner@acme.test",
      "b@x.test",
      "c@y.test",
      "d@z.test",
    ]);
    expect(configFromEnv(env).mainnetAllowlist).toEqual([]);
  });
});

describe("mayUseMainnet (M1)", () => {
  const on = { mainnetEnabled: true, mainnetAllowlist: ["owner@acme.test"] };
  it("allows a listed address, in any case, while mainnet is on", () => {
    expect(mayUseMainnet("Owner@Acme.test", on)).toBe(true);
  });
  it("refuses an unlisted address, no address, or anyone while mainnet is off", () => {
    expect(mayUseMainnet("other@acme.test", on)).toBe(false);
    expect(mayUseMainnet(null, on)).toBe(false);
    expect(mayUseMainnet("owner@acme.test", { ...on, mainnetEnabled: false })).toBe(false);
  });
  it("reads the deployment's settings when none are given", () => {
    const config = configFromEnv({ ...env, MAINNET_ENABLED: "1", MAINNET_ALLOWLIST: "owner@acme.test" });
    expect(runWithConfig(config, () => mayUseMainnet("owner@acme.test"))).toBe(true);
  });
});

describe("networkHold (M4)", () => {
  it("holds nothing on Arc testnet", () => {
    expect(networkHold("arc-testnet", "sandbox", { mainnetEnabled: false })).toBeNull();
    expect(networkHold("arc-testnet", "live", { mainnetEnabled: false })).toBeNull();
  });
  it("holds a mainnet workspace while mainnet is off, and until it is live", () => {
    expect(networkHold("arc-mainnet", "live", { mainnetEnabled: false })).toBe(MAINNET_OFF);
    expect(networkHold("arc-mainnet", "sandbox", { mainnetEnabled: true })).toBe(MAINNET_NOT_LIVE);
    expect(networkHold("arc-mainnet", "live", { mainnetEnabled: true })).toBeNull();
  });
  it("says so in words a person reads", () => {
    expect(MAINNET_OFF).toBe("Arc mainnet is switched off on this deployment.");
    expect(MAINNET_NOT_LIVE).toBe("This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.");
  });
});
```

Append to `tests/network.test.ts`:

```ts
describe("what each network's wallets are (mainnet go-live M6, M7)", () => {
  it("gives Arc testnet sponsored smart accounts, and Arc mainnet EOAs that keep USDC for gas", () => {
    expect(ARC_TESTNET).toMatchObject({ walletAccountType: "SCA", gasReserveUsdc: 0, escrow: true, spendingLimitContract: true, usdcIsNative: true });
    expect(ARC_MAINNET).toMatchObject({ walletAccountType: "EOA", gasReserveUsdc: 0.1, escrow: false, spendingLimitContract: false, usdcIsNative: true });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/mainnet-settings.test.ts tests/network.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mainnet'`, and the profile assertion fails on the missing fields.

- [ ] **Step 3: Implement**

`src/lib/network.ts`: add to `NetworkProfile` (after `modularWallets`):

```ts
  /**
   * The account type of the workspace's treasury wallets (mainnet go-live M6): a smart account whose gas Circle Gas
   * Station pays, or an EOA that pays its own gas in USDC. Circle bills Gas Station on mainnet and refuses an SCA there
   * until a paymaster policy exists, so Arc mainnet's are EOAs.
   */
  walletAccountType: "SCA" | "EOA";
  /** USDC the operating wallet keeps aside for its own gas (M6): 0 where gas is sponsored. */
  gasReserveUsdc: number;
  /** Whether a milestone's USDC can be locked in the per-workspace escrow contract (M6). */
  escrow: boolean;
  /** Whether the agent's spending limit can be enforced by its per-workspace contract (M6). */
  spendingLimitContract: boolean;
  /** Whether the chain's native currency is USDC (M7): Arc's is, so Circle's native entry for a wallet is USDC. */
  usdcIsNative: boolean;
```

Testnet profile values: `walletAccountType: "SCA", gasReserveUsdc: 0, escrow: true, spendingLimitContract: true, usdcIsNative: true`. Mainnet: `walletAccountType: "EOA", gasReserveUsdc: 0.1, escrow: false, spendingLimitContract: false, usdcIsNative: true`. Update the file's header comment: escrow and the spending-limit contract are off on mainnet (MVP), and wallets are EOAs there.

`src/lib/config.ts`: add to `VestiarionConfig` after `paymentsDisabled`:

```ts
  /** Arc mainnet is on for this deployment (MAINNET_ENABLED; mainnet go-live M1). Off, a mainnet workspace moves nothing. */
  mainnetEnabled?: boolean;
  /** Who may open a mainnet workspace and take one live (MAINNET_ALLOWLIST): lower-cased email addresses. */
  mainnetAllowlist?: readonly string[];
```

In `configFromEnv`'s returned object, after `paymentsDisabled`:

```ts
    // Read as PAYMENTS_DISABLED is: only a plain yes turns Arc mainnet on (mainnet go-live M1).
    mainnetEnabled: ["1", "true", "yes"].includes(trimmed(env.MAINNET_ENABLED)?.toLowerCase() ?? ""),
    mainnetAllowlist: (env.MAINNET_ALLOWLIST ?? "")
      .split(/[\s,;]+/)
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
```

`src/lib/mainnet.ts`:

```ts
import { currentConfig } from "./context";
import type { VestiarionConfig } from "./config";
import type { Network } from "./network";

/**
 * Arc mainnet behind a switch (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M1, M4): who may open and
 * take live a mainnet workspace, and why one cannot move money now. Pure apart from reading the deployment's settings.
 */

export const MAINNET_NOT_OPEN = "Arc mainnet is not open to this account yet.";
export const MAINNET_OFF = "Arc mainnet is switched off on this deployment.";
export const MAINNET_NOT_LIVE = "This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.";
export const MAINNET_NOT_CONNECTED = "This workspace on Arc mainnet has no Circle account connected yet.";

/** Arc mainnet is on, and this address is on the allowlist (M1). No address is never allowed. */
export function mayUseMainnet(
  email: string | null | undefined,
  config: Pick<VestiarionConfig, "mainnetEnabled" | "mainnetAllowlist"> = currentConfig()
): boolean {
  if (!config.mainnetEnabled || !email) return false;
  return (config.mainnetAllowlist ?? []).includes(email.trim().toLowerCase());
}

/**
 * Why a workspace cannot move money now because of its network, or null (M4): on Arc mainnet, while the deployment has
 * it off, and until the workspace is live. Arc testnet holds nothing here; the platform's stop switch still applies.
 */
export function networkHold(network: Network, mode: "sandbox" | "live", config: Pick<VestiarionConfig, "mainnetEnabled">): string | null {
  if (network !== "arc-mainnet") return null;
  if (!config.mainnetEnabled) return MAINNET_OFF;
  return mode === "live" ? null : MAINNET_NOT_LIVE;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/mainnet-settings.test.ts tests/network.test.ts tests/config.test.ts`
Expected: PASS. (If `tests/config.test.ts` snapshots the whole config, add `mainnetEnabled: false, mainnetAllowlist: []` to its expectation.)

- [ ] **Step 5: Verify and commit**

Run: `npm run verify > .superpowers/sdd/2026-10-06-mainnet-go-live-plan/t1.log 2>&1; tail -5 …/t1.log`
Expected: all green.

```bash
git add src/lib/network.ts src/lib/config.ts src/lib/mainnet.ts tests/mainnet-settings.test.ts tests/network.test.ts tests/config.test.ts
git commit -m "Give each network's profile its wallet type and gas reserve, and read who may use Arc mainnet"
```

---

### Task 2: A stablecoin is chosen by its contract

**Files:**
- Create: `src/lib/circle/stablecoins.ts`
- Modify: `src/lib/circle/liveProvider.ts` (`resolveUsdcTokenId`, `resolveTokenId`, `listInboundTransfers`, `getTokenBalance`)
- Test: `tests/stablecoins.test.ts`; update fakes in `tests/circle-live-provider.test.ts`, `tests/circle-eurc.test.ts`, `tests/inbound-transfers.test.ts`

**Interfaces:**
- Consumes: `NetworkProfile.usdcIsNative`, `.tokens` (Task 1).
- Produces: `stablecoinOf(token: CircleToken | undefined, network: NetworkProfile): Stablecoin | null`; `stablecoinEntry<T extends { token?: CircleToken }>(balances: readonly T[] | undefined, coin: Stablecoin, network: NetworkProfile): T | undefined`, where `CircleToken = { id?: string; symbol?: string; tokenAddress?: string | null; isNative?: boolean }`.

- [ ] **Step 1: Write the failing tests**

`tests/stablecoins.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stablecoinEntry, stablecoinOf } from "@/lib/circle/stablecoins";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/** As Circle listed an Arc testnet wallet on 2026-10-06: the native token first, then the ERC-20 at 0x3600…. */
const NATIVE = { token: { id: "usdc-native", symbol: "USDC", tokenAddress: null, isNative: true }, amount: "13" };
const ERC20 = { token: { id: "usdc-erc20", symbol: "USDC", tokenAddress: "0x3600000000000000000000000000000000000000", isNative: false }, amount: "13" };
const EURC = { token: { id: "eurc", symbol: "EURC", tokenAddress: ARC_TESTNET.tokens.EURC.toLowerCase(), isNative: false }, amount: "2" };
const FAKE_USDC = { token: { id: "spoof", symbol: "USDC", tokenAddress: "0x1111111111111111111111111111111111111111", isNative: false }, amount: "1000000" };
const FAKE_EURC = { token: { id: "spoof-eurc", symbol: "EURC", tokenAddress: "0x2222222222222222222222222222222222222222", isNative: false }, amount: "500" };

describe("stablecoinOf (mainnet go-live M7)", () => {
  it("knows Arc's native token and the ERC-20 at the profile's address as USDC", () => {
    expect(stablecoinOf(NATIVE.token, ARC_TESTNET)).toBe("USDC");
    expect(stablecoinOf(ERC20.token, ARC_TESTNET)).toBe("USDC");
    expect(stablecoinOf(ERC20.token, ARC_MAINNET)).toBe("USDC");
  });
  it("knows EURC only at the network's own EURC address", () => {
    expect(stablecoinOf(EURC.token, ARC_TESTNET)).toBe("EURC");
    expect(stablecoinOf(EURC.token, ARC_MAINNET)).toBeNull();
  });
  it("ignores a token that only calls itself USDC or EURC", () => {
    expect(stablecoinOf(FAKE_USDC.token, ARC_TESTNET)).toBeNull();
    expect(stablecoinOf(FAKE_EURC.token, ARC_TESTNET)).toBeNull();
    expect(stablecoinOf(undefined, ARC_TESTNET)).toBeNull();
  });
});

describe("stablecoinEntry (M7)", () => {
  it("keeps Circle's order among the real entries, so Arc testnet picks what it picked before", () => {
    expect(stablecoinEntry([NATIVE, ERC20], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-native");
    expect(stablecoinEntry([ERC20, NATIVE], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-erc20");
  });
  it("passes over a spoof listed first", () => {
    expect(stablecoinEntry([FAKE_USDC, NATIVE], "USDC", ARC_TESTNET)?.token.id).toBe("usdc-native");
    expect(stablecoinEntry([FAKE_EURC, EURC], "EURC", ARC_TESTNET)?.token.id).toBe("eurc");
    expect(stablecoinEntry([FAKE_USDC], "USDC", ARC_TESTNET)).toBeUndefined();
    expect(stablecoinEntry(undefined, "USDC", ARC_TESTNET)).toBeUndefined();
  });
});
```

In `tests/circle-live-provider.test.ts`, add a case to the balance describe:

```ts
  it("reads USDC by its contract, never a token that only calls itself USDC (mainnet go-live M7)", async () => {
    const getWalletTokenBalance = vi.fn(async () => ({
      data: {
        tokenBalances: [
          { token: { id: "spoof", symbol: "USDC", tokenAddress: "0x1111111111111111111111111111111111111111", isNative: false }, amount: "999999" },
          { token: { id: "usdc-token-id", symbol: "USDC", tokenAddress: null, isNative: true }, amount: "12.5" },
        ],
      },
    }));
    const client = fakeClient({ getWalletTokenBalance } as unknown as Partial<LiveProviderClient>);
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client, paymentsDisabled: true });
    accountSingle.mockResolvedValueOnce({ data: { id: "operating", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-1", address: "0xabc" }, error: null });
    await expect(provider.getBalance("operating")).resolves.toMatchObject({ balance: 12.5 });
  });
```

(Match the existing "still reads a balance" case's account mock exactly; copy its `accountSingle` setup line.)

In `tests/inbound-transfers.test.ts`, add one transfer of a spoof token named "USDC" (`tokenId: "spoof"`, its balance entry with `tokenAddress: "0x1111…"`) and expect it left out.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/stablecoins.test.ts tests/circle-live-provider.test.ts tests/inbound-transfers.test.ts tests/circle-eurc.test.ts`
Expected: FAIL — module not found; the spoof is read as the balance.

- [ ] **Step 3: Implement**

`src/lib/circle/stablecoins.ts`:

```ts
import type { NetworkProfile } from "../network";
import type { Stablecoin } from "./types";

/** A token as Circle's wallet balance list names it. */
export interface CircleToken {
  id?: string;
  symbol?: string;
  tokenAddress?: string | null;
  isNative?: boolean;
}

const same = (a: string | null | undefined, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Which stablecoin a token is on the network, or null (mainnet go-live M7): USDC is Arc's native token or the ERC-20
 * at the profile's USDC address; EURC is the ERC-20 at the profile's EURC address. Never by symbol alone: anyone can
 * deploy a token named "USDC".
 */
export function stablecoinOf(token: CircleToken | undefined, network: NetworkProfile): Stablecoin | null {
  if (!token) return null;
  if ((network.usdcIsNative && token.isNative === true) || same(token.tokenAddress, network.tokens.USDC)) return "USDC";
  if (same(token.tokenAddress, network.tokens.EURC)) return "EURC";
  return null;
}

/** The first of the wallet's entries that is `coin` on the network, in Circle's order (M7). */
export function stablecoinEntry<T extends { token?: CircleToken }>(
  balances: readonly T[] | undefined,
  coin: Stablecoin,
  network: NetworkProfile
): T | undefined {
  return balances?.find((entry) => stablecoinOf(entry.token, network) === coin);
}
```

In `liveProvider.ts`, replace each symbol match:
- `resolveUsdcTokenId`: `const usdc = stablecoinEntry(balances.data?.tokenBalances, "USDC", this.network);`
- `resolveTokenId` (EURC): `const eurc = stablecoinEntry(balances.data?.tokenBalances, "EURC", this.network);`
- `listInboundTransfers`: `const coin = stablecoinOf(balance.token, this.network); if (balance.token?.id && coin) tokens.set(balance.token.id, coin);`
- `getTokenBalance`: `const held = stablecoinEntry(balances.data?.tokenBalances, token, this.network);`
- The "Fund it with testnet USDC first" error names the network: ``Fund it with USDC on ${this.network.label} first.``

Update the existing fakes so each names the contract Circle lists: USDC entries gain `isNative: true` (they stand for the native entry listed first today); EURC entries gain `tokenAddress: ARC_TESTNET.tokens.EURC` (import `ARC_TESTNET` where missing); the WETH entry stays as is (ignored either way).

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/stablecoins.test.ts tests/circle-live-provider.test.ts tests/inbound-transfers.test.ts tests/circle-eurc.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify` (log to the workspace). Expected: green.

```bash
git add src/lib/circle/stablecoins.ts src/lib/circle/liveProvider.ts tests/stablecoins.test.ts tests/circle-live-provider.test.ts tests/circle-eurc.test.ts tests/inbound-transfers.test.ts
git commit -m "Choose USDC and EURC by their contracts, never by a token's symbol"
```

---

### Task 3: A mainnet workspace is held until it is live, and never simulates

**Files:**
- Modify: `src/lib/config.ts` (`ChainConfig.networkHold`)
- Modify: `src/lib/dal/org-config.ts` (mainnet rules; drop `MAINNET_NOT_YET`)
- Modify: `src/lib/payments-switch.ts` (`paymentsHold`, error reason)
- Modify: `src/lib/circle/index.ts` (pass the hold; hybrid earn refusal)
- Modify: `src/lib/circle/liveProvider.ts` (hold reason in refusals)
- Modify: `src/lib/agent/approvals.ts`, `src/lib/agent/milestone-decisions.ts` (carry the reason)
- Modify: `src/lib/sample-data.ts` (refuse on mainnet)
- Test: `tests/org-config.test.ts`, `tests/payments-switch.test.ts`, `tests/chain-provider.test.ts`, `tests/approvals.test.ts`, `tests/milestone-decisions.test.ts`, `tests/sample-data-actions.test.ts` (or the lib's test), new `tests/mainnet-hold.test.ts`

**Interfaces:**
- Consumes: `networkHold`, `MAINNET_*` (Task 1).
- Produces:
  - `ChainConfig.networkHold?: string`, set only by `orgConfig`.
  - `paymentsHold(now?: number): Promise<string | null>`; `PaymentsDisabledError(message?: string)`; `assertPaymentsEnabled()` throws with the hold's reason; `paymentsDisabled()` unchanged in meaning (true when any hold stands).
  - `LiveProvider` option `paymentsDisabled?: boolean | (() => Promise<boolean | string | null>)`: a string is the reason.
  - `SampleDataErrorCode` gains `"mainnet"`.

- [ ] **Step 1: Write the failing tests**

`tests/org-config.test.ts` — replace the N3 case with:

```ts
describe("a workspace on Arc mainnet (mainnet go-live M4, M5)", () => {
  const sealed = { apiKey: "LIVE_API_KEY:org-key", entity: "org-secret" };
  const mainnet = (mode: "sandbox" | "live", withKeys = true): OrgRow => ({ ...row(OTHER_ORG, withKeys ? sealed : {}), mode, network: "arc-mainnet" });
  const on = { ...base, mainnetEnabled: true };

  it("gets no Circle credentials while the deployment has Arc mainnet off, and is held with the reason", () => {
    const { config, warnings } = orgConfig(base, mainnet("live"), keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.circleEntitySecret).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe("Arc mainnet is switched off on this deployment.");
    expect(config.chain.networkHold).toBe("Arc mainnet is switched off on this deployment.");
    expect(warnings).toContain("Arc mainnet is switched off on this deployment.");
  });

  it("opens its own credentials once Arc mainnet is on, and holds it until it is live", () => {
    const sandbox = orgConfig(on, mainnet("sandbox"), keys).config;
    expect(sandbox.chain.circleApiKey).toBe("LIVE_API_KEY:org-key");
    expect(sandbox.chain.networkHold).toBe("This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.");
    const live = orgConfig(on, mainnet("live"), keys).config;
    expect(live.chain.circleApiKey).toBe("LIVE_API_KEY:org-key");
    expect(live.chain.networkHold).toBeUndefined();
  });

  it("is never given the simulator: with no Circle account connected, its provider refuses", () => {
    const { config, warnings } = orgConfig(on, mainnet("sandbox", false), keys);
    expect(config.chain.credentialsUnreadable).toBe("This workspace on Arc mainnet has no Circle account connected yet.");
    expect(warnings).not.toContain("This workspace on Arc mainnet has no Circle account connected yet.");
  });

  it("never takes the platform's hosted testnet pair", () => {
    const hostedBase = { ...on, chain: { ...on.chain, hostedCircleApiKey: "TEST_API_KEY:hosted", hostedCircleEntitySecret: "hosted-secret" } };
    const { config } = orgConfig(hostedBase, { ...row(OTHER_ORG, {}, keys, OTHER_ORG, "hosted"), network: "arc-mainnet" }, keys);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe("A hosted wallet does not run on Arc mainnet yet");
  });

  it("leaves a testnet workspace exactly as before", () => {
    const { config } = orgConfig(on, row(OTHER_ORG, sealed), keys);
    expect(config.chain.circleApiKey).toBe("LIVE_API_KEY:org-key");
    expect(config.chain.networkHold).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBeUndefined();
  });
});
```

`tests/payments-switch.test.ts` — add:

```ts
describe("a workspace's network hold (mainnet go-live M4)", () => {
  const held = { ...base, chain: { ...base.chain, networkHold: "This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live." } };

  it("refuses with the hold's reason, before reading the database's switch", async () => {
    const fake = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(
      fake,
      async () => {
        expect(await paymentsHold()).toBe(held.chain.networkHold);
        expect(await paymentsDisabled()).toBe(true);
        await expect(assertPaymentsEnabled()).rejects.toThrow(held.chain.networkHold!);
        await expect(assertPaymentsEnabled()).rejects.toBeInstanceOf(PaymentsDisabledError);
      },
      held
    );
    expect(reads(fake)).toBe(0);
  });

  it("is the platform's reason when there is no hold", async () => {
    const fake = database({ payments_disabled_at: "2026-10-05T05:00:00Z", payments_disabled_reason: "Incident 7" });
    await inScope(fake, async () => expect(await paymentsHold()).toBe(PAYMENTS_OFF));
    forgetPaymentsSwitch();
    const on = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(on, async () => expect(await paymentsHold()).toBeNull());
  });
});
```

`tests/mainnet-hold.test.ts` (Review Focus 1 — the provider itself refuses, whatever path calls it):

```ts
import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { getChainProvider } from "@/lib/circle";
import { MAINNET_NOT_LIVE, MAINNET_OFF } from "@/lib/mainnet";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-00000000ab01";
const keys = { circleApiKey: "LIVE_API_KEY:placeholder", circleEntitySecret: "placeholder-entity-secret" };
const TRANSFER = { fromAccountId: "operating", toAddress: "0x1111111111111111111111111111111111111111", amount: 1, memo: "m", idempotencyKey: "k" };

function inMainnet<T>(chain: Record<string, unknown>, fn: () => Promise<T>) {
  const config = { ...base, mainnetEnabled: true, network: "arc-mainnet" as const, chain: { ...base.chain, ...keys, ...chain } };
  const fake = fakeSupabase(() => ({ body: null }));
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

describe("a mainnet workspace's provider (mainnet go-live M4)", () => {
  it("refuses every way of moving money while the workspace is not live, before reading an account", async () => {
    await inMainnet({ networkHold: MAINNET_NOT_LIVE }, async () => {
      const provider = getChainProvider();
      await expect(provider.transfer(TRANSFER)).rejects.toThrow(MAINNET_NOT_LIVE);
      await expect(provider.depositToEarn({ fromAccountId: "operating", toAccountId: "reserve", amount: 1, memo: "m", idempotencyKey: "k" } as never)).rejects.toThrow();
      await expect(provider.batchTransfer!({ fromAccountId: "operating", transfers: [TRANSFER, { ...TRANSFER, idempotencyKey: "k2" }], idempotencyKey: "b" } as never)).rejects.toThrow(
        MAINNET_NOT_LIVE.replace(/\.$/, "")
      );
    });
  });

  it("names the switch when mainnet is off", async () => {
    await inMainnet({ networkHold: MAINNET_OFF }, async () => {
      await expect(getChainProvider().transfer(TRANSFER)).rejects.toThrow(MAINNET_OFF);
    });
  });

  it("refuses a simulated reserve where the network has no USYC (M5)", async () => {
    await inMainnet({}, async () => {
      await expect(getChainProvider().depositToEarn({ fromAccountId: "operating", toAccountId: "reserve", amount: 1, memo: "m", idempotencyKey: "k" } as never)).rejects.toThrow(
        "The USYC reserve does not run on Arc mainnet yet"
      );
    });
  });
});
```

(`depositToEarn`'s params type: copy the shape `EarnDepositParams` from `src/lib/circle/types.ts` instead of `as never` if it is simple; the platform switch is read through `platform_controls`, which the fake answers with `null` = on.)

`tests/approvals.test.ts` and `tests/milestone-decisions.test.ts`: in the existing "payments switched off" cases, add one where the scope's config carries `chain.networkHold = MAINNET_NOT_LIVE` and expect the `ApprovalError` / `MilestoneDecisionError` code `payments_off` with message `MAINNET_NOT_LIVE`, and nothing claimed (reuse each file's existing switched-off case as the template: same fixture, same expectations, the config changed and the message changed).

Sample data: in the lib-level sample-data test, a mainnet sandbox (org row `network: "arc-mainnet"`) refuses with `SampleDataError` code `mainnet` and the Global Constraints' message, and inserts nothing.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/org-config.test.ts tests/payments-switch.test.ts tests/mainnet-hold.test.ts tests/approvals.test.ts tests/milestone-decisions.test.ts tests/sample-data*.test.ts`
Expected: FAIL — `paymentsHold` not exported; `networkHold` undefined; mainnet credentials still withheld when on; the simulated reserve answers.

- [ ] **Step 3: Implement**

`src/lib/config.ts` `ChainConfig`, after `usycLive`:

```ts
  /**
   * Why the organization cannot move money now because of its network (mainnet go-live M4): set only by `orgConfig`.
   * The platform's stop switch reads it first, so every gate that switch built refuses with it.
   */
  networkHold?: string;
```

`src/lib/dal/org-config.ts`: delete `MAINNET_NOT_YET`; import `MAINNET_NOT_CONNECTED, MAINNET_OFF, networkHold` from `../mainnet` and `ARC_MAINNET, FeatureOffError` from `../network`. Replace the N3 block with:

```ts
  // Arc mainnet behind a switch (mainnet go-live M4, M5). Off, a mainnet workspace gets no Circle credentials at all,
  // as N3 kept every one; on, its own credentials open, and its hold stands until it is live. It never takes the
  // platform's hosted testnet pair, and with no Circle account of its own it gets no provider: never the simulator.
  const network = networkOf(org.network);
  const hold = networkHold(network, org.mode, base) ?? undefined;
  if (network === "arc-mainnet") {
    const withheld = !base.mainnetEnabled ? MAINNET_OFF : walletHost === "hosted" ? new FeatureOffError("A hosted wallet", ARC_MAINNET).message : null;
    if (withheld) {
      circleApiKey = undefined;
      circleEntitySecret = undefined;
      credentialsUnreadable = withheld;
      warnings.push(withheld);
    } else if (!circleApiKey || !circleEntitySecret) {
      credentialsUnreadable ??= MAINNET_NOT_CONNECTED;
    }
  }
```

and add `networkHold: hold,` to the returned `chain`. Update the doc comment above `orgConfig` (one paragraph: the mainnet rules).

`src/lib/payments-switch.ts`:

```ts
/** Thrown wherever money would move while payments are switched off, or the workspace's network holds it (M4). */
export class PaymentsDisabledError extends Error {
  constructor(message: string = PAYMENTS_OFF) {
    super(message);
    this.name = "PaymentsDisabledError";
  }
}

/**
 * Why no money may move now, or null: the scope's workspace's network hold first (mainnet go-live M4), then either
 * half of the platform's switch. Outside a workspace's scope only the platform's switch applies. A read of the
 * database's switch that fails counts as off.
 */
export async function paymentsHold(now: number = Date.now()): Promise<string | null> {
  const config = currentConfig();
  if (config.chain.networkHold) return config.chain.networkHold;
  if (config.paymentsDisabled === true) return PAYMENTS_OFF;
  try {
    return (await readSwitch(now)).off ? PAYMENTS_OFF : null;
  } catch (error) {
    console.error("payments switch: not read", error instanceof Error ? error.message : String(error));
    return PAYMENTS_OFF;
  }
}

export async function paymentsDisabled(now: number = Date.now()): Promise<boolean> {
  return (await paymentsHold(now)) !== null;
}

export async function assertPaymentsEnabled(): Promise<void> {
  const hold = await paymentsHold();
  if (hold) throw new PaymentsDisabledError(hold);
}
```

Keep the existing doc comments, extended by one line each. `paymentsSwitchForPages` stays as is (the banner is the platform's).

`src/lib/circle/liveProvider.ts`: the option becomes `paymentsDisabled?: boolean | (() => Promise<boolean | string | null>)`; store `private readonly paymentsHold: () => Promise<string | null>` built as: a function → `true` maps to `PAYMENTS_OFF`, a string to itself, anything else to null; a boolean → `true ? PAYMENTS_OFF : null`. `refuseWhilePaymentsOff` throws `new PaymentsDisabledError(hold)`; `batchTransfer` throws `new BatchNotSentError(hold.replace(/\.$/, ""))`.

`src/lib/circle/index.ts`: `paymentsDisabled: () => paymentsHold()`; in `HybridProvider.depositToEarn`/`withdrawFromEarn`, when `this.earnMode !== "live" && !this.network.usyc`, return `Promise.reject(new FeatureOffError("The USYC reserve", this.network))`.

`src/lib/agent/approvals.ts`: import `paymentsHold`; replace `if (!alreadySent && (await paymentsDisabled())) raise("payments_off");` with:

```ts
  if (!alreadySent) {
    const hold = await paymentsHold();
    if (hold) throw new ApprovalError("payments_off", hold);
  }
```

and `if (error instanceof PaymentsDisabledError) raise("payments_off");` with `throw new ApprovalError("payments_off", error.message);`. Same two changes in `milestone-decisions.ts` (`raise("payments_off", hold)` / `raise("payments_off", error.message)`). Remove now-unused imports.

`src/lib/sample-data.ts`: add `mainnet` to `SampleDataErrorCode` and `MESSAGES` ("Sample data runs on Arc testnet only: a workspace on Arc mainnet never simulates payments."); `requireSimulatedSandbox` selects `network` too and throws `new SampleDataError("mainnet")` when `networkOf(org.network) === "arc-mainnet"`, first.

Fix `tests/chain-provider.test.ts`'s N3 case: build the mainnet config with `credentialsUnreadable: MAINNET_OFF` from `@/lib/mainnet`, describe it as "mainnet go-live M4", same expectations.

- [ ] **Step 4: Run them and watch them pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run verify`. Expected: green (fix any test that pinned `MAINNET_NOT_YET`'s text by reading `MAINNET_OFF`).

```bash
git add -A src tests
git commit -m "Hold a mainnet workspace until it is live, through the stop switch's gates, and never simulate it"
```

---

### Task 4: Wallets on the workspace's chain, the gas reserve, and what Arc mainnet leaves out

**Files:**
- Modify: `src/lib/circle/provision.ts` (`createWallet`, `createTreasuryWallets`)
- Modify: `src/lib/circle/liveProvider.ts` (`batchTransfer` refuses on an EOA network)
- Modify: `src/lib/payments.ts` and `src/lib/agent/orchestrator.ts` (do not try a batch on an EOA network)
- Modify: `src/lib/circle/escrow-setup.ts`, `src/lib/circle/spending-limit-setup.ts` (refuse by name)
- Modify: `src/app/actions/escrow.ts`, `src/app/actions/agent.ts` (show `FeatureOffError`'s message)
- Modify: `src/lib/agent/balances.ts`, `src/lib/agent/pay.ts` (gas reserve)
- Test: `tests/circle-provision.test.ts`, `tests/escrow-setup.test.ts`, `tests/spending-limit-setup.test.ts`, `tests/circle-live-provider.test.ts`, `tests/balances*.test.ts` (whichever covers `liveOperatingBalance` / `syncOperatingBalance`)

**Interfaces:**
- Consumes: `walletAccountType`, `gasReserveUsdc`, `escrow`, `spendingLimitContract` (Task 1); `chainOn` (`src/lib/payee-chains.ts`).
- Produces: `createWallet(client, { walletSetId, chain, accountType, idempotencyKey? })`; `createScaWallet` kept as a wrapper; `liveOperatingBalance(onChain, notionalReserve, gasReserve = 0)`.

- [ ] **Step 1: Write the failing tests**

`tests/circle-provision.test.ts` — add (the file's `inOrg` takes a config; give it `{ ...config, network: "arc-mainnet" }`):

```ts
describe("createTreasuryWallets on the workspace's network (mainnet go-live M6)", () => {
  const MAINNET_OPERATING = { id: "acct-main", name: "Operating", chain: "ARC", circle_wallet_id: null };

  it("creates an EOA on ARC for a workspace on Arc mainnet", async () => {
    const fake = database([MAINNET_OPERATING]);
    const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });
    await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }), { ...config, network: "arc-mainnet" });
    expect(fakeCircle.createWallets.mock.calls[0][0]).toMatchObject({ blockchains: ["ARC"], accountType: "EOA" });
  });

  it("refuses an account on another network's chain before asking Circle for anything", async () => {
    const fake = database([OPERATING]);
    const fakeCircle = circle();
    await expect(inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }), { ...config, network: "arc-mainnet" })).rejects.toThrow(
      "ARC-TESTNET is not a chain this workspace pays on"
    );
    expect(fakeCircle.factory).not.toHaveBeenCalled();
    expect(patches(fake)).toEqual([]);
  });

  it("still creates SCAs on Arc testnet, a Base Sepolia account included", async () => {
    const fake = database([{ id: "acct-base", name: "Base", chain: "BASE-SEPOLIA", circle_wallet_id: null }]);
    const fakeCircle = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });
    await inOrg(fake, () => createTreasuryWallets({ client: fakeCircle.factory }));
    expect(fakeCircle.createWallets.mock.calls[0][0]).toMatchObject({ blockchains: ["BASE-SEPOLIA"], accountType: "SCA" });
  });
});
```

`tests/escrow-setup.test.ts` — replace the P4 mainnet case:

```ts
  it("refuses on Arc mainnet by name, before asking Circle for anything (mainnet go-live M6)", async () => {
    const db = database(null, OPERATING, { ...config, network: "arc-mainnet" });
    const c = circle();
    await expect(setUp(db, c)).rejects.toThrow("Escrow does not run on Arc mainnet yet");
    expect(c.calls).toEqual([]);
  });
```

`tests/spending-limit-setup.test.ts` — the same shape: `enforceSpendingLimit` in a mainnet scope rejects with "Enforcing the spending limit in a contract does not run on Arc mainnet yet", and no Circle call.

`tests/circle-live-provider.test.ts`:

```ts
  it("refuses a batch on a network whose wallets are EOAs, before calling Circle (mainnet go-live M6)", async () => {
    const createContractExecutionTransaction = vi.fn();
    const client = fakeClient({ createContractExecutionTransaction } as unknown as Partial<LiveProviderClient>);
    const provider = new LiveProvider(CHAIN, { network: ARC_MAINNET, client, paymentsDisabled: false });
    await expect(
      provider.batchTransfer({ fromAccountId: "operating", transfers: [TRANSFER, { ...TRANSFER, idempotencyKey: "k2" }], idempotencyKey: "batch-1" } as never)
    ).rejects.toThrow("Paying in one batch does not run on Arc mainnet yet");
    expect(createContractExecutionTransaction).not.toHaveBeenCalled();
  });
```

(`BatchNotSentError` is what it throws; assert `toBeInstanceOf(BatchNotSentError)` too. Use the file's `TRANSFER` fixture and the batch param shape its existing batch tests use.)

Balances — in the test that covers `liveOperatingBalance`:

```ts
describe("the gas an EOA keeps (mainnet go-live M6)", () => {
  it("keeps the gas reserve aside, never below zero, and changes nothing where it is 0", () => {
    expect(liveOperatingBalance(10, 2, 0.1)).toEqual({ spendable: 7.9, reserve: 2 });
    expect(liveOperatingBalance(0.05, 0, 0.1)).toEqual({ spendable: 0, reserve: 0 });
    expect(liveOperatingBalance(10, 2)).toEqual({ spendable: 8, reserve: 2 });
  });
});
```

and one `syncOperatingBalance` case on a mainnet-profile provider (fake `getBalance` 5 → stored 4.9).

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/circle-provision.test.ts tests/escrow-setup.test.ts tests/spending-limit-setup.test.ts tests/circle-live-provider.test.ts tests/balances*.test.ts`
Expected: FAIL — SCA asked on mainnet; escrow asks Circle; batch calls Circle; no gas reserve.

- [ ] **Step 3: Implement**

`provision.ts`:

```ts
/** One new wallet of `accountType` on `chain`, in the given set (mainnet go-live M6). With an idempotency key Circle returns the wallet an earlier call with that key created. */
export async function createWallet(
  client: CircleClient,
  input: { walletSetId: string; chain: string; accountType: "SCA" | "EOA"; idempotencyKey?: string }
): Promise<{ id: string; address: string }> {
  const created = await circleCall(
    "createWallets",
    () =>
      client.createWallets({
        blockchains: [input.chain as never],
        count: 1,
        walletSetId: input.walletSetId,
        accountType: input.accountType,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
    true
  );
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) throw new CircleCallFailed("createWallets");
  return { id: wallet.id, address: wallet.address };
}

/** One new SCA wallet: the spending limit's agent wallet is always a smart account. */
export function createScaWallet(client: CircleClient, walletSetId: string, chain: string, idempotencyKey?: string): Promise<{ id: string; address: string }> {
  return createWallet(client, { walletSetId, chain, accountType: "SCA", idempotencyKey });
}
```

In `createTreasuryWallets`, after computing `missing` (and before building the client): `const network = workspaceNetwork(); const chains = new Map(missing.map((account) => [account.id, chainOn(network.id, account.chain).id]));` (throws `ChainNotOnNetworkError` first); in the loop `createWallet(client, { walletSetId, chain: chains.get(account.id)!, accountType: network.walletAccountType, idempotencyKey: walletIdempotencyKey(orgId, account.id) })`. Update its doc comment (the profile's account type; never another network's chain).

`liveProvider.ts` `batchTransfer`: right after the hold check, `if (this.network.walletAccountType !== "SCA") throw new BatchNotSentError(new FeatureOffError("Paying in one batch", this.network).message);`.

`payments.ts`: the batch condition gains `|| provider.network.walletAccountType !== "SCA"`; `orchestrator.ts` line `if (releases.length < 2 || !deps.provider.batchTransfer)` gains the same clause. (Only when the `ChainProvider` type exposes `network` — it does since #218.)

`escrow-setup.ts` `setUpEscrow`: first line of its body `const network = workspaceNetwork(); if (!network.escrow) throw new FeatureOffError("Escrow", network);`. `spending-limit-setup.ts` `enforceSpendingLimit`: same with `spendingLimitContract` and `"Enforcing the spending limit in a contract"`. Both actions: `if (error instanceof FeatureOffError) return { ok: false, message: error.message };` beside their `PaymentsDisabledError` line.

`balances.ts`: `liveOperatingBalance(onChain, notionalReserve, gasReserve = 0)`: `const available = Math.max(0, onChain - Math.max(0, gasReserve));` then as before. In `syncOnChainBalances`, pass `carvesReserve ? provider.network.gasReserveUsdc : 0`. `pay.ts` `syncOperatingBalance`: `const spendable = Math.max(0, Number((snapshot.balance - carveOut - provider.network.gasReserveUsdc).toFixed(6)));`. Doc comments say why (an EOA pays its own gas).

- [ ] **Step 4: Run them and watch them pass** — the Step 2 command. Expected: PASS.

- [ ] **Step 5: Verify and commit** — `npm run verify` green.

```bash
git add -A src tests
git commit -m "Create each wallet as its network's account type, keep gas for an EOA, and refuse what Arc mainnet leaves out"
```

---

### Task 5: Migration 0078 — the database takes Arc mainnet's chain, and the network is fixed at creation

**Files:**
- Create: `supabase/migrations/0078_mainnet_go_live.sql`
- Modify: `supabase/migrations/0044_cctp_payouts.sql` (the rewrite keeps `ARC`)
- Test: `tests/mainnet-migration.test.ts`

**Interfaces:**
- Produces: `counterparties_chain_check` accepting `ARC`; `orgs_network_locked` refusing once any account exists; `pay_link_preview` and `payee_link_status` naming the workspace's home chain.

- [ ] **Step 1: Write the failing test**

`tests/mainnet-migration.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase } from "./support/pglite";

/** Migration 0078 (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M3, M11). */
let db: PGlite;

async function org(slug: string, network = "arc-testnet", mode = "sandbox"): Promise<string> {
  return (await db.query<{ id: string }>("insert into public.orgs (slug, name, mode, network) values ($1, $1, $2, $3) returning id", [slug, mode, network])).rows[0].id;
}
async function account(orgId: string, chain: string, wallet: string | null = null) {
  await db.query("insert into public.accounts (org_id, name, kind, chain, token, circle_wallet_id, address, balance) values ($1, 'Operating', 'operating', $2, 'USDC', $3, $4, 0)", [
    orgId, chain, wallet, wallet ? "0x" + "ab".repeat(20) : null,
  ]);
}

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
}, 60_000);

describe("a payee on Arc mainnet's chain (M11)", () => {
  it("is accepted for any role, and Sepolia chains stay vendor-only", async () => {
    const main = await org("main-cp", "arc-mainnet");
    await db.query("insert into public.counterparties (org_id, name, role, chain) values ($1, 'Builder', 'contractor', 'ARC')", [main]);
    await expect(db.query("insert into public.counterparties (org_id, name, role, chain) values ($1, 'Far', 'contractor', 'BASE-SEPOLIA')", [main])).rejects.toThrow(/counterparties_chain_check/);
    await expect(db.query("insert into public.counterparties (org_id, name, role, chain) values ($1, 'Odd', 'vendor', 'ARC-SEPOLIA')", [main])).rejects.toThrow(/counterparties_chain_check/);
  });

  it("survives 0044 running again, as db:migrate runs every file each time", async () => {
    const main = await org("main-rerun", "arc-mainnet");
    await db.query("insert into public.counterparties (org_id, name, role, chain) values ($1, 'Stays', 'vendor', 'ARC')", [main]);
    const file = readFileSync(path.join(process.cwd(), "supabase", "migrations", "0044_cctp_payouts.sql"), "utf8");
    await db.exec(file);
    const row = await db.query<{ chain: string }>("select chain from public.counterparties where org_id = $1", [main]);
    expect(row.rows[0].chain).toBe("ARC");
  });
});

describe("the network is fixed once a workspace has an account (M3)", () => {
  it("may change while there is none, as createWorkspace sets it", async () => {
    const fresh = await org("fresh");
    await db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [fresh]);
    expect((await db.query<{ network: string }>("select network from public.orgs where id = $1", [fresh])).rows[0].network).toBe("arc-mainnet");
  });

  it("is locked once a simulated account exists, so a testnet sandbox cannot be moved by hand", async () => {
    const sandbox = await org("hand-flip");
    await account(sandbox, "ARC-TESTNET");
    await expect(db.query("update public.orgs set network = 'arc-mainnet' where id = $1", [sandbox])).rejects.toThrow(/network_locked/);
  });
});

describe("the payment links on Arc mainnet (M11)", () => {
  it("pays into the operating account on ARC and names it", async () => {
    const main = await org("main-links", "arc-mainnet", "live");
    await account(main, "ARC", "w-main");
    const client = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Client', 'client') returning id", [main])).rows[0].id;
    const invoice = (await db.query<{ id: string }>(
      "insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, status) values ($1, 'receivable', $2, 5, '2026-10-20T12:00:00Z', 'open') returning id",
      [main, client]
    )).rows[0].id;
    await db.query("insert into public.receivable_links (org_id, invoice_id, token_hash) values ($1, $2, 'hash-main')", [main, invoice]);
    const preview = (await db.query<{ p: { chain: string; payTo: string | null } }>("select public.pay_link_preview('hash-main') as p")).rows[0].p;
    expect(preview).toMatchObject({ chain: "ARC", payTo: "0x" + "ab".repeat(20) });
  });

  it("names the workspace's own chain for a payee who has none", async () => {
    const main = await org("main-payee", "arc-mainnet", "live");
    const payee = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Payee', 'contractor') returning id", [main])).rows[0].id;
    await db.query("insert into public.payee_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, 'payee-main', now() + interval '1 day')", [main, payee]);
    const status = (await db.query<{ s: { chain: string } }>("select public.payee_link_status('payee-main') as s")).rows[0].s;
    expect(status.chain).toBe("ARC");
  });

  it("still names ARC-TESTNET on Arc testnet", async () => {
    const test = await org("test-payee", "arc-testnet", "live");
    const payee = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, 'Payee', 'contractor') returning id", [test])).rows[0].id;
    await db.query("insert into public.payee_links (org_id, counterparty_id, token_hash, expires_at) values ($1, $2, 'payee-test', now() + interval '1 day')", [test, payee]);
    expect((await db.query<{ s: { chain: string } }>("select public.payee_link_status('payee-test') as s")).rows[0].s.chain).toBe("ARC-TESTNET");
  });
});
```

(Check `receivable_links`' and `payee_links`' required columns in 0050/0039 and add any `created_by`/`expires_at` they need; the assertions stay.)

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/mainnet-migration.test.ts`
Expected: FAIL — `ARC` violates the check; the lock lets the hand flip through; the links name `ARC-TESTNET`.

- [ ] **Step 3: Implement**

`0044_cctp_payouts.sql`: the rewrite's list becomes `('ARC-TESTNET', 'ARC', 'BASE-SEPOLIA', 'ARB-SEPOLIA', 'ETH-SEPOLIA')`, with a comment: `ARC` is Arc mainnet's chain (0078), kept as written on every re-run.

`0078_mainnet_go_live.sql` (idempotent):

```sql
-- Arc mainnet behind a switch (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M3, M11).
--
-- 1. A payee may be on ARC, Arc mainnet's chain, whatever its role; the Sepolia chains stay vendor-only (0044).
-- 2. A workspace's network is fixed once it has any account: createWorkspace sets it before the first one, so a
--    sandbox whose account rows name ARC-TESTNET can no longer be moved to Arc mainnet by hand (0075's lock, widened).
-- 3. The payment links name the workspace's own chain: ARC on Arc mainnet, ARC-TESTNET on Arc testnet (0050, 0053).
--
-- Idempotent throughout: scripts/migrate.ts re-runs every migration each time. 0044's rewrite keeps ARC, so a re-run
-- leaves an ARC payee as it is.

alter table public.counterparties drop constraint if exists counterparties_chain_check;
alter table public.counterparties
  add constraint counterparties_chain_check
  check (chain in ('ARC-TESTNET', 'ARC', 'BASE-SEPOLIA', 'ARB-SEPOLIA', 'ETH-SEPOLIA') and (chain in ('ARC-TESTNET', 'ARC') or role = 'vendor'));

create or replace function public.orgs_network_locked() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.network is distinct from old.network
     and (old.mode = 'live'
          or exists (select 1 from public.accounts a where a.org_id = old.id)) then
    raise exception 'network_locked: a workspace keeps the network it was created on once it has an account';
  end if;
  return new;
end;
$$;
```

Then `create or replace function public.pay_link_preview(p_token_hash text)` — 0050's body with `a.chain = 'ARC-TESTNET'` replaced by `a.chain = case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end` and `'chain', 'ARC-TESTNET'` by `'chain', case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end`; and `public.payee_link_status(p_token_hash text)` — 0053's body with `coalesce(c.chain, 'ARC-TESTNET')` replaced by `coalesce(c.chain, case o.network when 'arc-mainnet' then 'ARC' else 'ARC-TESTNET' end)`. Repeat each function's `revoke`/`grant` lines exactly as in its source migration, then `notify pgrst, 'reload schema';` and the rollback note (restore 0050/0053/0075 bodies and 0044's check).

Note: 0075's lock test "may still change in a sandbox with no wallet" uses an org with no account, so it still holds.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/mainnet-migration.test.ts tests/network-migration.test.ts tests/*migration*.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit** — `npm run verify` green.

```bash
git add supabase/migrations/0044_cctp_payouts.sql supabase/migrations/0078_mainnet_go_live.sql tests/mainnet-migration.test.ts
git commit -m "Let the database hold Arc mainnet's chain, and fix a workspace's network once it has an account"
```

---

### Task 6: Creating a workspace on Arc mainnet

**Files:**
- Modify: `src/lib/platform/workspace.ts` (`createWorkspace({ network })`)
- Modify: `src/app/onboarding/actions.ts`, `src/app/onboarding/page.tsx`, `src/components/CreateWorkspaceForm.tsx`
- Modify: `src/lib/auth/membership.ts` (`OrgMembership.network`)
- Modify: `src/lib/agent-budget.ts` (a figure stays on mainnet)
- Test: `tests/workspace.test.ts`, `tests/onboarding-actions.test.ts` (create if none covers the action), `tests/agent-budget.test.ts`, `tests/membership.test.ts` (if it asserts the select), a render test for the form

**Interfaces:**
- Consumes: `mayUseMainnet`, `MAINNET_NOT_OPEN` (Task 1); `homeChain` (`src/lib/payee-chains.ts`).
- Produces: `createWorkspace(input: { userId; name; network?: Network; random? })`; `OrgMembership.network: Network`; `CreateWorkspaceForm({ mainnetOffered }: { mainnetOffered?: boolean })`; `AgentBudgetErrorCode` gains `"mainnet_needs_figure"`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace.test.ts` — extend `workspaceFake` so a PATCH to `/rest/v1/orgs` with `id=eq.<created id>` applies its body to `created` and answers `[{ id }]`, and so inserts are recorded. Then:

```ts
describe("a workspace on Arc mainnet (mainnet go-live M2, M9)", () => {
  it("is set to Arc mainnet before its first account, with one operating account on ARC and the agent's tight limit", async () => {
    const { fake, run } = workspaceFake();
    await run(() => createWorkspace({ userId: USER, name: "Acme Mainnet", network: "arc-mainnet" }));

    const patchAt = fake.requests.findIndex((request) => request.method === "PATCH" && request.path === "/rest/v1/orgs");
    const accountsAt = fake.requests.findIndex((request) => request.method === "POST" && request.path === "/rest/v1/accounts");
    expect(fake.requests[patchAt].body).toEqual({ network: "arc-mainnet" });
    expect(patchAt).toBeLessThan(accountsAt);
    expect(fake.requests[accountsAt].body).toEqual([{ name: "Operating", kind: "operating", chain: "ARC", balance: 0 }]);
    const budget = fake.requests.find((request) => request.path === "/rest/v1/agent_budgets");
    expect(budget?.body).toMatchObject({ daily_usdc: 50, weekly_usdc: 150, updated_by: USER });
    const created = rpcBodies(fake.requests, "append_ledger_entry")[0];
    expect(JSON.stringify(created)).toContain('"network":"arc-mainnet"');
  });

  it("leaves Arc testnet as it was: no network write, the two simulated accounts", async () => {
    const { fake, run } = workspaceFake();
    await run(() => createWorkspace({ userId: USER, name: "Acme" }));
    expect(fake.requests.some((request) => request.method === "PATCH" && request.path === "/rest/v1/orgs")).toBe(false);
    const accounts = fake.requests.find((request) => request.method === "POST" && request.path === "/rest/v1/accounts");
    expect(accounts?.body).toEqual([
      { name: "Operating (simulated)", kind: "operating", chain: "ARC-TESTNET", balance: 10000 },
      { name: "Reserve (simulated)", kind: "reserve", chain: "ARC-TESTNET", balance: 0 },
    ]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/agent_budgets")).toBe(false);
  });

  it("rolls back when the network cannot be set", async () => {
    const { fake, run } = workspaceFake({ fail: (request) => (request.method === "PATCH" && request.path === "/rest/v1/orgs" ? DB_ERROR("boom") : undefined) });
    await expect(run(() => createWorkspace({ userId: USER, name: "Acme Mainnet", network: "arc-mainnet" }))).rejects.toThrow();
    expect(deletes(fake.requests).some(([table]) => table === "/rest/v1/orgs")).toBe(true);
  });
});
```

Onboarding action (Review Focus 4): with a session user whose email is not allowed, posting `network=arc-mainnet` returns `{ ok: false, message: "Arc mainnet is not open to this account yet." }` and never calls `createWorkspace`; an allowed one (config with `mainnetEnabled` and the address listed) calls it with `network: "arc-mainnet"`; any other value of `network` creates on Arc testnet. Mock `getSessionUser` and `createWorkspace` with `vi.mock`, as other action tests in this repo do.

Form: rendered with `mainnetOffered`, it shows a "Network" choice whose options are "Arc testnet" (checked) and "Arc mainnet"; without it, no such field.

`tests/agent-budget.test.ts`:

```ts
  it("keeps a figure on Arc mainnet: removing both is refused (mainnet go-live M9)", async () => {
    // the file's existing harness, with the scope's config at network "arc-mainnet" and a stored budget of 50 / 150
    await expect(change({ daily: "", weekly: "" })).rejects.toMatchObject({ code: "mainnet_needs_figure", message: "A workspace on Arc mainnet keeps a daily or 7-day limit." });
  });
```

(Use the file's own harness names; the assertion is the contract.)

- [ ] **Step 2: Run them and watch them fail** — `npx vitest run tests/workspace.test.ts tests/onboarding-actions.test.ts tests/agent-budget.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`workspace.ts`:

```ts
/** The accounts a new workspace starts with (mainnet go-live M2): Arc testnet's two simulated ones, or Arc mainnet's one real operating account, empty, with no reserve. */
function startingAccounts(network: Network) {
  const chain = homeChain(network).id;
  if (network === "arc-mainnet") return [{ name: "Operating", kind: "operating", chain, balance: 0 }];
  return [
    { name: "Operating (simulated)", kind: "operating", chain, balance: 10000 },
    { name: "Reserve (simulated)", kind: "reserve", chain, balance: 0 },
  ];
}

/** The agent's spending limit a mainnet workspace starts with (M9): tight, and a figure always stays. */
export const MAINNET_STARTING_BUDGET = { dailyUsdc: 50, weeklyUsdc: 150 } as const;
```

`createWorkspace` takes `network?: Network` (default `"arc-testnet"`). After `created` is known and before `withOrg`: when the network is not Arc testnet, `platformDb().from("orgs").update({ network }).eq("id", orgId).select("id")`; an error or no row → `rollBack` and throw. Inside the scope: insert `startingAccounts(workspaceNetwork().id)`; on Arc mainnet insert `agent_budgets` `{ daily_usdc: 50, weekly_usdc: 150, updated_by: userId }`; `org_created` detail gains `network`. Wrap the network write in the existing `try … rollBack` so a failure there rolls back too.

`onboarding/actions.ts`: `const network = formData.get("network") === "arc-mainnet" ? "arc-mainnet" : "arc-testnet"; if (network === "arc-mainnet" && !mayUseMainnet(user.email)) return { ok: false, message: MAINNET_NOT_OPEN };` and pass `network`.

`onboarding/page.tsx`: `const mainnetOffered = mayUseMainnet(user.email);` passed to both `<CreateWorkspaceForm mainnetOffered={mainnetOffered} />`. In the memberships list, a mainnet membership's line reads `{role} · {mode} · Arc mainnet`.

`CreateWorkspaceForm.tsx`: when `mainnetOffered`, a fieldset legend "Network" with two radio inputs `name="network"`: `arc-testnet` (default checked) labelled "Arc testnet" with "It starts as a sandbox: the money in it is simulated."; `arc-mainnet` labelled "Arc mainnet" with "Real USDC, from your own Circle account. Nothing moves until an owner takes it live." Without it, the field's description stays as today.

`membership.ts`: `SELECT = "role, orgs!inner(id, slug, name, mode, network)"`; `OrgMembership.network: Network` from `networkOf(row.orgs.network)`.

`agent-budget.ts`: new code `mainnet_needs_figure` with the Global Constraints' message; in `changeAgentBudget`, after parsing, `if (to.dailyUsdc === null && to.weeklyUsdc === null && workspaceNetwork().id === "arc-mainnet") throw new AgentBudgetError("mainnet_needs_figure");`.

- [ ] **Step 4: Run them and watch them pass** — Step 2's command → PASS.

- [ ] **Step 5: Verify and commit** — `npm run verify` green.

```bash
git add -A src tests
git commit -m "Let a person on the allowlist create a workspace on Arc mainnet, with one empty operating account and a tight limit"
```

---

### Task 7: Going live on Arc mainnet

**Files:**
- Modify: `src/lib/platform/go-live.ts`
- Modify: `src/app/actions/go-live.ts`
- Modify: `src/components/GoLivePanel.tsx`
- Modify: `content/docs/guides/go-live.mdx` (rows for the new messages, and a short "On Arc mainnet" section)
- Test: `tests/go-live-lib.test.ts`, `tests/go-live-panel.test.tsx` (or the panel's existing render test), `tests/docs-guides.test.ts` (`GO_LIVE_ERRORS`)

**Interfaces:**
- Consumes: `mayUseMainnet`, `MAINNET_NOT_OPEN` (Task 1); the hold (Task 3); wallets (Task 4).
- Produces: `GoLiveErrorCode` gains `"mainnet_not_open" | "mainnet_confirmation"`; `connectCircle`, `createWallets`, `goLive` inputs gain `actorEmail?: string | null`; `goLive` gains `confirmation?: string`; `GoLiveStatus.network: Network`.

- [ ] **Step 1: Write the failing tests**

In `tests/go-live-lib.test.ts`, a new describe using the file's helpers:

```ts
describe("Arc mainnet (mainnet go-live M8)", () => {
  const OWNER = "owner@acme.test";
  const LIVE_KEY = "LIVE_API_KEY:main-key-id:main-key-secret-value";
  const mainnetPlatform = { ...config, mainnetEnabled: true, mainnetAllowlist: [OWNER] };
  const onMainnet = (state: State): State => {
    state.org.network = "arc-mainnet";
    state.accounts = state.accounts.filter((account) => account.kind === "operating").map((account) => ({ ...account, chain: "ARC" }));
    return state;
  };

  it("refuses someone not on the allowlist at every step, before Circle is asked", async () => {
    for (const email of ["other@acme.test", null]) {
      const { inScope } = database(onMainnet(sandbox()), { platform: mainnetPlatform });
      const c = circle();
      await expect(refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: email, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, client: c.factory, check: async () => "ok" })))).resolves.toMatchObject({
        code: "mainnet_not_open",
        message: "Arc mainnet is not open to this account yet.",
      });
      expect(c.factory).not.toHaveBeenCalled();
    }
  });

  it("refuses everyone while the deployment has Arc mainnet off", async () => {
    const { inScope } = database(onMainnet(sandbox()), { platform: { ...mainnetPlatform, mainnetEnabled: false } });
    await expect(refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, check: async () => "ok" })))).resolves.toMatchObject({ code: "mainnet_not_open" });
  });

  it("refuses a test key on a mainnet workspace, naming both networks", async () => {
    const { inScope } = database(onMainnet(sandbox()), { platform: mainnetPlatform });
    const error = await refusal(inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, apiKey: API_KEY, entitySecret: ENTITY_SECRET, check: async () => "ok" })));
    expect(error.code).toBe("key_network");
    expect(error.message).toBe("This Circle API key is for Arc testnet (TEST_API_KEY). This workspace is on Arc mainnet: paste a live key (LIVE_API_KEY).");
  });

  it("connects a live key, and creates one EOA on ARC", async () => {
    const state = onMainnet(sandbox());
    const { inScope } = database(state, { platform: mainnetPlatform });
    const c = circle({ sets: [{ id: "set-treasury", name: TREASURY_WALLET_SET }] });
    await inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, apiKey: LIVE_KEY, entitySecret: ENTITY_SECRET, client: c.factory, check: async () => "ok" }));
    await inScope(() => createWallets({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, client: c.factory }));
    expect(c.createWallets.mock.calls[0][0]).toMatchObject({ blockchains: ["ARC"], accountType: "EOA" });
  });

  it("goes live only with the word typed, and records the network", async () => {
    const state = onMainnet(withWallets(connected({ circle_api_key_enc: seal(LIVE_KEY, "circle_api_key_enc") })));
    state.accounts = state.accounts.filter((account) => account.kind === "operating").map((account) => ({ ...account, chain: "ARC" }));
    const { fake, inScope } = database(state, { platform: mainnetPlatform });
    const c = circle(SAME_ENTITY);
    for (const word of [undefined, "", "main net", "testnet"]) {
      await expect(refusal(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, confirmation: word, client: c.factory })))).resolves.toMatchObject({
        code: "mainnet_confirmation",
        message: "Type mainnet to confirm that this workspace pays real USDC.",
      });
    }
    expect(state.org.mode).toBe("sandbox");
    await inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER, confirmation: "  Mainnet ", client: c.factory }));
    expect(state.org.mode).toBe("live");
    expect(appends(fake).at(-1)).toMatchObject({ p_action: "workspace_went_live" });
    expect(JSON.stringify(appends(fake).at(-1))).toContain('"network":"arc-mainnet"');
  });

  it("asks nothing new of a testnet workspace", async () => {
    const { inScope } = database(founding(), { platform: config });
    // the founding fixture is live already; a fresh connected testnet sandbox with wallets goes live with no word and no email:
    const state = withWallets(connected());
    const testnet = database(state, { platform: config });
    await testnet.inScope(() => goLive({ orgId: ORG, actorId: ACTOR, client: circle(SAME_ENTITY).factory }));
    expect(state.org.mode).toBe("live");
    void inScope;
  });
});
```

(Adjust `appends(...)` field names to what the file's `append_ledger_entry` body carries — `p_action`/`p_detail` — by reading one existing go-live record assertion. The `refusal` helper is the file's own.)

`GO_LIVE_ERRORS` in `tests/docs-guides.test.ts` gains `mainnet_not_open: true, mainnet_confirmation: true`.

Panel: rendered with a mainnet status at each step, it shows no faucet link, asks for a live key ("LIVE_API_KEY"), describes one wallet on Arc mainnet, has a field named `confirmation` labelled "Type mainnet to confirm" on the go-live step, and the consequence line "Real USDC moves when the agent pays."; a testnet status renders exactly as before (existing tests unchanged).

- [ ] **Step 2: Run them and watch them fail** — `npx vitest run tests/go-live-lib.test.ts tests/docs-guides.test.ts tests/go-live-panel.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`go-live.ts`:
- Codes and messages: `mainnet_not_open: MAINNET_NOT_OPEN`, `mainnet_confirmation: "Type mainnet to confirm that this workspace pays real USDC."`.
- `function keyNetworkMessage(key: NetworkProfile, workspace: NetworkProfile): string` → ``This Circle API key is for ${key.label} (${key.circleKeyPrefix.replace(/:$/, "")}). This workspace is on ${workspace.label}: paste a ${workspace.id === "arc-mainnet" ? "live" : "test"} key (${workspace.circleKeyPrefix.replace(/:$/, "")}).`` — for a testnet workspace this equals today's message exactly (assert it in a test). `connectCircle` throws `new GoLiveError("key_network", keyNetworkMessage(...))`.
- `function requireMainnetAccess(state: OrgState, actorEmail: string | null | undefined)`: on Arc mainnet, `if (!mayUseMainnet(actorEmail)) throw new GoLiveError("mainnet_not_open")`. Called first in `connectCircle` (before the sample-data check), `createWallets` and `goLive`.
- `goLive`: on Arc mainnet, `if ((input.confirmation ?? "").trim().toLowerCase() !== "mainnet") throw new GoLiveError("mainnet_confirmation")`, after the access check and before the scope; `workspace_went_live` detail `{ by, network }`.
- `goLiveStatus` returns `network: networkOf(state.network)`.

`actions/go-live.ts`: pass `actorEmail: auth.user.email` to all three, and `confirmation: formString(formData, "confirmation")` to `goLive`.

`GoLivePanel.tsx`: read `status.network`; for `arc-mainnet`, use mainnet copy in `STATUS` lines ("Live · paying on Arc mainnet"), `ConnectIntro` (a live key and its entity secret, from Circle Console after "Upgrade to Prod"), `WalletsStep` ("One wallet on Arc mainnet, an EOA that pays its own gas in USDC, in a wallet set in your own Circle account."), `GoLiveStep` (fund with USDC on Arc mainnet: no faucet link; an `Input name="confirmation"` labelled "Type mainnet to confirm"), and `GO_LIVE_CONSEQUENCES` ("Real USDC moves when the agent pays."). Hosted choice is already hidden there. Testnet strings stay byte-for-byte.

`go-live.mdx`: rows for the two new messages and for the mainnet variant of the key message; a section "On Arc mainnet" listing the steps (allowlist, live key, one EOA wallet, fund, type mainnet) and that nothing moves before.

- [ ] **Step 4: Run them and watch them pass** — Step 2's command → PASS.

- [ ] **Step 5: Verify and commit** — `npm run verify` green.

```bash
git add -A src tests content
git commit -m "Take a workspace live on Arc mainnet only for a person on the allowlist who types mainnet"
```

---

### Task 8: Chats, the API's chain, and the mainnet banner

**Files:**
- Modify: `src/lib/commands/chat-decisions.ts` (M10)
- Modify: `src/lib/api/schemas.ts`, `src/lib/payee-chains.ts` (drop `TESTNET_PAYEE_CHAIN_IDS`), `src/lib/intake-validation.ts` (its enum message names every chain)
- Modify: `content/docs/changelog.mdx` (dated 2026-10-06, newest first)
- Create: `src/components/MainnetBanner.tsx`; Modify: `src/app/o/[slug]/layout.tsx`
- Modify: `tests/network-constants-ratchet.test.ts` (payee-chains' count down by what was removed)
- Test: `tests/chat-decisions.test.ts` (or where `approveRefusal` is tested: `tests/slack-blocks.test.ts`, `tests/network-records.test.ts`), `tests/api-schemas.test.ts`, `tests/api-write-counterparties*.test.ts` (or the route's test), `tests/mainnet-banner.test.tsx`

**Interfaces:**
- Consumes: `OrgMembership.network` (Task 6); `MAINNET_OFF`, `MAINNET_NOT_LIVE` (Task 1).
- Produces: `MainnetBanner({ mode, enabled }: { mode: "sandbox" | "live"; enabled: boolean })`.

- [ ] **Step 1: Write the failing tests**

```ts
// approveRefusal (M10)
it("refuses a payable on Arc mainnet from a chat, whatever the chat limit", () => {
  const facts = { network: "arc-mainnet" as const, amount: 1, currency: "USDC", chain: "ARC", address: "0x" + "ab".repeat(20), addressChangedAt: null, addressConfirmedAt: null };
  expect(approveRefusal(facts as never, 1000, "Slack")).toMatchObject({ code: "open_in_console", message: "It is on Arc mainnet, where payments are approved in Vestiarion." });
});
```

(Use the file's existing facts fixture with `network` and `chain` changed; compare the `refused` shape the file already asserts.)

API: `CreateCounterpartyBodySchema.parse({ name: "Acme", role: "vendor", paymentLimit: "5", chain: "ARC" })` succeeds; the route, for a testnet workspace, answers 400 `invalid_request` naming "ARC is not a chain this workspace pays on" (the route already refuses an off-network chain since #218; this proves the enum lets it reach that check); the schema's `chain` description names `ARC` for Arc mainnet.

Banner (`tests/mainnet-banner.test.tsx`, render with the repo's usual `renderToStaticMarkup` or testing-library):

```tsx
it("says real USDC moves on a live mainnet workspace, and why nothing moves otherwise", () => {
  expect(html(<MainnetBanner mode="live" enabled />)).toContain("Arc mainnet: payments here move real USDC.");
  expect(html(<MainnetBanner mode="sandbox" enabled />)).toContain(MAINNET_NOT_LIVE);
  expect(html(<MainnetBanner mode="live" enabled={false} />)).toContain(MAINNET_OFF);
});
```

- [ ] **Step 2: Run them and watch them fail** → FAIL.

- [ ] **Step 3: Implement**

- `approveRefusal`: first line `if (facts.network === "arc-mainnet") return refused("open_in_console", "It is on Arc mainnet, where payments are approved in Vestiarion.");`.
- `schemas.ts`: `.enum(ALL_PAYEE_CHAIN_IDS)` with the description "The chain the address receives on. Defaults to the workspace's own chain: `ARC-TESTNET` on Arc testnet, `ARC` on Arc mainnet. Only a vendor can be paid on another chain, and only a chain the workspace's network pays on is accepted."; remove `TESTNET_PAYEE_CHAIN_IDS` from `payee-chains.ts` (and its ratchet entry/count).
- `intake-validation.ts`: the enum message lists every chain's label from `ALL_PAYEE_CHAIN_IDS` (built, not hard-coded).
- Changelog entry, newest first:

```mdx
## 2026-10-06: `chain` accepts `ARC`, Arc mainnet's chain

- `POST /api/v1/counterparties` accepts `chain: "ARC"` for a workspace on Arc mainnet, and leaving `chain` out gives the workspace's own chain: `ARC` there, `ARC-TESTNET` on Arc testnet.
- A chain the workspace's network does not pay on is refused with `invalid_request`, as before: `ARC` on Arc testnet, or a Sepolia chain on Arc mainnet.
- Nothing else changes in `/api/v1`, and no webhook changes.
```

- `MainnetBanner.tsx` (a `Callout`, tone `held` while held, `proof` when live), and in `layout.tsx` render `{membership.network === "arc-mainnet" && <MainnetBanner mode={membership.mode} enabled={currentConfig().mainnetEnabled === true} />}` before the other banners (platform data only, as the layout's comment requires).

- [ ] **Step 4: Run them and watch them pass** → PASS (regenerate any OpenAPI snapshot the docs tests compare, by the repo's documented script).

- [ ] **Step 5: Verify and commit** — `npm run verify` green.

```bash
git add -A src tests content
git commit -m "Accept Arc mainnet's chain in the API, keep chats from approving mainnet payments, and mark a mainnet workspace"
```

---

### Task 9: The dry run, and the docs

**Files:**
- Modify: `tests/network-mainnet-dry-run.test.ts` (the enabled path)
- Modify: `ARCHITECTURE.md` (a section "Arc mainnet behind a switch"), `README.md` (the two settings), `.env.example`
- Modify: the spec's status line

- [ ] **Step 1: Write the failing test** — in `tests/network-mainnet-dry-run.test.ts`:

```ts
describe("a workspace on Arc mainnet with the switch on (mainnet go-live)", () => {
  it("is held until live, with a provider that refuses every send, and reads mainnet's facts", async () => {
    const config = { ...BASE, mainnetEnabled: true, network: "arc-mainnet" as const, chain: { ...BASE.chain, circleApiKey: "LIVE_API_KEY:k", circleEntitySecret: "s", networkHold: MAINNET_NOT_LIVE } };
    const { client } = fakeSupabase(() => ({ body: null }));
    await runWith(orgTestContext({ config, client, orgId: "org-main" }), async () => {
      expect(await paymentsHold()).toBe(MAINNET_NOT_LIVE);
      await expect(getChainProvider().transfer({ fromAccountId: "op", toAddress: PAYEE, amount: 1, memo: "m", idempotencyKey: "k" })).rejects.toThrow(MAINNET_NOT_LIVE);
      expect(getChainProvider().network).toBe(ARC_MAINNET);
      expect(workspaceNetwork().walletAccountType).toBe("EOA");
    });
  });
});
```

- [ ] **Step 2: Run it** — it passes if Tasks 1–8 are right; if it does not, fix the module it names (this test is the integration check, not new behaviour).

- [ ] **Step 3: Docs**
- `ARCHITECTURE.md`: "Arc mainnet behind a switch" — the two settings; creation; the hold through the stop switch; never simulating; EOA + gas reserve; tokens by contract; 0078; what waits for 2b–2d.
- `README.md` and `.env.example`: `MAINNET_ENABLED` (off unless `1`/`true`/`yes`) and `MAINNET_ALLOWLIST` (emails), with one line each.
- Spec status: "implemented on `feat/mainnet-go-live`".
- Grep for stale text: `MAINNET_NOT_YET`, "does not move money yet", "TESTNET_PAYEE_CHAIN_IDS".

- [ ] **Step 4: Verify and commit** — `npm run verify` green; `npx next build` once (log to the workspace) since pages changed.

```bash
git add -A
git commit -m "Prove the mainnet path end to end with Circle faked, and document Arc mainnet behind a switch"
```
