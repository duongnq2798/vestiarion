import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { TREASURY_WALLET_SET, walletIdempotencyKey } from "@/lib/circle/provision";
import {
  enforceSpendingLimit,
  MAX_ALLOWANCE,
  setLimitsOnChain,
  SpendingLimitSetupError,
  spendingLimitStepKey,
  turnOffSpendingLimit,
  type SpendingLimitScpClient,
  type SpendingLimitWalletsClient,
} from "@/lib/circle/spending-limit-setup";
import artifact from "@/lib/spending-limit/artifact.json";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Enforcing the agent's spending limit on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R1, R2, R10, R11): a deployer and its gas, the agent's own wallet, the contract with the workspace's figures, and
 * the operating wallet's approval, each keyed and recorded so an interrupted setup resumes; turning it off, and
 * changing the figures on the contract.
 */

const { appendLedgerEntry } = vi.hoisted(() => ({ appendLedgerEntry: vi.fn(async () => ({})) }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e5d";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const OPERATING = { id: "acct-op", circle_wallet_id: "wallet-op", address: "0x97F85033bBD83870a841cF7153F35b387746B6b6", balance: "5" };
const DEPLOYER = "0xDe9100000000000000000000000000000000Be11";
const AGENT = "0xA9e7000000000000000000000000000000000A9e";
const LIMIT = "0x11a1700000000000000000000000000000001111";
const USDC = "0x3600000000000000000000000000000000000000";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const config: VestiarionConfig = { ...base, chain: { ...base.chain, circleApiKey: "TEST_API_KEY:k:s", circleEntitySecret: "5eed".repeat(16) } };

interface Row {
  id: string;
  address: string | null;
  circle_contract_id: string | null;
  deployer_wallet_id: string | null;
  deployer_address: string | null;
  gas_tx_id: string | null;
  deploy_tx_hash: string | null;
  agent_wallet_id: string | null;
  agent_address: string | null;
  approve_tx_id: string | null;
  enforced: boolean;
}

const EMPTY: Omit<Row, "id"> = {
  address: null,
  circle_contract_id: null,
  deployer_wallet_id: null,
  deployer_address: null,
  gas_tx_id: null,
  deploy_tx_hash: null,
  agent_wallet_id: null,
  agent_address: null,
  approve_tx_id: null,
  enforced: false,
};

function database(
  start: Partial<Row> | null = null,
  options: { budget?: { daily_usdc: string | null; weekly_usdc: string | null } | null; operating?: typeof OPERATING; config?: VestiarionConfig } = {}
) {
  let row: Row | null = start ? { id: "lim-1", ...EMPTY, ...start } : null;
  const budget = options.budget === undefined ? { daily_usdc: "5", weekly_usdc: "20" } : options.budget;
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    // The platform's payment switch (payment safety S7): on.
    if (request.path === "/rest/v1/platform_controls") return { body: null };
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    const none: FakeReply = { status: 406, body: { code: "PGRST116", message: "no rows" } };
    if (request.path === "/rest/v1/accounts") return { body: wantsObject ? (options.operating ?? OPERATING) : [options.operating ?? OPERATING] };
    if (request.path === "/rest/v1/agent_budgets") return { body: budget ? [budget] : [] };
    if (request.path === "/rest/v1/spending_limit_contracts") {
      if (request.method === "GET") return wantsObject ? (row ? { body: row } : none) : { body: row ? [row] : [] };
      if (request.method === "POST") {
        if (!row) row = { id: "lim-1", ...EMPTY };
        return { body: wantsObject ? row : [row] };
      }
      if (request.method === "PATCH") {
        row = { ...(row as Row), ...(request.body as Partial<Row>) };
        return { body: [row] };
      }
      if (request.method === "DELETE") {
        row = null;
        return { body: [] };
      }
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config: options.config ?? config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run, row: () => row };
}

function circle(options: { deployment?: Array<{ status: string; contractAddress?: string; deploymentErrorReason?: string }>; txState?: (id: string) => string } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const deployments = [...(options.deployment ?? [{ status: "PENDING" }, { status: "COMPLETE", contractAddress: LIMIT }])];
  let executions = 0;
  const wallets = {
    listWalletSets: vi.fn(async () => ({ data: { walletSets: [{ id: "set-1", name: TREASURY_WALLET_SET }] } })),
    createWalletSet: vi.fn(),
    getWalletSet: vi.fn(),
    getWallet: vi.fn(),
    createWallets: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "createWallets", input });
      return input.accountType === "SCA"
        ? { data: { wallets: [{ id: "wallet-agent", address: AGENT }] } }
        : { data: { wallets: [{ id: "wallet-deployer", address: DEPLOYER }] } };
    }),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "execute", input });
      executions += 1;
      return { data: { id: `tx-${executions}` } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: { transaction: { id, state: options.txState?.(id) ?? "COMPLETE", txHash: `0xhash-${id}`, blockchain: "ARC-TESTNET" } },
    })),
  };
  const scp = {
    deployContract: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "deployContract", input });
      return { data: { contractId: "contract-1", transactionId: "tx-deploy" } };
    }),
    getContract: vi.fn(async () => {
      const next = deployments.length > 1 ? deployments.shift()! : deployments[0];
      return { data: { contract: { id: "contract-1", txHash: "0xdeploy", ...next } } };
    }),
  };
  return { wallets: wallets as unknown as SpendingLimitWalletsClient, scp: scp as unknown as SpendingLimitScpClient, calls };
}

