# Every module on its workspace's network: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every module that acts for a workspace, or for a record of one, reads its network's profile instead of an Arc
testnet constant, with Arc testnet behaving exactly as today.

**Architecture:**
- **One place for chain facts.** The network profile (`src/lib/network.ts`) gains the payee chains, each with its CCTP
  domain, USDC address, RPC and explorer, and the swap's adapter.
- **Pure helpers** in `src/lib/payee-chains.ts` take a network id: home chain, payee chain lookup, cross-chain test,
  explorer links and `networkOfChain`.
- **Server code in a workspace's scope** reads `workspaceNetwork()`. Code holding a record reads the record's network.
  Providers are built for one profile.
- **Two ratchets** pin the result:
  - literal identifiers;
  - imports of the testnet profile and the constants named for it.

**Tech Stack:** TypeScript, Next.js 16, Vitest (node environment), Circle Developer-Controlled Wallets SDK, viem.

**Spec:** `docs/superpowers/specs/2026-10-05-network-threading-design.md` (rulings P1–P9).

## Global Constraints

- Arc testnet behaves exactly as today. Every existing assertion stays. A test that imported a constant this plan
  deletes reads the testnet profile instead, with the same value (P9).
- N3 stays: `orgConfig` gives a mainnet workspace no Circle credentials, and its provider refuses (P9).
- No default network inside code that acts for a workspace. `workspaceNetwork()` throws outside a workspace's scope.
  A record's network is `networkOf(record.network)`, which reads null as Arc testnet, the rule for rows from before
  0075 (P1).
- A feature its network lacks refuses with `"<feature> does not run on <network label> yet"`, and never falls back to
  testnet values (P5).
- No migration, no environment variable, and no change to `/api/v1`'s schema or the OpenAPI document (§3, §5).
- The ratchets' allowed files are the P7 files only, each with its reason (P8).
- Commit messages are neutral and plain ([[neutral-commit-messages]]). Each commit ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests run in the node environment. Components are checked as server-rendered markup (`renderToStaticMarkup`).
- Run tests with `npx vitest run <files>`. The whole gate is `npm run verify`: typecheck, lint, then all tests.

## Review Focus

1. **Code outside any workspace's scope** that used to read a testnet constant: jobs, webhooks, public pages. It must
   read its record's network, not throw.
   - Tested in Task 6: the receipt page reads its facts' chain, with no scope. Notices and GitHub comments read the
     intent's network.
   - Tested in Task 7: the payee link page reads its status's chain.
2. **A row from before 0044 with a null chain**, or an intent from before 0075 with a null network. It is on Arc
   testnet's home chain, not refused.
   - Tested in Task 1 (`chainOn`) and Task 6 (`buildReceipt`).
3. **A chain from another network handed to a workspace**, for example `ARC` given to a testnet workspace through the
   intake. It gets a plain refusal: never a 500, and never a quiet payment on the home chain.
   - Tested in Task 1 (`chainOn`) and Task 7 (`counterpartyChainProblem`).
4. **The swap adapter drifting from Circle's App Kit.** The profile's adapter is the spender the swap approves.
   - Tested in Task 1: equality with `ArcTestnet.kitContracts.adapter`.
5. **A Sepolia payee on a testnet workspace.** CCTP and Gateway quotes, receipts and links must keep reading the same
   USDC addresses, RPCs and domains they read today.
   - Tested in Task 1: the profile's entries equal today's tables.
   - Tested by the existing CCTP, Gateway and receipt suites in Tasks 2 and 6.

## Conventions used by every task

- **Network ids against profiles.**
  - A *network id* is `Network` (`"arc-testnet" | "arc-mainnet"`). It goes where data crosses a boundary: props,
    records and stored facts.
  - A *profile* is `NetworkProfile`. It goes where server code needs chain facts.
  - `networkProfile(id)` turns one into the other.
- **Where each piece of code reads its network** (spec P1):
  - In a workspace's scope: `workspaceNetwork()`.
  - Holding an intent: `networkOf(intent.network)`.
  - Holding only a chain id: `networkOfChain(chain)`.
- **RPC:**
  - Server code asks `networkRpcUrl(profile)`, which honours `ARC_RPC_URL` on Arc testnet only.
  - A provider asks `rpcUrlFor(profile, chain.arcRpcUrl)`.
- **A feature the profile lacks:** `throw new FeatureOffError("<feature>", profile)`, which reads
  `"<feature> does not run on <label> yet"`. The feature names used:
  - `"Paying through CCTP"`
  - `"Paying through Gateway"`
  - `"The USYC reserve"`
  - `"The EURC swap"`
  - `"Buying services over x402"`
- **Tests** that need a profile import `ARC_TESTNET` / `ARC_MAINNET` from `@/lib/network`. Tests are outside both
  ratchets.

---

### Task 1: The profile holds every chain fact, and pure helpers read it

**Files:**
- Modify: `src/lib/network.ts`
- Modify: `src/lib/payee-chains.ts`
- Create: `src/lib/workspace-network.ts`
- Delete: `src/lib/current-network.ts`: no callers, and its Arc testnet default breaks P1.
- Modify: `src/lib/circle/arcFees.ts`
- Test: `tests/payee-chains-network.test.ts` (new) and `tests/network.test.ts`, whose two profile equality tests gain
  the new fields and whose `currentNetwork` test is removed.

**Interfaces:**
- Produces, in `src/lib/network.ts`:
  - `interface PayeeChainEntry { readonly id: string; readonly label: string; readonly domain: number | null; readonly usdc: string; readonly rpcUrl: string; readonly explorerTx: string; readonly nativeUsdc?: string }`
  - `NetworkProfile.payeeChains: readonly [PayeeChainEntry, ...PayeeChainEntry[]]`. The first entry is the network's
    own chain.
  - `NetworkProfile.cctp: { domain: number; iris: string; tokenMessenger: string } | null`
  - `NetworkProfile.gateway: { api: string; facilitator: string; wallet: string; minter: string } | null`
  - `NetworkProfile.swapAdapter: string | null`
  - `type PayeeChainId`: the union of both profiles' payee chain ids.
  - `class FeatureOffError extends Error { constructor(feature: string, network: NetworkProfile) }`, with the message
    `${feature} does not run on ${network.label} yet`.
- Produces, in `src/lib/payee-chains.ts`:
  - `chainsOn(network: Network): readonly PayeeChainEntry[]`
  - `homeChain(network: Network): PayeeChainEntry`
  - `chainOn(network: Network, value: string | null | undefined): PayeeChainEntry`, which throws
    `ChainNotOnNetworkError`
  - `networkOfChain(chain: string): Network`
  - `chainById(chain: string): PayeeChainEntry`
  - `txUrl(network: Network, hash: string): string`
  - `addressUrl(network: Network, address: string): string`
  - `class ChainNotOnNetworkError extends Error`
  - `paidAcrossChains(value)` keeps its signature. It becomes network-free: false for null and for every network's
    own chain, true for the others, and it throws for an unknown chain.
  - The old `PAYEE_CHAINS`, `PayeeChain`, `PAYEE_CHAIN_IDS`, `payeeChain`, `arcTxUrl` and `arcAddressUrl` stay until
    Task 8. `PAYEE_CHAINS` becomes `ARC_TESTNET.payeeChains`.
- Produces `workspaceNetwork(): NetworkProfile` in `src/lib/workspace-network.ts`.
- Produces, in `src/lib/circle/arcFees.ts`:
  - `rpcUrlFor(network: NetworkProfile, override: string | undefined): string`
  - `networkRpcUrl(network: NetworkProfile): string`

- [ ] **Step 1: Write the failing tests** (`tests/payee-chains-network.test.ts`)

