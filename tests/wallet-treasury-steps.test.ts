import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, erc20Abi, getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import type { CircleClientFactory } from "@/lib/circle/check";
import { SPENDING_LIMIT_ABI } from "@/lib/spending-limit/onchain";
import type { TreasuryChain, TreasuryReceipt } from "@/lib/treasury/chain";
import { deploymentData, walletProofMessage } from "@/lib/treasury/verify";
import {
  chooseWalletTreasury,
  createAgentWallet,
  prepareAgentGas,
  prepareApproval,
  prepareDeployment,
  proofMessage,
  recordApproval,
  recordDeployment,
  WalletTreasuryError,
  walletTreasuryStatus,
} from "@/lib/treasury/wallet-treasury";
import { ARC_MAINNET } from "@/lib/network";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The setup of a workspace that pays from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W3, W5–W10): the owner proves their wallet, Vestiarion creates the agent's wallet, the owner deploys and
 * approves the contract from their wallet, and sends the agent its gas. Each step checks the one before it, and each
 * result the owner hands back is read from the chain before it is recorded.
 */

const ORG = "6a1f0c2e-8c1b-4f7a-9e6d-0000000000c1";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const OWNER_EMAIL = "owner@example.com";
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const WALLET = OWNER.address;
const AGENT = getAddress("0x5af3107a4000000000000000000000000000a9e7");
const CONTRACT = getAddress("0x5af3107a4000000000000000000000000000e5c0");
const SECOND_CONTRACT = getAddress("0x5af3107a4000000000000000000000000000e5c1");
const USDC = getAddress(ARC_MAINNET.tokens.USDC);
const DEPLOY_TX = `0x${"d1".repeat(32)}` as Hex;
const REDEPLOY_TX = `0x${"d2".repeat(32)}` as Hex;
const APPROVE_TX = `0x${"a1".repeat(32)}` as Hex;
const NOW = Date.parse("2026-10-07T10:00:00Z");
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const platform = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  MAINNET_ENABLED: "1",
  MAINNET_ALLOWLIST: OWNER_EMAIL,
  MAINNET_AGENT_CIRCLE_API_KEY: "LIVE_API_KEY:agent-id:agent-secret",
  MAINNET_AGENT_CIRCLE_ENTITY_SECRET: "a9e7".repeat(16),
});

