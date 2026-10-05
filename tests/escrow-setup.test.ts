import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { escrowStepKey, setUpEscrow, EscrowSetupError, type EscrowScpClient, type EscrowWalletsClient } from "@/lib/circle/escrow-setup";
import { TREASURY_WALLET_SET, walletIdempotencyKey } from "@/lib/circle/provision";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Setting up a workspace's escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E2): an EOA
 * deployer, gas for it from the operating wallet, the contract deployed through the Smart Contract Platform,
 * and its address once Circle has one. Every step is keyed and recorded, so an interrupted setup resumes.
 */

const { appendLedgerEntry } = vi.hoisted(() => ({ appendLedgerEntry: vi.fn(async () => ({})) }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e5c";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const OPERATING = { id: "acct-op", circle_wallet_id: "wallet-op", address: "0x97F85033bBD83870a841cF7153F35b387746B6b6", balance: "5" };
const DEPLOYER = "0xDe9100000000000000000000000000000000Be11";
const ESCROW = "0xE5c0000000000000000000000000000000000E5c";
const USDC = "0x3600000000000000000000000000000000000000";
const artifact = JSON.parse(readFileSync("src/lib/escrow/artifact.json", "utf8")) as { abi: unknown[]; bytecode: string };
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
}

function database(start: Partial<Row> | null = null, operating = OPERATING) {
  let row: Row | null = start ? { id: "esc-1", address: null, circle_contract_id: null, deployer_wallet_id: null, deployer_address: null, gas_tx_id: null, deploy_tx_hash: null, ...start } : null;
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    const none: FakeReply = { status: 406, body: { code: "PGRST116", message: "no rows" } };
    if (request.path === "/rest/v1/accounts") return { body: wantsObject ? operating : [operating] };
    if (request.path === "/rest/v1/escrow_contracts") {
      if (request.method === "GET") return wantsObject ? (row ? { body: row } : none) : { body: row ? [row] : [] };
      if (request.method === "POST") {
        if (!row) row = { id: "esc-1", address: null, circle_contract_id: null, deployer_wallet_id: null, deployer_address: null, gas_tx_id: null, deploy_tx_hash: null };
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
  const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run, row: () => row };
}

function circle(options: { deployment?: Array<{ status: string; contractAddress?: string; deploymentErrorReason?: string }>; gasState?: string } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const deployments = [...(options.deployment ?? [{ status: "PENDING" }, { status: "COMPLETE", contractAddress: ESCROW }])];
  const wallets = {
    listWalletSets: vi.fn(async () => ({ data: { walletSets: [{ id: "set-1", name: TREASURY_WALLET_SET }] } })),
    createWalletSet: vi.fn(),
    getWalletSet: vi.fn(),
    getWallet: vi.fn(),
    createWallets: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "createWallets", input });
      return { data: { wallets: [{ id: "wallet-deployer", address: DEPLOYER }] } };
    }),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "execute", input });
      return { data: { id: "tx-gas" } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({ data: { transaction: { id, state: options.gasState ?? "COMPLETE", txHash: "0xgas", blockchain: "ARC-TESTNET" } } })),
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
  return { wallets: wallets as unknown as EscrowWalletsClient, scp: scp as unknown as EscrowScpClient, calls, raw: { wallets, scp } };
}

const setUp = (db: ReturnType<typeof database>, c: ReturnType<typeof circle>, waitMs = 1_000) =>
  db.run(() => setUpEscrow({ actorId: USER }, { wallets: () => c.wallets, scp: () => c.scp, pollMs: 1, waitMs }));

beforeEach(() => appendLedgerEntry.mockClear());

