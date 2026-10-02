import { decodeFunctionData, encodeAbiParameters, parseAbi, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import { usycStepKey, USYC_TELLER, UsycSubscriptionsClosedError } from "@/lib/circle/usyc";
import type { ChainConfig } from "@/lib/config";
import { ARC_TESTNET_USDC } from "@/lib/fx/quote";

/**
 * The live provider's real USYC moves (docs/superpowers/specs/2026-10-02-usyc-live-design.md R2–R7):
 * a sweep approves the Teller and deposits from the operating wallet to the reserve wallet; a
 * redemption redeems from the reserve wallet to the operating wallet; each step under a key derived
 * from the move's, waited for. Nothing is sent while USYC cannot be bought.
 */

vi.mock("server-only", () => ({}));
const ACCOUNTS: Record<string, { id: string; chain: string; token: string; circle_wallet_id: string; address: string }> = {
  "operating-1": { id: "operating-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-op", address: "0x97f85033bbd83870a841cf7153f35b387746b6b6" },
  "reserve-1": { id: "reserve-1", chain: "ARC-TESTNET", token: "USYC", circle_wallet_id: "wallet-res", address: "0xa8a4ced0cda82b24d11e0386f066eb8c27fd4887" },
};
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          single: async () => ({ data: ACCOUNTS[id], error: null }),
        }),
      }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const CHAIN: ChainConfig = { circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", usdcTokenId: "usdc-token-id", arcRpcUrl: "https://arc.test" };
const PRICE = 1_138_897_837_595_301_387n;
const ORACLE = "0x52b56c7642E71dc54714d879127d97cd0B3D4581";

const ABI = parseAbi([
  "function mintPrice() view returns (int256)",
  "function oracle() view returns (address)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function balanceOf(address) view returns (uint256)",
]);

function arc(state: { open: boolean; shares: bigint }) {
  return (async (_url: string, init: RequestInit) => {
    const { params } = JSON.parse(String(init.body)) as { params: [{ data: Hex }] };
    const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data });
    const result =
      functionName === "oracle"
        ? encodeAbiParameters([{ type: "address" }], [ORACLE])
        : functionName === "latestRoundData"
          ? encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [1n, PRICE, 0n, 0n, 1n])
          : functionName === "mintPrice"
            ? encodeAbiParameters([{ type: "int256" }], [state.open ? PRICE : 0n])
            : encodeAbiParameters([{ type: "uint256" }], [state.shares]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
}

function circle(states: Record<string, string> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const client = {
    createTransaction: vi.fn(() => Promise.reject(new Error("a USYC move makes no transfer"))),
    getWalletTokenBalance: vi.fn(() => Promise.reject(new Error("unexpected"))),
    signTypedData: vi.fn(() => Promise.reject(new Error("unexpected"))),
    createContractExecutionTransaction: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return { data: { id: `tx-${created.length}` } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: { transaction: { id, state: states[id] ?? "COMPLETE", txHash: states[id] === "FAILED" ? undefined : `0x${id.replace("tx-", "").padStart(64, "a")}` } },
    })),
  };
  return { client: client as unknown as LiveProviderClient, created };
}

const MOVE = { accountId: "operating-1", reserveAccountId: "reserve-1", key: "cycle-7/sweep_to_usyc" };