let savedMasterKeys: string | undefined;
beforeEach(() => {
  savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

type Row = Record<string, unknown>;
interface World {
  org: Row;
  operating: Row;
  contract: Row | null;
  budget: Row | null;
  ledger: Array<{ action: string; detail: Record<string, unknown> }>;
}

function world(overrides: { org?: Row; operating?: Row; contract?: Row | null; budget?: Row | null } = {}): World {
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
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    // The scope adds org_id to every tenant request; these rows are all this workspace's.
    if (["select", "order", "limit", "on_conflict", "columns", "org_id"].includes(key)) continue;
    if (key === "or") {
      const alternatives = value.replace(/^\(|\)$/g, "").split(",");
      if (!alternatives.some((alternative) => matches(row, new URLSearchParams([[alternative.split(".")[0], alternative.split(".").slice(1).join(".")]])))) return false;
      continue;
    }
    const cell = row[key.replace(/->>.*$/, "")];
    if (value === "is.null" && cell !== null && cell !== undefined) return false;
    if (value.startsWith("eq.") && String(cell) !== value.slice(3)) return false;
  }
  return true;
}

function database(state: World) {
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
      state.contract = { id: "slc-1", address: null, deploy_tx_hash: null, approve_tx_id: null, approve_tx_hash: null, enforced: false, ...(request.body as Row) };
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

function circle() {
  const createWallets = vi.fn(async () => ({ data: { wallets: [{ id: "agent-wallet-1", address: AGENT }] } }));
  const factory = (() => ({
    listWalletSets: vi.fn(async () => ({ data: { walletSets: [] } })),
    createWalletSet: vi.fn(async ({ name }: { name: string }) => ({ data: { walletSet: { id: "set-agents", name } } })),
    createWallets,
  })) as unknown as CircleClientFactory;
  return { factory, createWallets };
}

/** A chain whose wallet is an EOA, whose deployments leave a code naming their arguments, and whose reads are given. */
function chain(input: { receipts?: Record<string, TreasuryReceipt>; code?: Record<string, Hex>; usdc?: bigint; allowance?: bigint; gas?: bigint } = {}): TreasuryChain {
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

const ourCode = keccak256(deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 1n, weeklyUnits: 1n }));
const deployedAt = (contract: Hex): TreasuryReceipt => ({ status: "success", from: WALLET, to: null, contractAddress: contract });
const approvedOnUsdc: TreasuryReceipt = { status: "success", from: WALLET, to: USDC, contractAddress: null };

async function signedProof(state: World, issuedAt = new Date(NOW - 60_000).toISOString()) {
  const message = walletProofMessage({ orgSlug: String(state.org.slug), network: ARC_MAINNET, address: WALLET, issuedAt });
  return { message, signature: await OWNER.signMessage({ message }) };
}

const agentRow = (extra: Row = {}): Row => ({
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
  ...extra,
});
const chosen = { org: { wallet_host: "external" }, operating: { address: WALLET } };

describe("proving the owner's wallet", () => {
  it("records the wallet as the workspace's treasury, with the proof in the ledger", async () => {
    const state = world();
    const { inScope } = database(state);
    const proof = await signedProof(state);
    await inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET.toLowerCase(), ...proof }, { chain: chain(), now: NOW }));
    expect(state.org.wallet_host).toBe("external");
    expect(state.operating.address).toBe(WALLET);
    expect(state.ledger).toEqual([
      { action: "treasury_wallet_proven", detail: { by: ACTOR, address: WALLET, message: proof.message, signature: proof.signature, network: "arc-mainnet" } },
    ]);
  });

  it("gives the message to sign for this workspace, naming the wallet", async () => {
    const state = world();
    const { inScope } = database(state);
    const message = await inScope(() => proofMessage({ orgId: ORG, address: WALLET.toLowerCase() }));
    expect(message).toContain("Workspace: own-wallet-co");
    expect(message).toContain(`Wallet: ${WALLET}`);
  });

  it("refuses a workspace that chose its wallets already, a contract's address, a bad proof, and a person Arc mainnet is not open to", async () => {
    for (const host of ["own", "hosted"]) {
      const state = world({ org: { wallet_host: host } });
      const proof = await signedProof(state);
      await expect(
        database(state).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...proof }, { chain: chain(), now: NOW }))
      ).rejects.toMatchObject({ code: "wrong_step" });
    }
    const contract = world();
    const contractProof = await signedProof(contract);
    await expect(
      database(contract).inScope(() =>
        chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...contractProof }, { chain: chain({ code: { [WALLET.toLowerCase()]: "0x6080" } }), now: NOW })
      )
    ).rejects.toMatchObject({ code: "not_an_eoa" });
    const stale = world();
    const staleProof = await signedProof(stale, new Date(NOW - 20 * 60_000).toISOString());
    await expect(
      database(stale).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, address: WALLET, ...staleProof }, { chain: chain(), now: NOW }))
    ).rejects.toMatchObject({ code: "proof_refused" });
    const closed = world();
    const closedProof = await signedProof(closed);
    await expect(
      database(closed).inScope(() => chooseWalletTreasury({ orgId: ORG, actorId: ACTOR, actorEmail: "someone@else.com", address: WALLET, ...closedProof }, { chain: chain(), now: NOW }))
    ).rejects.toMatchObject({ code: "not_allowed" });
    expect([contract, stale, closed].every((state) => state.org.wallet_host === null)).toBe(true);
  });
});

describe("the agent's wallet", () => {
  it("is created once, in Vestiarion's agent account, and kept", async () => {
    const state = world(chosen);
    const { inScope } = database(state);
    const { factory, createWallets } = circle();
    await inScope(() => createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: factory }));
    await inScope(() => createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: factory }));
    expect(createWallets).toHaveBeenCalledTimes(1);
    expect(createWallets).toHaveBeenCalledWith(expect.objectContaining({ blockchains: ["ARC"], accountType: "EOA", walletSetId: "set-agents" }));
    expect(state.contract).toMatchObject({ treasury_kind: "external", treasury_address: WALLET, agent_wallet_id: "agent-wallet-1", agent_address: AGENT });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["agent_wallet_created"]);
    expect(state.ledger[0].detail).toEqual({ by: ACTOR, address: AGENT });
  });

  it("waits for the owner's wallet", async () => {
    const state = world();
    await expect(database(state).inScope(() => createAgentWallet({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL }, { circle: circle().factory }))).rejects.toMatchObject({
      code: "wrong_step",
    });
  });
});

