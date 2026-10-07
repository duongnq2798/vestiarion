import crypto from "node:crypto";
import { afterEach, beforeEach, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, type Hex, encodeEventTopics, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { CircleClientFactory } from "@/lib/circle/check";
import { SPENDING_LIMIT_ABI } from "@/lib/spending-limit/onchain";
import type { TreasuryChain, TreasuryReceipt } from "@/lib/treasury/chain";
import { deploymentData, walletProofMessage } from "@/lib/treasury/verify";
import { ARC_MAINNET } from "@/lib/network";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./fake-supabase";

/**
 * The world a wallet treasury is set up in, for tests (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md):
 * one workspace on Arc mainnet, its rows behind a fake PostgREST, a fake Circle that creates the agent wallet, and a
 * fake chain. Call sealLedgerKeysPerTest() in a test file, since the ledger signs with a sealed key.
 */

export const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-0000000000c1";
export const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
export const OWNER_EMAIL = "owner@example.com";
export const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const WALLET = OWNER.address;
export const AGENT = getAddress("0x5af3107a4000000000000000000000000000a9e7");
export const CONTRACT = getAddress("0x5af3107a4000000000000000000000000000e5c0");
export const SECOND_CONTRACT = getAddress("0x5af3107a4000000000000000000000000000e5c1");
export const USDC = getAddress(ARC_MAINNET.tokens.USDC);
export const DEPLOY_TX = `0x${"d1".repeat(32)}` as Hex;
export const REDEPLOY_TX = `0x${"d2".repeat(32)}` as Hex;
export const APPROVE_TX = `0x${"a1".repeat(32)}` as Hex;
export const NOW = Date.parse("2026-10-07T10:00:00Z");
export const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
export const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export const platform = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  MAINNET_ENABLED: "1",
  MAINNET_ALLOWLIST: OWNER_EMAIL,
  MAINNET_AGENT_CIRCLE_API_KEY: "LIVE_API_KEY:agent-id:agent-secret",
  MAINNET_AGENT_CIRCLE_ENTITY_SECRET: "a9e7".repeat(16),
});

/** Seals the ledger key with MASTER_KEYS for each test of the file that calls it, and restores the environment after. */
export function sealLedgerKeysPerTest(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.VESTIARION_MASTER_KEYS;
    process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.VESTIARION_MASTER_KEYS;
    else process.env.VESTIARION_MASTER_KEYS = saved;
  });
}

export type Row = Record<string, unknown>;
export interface World {
  org: Row;
  operating: Row;
  contract: Row | null;
  budget: Row | null;
  ledger: Array<{ action: string; detail: Record<string, unknown> }>;
}

export function world(overrides: { org?: Row; operating?: Row; contract?: Row | null; budget?: Row | null } = {}): World {
  return {
    org: {
      id: ORG,
      slug: "own-wallet-co",
      name: "Own Wallet Co",
      mode: "sandbox",
      network: "arc-mainnet",
      wallet_host: null,
      circle_api_key_enc: null,
      circle_entity_secret_enc: null,
      ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
      ledger_retired_keys: [],
      usyc_live_at: null,
      ...overrides.org,
    },
    operating: { id: "acct-op", name: "Operating", kind: "operating", address: null, circle_wallet_id: null, balance: "0", ...overrides.operating },
    contract: overrides.contract === undefined ? null : overrides.contract,
    budget: overrides.budget === undefined ? { daily_usdc: "50", weekly_usdc: "150" } : overrides.budget,
    ledger: [],
  };
}

/** Whether a row passes PostgREST's filters as supabase-js writes them: eq., is.null, and or=(…). */
export function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    // The scope adds org_id to every tenant request; these rows are all this workspace's.
    if (["select", "order", "limit", "on_conflict", "columns", "org_id"].includes(key)) continue;
    if (key === "or") {
      const alternatives = value.replace(/^\(|\)$/g, "").split(",");
      if (!alternatives.some((alternative) => matches(row, new URLSearchParams([[alternative.split(".")[0], alternative.split(".").slice(1).join(".")]])))) return false;
      continue;
    }
    // A JSON field (`detail->>txHash`) is read from its column's object.
    const [column, field] = key.split("->>");
    const cell = field === undefined ? row[column] : (row[column] as Row | undefined)?.[field];
    if (value === "is.null" && cell !== null && cell !== undefined) return false;
    if (value.startsWith("eq.") && String(cell) !== value.slice(3)) return false;
    if (value.startsWith("in.(") && !value.slice(4, -1).split(",").includes(String(cell))) return false;
  }
  return true;
}