const clients = (c: ReturnType<typeof circle>) => ({ wallets: () => c.wallets, scp: () => c.scp, pollMs: 1, waitMs: 1_000 });
const enforce = (db: ReturnType<typeof database>, c: ReturnType<typeof circle>) => db.run(() => enforceSpendingLimit({ actorId: USER }, clients(c)));

beforeEach(() => appendLedgerEntry.mockClear());

describe("enforcing the spending limit on Arc", () => {
  it("creates the deployer and its gas, the agent's wallet, the contract with the figures, and the operating wallet's approval", async () => {
    const db = database();
    const c = circle();
    expect(await enforce(db, c)).toEqual({ contract: LIMIT, agent: AGENT, alreadyEnforced: false });

    expect(c.calls.map((call) => call.method)).toEqual(["createWallets", "execute", "createWallets", "deployContract", "execute"]);
    expect(c.calls[0].input).toEqual({
      blockchains: ["ARC-TESTNET"],
      count: 1,
      walletSetId: "set-1",
      accountType: "EOA",
      idempotencyKey: walletIdempotencyKey(ORG, "spending-limit-deployer"),
    });
    expect(c.calls[1].input).toMatchObject({
      walletId: "wallet-op",
      contractAddress: USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [DEPLOYER, "100000"],
      idempotencyKey: spendingLimitStepKey(`${ORG}/lim-1/gas`),
    });
    // The agent's own wallet: a smart account, which Circle's Gas Station pays gas for on Arc testnet.
    expect(c.calls[2].input).toEqual({
      blockchains: ["ARC-TESTNET"],
      count: 1,
      walletSetId: "set-1",
      accountType: "SCA",
      idempotencyKey: walletIdempotencyKey(ORG, "spending-limit-agent"),
    });
    expect(c.calls[3].input).toMatchObject({
      name: "VestiarionSpendingLimit",
      walletId: "wallet-deployer",
      blockchain: "ARC-TESTNET",
      bytecode: artifact.bytecode,
      abiJson: JSON.stringify(artifact.abi),
      constructorParameters: [USDC, OPERATING.address, AGENT, "5000000", "20000000"],
      idempotencyKey: spendingLimitStepKey(`${ORG}/lim-1/deploy`),
    });
    expect(c.calls[4].input).toMatchObject({
      walletId: "wallet-op",
      contractAddress: USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [LIMIT, MAX_ALLOWANCE],
    });

    expect(db.row()).toMatchObject({
      address: LIMIT,
      circle_contract_id: "contract-1",
      deployer_wallet_id: "wallet-deployer",
      deployer_address: DEPLOYER,
      gas_tx_id: "tx-1",
      deploy_tx_hash: "0xdeploy",
      agent_wallet_id: "wallet-agent",
      agent_address: AGENT,
      approve_tx_id: "tx-2",
      enforced: true,
    });
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "human",
        domain: "system",
        action: "spending_limit_enforced",
        detail: {
          by: USER,
          contract: LIMIT,
          agent: AGENT,
          treasury: OPERATING.address,
          dailyUsdc: 5,
          weeklyUsdc: 20,
          deployTxHash: "0xdeploy",
          approveTxHash: "0xhash-tx-2",
          setLimitsTxHash: null,
        },
      })
    );
  });

  it("refuses without a daily or 7-day figure, before anything reaches Circle", async () => {
    for (const budget of [null, { daily_usdc: null, weekly_usdc: null }]) {
      const db = database(null, { budget });
      const c = circle();
      await expect(enforce(db, c)).rejects.toThrow(/Set a daily or 7-day limit first/);
      expect(c.calls).toEqual([]);
      expect(db.row()).toBeNull();
    }
  });

  it("refuses when the operating wallet cannot pay the deployer's gas, before anything reaches Circle", async () => {
    const db = database(null, { operating: { ...OPERATING, balance: "0.05" } });
    const c = circle();
    await expect(enforce(db, c)).rejects.toBeInstanceOf(SpendingLimitSetupError);
    expect(c.calls).toEqual([]);
  });

  it("resumes an interrupted setup from what it recorded, and finishes with the approval", async () => {
    const db = database({
      deployer_wallet_id: "wallet-deployer",
      deployer_address: DEPLOYER,
      gas_tx_id: "tx-gas",
      agent_wallet_id: "wallet-agent",
      agent_address: AGENT,
      circle_contract_id: "contract-1",
    });
    const c = circle({ deployment: [{ status: "COMPLETE", contractAddress: LIMIT }] });
    expect(await enforce(db, c)).toEqual({ contract: LIMIT, agent: AGENT, alreadyEnforced: false });
    expect(c.calls.map((call) => call.method)).toEqual(["execute"]);
    expect(c.calls[0].input).toMatchObject({ abiFunctionSignature: "approve(address,uint256)", abiParameters: [LIMIT, MAX_ALLOWANCE] });
    expect(db.row()?.enforced).toBe(true);
  });

  it("does nothing for a workspace whose limit is already enforced on Arc", async () => {
    const db = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true });
    const c = circle();
    expect(await enforce(db, c)).toEqual({ contract: LIMIT, agent: AGENT, alreadyEnforced: true });
    expect(c.calls).toEqual([]);
    expect(appendLedgerEntry).not.toHaveBeenCalled();
  });

  it("enforces it again after it was turned off: the contract's figures set to the current ones, then the approval", async () => {
    const db = database({
      address: LIMIT,
      circle_contract_id: "contract-1",
      deployer_wallet_id: "wallet-deployer",
      deployer_address: DEPLOYER,
      gas_tx_id: "tx-gas",
      agent_wallet_id: "wallet-agent",
      agent_address: AGENT,
      enforced: false,
    });
    const c = circle();
    expect(await enforce(db, c)).toEqual({ contract: LIMIT, agent: AGENT, alreadyEnforced: false });
    expect(c.calls.map((call) => call.input.abiFunctionSignature)).toEqual(["setLimits(uint256,uint256)", "approve(address,uint256)"]);
    expect(c.calls[0].input).toMatchObject({ walletId: "wallet-op", contractAddress: LIMIT, abiParameters: ["5000000", "20000000"] });
    expect(db.row()).toMatchObject({ enforced: true, approve_tx_id: "tx-2" });
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "spending_limit_enforced", detail: expect.objectContaining({ setLimitsTxHash: "0xhash-tx-1", deployTxHash: null }) })
    );
  });

  it("forgets a deployment Circle failed, so the next press starts over", async () => {
    const db = database();
    const c = circle({ deployment: [{ status: "FAILED", deploymentErrorReason: "INSUFFICIENT_FUNDS" }] });
    await expect(enforce(db, c)).rejects.toThrow(/Circle could not deploy the spending limit contract \(INSUFFICIENT_FUNDS\)/);
    expect(db.row()).toBeNull();
  });

  it("leaves the limit unenforced when Circle fails the approval", async () => {
    const db = database();
    const c = circle({ txState: (id) => (id === "tx-2" ? "FAILED" : "COMPLETE") });
    await expect(enforce(db, c)).rejects.toThrow(/approval/);
    expect(db.row()).toMatchObject({ address: LIMIT, enforced: false, approve_tx_id: null });
  });
});

