import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { GATEWAY_WALLET, gatewayStepKey } from "@/lib/circle/gateway";
import { fundGateway, GatewayStepFailed, readGatewayState, type GatewayFundingClient } from "@/lib/circle/gateway-funding";
import { TREASURY_WALLET_SET, walletIdempotencyKey } from "@/lib/circle/provision";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Funding a workspace's Gateway balance (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G1):
 * the signer created once, the delegate added once, then approve and deposit from the operating
 * wallet, each under a key, each a ledger entry. Run inside the workspace's scope over a recorded
 * database and a fake Circle client.
 */

const { appendLedgerEntry } = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn<(entry: { action: string; detail: Record<string, unknown> }) => Promise<object>>(async () => ({})),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d1d";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const OPERATING = { id: "acct-op", circle_wallet_id: "wallet-op", address: "0x97F85033bBD83870a841cF7153F35b387746B6b6", balance: "10" };
const SIGNER_ADDRESS = "0x5aF3107A4000000000000000000000000000b0b0";
const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const config: VestiarionConfig = { ...base, chain: { ...base.chain, circleApiKey: "TEST_API_KEY:k:s", circleEntitySecret: "5eed".repeat(16) } };

interface SignerRow {
  org_id: string;
  circle_wallet_id: string;
  address: string;
  delegate_tx_id: string | null;
  delegate_tx_hash: string | null;
}

function database(start: { signer?: SignerRow | null } = {}) {
  let signer: SignerRow | null = start.signer ?? null;
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (request.method === "GET" && request.path === "/rest/v1/accounts") return { body: wantsObject ? OPERATING : [OPERATING] };
    if (request.path === "/rest/v1/gateway_signers") {
      if (request.method === "GET") return wantsObject ? (signer ? { body: signer } : { status: 406, body: { code: "PGRST116", message: "no rows" } }) : { body: signer ? [signer] : [] };
      if (request.method === "POST") {
        const row = request.body as SignerRow;
        if (!signer) signer = { ...row, delegate_tx_id: null, delegate_tx_hash: null };
        return { body: [] };
      }
      if (request.method === "PATCH") {
        signer = { ...(signer as SignerRow), ...(request.body as Partial<SignerRow>) };
        return { body: [signer] };
      }
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  return { fake, signer: () => signer };
}

function circle(options: { failDeposit?: boolean; failDelegate?: boolean } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let executions = 0;
  const transactions = new Map<string, { state: string; txHash: string }>();
  const client = {
    listWalletSets: vi.fn(async () => ({ data: { walletSets: [{ id: "set-1", name: TREASURY_WALLET_SET }] } })),
    getWallet: vi.fn(),
    getWalletSet: vi.fn(),
    createWalletSet: vi.fn(async () => ({ data: { walletSet: { id: "set-new" } } })),
    createWallets: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "createWallets", input });
      return { data: { wallets: [{ id: "wallet-signer", address: SIGNER_ADDRESS }] } };
    }),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      calls.push({ method: "execute", input });
      executions += 1;
      const id = `tx-${executions}`;
      const failed =
        (options.failDeposit && input.abiFunctionSignature === "deposit(address,uint256)") ||
        (options.failDelegate && input.abiFunctionSignature === "addDelegate(address,address)");
      transactions.set(id, { state: failed ? "FAILED" : "COMPLETE", txHash: `0xhash${executions}` });
      return { data: { id } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: { transaction: { id, state: transactions.get(id)?.state ?? "COMPLETE", txHash: transactions.get(id)?.txHash, blockchain: "ARC-TESTNET" } },
    })),
  };
  return { client: client as unknown as GatewayFundingClient, calls };
}

const balance = (async () => new Response(JSON.stringify({ balances: [{ domain: 26, balance: "3" }] }), { status: 200 })) as unknown as typeof fetch;

beforeEach(() => appendLedgerEntry.mockClear());

async function fund(db: ReturnType<typeof database>, c: ReturnType<typeof circle>, requestId = "req-1", amount = 3) {
  return runWith(orgTestContext({ config, client: db.fake.client, orgId: ORG, userId: USER }), () =>
    fundGateway({ actorId: USER, amount, requestId }, { client: () => c.client, fetch: balance })
  );
}