describe("deploying the contract from the owner's wallet", () => {
  it("builds the deployment with the workspace's figures, or the owner's", async () => {
    const state = world({ ...chosen, contract: agentRow() });
    const { inScope } = database(state);
    const defaults = await inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc: null, weeklyUsdc: null }));
    expect(defaults).toEqual({ to: null, data: deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 50_000_000n, weeklyUnits: 150_000_000n }), value: "0", chainId: 5042 });
    const chosenFigures = await inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc: 20, weeklyUsdc: null }));
    expect(chosenFigures.data).toBe(deploymentData({ usdc: USDC, treasury: WALLET, agent: AGENT, dailyUnits: 20_000_000n, weeklyUnits: 0n }));
    for (const [dailyUsdc, weeklyUsdc] of [[0, 10], [-1, null], [30, 20]] as const) {
      await expect(inScope(() => prepareDeployment({ orgId: ORG, dailyUsdc, weeklyUsdc }))).rejects.toMatchObject({ code: "invalid_figures" });
    }
  });

  it("records nothing while the deployment is not mined", async () => {
    const state = world({ ...chosen, contract: agentRow() });
    expect(await database(state).inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: DEPLOY_TX }, { chain: chain() }))).toBe("pending");
    expect(state.contract?.address).toBeNull();
    expect(state.ledger).toEqual([]);
  });

  it("records a verified deployment, its figures as the workspace's limit, and replaces one not yet approved", async () => {
    const state = world({ ...chosen, contract: agentRow() });
    const { inScope } = database(state);
    const onChain = chain({
      receipts: { [DEPLOY_TX]: deployedAt(CONTRACT), [REDEPLOY_TX]: deployedAt(SECOND_CONTRACT) },
      code: { [CONTRACT.toLowerCase()]: ourCode, [SECOND_CONTRACT.toLowerCase()]: ourCode },
    });
    expect(await inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: DEPLOY_TX }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({ address: CONTRACT, deploy_tx_hash: DEPLOY_TX });
    expect(state.budget).toMatchObject({ daily_usdc: 20, weekly_usdc: 60 });
    expect(state.ledger.map((entry) => entry.action)).toEqual(["agent_budget_changed", "spending_limit_deployed"]);
    expect(state.ledger[1].detail).toEqual({ by: ACTOR, contract: CONTRACT, txHash: DEPLOY_TX, dailyUsdc: 20, weeklyUsdc: 60 });

    expect(await inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: REDEPLOY_TX }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({ address: SECOND_CONTRACT, deploy_tx_hash: REDEPLOY_TX });
  });

  it("refuses to replace an approved contract, and refuses a deployment that is not the workspace's", async () => {
    const approved = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    await expect(
      database(approved).inScope(() => recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: REDEPLOY_TX }, { chain: chain({ receipts: { [REDEPLOY_TX]: deployedAt(SECOND_CONTRACT) } }) }))
    ).rejects.toMatchObject({ code: "wrong_step" });
    const foreign = world({ ...chosen, contract: agentRow() });
    await expect(
      database(foreign).inScope(() =>
        recordDeployment({ orgId: ORG, actorId: ACTOR, txHash: DEPLOY_TX }, { chain: chain({ receipts: { [DEPLOY_TX]: deployedAt(CONTRACT) }, code: { [CONTRACT.toLowerCase()]: "0x6080" } }) })
      )
    ).rejects.toMatchObject({ code: "chain_refused" });
    expect(foreign.contract?.address).toBeNull();
  });
});