```ts
import { ArcTestnet } from "@circle-fin/app-kit/chains";
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith, runWithConfig } from "@/lib/context";
import { networkRpcUrl, rpcUrlFor } from "@/lib/circle/arcFees";
import { ARC_MAINNET, ARC_TESTNET, FeatureOffError } from "@/lib/network";
import { addressUrl, chainById, ChainNotOnNetworkError, chainOn, chainsOn, homeChain, networkOfChain, paidAcrossChains, txUrl } from "@/lib/payee-chains";
import { workspaceNetwork } from "@/lib/workspace-network";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/** Every chain fact in its network's profile, and the helpers that read it (network threading P1–P3, P5, P6). */

const BASE = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("each network's payee chains (P3)", () => {
  it("lists Arc testnet's own chain, then the three Sepolia chains CCTP and Gateway pay, with today's facts", () => {
    expect(ARC_TESTNET.payeeChains).toEqual([
      { id: "ARC-TESTNET", label: "Arc testnet", domain: 26, usdc: "0x3600000000000000000000000000000000000000", rpcUrl: "https://rpc.testnet.arc.network", explorerTx: "https://explorer.testnet.arc.io/tx/", nativeUsdc: "0xfffffffffffffffffffffffffffffffffffffffe" },
      { id: "BASE-SEPOLIA", label: "Base Sepolia", domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpcUrl: "https://sepolia.base.org", explorerTx: "https://sepolia.basescan.org/tx/" },
      { id: "ARB-SEPOLIA", label: "Arbitrum Sepolia", domain: 3, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc", explorerTx: "https://sepolia.arbiscan.io/tx/" },
      { id: "ETH-SEPOLIA", label: "Ethereum Sepolia", domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorerTx: "https://sepolia.etherscan.io/tx/" },
    ]);
  });

  it("lists Arc mainnet's own chain alone, with no CCTP domain until it is verified there", () => {
    expect(ARC_MAINNET.payeeChains).toEqual([
      { id: "ARC", label: "Arc mainnet", domain: null, usdc: "0x3600000000000000000000000000000000000000", rpcUrl: "https://rpc.mainnet.arc.io", explorerTx: "https://explorer.arc.io/tx/" },
    ]);
  });

  it("keeps the swap's adapter equal to Circle's App Kit, since it is the spender the swap approves (Review Focus 4)", () => {
    expect(ARC_TESTNET.swapAdapter).toBe(ArcTestnet.kitContracts.adapter);
    expect(ARC_MAINNET.swapAdapter).toBeNull();
  });

  it("names a feature a network lacks", () => {
    expect(new FeatureOffError("Paying through CCTP", ARC_MAINNET).message).toBe("Paying through CCTP does not run on Arc mainnet yet");
  });
});

describe("a chain on a network (P3)", () => {
  it("reads no chain as the network's own, and a chain by its id (Review Focus 2)", () => {
    expect(homeChain("arc-testnet").id).toBe("ARC-TESTNET");
    expect(homeChain("arc-mainnet").id).toBe("ARC");
    expect(chainOn("arc-testnet", null)).toBe(ARC_TESTNET.payeeChains[0]);
    expect(chainOn("arc-mainnet", undefined)).toBe(ARC_MAINNET.payeeChains[0]);
    expect(chainOn("arc-testnet", "BASE-SEPOLIA").domain).toBe(6);
    expect(chainsOn("arc-mainnet").map((chain) => chain.id)).toEqual(["ARC"]);
  });

  it("refuses a chain from another network, or one no network lists, in plain words (Review Focus 3)", () => {
    expect(() => chainOn("arc-testnet", "ARC")).toThrow(ChainNotOnNetworkError);
    expect(() => chainOn("arc-testnet", "ARC")).toThrow("ARC is not a chain this workspace pays on");
    expect(() => chainOn("arc-mainnet", "ARB-SEPOLIA")).toThrow("ARB-SEPOLIA is not a chain this workspace pays on");
    expect(() => chainOn("arc-testnet", "SOL-DEVNET")).toThrow("SOL-DEVNET is not a chain this workspace pays on");
  });

  it("finds the network a chain is on, since each chain is on one network's list", () => {
    expect(networkOfChain("ARC-TESTNET")).toBe("arc-testnet");
    expect(networkOfChain("ETH-SEPOLIA")).toBe("arc-testnet");
    expect(networkOfChain("ARC")).toBe("arc-mainnet");
    expect(chainById("ARB-SEPOLIA").usdc).toBe("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d");
    expect(() => networkOfChain("SOL-DEVNET")).toThrow('"SOL-DEVNET" is not a chain Vestiarion knows');
  });

  it("pays each network's own chain directly and the others across chains", () => {
    expect(paidAcrossChains(null)).toBe(false);
    expect(paidAcrossChains("ARC-TESTNET")).toBe(false);
    expect(paidAcrossChains("ARC")).toBe(false);
    expect(paidAcrossChains("BASE-SEPOLIA")).toBe(true);
    expect(() => paidAcrossChains("SOL-DEVNET")).toThrow('"SOL-DEVNET" is not a chain Vestiarion knows');
  });
});

describe("a link names its network (P6)", () => {
  it("opens that network's explorer", () => {
    expect(txUrl("arc-testnet", "0xabc")).toBe("https://explorer.testnet.arc.io/tx/0xabc");
    expect(txUrl("arc-mainnet", "0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(addressUrl("arc-testnet", "0xdef")).toBe("https://explorer.testnet.arc.io/address/0xdef");
    expect(addressUrl("arc-mainnet", "0xdef")).toBe("https://explorer.arc.io/address/0xdef");
  });
});

describe("the workspace's network (P1)", () => {
  it("is the profile of the workspace in scope, Arc testnet for a row from before 0075", () => {
    const { client } = fakeSupabase();
    expect(runWith(orgTestContext({ config: { ...BASE, network: "arc-mainnet" }, client, orgId: "org-1" }), () => workspaceNetwork())).toBe(ARC_MAINNET);
    expect(runWith(orgTestContext({ config: BASE, client, orgId: "org-1" }), () => workspaceNetwork())).toBe(ARC_TESTNET);
  });

  it("throws outside a workspace's scope rather than assume Arc testnet", () => {
    expect(() => runWithConfig(BASE, () => workspaceNetwork())).toThrow();
  });
});

describe("a network's RPC (P2)", () => {
  it("lets ARC_RPC_URL replace Arc testnet's, and nothing replace another network's", () => {
    expect(rpcUrlFor(ARC_TESTNET, "https://keyed.example/rpc")).toBe("https://keyed.example/rpc");
    expect(rpcUrlFor(ARC_TESTNET, undefined)).toBe("https://rpc.testnet.arc.network");
    expect(rpcUrlFor(ARC_MAINNET, "https://keyed.example/rpc")).toBe("https://rpc.mainnet.arc.io");
    const keyed = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k", ARC_RPC_URL: "https://keyed.example/rpc" });
    expect(runWithConfig(keyed, () => networkRpcUrl(ARC_TESTNET))).toBe("https://keyed.example/rpc");
    expect(runWithConfig(keyed, () => networkRpcUrl(ARC_MAINNET))).toBe("https://rpc.mainnet.arc.io");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/payee-chains-network.test.ts`
Expected: FAIL. The imports `chainOn`, `workspaceNetwork`, `rpcUrlFor` and `FeatureOffError` do not exist.

- [ ] **Step 3: Implement**

`src/lib/network.ts`:
- Add `PayeeChainEntry`, the new profile fields, `PayeeChainId` and `FeatureOffError`.
- Testnet's `cctp` gains `tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"`.
- Testnet's `gateway` gains `wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"` and
  `minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B"`.