describe("turning it off", () => {
  it("sets the operating wallet's approval to 0, so the contract can draw nothing, and keeps the contract", async () => {
    const db = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true });
    const c = circle();
    expect(await db.run(() => turnOffSpendingLimit({ actorId: USER }, clients(c)))).toEqual({ contract: LIMIT, txHash: "0xhash-tx-1" });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].input).toMatchObject({ walletId: "wallet-op", contractAddress: USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [LIMIT, "0"] });
    expect(db.row()).toMatchObject({ address: LIMIT, enforced: false, approve_tx_id: null });
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "human", domain: "system", action: "spending_limit_unenforced", detail: { by: USER, contract: LIMIT, txHash: "0xhash-tx-1" } })
    );
  });

  it("refuses when it is not enforced, and keeps it enforced when Circle fails the change", async () => {
    const off = database({ address: LIMIT, enforced: false });
    await expect(off.run(() => turnOffSpendingLimit({ actorId: USER }, clients(circle())))).rejects.toThrow(/not enforced on Arc/);
    const on = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true });
    await expect(on.run(() => turnOffSpendingLimit({ actorId: USER }, clients(circle({ txState: () => "FAILED" }))))).rejects.toBeInstanceOf(SpendingLimitSetupError);
    expect(on.row()?.enforced).toBe(true);
  });
});