describe("setting up escrow", () => {
  it("creates the deployer, gives it gas from the operating wallet, deploys the contract for the operating wallet, and stores its address", async () => {
    const db = database();
    const c = circle();
    expect(await setUp(db, c)).toEqual({ address: ESCROW, alreadySetUp: false });

    expect(c.calls[0]).toEqual({
      method: "createWallets",
      input: { blockchains: ["ARC-TESTNET"], count: 1, walletSetId: "set-1", accountType: "EOA", idempotencyKey: walletIdempotencyKey(ORG, "escrow-deployer") },
    });
    expect(c.calls[1]).toMatchObject({
      method: "execute",
      input: { walletId: "wallet-op", contractAddress: USDC, abiFunctionSignature: "transfer(address,uint256)", abiParameters: [DEPLOYER, "100000"], idempotencyKey: escrowStepKey(`${ORG}/esc-1/gas`) },
    });
    expect(c.calls[2]).toMatchObject({
      method: "deployContract",
      input: {
        walletId: "wallet-deployer",
        blockchain: "ARC-TESTNET",
        bytecode: artifact.bytecode,
        abiJson: JSON.stringify(artifact.abi),
        constructorParameters: [USDC, OPERATING.address],
        idempotencyKey: escrowStepKey(`${ORG}/esc-1/deploy`),
      },
    });
    expect(db.row()).toMatchObject({ address: ESCROW, circle_contract_id: "contract-1", deployer_wallet_id: "wallet-deployer", deployer_address: DEPLOYER, gas_tx_id: "tx-gas", deploy_tx_hash: "0xdeploy" });
    expect(appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "human", domain: "contractor", action: "escrow_deployed", detail: { by: USER, address: ESCROW, payer: OPERATING.address, deployer: DEPLOYER, circleContractId: "contract-1", txHash: "0xdeploy" } })
    );
  });

  it("resumes an interrupted setup from what it recorded: no second wallet, gas or deployment", async () => {
    const db = database({ deployer_wallet_id: "wallet-deployer", deployer_address: DEPLOYER, gas_tx_id: "tx-gas", circle_contract_id: "contract-1" });
    const c = circle({ deployment: [{ status: "COMPLETE", contractAddress: ESCROW }] });
    expect(await setUp(db, c)).toEqual({ address: ESCROW, alreadySetUp: false });
    expect(c.calls).toEqual([]);
    expect(db.row()?.address).toBe(ESCROW);
  });

  it("does nothing for a workspace whose escrow is set up", async () => {
    const c = circle();
    expect(await setUp(database({ address: ESCROW }), c)).toEqual({ address: ESCROW, alreadySetUp: true });
    expect(c.calls).toEqual([]);
  });

  it("says the deployment is still under way, and keeps what it recorded, when Circle has no address yet", async () => {
    const db = database();
    const c = circle({ deployment: [{ status: "PENDING" }] });
    await expect(setUp(db, c, 0)).rejects.toEqual(new EscrowSetupError("The escrow contract is still being deployed. Press Set up escrow again in a minute to finish."));
    expect(db.row()).toMatchObject({ circle_contract_id: "contract-1", address: null });
  });

  it("starts over, with new keys, after Circle failed the deployment; the reason is Circle's", async () => {
    const db = database();
    const c = circle({ deployment: [{ status: "FAILED", deploymentErrorReason: "INSUFFICIENT_NATIVE_TOKEN" }] });
    await expect(setUp(db, c)).rejects.toEqual(new EscrowSetupError("Circle could not deploy the escrow contract (INSUFFICIENT_NATIVE_TOKEN). Nothing is locked; press Set up escrow to try again."));
    expect(db.row()).toBeNull();
  });

  it("refuses when the operating wallet cannot pay the deployer's gas, before calling Circle", async () => {
    const c = circle();
    await expect(setUp(database(null, { ...OPERATING, balance: "0.05" }), c)).rejects.toEqual(
      new EscrowSetupError("The operating wallet holds 0.05 USDC; setting up escrow sends 0.1 USDC of it to the deployer for gas.")
    );
    expect(c.calls).toEqual([]);
  });
});

describe("setting up escrow while payments are switched off (payment safety S2)", () => {
  it("deploys and funds nothing, before reading the workspace or calling Circle", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));
    const wallets = vi.fn();
    const scp = vi.fn();
    const run = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config: { ...config, paymentsDisabled: true }, client: fake.client, orgId: ORG, userId: USER }), fn);

    await expect(run(() => setUpEscrow({ actorId: USER }, { wallets, scp }))).rejects.toThrow("Payments are switched off for every workspace right now.");
    expect(fake.requests).toHaveLength(0);
    expect(wallets).not.toHaveBeenCalled();
    expect(scp).not.toHaveBeenCalled();
  });
});