describe("LiveProvider: a sweep into USYC", () => {
  it("approves the Teller for the USDC, then deposits it for the reserve wallet, each under its own key", async () => {
    const c = circle();
    const result = await new LiveProvider(CHAIN, { client: c.client, fetch: arc({ open: true, shares: 0n }) }).depositToEarn({ ...MOVE, amount: 10 });

    expect(c.created).toHaveLength(2);
    expect(c.created[0]).toMatchObject({
      walletId: "wallet-op",
      contractAddress: ARC_TESTNET_USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [USYC_TELLER, "10000000"],
      idempotencyKey: usycStepKey("cycle-7/sweep_to_usyc/approve"),
    });
    expect(c.created[1]).toMatchObject({
      walletId: "wallet-op",
      contractAddress: USYC_TELLER,
      abiFunctionSignature: "deposit(uint256,address)",
      abiParameters: ["10000000", ACCOUNTS["reserve-1"].address],
      idempotencyKey: usycStepKey("cycle-7/sweep_to_usyc/deposit"),
    });
    expect(result.execution).toEqual({
      approveTxHash: `0x${"1".padStart(64, "a")}`,
      depositTxHash: `0x${"2".padStart(64, "a")}`,
      shares: 8.780418,
      price: 1.138897,
    });
    expect(result.txRef).toBe(result.execution?.depositTxHash);
  });

  it("sends nothing while USYC cannot be bought (R4)", async () => {
    const c = circle();
    await expect(new LiveProvider(CHAIN, { client: c.client, fetch: arc({ open: false, shares: 0n }) }).depositToEarn({ ...MOVE, amount: 10 })).rejects.toBeInstanceOf(UsycSubscriptionsClosedError);
    expect(c.created).toEqual([]);
  });

  it("deposits nothing when the approval failed, and says so", async () => {
    const c = circle({ "tx-1": "FAILED" });
    await expect(new LiveProvider(CHAIN, { client: c.client, fetch: arc({ open: true, shares: 0n }) }).depositToEarn({ ...MOVE, amount: 10 })).rejects.toThrow("approve failed (FAILED) on Arc testnet");
    expect(c.created).toHaveLength(1);
  });

  it("refuses a move with no reserve account or key, before anything is sent", async () => {
    const c = circle();
    await expect(new LiveProvider(CHAIN, { client: c.client, fetch: arc({ open: true, shares: 0n }) }).depositToEarn({ accountId: "operating-1", amount: 10 })).rejects.toThrow(/needs the reserve account and a key/);
    expect(c.created).toEqual([]);
  });
});

describe("LiveProvider: a redemption from USYC", () => {
  it("redeems, from the reserve wallet to the operating wallet, the whole shares that cover the USDC (R5)", async () => {
    const c = circle();
    const result = await new LiveProvider(CHAIN, { client: c.client, fetch: arc({ open: false, shares: 20_000_000n }) }).withdrawFromEarn({ ...MOVE, key: "cycle-8/redeem_from_usyc", amount: 5 });

    expect(c.created).toEqual([
      expect.objectContaining({
        walletId: "wallet-res",
        contractAddress: USYC_TELLER,
        abiFunctionSignature: "redeem(uint256,address,address)",
        abiParameters: ["4390210", ACCOUNTS["operating-1"].address, ACCOUNTS["reserve-1"].address],
        idempotencyKey: usycStepKey("cycle-8/redeem_from_usyc/redeem"),
      }),
    ]);
    expect(result.execution).toEqual({ redeemTxHash: `0x${"1".padStart(64, "a")}`, shares: 4.39021, price: 1.138897 });
    // What stays in the reserve, at the price.
    expect(result.positionValue).toBe(17.777956);
  });

  it("never redeems more than the reserve holds, and nothing from an empty one", async () => {
    const all = circle();
    await new LiveProvider(CHAIN, { client: all.client, fetch: arc({ open: true, shares: 1_000_000n }) }).withdrawFromEarn({ ...MOVE, amount: 50 });
    expect((all.created[0].abiParameters as string[])[0]).toBe("1000000");

    const none = circle();
    await expect(new LiveProvider(CHAIN, { client: none.client, fetch: arc({ open: true, shares: 0n }) }).withdrawFromEarn({ ...MOVE, amount: 5 })).rejects.toThrow("The reserve wallet holds no USYC to redeem");
    expect(none.created).toEqual([]);
  });
});

describe("LiveProvider: the reserve's position (R3)", () => {
  it("is its USYC at the oracle's latest price", async () => {
    const c = circle();
    expect(await new LiveProvider(CHAIN, { client: c.client, fetch: arc({ open: false, shares: 5_000_000n }) }).getEarnPosition("reserve-1")).toEqual({ shares: 5, valueUsdc: 5.694489, price: 1.138897 });
  });
});
