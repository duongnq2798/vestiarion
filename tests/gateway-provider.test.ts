import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import { SimulateProvider } from "@/lib/circle/simulateProvider";
import { BridgeFeeError } from "@/lib/circle/cctp";
import { burnIntentTypedData, gatewaySalt } from "@/lib/circle/gateway";
import type { ChainConfig } from "@/lib/config";

/**
 * The live provider paying a payee on another chain from the workspace's Gateway balance
 * (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G3, G4): the signer signs a burn
 * intent whose salt comes from the attempt, Gateway forwards the mint, and reconciliation reads the
 * transfer and never sends.
 */

const { signer } = vi.hoisted(() => ({ signer: { current: null as null | { circle_wallet_id: string; address: string } } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: "account-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: "wallet-op", address: DEPOSITOR, balance: "100" }, error: null }),
        }),
        maybeSingle: async () => ({ data: table === "gateway_signers" ? signer.current : null, error: null }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const DEPOSITOR = "0x97F85033bBD83870a841cF7153F35b387746B6b6";
const SIGNER = { circle_wallet_id: "wallet-signer", address: "0x5aF3107A4000000000000000000000000000b0b0" };
const CHAIN: ChainConfig = { circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", usdcTokenId: "usdc-token-id" };
const KEY = "00000000-0000-4000-8000-000000000001";
const PAYEE = "0x19801dAA2F1E5E5e707b7E57Ff664f3d27fFdd12";
const TRANSFER = { fromAccountId: "account-1", toAddress: PAYEE, amount: 1, memo: "Invoice x", idempotencyKey: KEY, destinationChain: "BASE-SEPOLIA", route: "gateway" as const };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function gateway(options: { status?: string; fee?: string } = {}) {
  const posted: Array<{ url: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) posted.push({ url, body: JSON.parse(String(init.body)) });
    if (url.includes("/estimate")) return json({ body: [{ burnIntent: { maxFee: "56724", maxBlockHeight: "66288611" } }], fees: { total: options.fee ?? "0.056724" } });
    if (url.includes("/transfer?")) return json({ transferId: "tr-1" });
    if (url.includes("/transfer/tr-1")) return json({ status: options.status ?? "confirmed", destinationDomain: 6, transactionHash: "0xmint" });
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, posted, raw: fetch };
}

function circle() {
  const client = {
    createTransaction: vi.fn(() => Promise.reject(new Error("a Gateway payout makes no transfer from the wallet"))),
    getWalletTokenBalance: vi.fn(() => Promise.reject(new Error("unexpected"))),
    createContractExecutionTransaction: vi.fn(() => Promise.reject(new Error("a Gateway payout makes no contract call"))),
    getTransaction: vi.fn(() => Promise.reject(new Error("unexpected"))),
    signTypedData: vi.fn<(input: { walletId: string; data: string }) => Promise<{ data: { signature: string } }>>(async () => ({ data: { signature: "0xsigned" } })),
  };
  return { client: client as unknown as LiveProviderClient, raw: client };
}

beforeEach(() => {
  signer.current = SIGNER;
});

describe("LiveProvider: a payout from the Gateway balance", () => {
  it("signs a burn intent salted by the attempt with the signer, sends it with forwarding, and is paid on the mint", async () => {
    const c = circle();
    const g = gateway();
    const result = await new LiveProvider(CHAIN, { client: c.client, fetch: g.fetch, bridgeMintWaitMs: 0 }).transfer(TRANSFER);

    const signed = c.raw.signTypedData.mock.calls[0][0];
    expect(signed.walletId).toBe("wallet-signer");
    const typed = JSON.parse(signed.data) as ReturnType<typeof burnIntentTypedData>;
    expect(typed.primaryType).toBe("BurnIntent");
    expect(typed.message.spec).toMatchObject({ value: "1000000", salt: gatewaySalt(KEY), destinationDomain: 6 });
    expect(typed.message.spec.sourceDepositor.endsWith(DEPOSITOR.slice(2).toLowerCase())).toBe(true);
    expect(typed.message.spec.sourceSigner.endsWith(SIGNER.address.slice(2).toLowerCase())).toBe(true);
    expect(typed.message).toMatchObject({ maxFee: "56724", maxBlockHeight: "66288611" });
    expect(g.posted.find((post) => post.url.includes("/transfer?"))?.body).toEqual([{ burnIntent: typed.message, signature: "0xsigned" }]);

    expect(result).toMatchObject({
      providerTxId: "gateway:tr-1",
      txHash: "0xmint",
      txRef: "0xmint",
      chain: "BASE-SEPOLIA",
      status: "confirmed",
      destinationChain: "BASE-SEPOLIA",
      mintTxHash: "0xmint",
      bridgeFeeUsdc: 0.056724,
      route: "gateway",
    });
    expect(c.raw.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  it("is in flight while Gateway has not minted yet", async () => {
    const result = await new LiveProvider(CHAIN, { client: circle().client, fetch: gateway({ status: "pending" }).fetch, bridgeMintWaitMs: 0 }).transfer(TRANSFER);
    expect(result).toMatchObject({ providerTxId: "gateway:tr-1", status: "pending", txHash: null, txRef: "gateway:tr-1", mintTxHash: null });
  });

  it("sends nothing when Gateway's fee is above what the payment may pay", async () => {
    const c = circle();
    const g = gateway({ fee: "0.5" });
    await expect(new LiveProvider(CHAIN, { client: c.client, fetch: g.fetch, bridgeMintWaitMs: 0 }).transfer({ ...TRANSFER, maxBridgeFeeUsdc: 0.1 })).rejects.toThrow(
      new BridgeFeeError("The Gateway fee to Base Sepolia, 0.5 USDC, is above the 0.1 USDC this payment may pay; nothing was sent.")
    );
    expect(c.raw.signTypedData).not.toHaveBeenCalled();
    expect(g.posted.some((post) => post.url.includes("/transfer?"))).toBe(false);
  });

  it("sends nothing from a workspace with no Gateway signer", async () => {
    signer.current = null;
    const g = gateway();
    await expect(new LiveProvider(CHAIN, { client: circle().client, fetch: g.fetch, bridgeMintWaitMs: 0 }).transfer(TRANSFER)).rejects.toThrow(
      "This workspace has no Gateway balance yet: an owner or admin funds one on Treasury."
    );
    expect(g.raw).not.toHaveBeenCalled();
  });

  it("reconciles a Gateway payout by reading the transfer: never signing or sending", async () => {
    const c = circle();
    const g = gateway();
    const result = await new LiveProvider(CHAIN, { client: c.client, fetch: g.fetch }).reconcileTransfer("gateway:tr-1");
    expect(result).toMatchObject({ providerTxId: "gateway:tr-1", status: "confirmed", mintTxHash: "0xmint", txHash: "0xmint", chain: "BASE-SEPOLIA", destinationChain: "BASE-SEPOLIA" });
    expect(c.raw.signTypedData).not.toHaveBeenCalled();
    expect(g.posted).toEqual([]);
  });

  it("pays through CCTP when the route is not Gateway, as before", async () => {
    const c = circle();
    await expect(new LiveProvider(CHAIN, { client: c.client, fetch: gateway().fetch, bridgeMintWaitMs: 0 }).transfer({ ...TRANSFER, route: "cctp" })).rejects.toThrow();
    expect(c.raw.signTypedData).not.toHaveBeenCalled();
  });
});

describe("SimulateProvider: a Gateway payout in a sandbox", () => {
  it("is simulated like any payout across chains, and names its route", async () => {
    const result = await new SimulateProvider().transfer(TRANSFER);
    expect(result).toMatchObject({ status: "confirmed", destinationChain: "BASE-SEPOLIA", mintTxHash: `sim_mint_${KEY}`, route: "gateway" });
  });
});