describe("changing the figures on the contract", () => {
  it("sends setLimits from the operating wallet in token units, 0 for a figure not set, and answers once Circle confirms it", async () => {
    const db = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true });
    const c = circle();
    expect(await db.run(() => setLimitsOnChain({ dailyUsdc: 7.5, weeklyUsdc: null }, clients(c)))).toEqual({ contract: LIMIT, txHash: "0xhash-tx-1" });
    expect(c.calls[0].input).toMatchObject({ walletId: "wallet-op", contractAddress: LIMIT, abiFunctionSignature: "setLimits(uint256,uint256)", abiParameters: ["7500000", "0"] });
  });

  it("throws, and changes nothing, when Circle fails it", async () => {
    const db = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true });
    await expect(db.run(() => setLimitsOnChain({ dailyUsdc: 7.5, weeklyUsdc: 30 }, clients(circle({ txState: () => "FAILED" }))))).rejects.toThrow(
      /Circle did not change the figures on the contract/
    );
  });
});

describe("before migration 0062", () => {
  it("reads no contract, rather than failing, when the table does not exist yet: nothing can be enforced without it", async () => {
    const { readSpendingLimitContract, enforcedSpendingLimit } = await import("@/lib/circle/spending-limit-setup");
    for (const missing of [
      { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.spending_limit_contracts' in the schema cache" } },
      { status: 404, body: { code: "42P01", message: 'relation "public.spending_limit_contracts" does not exist' } },
    ]) {
      const fake = fakeSupabase(() => missing);
      const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
      expect(await run(() => readSpendingLimitContract())).toBeNull();
      expect(await run(() => enforcedSpendingLimit())).toBeNull();
    }
  });

  it("still throws on any other failure to read it", async () => {
    const { readSpendingLimitContract } = await import("@/lib/circle/spending-limit-setup");
    const fake = fakeSupabase(() => ({ status: 500, body: { code: "57014", message: "canceling statement due to statement timeout" } }));
    await expect(runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), () => readSpendingLimitContract())).rejects.toThrow(/statement timeout/);
  });
});

describe("the spending limit contract while payments are switched off (payment safety S2)", () => {
  const off = (): VestiarionConfig => ({ ...config, paymentsDisabled: true });

  it("enforces nothing and changes no figures, before reading the workspace or calling Circle", async () => {
    const db = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true }, { config: off() });
    const c = circle();

    await expect(db.run(() => enforceSpendingLimit({ actorId: USER }, clients(c)))).rejects.toThrow("Payments are switched off for every workspace right now.");
    await expect(db.run(() => setLimitsOnChain({ dailyUsdc: 7.5, weeklyUsdc: null }, clients(c)))).rejects.toThrow("Payments are switched off for every workspace right now.");
    expect(db.fake.requests).toHaveLength(0);
    expect(c.calls).toHaveLength(0);
  });

  it("still turns the limit off, which only takes the agent's power to pay away", async () => {
    const db = database({ address: LIMIT, agent_wallet_id: "wallet-agent", agent_address: AGENT, approve_tx_id: "tx-a", enforced: true }, { config: off() });

    expect(await db.run(() => turnOffSpendingLimit({ actorId: USER }, clients(circle())))).toEqual({ contract: LIMIT, txHash: "0xhash-tx-1" });
    expect(db.row()?.enforced).toBe(false);
  });
});

describe("the spending limit contract on Arc mainnet (mainnet go-live M6)", () => {
  it("refuses by name, before reading the workspace or calling Circle", async () => {
    const db = database(null, { config: { ...config, network: "arc-mainnet" } });
    const c = circle();
    await expect(db.run(() => enforceSpendingLimit({ actorId: USER }, clients(c)))).rejects.toThrow("Enforcing the spending limit in a contract does not run on Arc mainnet yet");
    expect(db.fake.requests).toHaveLength(0);
  });
});
