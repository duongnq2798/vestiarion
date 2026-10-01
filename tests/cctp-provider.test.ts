import { describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import { TOKEN_MESSENGER_V2 } from "@/lib/circle/cctp";
import type { ChainConfig } from "@/lib/config";

/**
 * The live provider paying a payee on another chain through CCTP V2 with the Forwarding Service
 * (docs/superpowers/specs/2026-10-01-cctp-payouts-design.md X2, X8, X9): approve, then burn, each with
 * an idempotency key derived from the payment attempt's, so a resubmission never burns twice; the
 * mint is read from Iris, and reconciliation reads the burn and the mint, never sending anything.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { id: "account-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-1" }, error: null }) }),
      }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const CHAIN: ChainConfig = { circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", usdcTokenId: "usdc-token-id" };
const KEY = "00000000-0000-4000-8000-000000000001";
const PAYEE = "0x19801dAA2F1E5E5e707b7E57Ff664f3d27fFdd12";
const BURN_HASH = "0xb0b0000000000000000000000000000000000000000000000000000000000001";

const TRANSFER = { fromAccountId: "account-1", toAddress: PAYEE, amount: 1.5, memo: "Invoice x", idempotencyKey: KEY, destinationChain: "BASE-SEPOLIA" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const FEES = [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 54277, med: 54277, high: 54613 } }];

function iris(mint: string | null): typeof fetch {
  return vi.fn(async (url: string) => {
    if (url.includes("/fees/")) return json(FEES);
    return json({ messages: [mint ? { status: "complete", forwardTxHash: mint } : { status: "pending_confirmations" }] });
  }) as unknown as typeof fetch;
}

function circle() {
  const executions: Array<Record<string, unknown>> = [];
  const client = {
    createTransaction: vi.fn(() => Promise.reject(new Error("a bridge makes no plain transfer"))),
    getWalletTokenBalance: vi.fn(() => Promise.reject(new Error("unexpected"))),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      executions.push(input);
      return { data: { id: String(input.abiFunctionSignature).startsWith("approve") ? "approve-tx" : "burn-tx", state: "INITIATED" } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: {
        transaction: {
          id,
          state: "COMPLETE",
          txHash: id === "burn-tx" ? BURN_HASH : "0xapprove",
          blockchain: "ARC-TESTNET",
          createDate: "2026-10-01T00:00:00Z",
          firstConfirmDate: "2026-10-01T00:00:01Z",
          networkFeeInUSD: "0.01",
        },
      },
    })),
  };
  return { client: client as unknown as LiveProviderClient, executions, raw: client };
}

describe("LiveProvider: a payee on another chain", () => {
  it("approves, then burns with the forwarding hook, each under its own key derived from the attempt", async () => {
    const { client, executions } = circle();
    const provider = new LiveProvider(CHAIN, { client, fetch: iris("0xmint"), bridgeMintWaitMs: 0 });

    const result = await provider.transfer(TRANSFER);

    expect(executions.map((call) => call.abiFunctionSignature)).toEqual([
      "approve(address,uint256)",
      "depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)",
    ]);
    expect(executions[0]).toMatchObject({ walletId: "wallet-1", abiParameters: [TOKEN_MESSENGER_V2, "1554613"] });
    expect((executions[1].abiParameters as string[])[1]).toBe("6");
    const [approveKey, burnKey] = executions.map((call) => call.idempotencyKey as string);
    expect(new Set([approveKey, burnKey, KEY]).size).toBe(3);
    for (const key of [approveKey, burnKey]) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(result).toMatchObject({
      providerTxId: "cctp:burn-tx",
      txHash: BURN_HASH,
      status: "confirmed",
      mintTxHash: "0xmint",
      destinationChain: "BASE-SEPOLIA",
      bridgeFeeUsdc: 0.054613,
    });
  });

  it("is in flight, not paid, while the mint has not been forwarded", async () => {
    const { client } = circle();
    const provider = new LiveProvider(CHAIN, { client, fetch: iris(null), bridgeMintWaitMs: 0 });
    expect(await provider.transfer(TRANSFER)).toMatchObject({ providerTxId: "cctp:burn-tx", txHash: BURN_HASH, status: "pending", mintTxHash: null });
  });

  it("uses the same keys when the same attempt is sent again, so Circle creates neither call twice", async () => {
    const first = circle();
    await new LiveProvider(CHAIN, { client: first.client, fetch: iris(null), bridgeMintWaitMs: 0 }).transfer(TRANSFER);
    const second = circle();
    await new LiveProvider(CHAIN, { client: second.client, fetch: iris(null), bridgeMintWaitMs: 0 }).transfer(TRANSFER);
    expect(second.executions.map((call) => call.idempotencyKey)).toEqual(first.executions.map((call) => call.idempotencyKey));
  });

  it("refuses EURC across chains, before anything is sent (X6)", async () => {
    const { client, executions } = circle();
    const provider = new LiveProvider(CHAIN, { client, fetch: iris(null), bridgeMintWaitMs: 0 });
    await expect(provider.transfer({ ...TRANSFER, token: "EURC" })).rejects.toThrow(/Only USDC/);
    expect(executions).toEqual([]);
  });

  it("does not burn when the approve did not confirm", async () => {
    const { client, executions, raw } = circle();
    raw.getTransaction.mockImplementation((async ({ id }: { id: string }) => ({
      data: { transaction: { id, state: "FAILED", errorReason: "INSUFFICIENT_TOKEN", blockchain: "ARC-TESTNET", createDate: "2026-10-01T00:00:00Z" } },
    })) as never);
    const provider = new LiveProvider(CHAIN, { client, fetch: iris(null), bridgeMintWaitMs: 0 });
    const result = await provider.transfer(TRANSFER);
    expect(executions).toHaveLength(1);
    expect(result).toMatchObject({ status: "failed", providerTxId: "cctp-approve:approve-tx" });
  });

  it("reconciles a bridge by its burn and the mint Iris reports, and sends nothing", async () => {
    const { client, executions } = circle();
    const pending = await new LiveProvider(CHAIN, { client, fetch: iris(null), bridgeMintWaitMs: 0 }).reconcileTransfer("cctp:burn-tx");
    expect(pending).toMatchObject({ status: "pending", txHash: BURN_HASH, mintTxHash: null });
    const done = await new LiveProvider(CHAIN, { client, fetch: iris("0xmint"), bridgeMintWaitMs: 0 }).reconcileTransfer("cctp:burn-tx");
    expect(done).toMatchObject({ status: "confirmed", providerTxId: "cctp:burn-tx", txHash: BURN_HASH, mintTxHash: "0xmint" });
    expect(executions).toEqual([]);
  });
});

describe("SimulateProvider: a payee on another chain (X10)", () => {
  it("confirms a simulated bridge at once, with a simulated burn and mint", async () => {
    const provider = new SimulateProvider();
    const account = vi.spyOn(provider as unknown as { account: (id: string) => Promise<unknown> }, "account");
    account.mockResolvedValue({ id: "account-1", chain: "ARC-TESTNET", token: "USDC", balance: "100" });
    const addBalance = vi
      .spyOn(provider as unknown as { addBalance: (id: string, delta: number, current: number) => Promise<void> }, "addBalance")
      .mockResolvedValue();
    const result = await provider.transfer(TRANSFER);
    expect(result).toMatchObject({ status: "confirmed", destinationChain: "BASE-SEPOLIA", providerMode: "simulate" });
    expect(result.txHash).toMatch(/^sim_/);
    expect(result.mintTxHash).toMatch(/^sim_/);
    expect(addBalance).toHaveBeenCalledWith("account-1", -1.5, 100);
  });
});