export function database(state: World) {
  const one = (request: RecordedRequest, rows: Row[]): FakeReply => {
    const single = request.headers.get("accept")?.includes("vnd.pgrst.object");
    return single ? { body: rows[0] ?? null, ...(rows[0] ? {} : { status: 406 }) } : { body: rows };
  };
  const fake = fakeSupabase((request): FakeReply => {
    const { path, method, params } = request;
    if (path === "/rest/v1/orgs" && method === "GET") {
      const org = { ...state.org, api_key_stored: state.org.circle_api_key_enc ? "t1" : null };
      return one(request, [org]);
    }
    if (path === "/rest/v1/orgs" && method === "PATCH") {
      if (!matches(state.org, params)) return { body: [] };
      Object.assign(state.org, request.body);
      return { body: [{ id: ORG }] };
    }
    if (path === "/rest/v1/accounts" && method === "GET") return one(request, [state.operating]);
    if (path === "/rest/v1/accounts" && method === "PATCH") {
      if (!matches(state.operating, params)) return { body: [] };
      Object.assign(state.operating, request.body);
      return { body: [{ id: state.operating.id }] };
    }
    if (path === "/rest/v1/spending_limit_contracts" && method === "GET") {
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("vnd.pgrst.object")) return state.contract ? { body: state.contract } : { status: 406, body: { code: "PGRST116", message: "no rows" } };
      return { body: state.contract ? [state.contract] : [] };
    }
    if (path === "/rest/v1/spending_limit_contracts" && method === "POST") {
      state.contract = {
        id: "slc-1",
        address: null,
        deploy_tx_hash: null,
        approve_tx_id: null,
        approve_tx_hash: null,
        enforced: false,
        // The columns' defaults (0083).
        treasury_signer: "wallet",
        recovery_address: null,
        recovery_skipped_at: null,
        ...(request.body as Row),
      };
      return one(request, [state.contract]);
    }
    if (path === "/rest/v1/spending_limit_contracts" && method === "PATCH") {
      if (!state.contract || !matches(state.contract, params)) return { body: [] };
      Object.assign(state.contract, request.body);
      return { body: [{ id: state.contract.id }] };
    }
    if (path === "/rest/v1/agent_budgets" && method === "GET") return { body: state.budget ? [state.budget] : [] };
    if (path === "/rest/v1/agent_budgets" && method === "POST") {
      state.budget = { ...(request.body as Row) };
      return { body: [] };
    }
    // A control is looked up by its transaction (treasury wallet controls C4); every other read of the ledger finds nothing.
    if (path === "/rest/v1/ledger_entries" && method === "GET" && params.has("detail->>txHash")) {
      return { body: state.ledger.filter((entry) => matches(entry, params)).map((entry, index) => ({ seq: index + 1, ...entry })) };
    }
    if (path === "/rest/v1/ledger_entries") return { body: [] };
    if (path === "/rest/v1/rpc/append_ledger_entry") {
      const body = request.body as { p_action: string; p_detail: Record<string, unknown> };
      state.ledger.push({ action: body.p_action, detail: body.p_detail });
      return {
        body: { seq: 1, id: "e1", ts: "2026-10-07T00:00:00Z", actor: "human", domain: "system", action: body.p_action, summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null },
      };
    }
    throw new Error(`unexpected request ${method} ${path}?${params.toString()}`);
  });
  return {
    fake,
    inScope: <T>(fn: () => Promise<T>) => runWith({ config: platform, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: ACTOR })),
  };
}

export function circle() {
  const createWallets = vi.fn(async () => ({ data: { wallets: [{ id: "agent-wallet-1", address: AGENT }] } }));
  const factory = (() => ({
    listWalletSets: vi.fn(async () => ({ data: { walletSets: [] } })),
    createWalletSet: vi.fn(async ({ name }: { name: string }) => ({ data: { walletSet: { id: "set-agents", name } } })),
    createWallets,
  })) as unknown as CircleClientFactory;
  return { factory, createWallets };
}

/** A chain whose wallet is an EOA, whose deployments leave a code naming their arguments, and whose reads are given. */
export function chain(input: { receipts?: Record<string, TreasuryReceipt>; code?: Record<string, Hex>; usdc?: bigint; allowance?: bigint; gas?: bigint } = {}): TreasuryChain {
  return {
    receipt: async (hash) => input.receipts?.[hash.toLowerCase()] ?? null,
    code: async (address) => input.code?.[address.toLowerCase()] ?? "0x",
    simulateDeploy: async ({ data }) => keccak256(data),
    read: async (_to, data) => {
      const { functionName } = decodeFunctionData({ abi: SPENDING_LIMIT_ABI, data });
      return encodeAbiParameters([{ type: "uint256" }], [functionName === "dailyLimit" ? 20_000_000n : 60_000_000n]);
    },
    usdcBalance: async () => input.usdc ?? 0n,
    allowance: async () => input.allowance ?? 0n,
    nativeBalance: async () => input.gas ?? 0n,
  };
}

export const ourCode = keccak256(deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 1n, weeklyUnits: 1n }));
export const deployedAt = (contract: Hex): TreasuryReceipt => ({ status: "success", from: WALLET, to: null, contractAddress: contract });
export const approvedOnUsdc: TreasuryReceipt = { status: "success", from: WALLET, to: USDC, contractAddress: null };

export async function signedProof(state: World, issuedAt = new Date(NOW - 60_000).toISOString()) {
  const message = walletProofMessage({ orgSlug: String(state.org.slug), network: ARC_MAINNET, address: WALLET, issuedAt });
  return { message, signature: await OWNER.signMessage({ message }) };
}

export const agentRow = (extra: Row = {}): Row => ({
  id: "slc-1",
  treasury_kind: "external",
  treasury_address: WALLET,
  agent_wallet_id: "agent-wallet-1",
  agent_address: AGENT,
  address: null,
  deploy_tx_hash: null,
  approve_tx_id: null,
  approve_tx_hash: null,
  enforced: false,
  treasury_signer: "wallet",
  recovery_address: null,
  recovery_skipped_at: null,
  ...extra,
});
export const chosen = { org: { wallet_host: "external" }, operating: { address: WALLET } };

/** EntryPoint v0.7's `UserOperationEvent` for `sender`, as a bundler's `handleOps` receipt carries it (passkey treasury K7). */
export function userOperationLog(sender: string, success = true) {
  const event = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");
  return {
    address: getAddress("0x0000000071727de22e5e9d8baf0edac6f37da032"),
    topics: encodeEventTopics({ abi: [event], eventName: "UserOperationEvent", args: { userOpHash: `0x${"ab".repeat(32)}`, sender: sender as Hex, paymaster: "0x0000000000000000000000000000000000000000" } }) as Hex[],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [0n, success, 20_000_000_000_000_000n, 500_000n]),
  };
}