- `swapAdapter` is `"0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b"` on testnet and `null` on mainnet.
- `payeeChains` holds the values in the test above.
- The type of `PayeeChainId`:

```ts
export type PayeeChainId = (typeof ARC_TESTNET.payeeChains)[number]["id"] | (typeof ARC_MAINNET.payeeChains)[number]["id"];

/** A feature its network does not offer (network threading P5): it refuses by name, never falling back to another network's values. */
export class FeatureOffError extends Error {
  constructor(feature: string, network: NetworkProfile) {
    super(`${feature} does not run on ${network.label} yet`);
    this.name = "FeatureOffError";
  }
}
```

`src/lib/payee-chains.ts`, added beside the old exports (the old `paidAcrossChains` is replaced; `PAYEE_CHAINS` now
equals `ARC_TESTNET.payeeChains`):

```ts
const EVERY_CHAIN = NETWORK_IDS.flatMap((network) => networkProfile(network).payeeChains.map((chain) => ({ network, chain })));
const OWN_CHAINS = new Set(NETWORK_IDS.map((network) => networkProfile(network).payeeChains[0].id));

/** A chain a workspace's network does not pay on (network threading P3). */
export class ChainNotOnNetworkError extends Error {
  constructor(chain: string) {
    super(`${chain} is not a chain this workspace pays on`);
    this.name = "ChainNotOnNetworkError";
  }
}

/** The chains a workspace on `network` can pay a payee on: its own first, then those CCTP and Gateway reach. */
export function chainsOn(network: Network): readonly PayeeChainEntry[] {
  return networkProfile(network).payeeChains;
}

/** The chain a workspace on `network` pays directly: the network's own. */
export function homeChain(network: Network): PayeeChainEntry {
  return networkProfile(network).payeeChains[0];
}

/** A payee's chain on the workspace's network: none (a row from before 0044) is its own chain; a chain the network does not pay on is refused. */
export function chainOn(network: Network, value: string | null | undefined): PayeeChainEntry {
  if (value === null || value === undefined) return homeChain(network);
  const chain = chainsOn(network).find((entry) => entry.id === value);
  if (!chain) throw new ChainNotOnNetworkError(value);
  return chain;
}

/** The network a chain is on: each chain is on one network's list. */
export function networkOfChain(chain: string): Network {
  const found = EVERY_CHAIN.find((entry) => entry.chain.id === chain);
  if (!found) throw new Error(`"${chain}" is not a chain Vestiarion knows`);
  return found.network;
}

/** A chain's entry by its id alone, for a record that names its chain. */
export function chainById(chain: string): PayeeChainEntry {
  return chainOn(networkOfChain(chain), chain);
}

/** Whether a payee on this chain is paid across chains, through CCTP or Gateway, rather than on its network's own chain. */
export function paidAcrossChains(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  networkOfChain(value);
  return !OWN_CHAINS.has(value);
}

/** A transaction on a network's explorer. */
export function txUrl(network: Network, hash: string): string {
  return `${networkProfile(network).explorer}/tx/${hash}`;
}

/** A wallet or a contract on a network's explorer. */
export function addressUrl(network: Network, address: string): string {
  return `${networkProfile(network).explorer}/address/${address}`;
}
```

`src/lib/workspace-network.ts`:

```ts
import { currentOrgConfig } from "./context";
import { networkOf, networkProfile, type NetworkProfile } from "./network";

/**
 * The profile of the workspace in scope (docs/superpowers/specs/2026-10-05-network-threading-design.md P1): what
 * `orgConfig` read from its row. Outside a workspace's scope it throws, as `currentOrgConfig` does; code that holds a
 * record reads the record's network instead.
 */
export function workspaceNetwork(): NetworkProfile {
  return networkProfile(networkOf(currentOrgConfig().network));
}
```

`src/lib/circle/arcFees.ts` (`arcRpcUrl` stays until Task 8):

```ts
/** The RPC for a network's own chain (network threading P2): ARC_RPC_URL, a keyed endpoint, replaces Arc testnet's only. */
export function rpcUrlFor(network: NetworkProfile, override: string | undefined): string {
  return network.id === "arc-testnet" && override ? override : network.rpcUrl;
}

/** `rpcUrlFor` with the running configuration's ARC_RPC_URL. */
export function networkRpcUrl(network: NetworkProfile): string {
  return rpcUrlFor(network, currentConfig().chain.arcRpcUrl);
}
```

`tests/network.test.ts`:
- The two `toEqual` profile tests gain `payeeChains`, `cctp.tokenMessenger`, `gateway.wallet`/`minter` and
  `swapAdapter`, with the values above.
- The `currentNetwork` test is deleted, now that `workspaceNetwork` is covered in the new file.
- Delete `src/lib/current-network.ts`.

- [ ] **Step 4: Run the task's tests and the suites that read `paidAcrossChains`**

Run: `npx vitest run tests/payee-chains-network.test.ts tests/network.test.ts && npm run verify`
Expected: PASS.
- A failure is a test or a row that gives `paidAcrossChains` an unknown chain. Read it.
  - A fixture's typo is fixed in the fixture.
  - A real value Circle returns is added to the profile's list, never back to a quiet `false`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/network.ts src/lib/payee-chains.ts src/lib/workspace-network.ts src/lib/circle/arcFees.ts tests/payee-chains-network.test.ts tests/network.test.ts