describe("funding a Gateway balance", () => {
  it("creates the signer as a Circle EOA under a key of its own, adds it as the operating wallet's delegate, then approves and deposits", async () => {
    const db = database();
    const c = circle();
    const result = await fund(db, c);

    expect(result).toEqual({ signerAddress: SIGNER_ADDRESS, depositTxHash: "0xhash3", balanceUsdc: 3 });
    expect(c.calls[0]).toEqual({
      method: "createWallets",
      input: { blockchains: ["ARC-TESTNET"], count: 1, walletSetId: "set-1", accountType: "EOA", idempotencyKey: walletIdempotencyKey(ORG, "gateway-signer") },
    });
    expect(c.calls.slice(1).map((call) => [call.input.walletId, call.input.contractAddress, call.input.abiFunctionSignature, call.input.abiParameters, call.input.idempotencyKey])).toEqual([
      ["wallet-op", GATEWAY_WALLET, "addDelegate(address,address)", ["0x3600000000000000000000000000000000000000", SIGNER_ADDRESS], gatewayStepKey(`${ORG}/delegate`)],
      ["wallet-op", "0x3600000000000000000000000000000000000000", "approve(address,uint256)", [GATEWAY_WALLET, "3000000"], gatewayStepKey(`${ORG}/fund/req-1/approve`)],
      ["wallet-op", GATEWAY_WALLET, "deposit(address,uint256)", ["0x3600000000000000000000000000000000000000", "3000000"], gatewayStepKey(`${ORG}/fund/req-1/deposit`)],
    ]);
    expect(db.signer()).toMatchObject({ circle_wallet_id: "wallet-signer", address: SIGNER_ADDRESS, delegate_tx_id: "tx-1", delegate_tx_hash: "0xhash1" });
    expect(appendLedgerEntry.mock.calls.map(([entry]) => entry.action)).toEqual(["gateway_signer_created", "gateway_delegate_added", "gateway_deposit"]);
    expect(appendLedgerEntry.mock.calls[2][0].detail).toMatchObject({
      by: USER,
      amountUsdc: 3,
      depositor: OPERATING.address,
      signer: SIGNER_ADDRESS,
      approveTxHash: "0xhash2",
      depositTxHash: "0xhash3",
    });
  });

  it("uses the signer and delegate it already has: a second funding only approves and deposits", async () => {
    const db = database({ signer: { org_id: ORG, circle_wallet_id: "wallet-signer", address: SIGNER_ADDRESS, delegate_tx_id: "tx-0", delegate_tx_hash: "0xdelegated" } });
    const c = circle();
    await fund(db, c, "req-2", 1.5);
    expect(c.calls.map((call) => call.input.abiFunctionSignature ?? call.method)).toEqual(["approve(address,uint256)", "deposit(address,uint256)"]);
    expect(c.calls[1].input.abiParameters).toEqual(["0x3600000000000000000000000000000000000000", "1500000"]);
    expect(appendLedgerEntry.mock.calls.map(([entry]) => entry.action)).toEqual(["gateway_deposit"]);
  });

  it("stops when Circle fails the deposit, and records no deposit", async () => {
    const db = database({ signer: { org_id: ORG, circle_wallet_id: "wallet-signer", address: SIGNER_ADDRESS, delegate_tx_id: "tx-0", delegate_tx_hash: "0xdelegated" } });
    await expect(fund(db, circle({ failDeposit: true }), "req-3", 1)).rejects.toThrow("Circle did not complete the deposit into Gateway (FAILED)");
    expect(appendLedgerEntry).not.toHaveBeenCalled();
  });

  it("says a step Circle failed moved nothing, and that the request may be made again as a new one (review I5)", async () => {
    const db = database({ signer: { org_id: ORG, circle_wallet_id: "wallet-signer", address: SIGNER_ADDRESS, delegate_tx_id: "tx-0", delegate_tx_hash: "0xdelegated" } });
    const failed = await fund(db, circle({ failDeposit: true }), "req-3", 1).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(GatewayStepFailed);
    expect((failed as Error).message).toBe("Circle did not complete the deposit into Gateway (FAILED). Nothing was moved into Gateway; try again.");
  });

  it("adds the delegate under a new key after Circle failed the first one, never answered with the failed one again (review I5)", async () => {
    const db = database();
    await expect(fund(db, circle({ failDelegate: true }), "req-5", 1)).rejects.toBeInstanceOf(GatewayStepFailed);
    expect(db.signer()).toMatchObject({ delegate_tx_id: "tx-1", delegate_tx_hash: null });

    const again = circle();
    await fund(db, again, "req-6", 1);
    expect(again.calls.find((call) => call.input.abiFunctionSignature === "addDelegate(address,address)")?.input.idempotencyKey).toBe(gatewayStepKey(`${ORG}/delegate/after/tx-1`));
    expect(db.signer()).toMatchObject({ delegate_tx_hash: "0xhash1" });
  });

  it("refuses more than the operating wallet holds, before calling Circle (review I5)", async () => {
    const c = circle();
    await expect(fund(database(), c, "req-7", 12)).rejects.toThrow("The operating wallet holds 10 USDC, less than the 12 USDC to move into Gateway.");
    expect(c.calls).toEqual([]);
  });

  it("refuses an amount that is not positive, before calling Circle", async () => {
    const c = circle();
    await expect(fund(database(), c, "req-4", 0)).rejects.toThrow("Enter an amount greater than zero.");
    expect(c.calls).toEqual([]);
  });
});

describe("what the Treasury page shows of the Gateway balance", () => {
  const read = (db: ReturnType<typeof database>, fetcher: typeof fetch = balance) =>
    runWith(orgTestContext({ config, client: db.fake.client, orgId: ORG, userId: USER }), () => readGatewayState({ fetch: fetcher }));

  it("is nothing before the first funding", async () => {
    expect(await read(database())).toEqual({ signerAddress: null, balanceUsdc: null });
  });

  it("is the signer and the balance Gateway holds for the operating wallet", async () => {
    const db = database({ signer: { org_id: ORG, circle_wallet_id: "wallet-signer", address: SIGNER_ADDRESS, delegate_tx_id: "tx-0", delegate_tx_hash: "0xdelegated" } });
    expect(await read(db)).toEqual({ signerAddress: SIGNER_ADDRESS, balanceUsdc: 3 });
  });

  it("is the signer with no balance when Gateway does not answer", async () => {
    const db = database({ signer: { org_id: ORG, circle_wallet_id: "wallet-signer", address: SIGNER_ADDRESS, delegate_tx_id: "tx-0", delegate_tx_hash: "0xdelegated" } });
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await read(db, down)).toEqual({ signerAddress: SIGNER_ADDRESS, balanceUsdc: null });
  });
});