describe("approving the contract", () => {
  it("builds the approval on USDC, unlimited or capped", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT }) });
    const { inScope } = database(state);
    const unlimited = await inScope(() => prepareApproval({ orgId: ORG, capUsdc: null }));
    expect(unlimited).toMatchObject({ to: USDC, value: "0", chainId: 5042 });
    expect(decodeFunctionData({ abi: erc20Abi, data: unlimited.data as Hex }).args).toEqual([CONTRACT, 2n ** 256n - 1n]);
    const capped = await inScope(() => prepareApproval({ orgId: ORG, capUsdc: 250 }));
    expect(decodeFunctionData({ abi: erc20Abi, data: capped.data as Hex }).args).toEqual([CONTRACT, 250_000_000n]);
  });

  it("enforces the contract once the approval is read on chain", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT }) });
    const { inScope } = database(state);
    const onChain = chain({ receipts: { [APPROVE_TX]: approvedOnUsdc }, allowance: 2n ** 256n - 1n });
    expect(await inScope(() => recordApproval({ orgId: ORG, actorId: ACTOR, txHash: APPROVE_TX }, { chain: onChain }))).toBe("verified");
    expect(state.contract).toMatchObject({ approve_tx_hash: APPROVE_TX, enforced: true });
    expect(state.ledger).toEqual([
      { action: "spending_limit_enforced", detail: { by: ACTOR, contract: CONTRACT, approveTxHash: APPROVE_TX, treasury: "external", allowanceUsdc: null } },
    ]);
  });

  it("refuses an approval that leaves the contract nothing", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT }) });
    await expect(
      database(state).inScope(() => recordApproval({ orgId: ORG, actorId: ACTOR, txHash: APPROVE_TX }, { chain: chain({ receipts: { [APPROVE_TX]: approvedOnUsdc }, allowance: 0n }) }))
    ).rejects.toMatchObject({ code: "chain_refused" });
    expect(state.contract?.enforced).toBe(false);
  });
});

describe("the agent's gas, on a network where it pays its own", () => {
  it("is 0.50 USDC sent to the agent from the owner's wallet", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    expect(await database(state).inScope(() => prepareAgentGas({ orgId: ORG }))).toEqual({ to: AGENT, data: "0x", value: "500000000000000000", chainId: 5042 });
  });
});

describe("walletTreasuryStatus", () => {
  it("walks every step, from the wallet to ready", async () => {
    const status = (state: World, onChain: TreasuryChain) => database(state).inScope(() => walletTreasuryStatus(ORG, { chain: onChain }));
    expect((await status(world(), chain())).step).toBe("wallet");
    expect((await status(world(chosen), chain())).step).toBe("agent");
    expect((await status(world({ ...chosen, contract: agentRow() }), chain())).step).toBe("deploy");
    expect((await status(world({ ...chosen, contract: agentRow({ address: CONTRACT }) }), chain())).step).toBe("approve");
    const enforced = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    expect((await status(enforced, chain({ gas: 50_000_000_000_000_000n }))).step).toBe("gas");
    const ready = await status(enforced, chain({ usdc: 12_500_000n, allowance: 2n ** 256n - 1n, gas: 500_000_000_000_000_000n }));
    expect(ready).toEqual({
      step: "ready",
      wallet: WALLET,
      agent: AGENT,
      contract: CONTRACT,
      dailyUsdc: 20,
      weeklyUsdc: 60,
      walletUsdc: 12.5,
      spendableUsdc: 12.5,
      agentGasUsdc: 0.5,
      agentGasMinimumUsdc: 0.1,
    });
  });

  it("keeps the step and leaves a figure out when the chain cannot be read", async () => {
    const enforced = world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
    const broken = { ...chain(), nativeBalance: async () => { throw new Error("rpc down"); } } as TreasuryChain;
    const status = await database(enforced).inScope(() => walletTreasuryStatus(ORG, { chain: broken }));
    expect(status.step).toBe("gas");
    expect(status.agentGasUsdc).toBeNull();
  });
});

describe("WalletTreasuryError", () => {
  it("carries its code and a message", () => {
    const error = new WalletTreasuryError("invalid_figures");
    expect(error.code).toBe("invalid_figures");
    expect(error.message.length).toBeGreaterThan(10);
  });
});