git rm src/lib/current-network.ts
git commit -m "Give each network's profile its payee chains and contracts, with helpers that read a workspace's network"
```

---

### Task 2: Providers, fees, batches, CCTP and Gateway on one profile

**Files:**
- Modify:
  - `src/lib/circle/index.ts`
  - `src/lib/circle/liveProvider.ts`
  - `src/lib/circle/simulateProvider.ts`
  - `src/lib/circle/arcFees.ts`
  - `src/lib/circle/batch.ts`
  - `src/lib/circle/cctp.ts`
  - `src/lib/circle/gateway.ts`
  - `src/lib/circle/gateway-quote.ts`
- Callers changed by the new signatures:
  - `src/lib/agent/orchestrator.ts`: `irisBridgeFee` and `gatewayQuoter`
  - `src/lib/agent/approvals.ts`: `bridgeFee` and `gatewayQuoter`
- Tests:
  - every `new LiveProvider(` (66 sites in 9 files) and `new SimulateProvider(` (9 sites in 5 files);
  - `tests/cctp*.test.ts`, `tests/gateway*.test.ts` and `tests/batch*.test.ts` for the changed signatures;
  - new cases in `tests/network-providers.test.ts`.

**Interfaces:**
- Consumes (Task 1): `NetworkProfile`, `FeatureOffError`, `chainOn`, `homeChain`, `rpcUrlFor`.
- Produces:
  - `new LiveProvider(chain: ChainConfig, options: { network: NetworkProfile; client?: LiveProviderClient; fetch?: typeof fetch; bridgeMintWaitMs?: number; paymentsDisabled?: boolean | (() => Promise<boolean>) })`
  - `new SimulateProvider(network: NetworkProfile)`
  - `readonly network: NetworkProfile` on both providers and on the hybrid, which takes the live leg's
  - `fetchArcFeeUsd(txHash: string, options: { url: string; timeoutMs?: number })`: the URL is required
  - `batchCalls(transfers: BatchTransfer[], usdc: string)`
  - `cctpOf(network: NetworkProfile): { domain: number; iris: string; tokenMessenger: string }`, which throws
    `FeatureOffError("Paying through CCTP", network)`
  - `bridgeFee(network: NetworkProfile, chain: string, amount: number, options?: { fetch?: typeof fetch })`
  - `burnCalls(input: { amount: number; maxFeeUnits: bigint; domain: number; recipient: string; usdc: string; tokenMessenger: string })`
  - `forwardedMint(network: NetworkProfile, burnTxHash: string, options?: { fetch?: typeof fetch })`
  - `gatewayOf(network: NetworkProfile): { api: string; facilitator: string; wallet: string; minter: string }`, which
    throws `FeatureOffError("Paying through Gateway", network)`
  - Every Gateway function takes `network: NetworkProfile` first: `estimateGateway`, `gatewayBalance`,
    `submitGatewayTransfer`, `gatewayTransferStatus` and `burnIntent`. The rest of each signature is unchanged.
  - `gatewayQuoter(provider: ChainProvider, db: OrgDb)` reads `provider.network`.
  - `USDC_BY_CHAIN`, `GATEWAY_API`, `GATEWAY_WALLET`, `GATEWAY_MINTER`, `TOKEN_MESSENGER_V2` and `ARC_TESTNET_DOMAIN`
    are deleted. Readers use `chainOn(...).usdc`, `gatewayOf(...)` and `cctpOf(...)`.
  - `ARC_TESTNET_USDC` (cctp.ts) stays until Task 8 for the modules of Tasks 3 to 7.

- [ ] **Step 1: Write the failing tests** (`tests/network-providers.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { bridgeFee, burnCalls, cctpOf } from "@/lib/circle/cctp";
import { gatewayOf } from "@/lib/circle/gateway";
import { batchCalls } from "@/lib/circle/batch";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import { ARC_MAINNET, ARC_TESTNET } from "@/lib/network";

/** A provider and the Circle modules work on the profile they are given (network threading P2, P5). */

describe("the simulated provider", () => {
  it("settles on its network's own chain", async () => {
    expect((await new SimulateProvider(ARC_TESTNET).reconcileTransfer("sim-1")).chain).toBe("ARC-TESTNET");
    expect((await new SimulateProvider(ARC_MAINNET).reconcileTransfer("sim-1")).chain).toBe("ARC");
    expect(new SimulateProvider(ARC_MAINNET).network).toBe(ARC_MAINNET);
  });
});

describe("CCTP and Gateway read the profile", () => {
  it("give Arc testnet's facts, as before", () => {
    expect(cctpOf(ARC_TESTNET)).toEqual({ domain: 26, iris: "https://iris-api-sandbox.circle.com", tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" });
    expect(gatewayOf(ARC_TESTNET).wallet).toBe("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
  });

  it("refuse by name on a network without them, before any request", async () => {
    expect(() => cctpOf(ARC_MAINNET)).toThrow("Paying through CCTP does not run on Arc mainnet yet");
    expect(() => gatewayOf(ARC_MAINNET)).toThrow("Paying through Gateway does not run on Arc mainnet yet");
    const fetch = (() => { throw new Error("no request expected"); }) as unknown as typeof globalThis.fetch;
    await expect(bridgeFee(ARC_MAINNET, "BASE-SEPOLIA", 1, { fetch })).rejects.toThrow("Paying through CCTP does not run on Arc mainnet yet");
  });

  it("burn and batch with the USDC they are given", () => {
    const [approve] = burnCalls({ amount: 1, maxFeeUnits: 10n, domain: 6, recipient: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4", usdc: "0x3600000000000000000000000000000000000000", tokenMessenger: cctpOf(ARC_TESTNET).tokenMessenger });
    expect(approve.contractAddress).toBe("0x3600000000000000000000000000000000000000");
    expect(batchCalls([{ toAddress: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4", amount: 1 }], ARC_MAINNET.tokens.USDC)[0][0]).toBe(ARC_MAINNET.tokens.USDC);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/network-providers.test.ts`
Expected: FAIL. `cctpOf` and `gatewayOf` are missing, `SimulateProvider` takes no network, and `batchCalls` takes one
argument.

- [ ] **Step 3: Implement**

**Providers.**
- `SimulateProvider` gets `constructor(readonly network: NetworkProfile) {}`.
  - `reconcileTransfer` returns `chain: this.network.circleBlockchain`.
- `LiveProvider` keeps `readonly network = options.network`.
  - `this.rpcUrl = rpcUrlFor(this.network, chain.arcRpcUrl)` replaces `arcRpcUrl`, and every read passes it.
  - `spendingLimitPay` returns `chain: this.network.circleBlockchain`.
  - `bridge` and `gatewayPayout` call `chainOn(this.network.id, params.destinationChain)`.
  - `resolveFee(this.rpcUrl, ...)` → `fetchArcFeeUsd(txHash, { url })`.
  - USYC and the swap keep their reads until Task 3 and Task 4, but pass `this.rpcUrl`.
- `getChainProvider` (index.ts):
  - `const network = networkProfile(networkOf(config.network))`;
  - `new LiveProvider(config.chain, { network, paymentsDisabled })`;
  - `new SimulateProvider(network)` in both places.
  - `HybridProvider` gets `readonly network = live.network`.
- `ChainProvider` (types.ts) gains `readonly network: NetworkProfile`. Test fakes of `ChainProvider` add
  `network: ARC_TESTNET`.

**Fees.** `fetchArcFeeUsd`'s `options.url` is required, and its `arcRpcUrl()` fallback is removed.

**Batches.** `batchCalls(transfers, usdc)` uses `usdc` in place of `ARC_TESTNET_USDC`. `LiveProvider.batchTransfer`
passes `this.network.tokens.USDC`.

**CCTP.**
- `cctpOf` reads `network.cctp`, or throws.
- `bridgeFee(network, chain, amount, options)`:
  - `const target = chainOn(network.id, chain)`;
  - a target equal to `homeChain(network.id)` throws "A payee on <label> is not paid across chains";
  - Iris is `cctpOf(network).iris` with source domain `cctpOf(network).domain`.
- `forwardedMint(network, hash)` uses the same domain.
- `burnCalls` takes `usdc` and `tokenMessenger`. `LiveProvider.bridge` passes `this.network.tokens.USDC` and
  `cctpOf(this.network).tokenMessenger`.

**Gateway.**
- `gatewayOf` reads `network.gateway`, or throws.
- `transferSpec(network, payout)`:
  - `sourceDomain: cctpOf(network).domain`
  - `sourceContract: toBytes32(gatewayOf(network).wallet)`
  - `sourceToken: network.tokens.USDC`
  - `destinationToken: chainOn(network.id, payout.chain).usdc`
- `gatewayTransferStatus(network, id)` finds the destination among `chainsOn(network.id)` other than the home chain.
- `gatewayQuoter` reads `provider.network`.

**Callers.**
- `orchestrator.ts` builds `irisBridgeFee` as `(chain, amount) => bridgeFee(provider.network, chain, amount)`.
- `approvals.ts` does the same with `getChainProvider().network`.
- `tests/`:
  - `new LiveProvider(X, {` becomes `new LiveProvider(X, { network: ARC_TESTNET,`;
  - `new LiveProvider(X)` becomes `new LiveProvider(X, { network: ARC_TESTNET })`;
  - `new SimulateProvider()` becomes `new SimulateProvider(ARC_TESTNET)`;
  - CCTP and Gateway calls gain `ARC_TESTNET` first;
  - `USDC_BY_CHAIN[c]` becomes `chainById(c).usdc`.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/network-providers.test.ts && npm run verify`
Expected: PASS. Every testnet assertion is unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A src/lib/circle src/lib/agent/orchestrator.ts src/lib/agent/approvals.ts tests
git commit -m "Build each provider, and the CCTP, Gateway and batch calls, for one network's profile"
```

---

### Task 3: The reserve, Gateway funding, escrow and the spending limit on the workspace's network

**Files:**
- Modify:
  - `src/lib/circle/usyc.ts`
  - `src/lib/circle/liveProvider.ts`: its USYC calls
  - `src/lib/platform/usyc-reserve.ts`
  - `src/lib/agent/orchestrator.ts`: `usycSubscriptionsOpen`
  - `src/lib/circle/gateway-funding.ts`
  - `src/lib/circle/escrow-setup.ts`
  - `src/lib/circle/escrow-holds.ts`
  - `src/lib/circle/spending-limit-setup.ts`
  - `src/lib/spending-limit/onchain.ts`
- Tests: the existing suites for these modules, and new cases in `tests/network-providers.test.ts`.

**Interfaces:**
- Consumes (Tasks 1–2): `workspaceNetwork`, `networkRpcUrl`, `homeChain`, `FeatureOffError`, `gatewayOf`,
  `LiveProvider.network`.
- Produces:
  - `type UsycRead = { network: NetworkProfile; rpcUrl: string; fetch?: typeof fetch }`.
  - Every USYC function takes a required `read: UsycRead` in place of `options: UsycReadOptions = {}`:
    `readUsycPrice`, `readUsycApy`, `usycSubscriptionsOpen`, `readUsycShares` and `usycEntitlements`.
  - `usycOf(network: NetworkProfile)` throws `FeatureOffError("The USYC reserve", network)`.
  - `ARC_TESTNET_USYC`, `USYC_TELLER` and `USYC_ENTITLEMENTS` are deleted. Readers use `usycOf(...)`.
  - `readHold(escrow, id, options: { rpcUrl: string; fetch?: typeof fetch })`: `rpcUrl` is required.
  - `spending-limit/onchain.ts`'s default RPC is `networkRpcUrl(workspaceNetwork())`. Its `ARC_TESTNET_RPC_URL`
    fallback is removed.
  - Wallets are created with `blockchains: [workspaceNetwork().circleBlockchain]`.

- [ ] **Step 1: Write the failing tests** (added to `tests/network-providers.test.ts`)

```ts
import { readUsycPrice, usycOf } from "@/lib/circle/usyc";

describe("the USYC reserve reads the profile", () => {
  it("gives Arc testnet's contracts, and refuses on a network without a reserve before any request", async () => {
    expect(usycOf(ARC_TESTNET).teller).toBe("0x9fdF14c5B14173D74C08Af27AebFf39240dC105A");
    const fetch = (() => { throw new Error("no request expected"); }) as unknown as typeof globalThis.fetch;
    await expect(readUsycPrice({ network: ARC_MAINNET, rpcUrl: ARC_MAINNET.rpcUrl, fetch })).rejects.toThrow("The USYC reserve does not run on Arc mainnet yet");
  });
});
```

These wallet-creation cases are also added, in scope:
- `setUpEscrow` with a fake wallets client in a scope whose config says `network: "arc-mainnet"` and has fake
  credentials. The test builds that config directly, bypassing N3 the way phase 2 will.
  - Expected: Circle's `createWallets` is asked for `blockchains: ["ARC"]`, and the escrow is deployed with
    `blockchain: "ARC"`.
- `enforceSpendingLimit`, in the same way: the agent wallet is asked for on `"ARC"`.
- `fundGateway` on mainnet rejects with "Paying through Gateway does not run on Arc mainnet yet" before any Circle call.

Each case copies the fake client its module's existing suite builds (`tests/escrow-setup.test.ts`,
`tests/spending-limit-setup.test.ts`, `tests/gateway-funding.test.ts`) and asserts on the recorded request.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/network-providers.test.ts`
Expected: FAIL. `usycOf` is missing, and the wallets are asked for on `"ARC-TESTNET"`.

- [ ] **Step 3: Implement**

**USYC** (`usyc.ts`):
- `call(read, …)` uses `read.rpcUrl`.
- Each function reads `usycOf(read.network)` first, so it throws before fetching.
- `LiveProvider` passes `{ network: this.network, rpcUrl: this.rpcUrl, fetch: this.fetch }`.
- `orchestrator.ts` passes `{ network: provider.network, rpcUrl: networkRpcUrl(provider.network) }`.
- `usyc-reserve.ts` passes `{ network: workspaceNetwork(), rpcUrl: networkRpcUrl(workspaceNetwork()) }`.

**Gateway funding** (`gateway-funding.ts`):
- `const network = workspaceNetwork(); const gateway = gatewayOf(network);` at the top of `fundGateway`,
  `fundServiceBudget` and `readGatewayState`. `readGatewayState` answers `{ signerAddress, balanceUsdc: null }` when
  the network has no Gateway.
- `blockchains: [network.circleBlockchain]`.
- `GATEWAY_WALLET` becomes `gateway.wallet`, and `ARC_TESTNET_USDC` becomes `network.tokens.USDC`.

**Escrow setup** (`escrow-setup.ts`):
- `network.circleBlockchain` for `blockchains` and `blockchain`;
- `network.tokens.USDC` for the gas transfer and the constructor.

**Escrow holds** (`escrow-holds.ts`):
- the payee check is `(contractor.chain ?? homeChain(network.id).id) !== homeChain(network.id).id`;
- approve on `network.tokens.USDC`;
- `readHold` callers pass `rpcUrl: options.rpcUrl ?? networkRpcUrl(network)`.

**Spending limit** (`spending-limit-setup.ts`):
- the three `"ARC-TESTNET"`s become `network.circleBlockchain`;
- `ARC_TESTNET_USDC` becomes `network.tokens.USDC`.

**On-chain reads** (`spending-limit/onchain.ts`): `defaultRpcUrl()` returns `networkRpcUrl(workspaceNetwork())`, with no
catch.

**Tests** keep their assertions. Calls gain `{ network: ARC_TESTNET, rpcUrl: ARC_TESTNET.rpcUrl }` where they passed
`{}`.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/network-providers.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Read the reserve, Gateway funding, escrow and the spending limit from the workspace's network"
```

---

### Task 4: The EURC swap and quotes on the workspace's network

**Files:**
- Modify:
  - `src/lib/fx/quote.ts`
  - `src/lib/fx/swap.ts`
  - `src/lib/fx/swap-service.ts`
  - `src/lib/fx/eurc-balance.ts`
  - `src/lib/fx/probe.ts`
  - `src/lib/agent/fx-watch.ts`
  - `src/lib/agent/orchestrator.ts`: `swapDeps`, the quotes and `onceQuotes`
  - `src/app/actions/treasury.ts`: `operatingEurcBalance`
- Tests: the existing FX suites, and new cases in `tests/network-providers.test.ts`.

**Interfaces:**
- Produces:
  - `quoteEurcInUsdc(amountEurc: number, options: { network: NetworkProfile; fromAddress: string; now?: number; fetch?: typeof fetch; retryDelayMs?: number; once?: boolean })`
  - `AskOptions` gains `network: NetworkProfile`.
  - `quoteUsdcForEurc` and `createSwapTransaction` read `network.stablecoinServiceChain`, `network.tokens` and
    `network.swapAdapter`. They throw `FeatureOffError("The EURC swap", network)` when either is null.
  - `SwapDeps` gains `network: NetworkProfile`. The optional `rpcUrl` stays as an override; its default is
    `networkRpcUrl(deps.network)`.
  - `readEurcBalance(address, options: { network: NetworkProfile; rpcUrl?: string; fetch?: typeof fetch })`
  - `operatingEurcBalance()` reads `workspaceNetwork()`.
  - `onceQuotes(input: { network: NetworkProfile; operatingAddress: string | null; canSwap: boolean; apiKey: string | null })`
  - `ADAPTER`, `ARC_TESTNET_EURC`, `ARC_TESTNET_USDC` (quote.ts) and `STABLECOIN_SERVICE_CHAIN` are deleted.
  - The quote cache's key becomes `${network.id}:${amount}`.

- [ ] **Step 1: Write the failing test**

```ts
import { quoteUsdcForEurc } from "@/lib/fx/swap-service";

describe("the EURC swap reads the profile", () => {
  it("refuses by name on a network without the Stablecoin Service, before any request", async () => {
    const fetch = (() => { throw new Error("no request expected"); }) as unknown as typeof globalThis.fetch;
    await expect(quoteUsdcForEurc(1, { network: ARC_MAINNET, apiKey: "k", fromAddress: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4", fetch })).rejects.toThrow("The EURC swap does not run on Arc mainnet yet");
  });
});
```

The `AskOptions` fields other than `network`, `apiKey`, `fromAddress` and `fetch` keep their defaults. The executor
checks the field names against `AskOptions` at `swap-service.ts:114-122` and matches them exactly.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/network-providers.test.ts`
Expected: FAIL. `network` is not an `AskOptions` field, and the quote asks the service.

- [ ] **Step 3: Implement**

**Network facts.**
- Each `ARC_TESTNET_EURC`, `ARC_TESTNET_USDC` and `STABLECOIN_SERVICE_CHAIN` use becomes the `network` it was given.
- `swap-service.ts` drops its `@circle-fin/app-kit/chains` import, and `adapter: network.swapAdapter`.

**Swap** (`swap.ts`): `eurcReceivedIn` reads `deps.rpcUrl ?? networkRpcUrl(deps.network)` and
`deps.network.tokens.EURC`.

**Orchestrator.**
- `swapDeps` adds `network: provider.network`.
- The quote calls pass `network: provider.network`.
- `onceQuotes({ network: provider.network, … })`.

**FX watch** (`fx-watch.ts`): `workspaceQuotes` passes `network: workspaceNetwork()`.

**Treasury action** (`treasury.ts`): `operatingEurcBalance` is unchanged at its call site, since it reads the scope
itself.

**Tests** pass `network: ARC_TESTNET` where they called these functions.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/network-providers.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Quote and swap EURC on the workspace's network, refusing where the Stablecoin Service does not run"
```

---

### Task 5: The agent's payments and purchases on the workspace's network

**Files:**
- Modify:
  - `src/lib/agent/orchestrator.ts`: `decideApPayable`, `runApStage` and `releaseMilestone`'s chain checks
  - `src/lib/agent/approvals.ts`
  - `src/lib/agent/receipts.ts`
  - `src/lib/agent/services.ts`
  - `src/lib/payments.ts`: types only
  - `src/lib/commands/chat-decisions.ts`
- Tests: the existing agent suites, and new cases in `tests/network-providers.test.ts`.

**Interfaces:**
- Produces:
  - `decideApPayable` reads `paidAcrossChains(counterparty.chain)` in place of
    `payeeChain(...).id !== "ARC-TESTNET"`, and `chainOn(provider.network.id, counterparty.chain)` for the label and
    domain.
  - `runApStage` likewise at line 2201.
  - `WaitingPayable.payeeChain` stays a chain id, filled with `chainOn(network.id, chain).id`.
  - `payoutRecord` reads `chainOn(network.id, chain).domain`.
  - `recordIncomingTransfers` writes `chain: provider.network.circleBlockchain`.
  - `buyPayeeHistories` returns `{ bought: [], skipped: "Buying services over x402 does not run on <label> yet" }`
    when `workspaceNetwork().gateway === null`. The executor matches the field names of its existing result type and
    leaves a ledger-free skip.

- [ ] **Step 1: Write the failing tests**

```ts
import { recordIncomingTransfers } from "@/lib/agent/receipts";
```

- **`recordIncomingTransfers`, with a mainnet simulated provider** and one inbound transfer. It copies
  `tests/receipts-stage.test.ts`'s fake `OrgDb` and provider, with `new SimulateProvider(ARC_MAINNET)` and a stubbed
  `listInboundTransfers`.
  - Expected: the inserted `incoming_transfers` row has `chain: "ARC"`.
- **`buyPayeeHistories`, in a mainnet scope.** Expected: it buys nothing, and its result names "Buying services over
  x402 does not run on Arc mainnet yet". No request leaves: its `fetch` throws if called.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/network-providers.test.ts`
Expected: FAIL. The row says `"ARC-TESTNET"`, and the purchase reaches Gateway.

- [ ] **Step 3: Implement**

**Agent** (`orchestrator.ts`, `approvals.ts`):
- Each remaining `payeeChain(x)` becomes `chainOn(network.id, x)`.
  - In the cycle and the provider, `network` is `provider.network`.
  - In approvals, it is `getChainProvider().network`.
- Each `!== "ARC-TESTNET"` becomes `paidAcrossChains(x)`.

**Incoming transfers** (`receipts.ts`): `chain: provider.network.circleBlockchain`.

**Purchases** (`services.ts`): the early return described above sits before `gatewayBalance`.

**Chat decisions** (`chat-decisions.ts`): no change; `paidAcrossChains` keeps its signature.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/network-providers.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Decide, record and buy on the workspace's network in the agent's cycle"
```

---

### Task 6: Records carry their network: intents, notices, comments, chat messages, activity and receipts

**Files:**
- Modify:
  - `src/lib/payments.ts`: `PaymentIntent.network` and `PaymentIntentRow.network`, mapped in `fromRow`
  - `src/lib/payment-notices.ts`
  - `src/lib/github/payment-comments.ts`
  - `src/lib/agent-activity.ts`: `ActivityItem.txUrl`
  - `src/lib/slack/blocks.ts`
  - `src/lib/telegram/messages.ts`
  - `src/components/AgentActivity.tsx`
  - `src/lib/receipts/facts.ts`
  - `src/lib/receipts/onchain.ts`
  - `src/lib/receipts/share.ts`
  - `src/lib/platform/receipts.ts`
  - `src/components/receipt/ReceiptView.tsx`
- Tests: the existing suites for each, and new cases in `tests/network-records.test.ts`.

**Interfaces:**
- Produces:
  - `PaymentIntent.network: Network`, from `networkOf(row.network)`.
  - The explicit selects add `network`: `payment-notices.ts:87`, `github/payment-comments.ts:82`,
    `receipts/share.ts` `INTENT_COLUMNS`, `orchestrator.ts:678, :704` and `approvals.ts:488`.
  - Notices and comments keep an intent when `intent.chain ?? homeChain(net).id` equals `homeChain(net).id`, with
    `net = networkOf(intent.network)`. Its link is `txUrl(net, hash)`.
  - `pullRequestCommentBody` input gains `network: Network`.
  - `ActivityItem` gains `txUrl: string | null`, built in scope with `txUrl(workspaceNetwork().id, hash)`.
    Slack, Telegram and `AgentActivity` use `item.txUrl` and never build a link themselves.
  - `ReceiptIntent` gains `network: string | null`.
  - `buildReceipt` uses `homeChain(networkOf(intent.network)).id` where it said `"ARC-TESTNET"`.
  - `receiptSummary` reads `chainById(facts.chain).label`.
  - `readOnChain`, `receiptRpcUrl` and `tokenContracts` read `chainById(facts.chain)`: `rpcUrl`, `usdc` and
    `nativeUsdc`.
    - EURC is read on the chain's network's own chain only, through `networkProfile(networkOfChain(c)).tokens.EURC`.
    - `PUBLIC_RPC` and `ARC_NATIVE_USDC` are deleted.
  - `ReceiptView` links the source transaction with `homeChain(networkOfChain(facts.chain)).explorerTx`, and labels
    with `chainById`.

- [ ] **Step 1: Write the failing tests** (`tests/network-records.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { buildReceipt, receiptSummary } from "@/lib/receipts/facts";
import { readOnChain } from "@/lib/receipts/onchain";
import { pullRequestCommentBody } from "@/lib/github/payment-comments";

/** A record reads the network it carries (network threading P1, P6), with no scope. */

const intent = (over: Record<string, unknown> = {}) => ({
  status: "confirmed", provider_mode: "live", token: "USDC", amount: 1, destination: "0x840de234Bfc3F66fA380888A0a8204D9487D60d4",
  tx_hash: `0x${"ab".repeat(32)}`, chain: null, destination_chain: null, mint_tx_hash: null, bridge_fee: null, payout_route: null,
  confirmed_at: "2026-10-05T14:25:34Z", network: null, ...over,
});

describe("a receipt", () => {
  it("is on Arc testnet's own chain for an intent from before 0075 (Review Focus 2)", () => {
    const built = buildReceipt({ invoice: { id: "inv-1", status: "paid", direction: "ap" }, intent: intent() as never, entries: [] });
    expect(built.facts?.chain).toBe("ARC-TESTNET");
  });

  it("is on Arc mainnet's own chain for a mainnet intent, read on mainnet's RPC with no scope", async () => {
    const built = buildReceipt({ invoice: { id: "inv-1", status: "paid", direction: "ap" }, intent: intent({ network: "arc-mainnet" }) as never, entries: [] });
    expect(built.facts?.chain).toBe("ARC");
    expect(receiptSummary(built.facts!)).toContain("Arc mainnet");
    const asked: string[] = [];
    const fetch = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null })); }) as unknown as typeof globalThis.fetch;
    await readOnChain(built.facts!, { fetch });
    expect(asked[0]).toBe("https://rpc.mainnet.arc.io");
  });
});

describe("a payment's comment", () => {
  it("links the explorer of the intent's network", () => {
    expect(pullRequestCommentBody({ amount: "1.00", token: "USDC", orgName: "Acme", txHash: "0xabc", origin: "https://www.vestiarion.xyz", network: "arc-mainnet" })).toContain("https://explorer.arc.io/tx/0xabc");
    expect(pullRequestCommentBody({ amount: "1.00", token: "USDC", orgName: "Acme", txHash: "0xabc", origin: "https://www.vestiarion.xyz", network: "arc-testnet" })).toContain("https://explorer.testnet.arc.io/tx/0xabc");
  });
});
```

The executor checks `BuiltReceipt`'s shape at `receipts/facts.ts:56` (whether `facts` is nullable) and adjusts the two
`built.facts` reads to match, keeping the assertions.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/network-records.test.ts`
Expected: FAIL. The mainnet receipt says `"ARC-TESTNET"`, the RPC is testnet's, and `network` is not a comment input.

- [ ] **Step 3: Implement**

Make the changes listed under Interfaces.
- `sendPaymentNotices` and `sendPullRequestComments` keep reading in scope, but build links from the intent's network,
  never `workspaceNetwork()`: the same code serves a record after a network's scope.
- `agent-activity.ts`'s `arcTx()` stays a hash check, and `txUrl` is added beside each `txHash`.
- Tests add `network: null` to intent rows they build, where a type requires it.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/network-records.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Read a payment's network from its record for receipts, notices, comments and chat links"
```

---

### Task 7: Workspaces, payee flows and the pages' links on the workspace's network

**Files:**
- Modify:
  - `src/lib/intake-validation.ts`
  - `src/components/intake/CounterpartyIntake.tsx` and its pages (`app/o/[slug]/counterparties/page.tsx`, design,
    docs-shots)
  - `src/app/api/v1/counterparties/route.ts`
  - `src/lib/pay-freelancer.ts`
  - `src/lib/github/bounties.ts`
  - `src/lib/platform/payee-links.ts`
  - `src/components/payee/PayeeJourney.tsx`
  - `src/app/o/[slug]/contractors/page.tsx`
  - `src/lib/platform/workspace.ts`
  - `src/lib/sample-data.ts`
  - `src/components/vx/types.ts`, `src/components/vx/map.ts`, `src/lib/decision-trail.ts`,
    `src/components/vx/DecisionCard.tsx` and `src/components/vx/DecisionTrail.tsx`, with the builders' callers
    (console, invoices, contractors, docs-shots, design)
  - `src/components/AgentBudgetPanel.tsx`, `EscrowPanel.tsx` and `MilestoneEscrow.tsx`, with their pages
  - `src/components/CounterpartyRow.tsx`, `ApprovalCard.tsx` and `open/OurPayments.tsx`
  - `src/components/wallet/PasskeyWallet.tsx`
- Tests: the existing suites, and new cases in `tests/network-records.test.ts`.

**Interfaces:**
- Produces:
  - **Intake schema.**
    - `payeeChainSchema` accepts every network's payee chain ids:
      `z.enum(NETWORK_IDS.flatMap((n) => networkProfile(n).payeeChains.map((c) => c.id)))`.
    - Its superRefine is "a chain other than a network's own is for vendors only", with `paidAcrossChains`.
    - Its message is unchanged.
  - **`counterpartyChainProblem(network: Network, chain: string | null | undefined): string | null`.** It is new in
    `intake-validation.ts`.
    - The plain refusal from `ChainNotOnNetworkError`, or null.
    - Called in scope by `createCounterpartyAction`, the API POST (inside its `withOrg`) and `bounties.attach` before
      writing. A refusal reaches the person as their form's error, and the API as `400 invalid_request`, the shape its
      other field errors use.
  - **The API route.**
    - `chain: shape.data.chain ?? homeChain(workspaceNetwork().id).id`, set inside the scope.
    - The OpenAPI enum and description are unchanged.
  - **Payee flows.**
    - `pay-freelancer`, `bounties.attach`, `workspace.ts`'s simulated accounts and `sample-data` write
      `homeChain(workspaceNetwork().id).id`.
    - `previewPayeeLink`'s default is the home chain of `networkOfChain(...)` of the RPC's answer. Until the RPC
      answers, it is `null`, not `"ARC-TESTNET"`.
    - `PayeeJourney`:
      - `const network = networkOfChain(status.chain)`;
      - `onArc = !paidAcrossChains(status.chain)`;
      - the explorer is `homeChain(network).explorerTx`.
    - The contractors page's `lockable` compares with `homeChain(network.id).id`, where `network` is
      `workspaceNetwork()` read inside `inOrg`.
  - **Decisions.**
    - `Decision` gains `network: Network`. `invoiceDecision`, `milestoneDecision`, `treasuryActionDecision` and
      `receivableDecision` take it in their options, and return it.
    - `TrailStep` links are built with `txUrl(decision.network, hash)` in `DecisionCard` and `DecisionTrail`. Both get
      it from the decision, so no new prop crosses `Shell`.
  - **Client panels.** `AgentBudgetPanel`, `EscrowPanel` and `MilestoneEscrow` take `network: Network`, passed by their
    pages from `workspaceNetwork().id` inside `inOrg`.
  - **Labels.**
    - `CounterpartyRow` takes `network: Network` and reads `chainOn(network, counterparty.chain).label`.
    - `ApprovalCard` reads `chainById(payable.payeeChain).label`.
  - **`OurPayments`** reads `chainById(payment.chain).explorerTx` for a payment across chains.
  - **`PasskeyWallet`** uses `txUrl(PASSKEY_WALLET_NETWORK.id, …)` and `addressUrl(…)`, P7's testnet-only page.

- [ ] **Step 1: Write the failing tests** (added to `tests/network-records.test.ts`)

```ts
import { counterpartyChainProblem } from "@/lib/intake-validation";

describe("a counterparty's chain on its workspace's network (Review Focus 3)", () => {
  it("is refused in plain words when it is another network's", () => {
    expect(counterpartyChainProblem("arc-testnet", "ARC")).toBe("ARC is not a chain this workspace pays on");
    expect(counterpartyChainProblem("arc-mainnet", "BASE-SEPOLIA")).toBe("BASE-SEPOLIA is not a chain this workspace pays on");
    expect(counterpartyChainProblem("arc-testnet", "BASE-SEPOLIA")).toBeNull();
    expect(counterpartyChainProblem("arc-mainnet", null)).toBeNull();
  });
});
```

Two cases render with `renderToStaticMarkup`, copying the existing suites' status and decision fixtures:
- **`PayeeJourney`** with a paid status whose chain is `"ARC"`. Expected: its transaction link starts with
  `https://explorer.arc.io/tx/`.
  - The fixture is the one in `tests/payee-passkey-option.test.tsx`, with `chain: "ARC"`, `linkState: "used"` and one
    paid payment.
- **`DecisionCard`** for an `invoiceDecision(…, { network: "arc-mainnet" })` with a paid entry. Expected: its link is
  `https://explorer.arc.io/tx/…`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/network-records.test.ts`
Expected: FAIL. `counterpartyChainProblem` is missing, and the links are testnet's.

- [ ] **Step 3: Implement**

Make the changes listed under Interfaces.
- The pages read `workspaceNetwork()` once, inside their `inOrg` callback, and pass `network.id` down.
- Fixtures in `src/app/design/fixtures.ts` and `src/app/docs-shots/shots.tsx` pass `network: "arc-testnet"` (P7).

- [ ] **Step 4: Run**

Run: `npx vitest run tests/network-records.test.ts && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "Write each workspace's own chain, and build each page's links for the workspace's network"
```

---

### Task 8: Delete the testnet constants, tighten both ratchets, run the mainnet dry run, and update the docs

**Files:**
- Modify:
  - `src/lib/payee-chains.ts`: delete `PAYEE_CHAINS`, `PayeeChain`, `PAYEE_CHAIN_IDS`, `payeeChain`, `arcTxUrl` and
    `arcAddressUrl`. Add `TESTNET_PAYEE_CHAIN_IDS` for the API schema (P7).
  - `src/lib/circle/cctp.ts`: delete `ARC_TESTNET_USDC`.
  - `src/lib/circle/arcFees.ts`: delete `ARC_TESTNET_RPC_URL`, `ARC_TESTNET_CHAIN_ID` and `arcRpcUrl`.
  - `src/lib/fx/quote.ts`: anything left from Task 4.
  - `src/lib/x402/offer.ts`: reads `ARC_TESTNET.tokens.USDC` and `ARC_TESTNET.gateway.wallet` directly, as the
    platform's own testnet offer (P7).
  - `src/lib/api/schemas.ts`: `z.enum(TESTNET_PAYEE_CHAIN_IDS)`. The OpenAPI document is unchanged.
  - `tests/network-ratchet.test.ts`
  - `ARCHITECTURE.md`
  - the spec's status line
- Create:
  - `tests/network-constants-ratchet.test.ts`
  - `tests/network-mainnet-dry-run.test.ts`
- Tests: every test still importing a deleted name reads the profile:

| Deleted name | Replacement |
|---|---|
| `ARC_TESTNET_USDC` | `ARC_TESTNET.tokens.USDC` |
| `ARC_TESTNET_EURC` | `ARC_TESTNET.tokens.EURC` |
| `ARC_TESTNET_RPC_URL` | `ARC_TESTNET.rpcUrl` |
| `ARC_TESTNET_DOMAIN` | `ARC_TESTNET.cctp.domain` |
| `ARC_TESTNET_USYC` | `ARC_TESTNET.usyc.token` |
| `ARC_TESTNET_CHAIN_ID` | `ARC_TESTNET.chainId` |
| `PAYEE_CHAINS` | `ARC_TESTNET.payeeChains` |
| `arcTxUrl(h)` | `txUrl("arc-testnet", h)` |
| `arcAddressUrl(a)` | `addressUrl("arc-testnet", a)` |

**Interfaces:**
- Consumes: everything above.
- Produces: the final allowed lists.

- [ ] **Step 1: Write the ratchets and the dry run**

`tests/network-constants-ratchet.test.ts` follows `tests/network-ratchet.test.ts`'s walk and comment stripping.
- The identifier is
  `/\bARC_TESTNET\b|\bARC_TESTNET_[A-Z_]+\b|\bARC_NATIVE_USDC\b|\bUSDC_BY_CHAIN\b|\bPAYEE_CHAINS\b|\bPASSKEY_WALLET_NETWORK\b/g`.
- It skips `src/lib/network.ts`.
- Its allowed files, with their reasons:

```ts
/** Files that read the testnet profile on purpose (network threading P7), and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "src/app/open/page.tsx": { count: 3, why: "/open shows both networks by design" },
  "src/lib/x402/offer.ts": { count: 4, why: "the platform's own x402 service sells on Arc testnet" },
  "src/lib/passkey-wallet.ts": { count: 4, why: "Modular Wallets run on Arc testnet only; /wallet is that network's" },
  "src/lib/passkey-wallet-send.ts": { count: 2, why: "the passkey wallet's sends, on Arc testnet" },
  "src/lib/passkey-wallet-sdk.ts": { count: 5, why: "the passkey wallet's chain for viem, Arc testnet" },
  "src/components/wallet/PasskeyWallet.tsx": { count: 3, why: "the passkey wallet page, Arc testnet" },
  "src/lib/payee-chains.ts": { count: 1, why: "TESTNET_PAYEE_CHAIN_IDS, the public API's enum until phase 2" },
};
```

- The counts are written from the run in Step 2, and each must be at most what the table above names.
- A file not in the table fails the test.

`tests/network-ratchet.test.ts`'s `ALLOWED` falls to the P7 data files. Its counts are written from the run:
- `src/lib/seed.ts`
- `src/app/design/fixtures.ts`
- `src/app/docs-shots/shots.tsx`
- `src/lib/api/schemas.ts`, for its description's `` `ARC-TESTNET` ``

Each line gains a `// why` comment.

`tests/network-mainnet-dry-run.test.ts` is one file collecting the mainnet cases from Tasks 2–7 as imports of their
helpers. It adds the ones not yet covered:
- `networkRpcUrl(ARC_MAINNET)` is `https://rpc.mainnet.arc.io`;
- `chainsOn("arc-mainnet")` refuses every Sepolia chain;
- `passkeyWalletOffered("ARC", config)` is false;
- a mainnet `SimulateProvider`'s transfer settles on `"ARC"`.

- [ ] **Step 2: Delete the constants, and replace each test import using the table above**

Run: `npx vitest run tests/network-ratchet.test.ts tests/network-constants-ratchet.test.ts tests/network-mainnet-dry-run.test.ts`
Expected: the dry run passes. The ratchets fail only on their counts. Write the counts, and confirm each file is P7's.

- [ ] **Step 3: Update the docs**
- `ARCHITECTURE.md`: in the section that describes the network profile (added by #207), add a paragraph on
  - where each module reads its network (P1);
  - the provider built for one profile (P2);
  - the home chain and payee chains (P3);
  - features off by name (P5);
  - the two ratchets (P8).
- The spec's status reads "implemented on `feat/network-circle-modules`".

- [ ] **Step 4: Run the whole gate**

Run: `npm run verify && npm run build`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add -A src tests ARCHITECTURE.md docs/superpowers/specs/2026-10-05-network-threading-design.md
git commit -m "Delete the testnet constants and keep the profile as the one source of chain facts"
```
