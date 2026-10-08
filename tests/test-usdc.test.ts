import { beforeEach, describe, expect, it, vi } from "vitest";
import { cashOutlook } from "@/lib/cash-outlook";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { txUrl } from "@/lib/payee-chains";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { addTestUsdc, readTestUsdcWeek, TestUsdcError, type FloatClientFactory } from "@/lib/test-usdc";
import { ceilCents, testUsdcKey } from "@/lib/test-usdc-rules";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T2–T5): a shadow workspace on
 * Arc testnet takes what its open bills need from Vestiarion's float, worked out again at the moment of adding, within
 * its weekly limit and the float's USDC, under a key two clicks share, and signed.
 */

const { ledgerMock, providerMock, paymentsMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), providerMock: vi.fn(), paymentsMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/circle", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle")>()), getChainProvider: providerMock }));
vi.mock("@/lib/payments-switch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/payments-switch")>()), assertPaymentsEnabled: paymentsMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a";
const MEMBER = "a1b2c3d4-0000-4000-8000-0000000002a1";
const FLOAT = "0xf10a7000000000000000000000000000000000f1";
const OPERATING = "0x0be2a7000000000000000000000000000000000a";
const base = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  HOSTED_CIRCLE_API_KEY: "hosted-key",
  HOSTED_CIRCLE_ENTITY_SECRET: "hosted-secret",
  SHADOW_FLOAT_WALLET_ID: "float-wallet",
});
const config: VestiarionConfig = { ...base, chain: { ...base.chain, hostedAvailable: true } };
const NOW = Date.parse("2026-10-08T12:00:00Z");
const USDC_TOKEN = { id: "usdc-token", symbol: "USDC", tokenAddress: "0x3600000000000000000000000000000000000000", blockchain: "ARC-TESTNET", isNative: false };

function circle(floatUsdc = "10000") {
  const createTransaction = vi.fn<(request: Record<string, unknown>) => Promise<{ data: { id: string } }>>(async () => ({ data: { id: "tx-1" } }));
  const client = {
    getWallet: vi.fn(async () => ({ data: { wallet: { id: "float-wallet", address: FLOAT } } })),
    getWalletTokenBalance: vi.fn(async () => ({ data: { tokenBalances: [{ token: USDC_TOKEN, amount: floatUsdc }] } })),
    createTransaction,
    getTransaction: vi.fn(),
  };
  const factory = vi.fn(() => client);
  return { factory: factory as unknown as FloatClientFactory, calls: factory, client, createTransaction };
}
const settled = (status: "confirmed" | "pending", txHash?: string) =>
  vi.fn(async () => (status === "confirmed" ? { status, transaction: { id: "tx-1", txHash, state: "CONFIRMED" } } : { status })) as never;

const PAYABLE = (bill: number) => ({ id: "inv-1", direction: "payable", counterparty_id: "cp-1", counterparties: { name: "Firm Studio" }, amount: String(bill), currency: "USDC", due_date: "2026-10-09", status: "pending", scheduled_for: null });

/** One open payable of `bill` USDC due tomorrow, the operating account, shadow mode on, and `grants` earlier entries. */
function workspace(over: { shadow?: boolean; bill?: number; grants?: Array<{ ts: string; detail: Record<string, unknown> }>; operating?: boolean } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/shadow_modes") return { body: over.shadow === false ? [] : [{ currency: "USDC", started_at: "2026-10-07T00:00:00Z", started_by: MEMBER }] };
    if (r.path === "/rest/v1/accounts")
      return {
        body:
          over.operating === false
            ? []
            : [{ id: "op", name: "Operating", kind: "operating", chain: "ARC-TESTNET", token: "USDC", address: OPERATING, circle_wallet_id: "op-wallet", balance: "999", apy: "0" }],
      };
    if (r.path === "/rest/v1/invoices") return { body: [PAYABLE(over.bill ?? 500)] };
    if (r.path === "/rest/v1/milestones") return { body: [] };
    if (r.path === "/rest/v1/ledger_entries") return { body: over.grants ?? [] };
    return { body: [] };
  };
}

/** Safe to spend today for one open payable of `bill` and `operatingUsdc` in the wallet, as the console works it out. */
const safeToSpend = (bill: number, operatingUsdc: number) =>
  cashOutlook({
    now: NOW,
    operatingUsdc,
    payables: [{ id: "inv-1", counterparty: "Firm Studio", amount: bill, currency: "USDC", due_date: "2026-10-09", status: "pending", scheduled_for: null }],
    milestones: [],
    receivables: [],
  }).safeToSpend;

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>, c: VestiarionConfig = config) => runWith(orgTestContext({ config: c, client: fake.client, orgId: ORG, userId: MEMBER }), fn);
const provider = (operatingUsdc: number) => ({
  mode: "live",
  network: { id: "arc-testnet", circleBlockchain: "ARC-TESTNET" },
  getTokenBalance: vi.fn(async () => ({ accountId: "op", chain: "ARC-TESTNET", token: "USDC", balance: operatingUsdc })),
});
const add = (deps: Parameters<typeof addTestUsdc>[1]) => run(() => addTestUsdc({ actorId: MEMBER }, { now: NOW, settle: settled("confirmed", "0xabc"), ...deps }));
const within = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  providerMock.mockReset().mockReturnValue(provider(20));
  paymentsMock.mockReset().mockResolvedValue(undefined);
});

describe("addTestUsdc", () => {
  it("sends what the open bills need from the float to the operating wallet, and signs it", async () => {
    const { factory, calls, createTransaction } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    const expected = ceilCents(-safeToSpend(500, 20));
    expect(expected).toBeGreaterThan(480);

    expect(await add({ circle: factory })).toEqual({ amount: expected, status: "confirmed", txHash: "0xabc", txUrl: txUrl("arc-testnet", "0xabc") });
    expect(calls).toHaveBeenCalledWith({ apiKey: "hosted-key", entitySecret: "hosted-secret" });
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "float-wallet",
        tokenId: "usdc-token",
        destinationAddress: OPERATING,
        amount: [expected.toFixed(6)],
        idempotencyKey: testUsdcKey(ORG, 1),
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      })
    );
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "human",
        domain: "treasury",
        action: "test_usdc_added",
        summary: `Added ${expected} test USDC on Arc testnet to the operating wallet, from Vestiarion's test USDC float, for shadow mode`,
        detail: { by: MEMBER, amount: expected, from: FLOAT, to: OPERATING, transferId: "tx-1", txHash: "0xabc", status: "confirmed", shortfall: expected, weeklyLimit: 5000 },
      })
    );
  });

  it("works out the amount again at the moment of adding, from the chain's balance", async () => {
    // The account's row says 999, the page's figure may say anything: the operating wallet's USDC on chain decides.
    expect(safeToSpend(500, 600)).toBeGreaterThanOrEqual(0);
    providerMock.mockReturnValue(provider(600));
    const { factory, createTransaction } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    await expect(add({ circle: factory })).rejects.toMatchObject({ code: "nothing_needed", message: "Nothing to add: the operating wallet covers your open bills." });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("counts this week's grants: the key's ordinal and the limit", async () => {
    const { factory, createTransaction } = circle();
    const grants = [
      { ts: within(2), detail: { amount: 2000 } },
      { ts: within(48), detail: { amount: 2900 } },
      { ts: within(24 * 10), detail: { amount: 4000 } },
    ];
    fake = fakeSupabase(workspace({ bill: 500, grants }));
    expect((await add({ circle: factory })).amount).toBe(100);
    // Every grant ever counts towards the ordinal; only the last 7 days' towards the limit.
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: ["100.000000"], idempotencyKey: testUsdcKey(ORG, 4) }));
  });

  it("two calls that counted the same entries send under one key", async () => {
    const { factory, createTransaction } = circle();
    fake = fakeSupabase(workspace({ bill: 500, grants: [{ ts: within(2), detail: { amount: 20 } }] }));
    await Promise.all([add({ circle: factory }), add({ circle: factory })]);
    expect(createTransaction).toHaveBeenCalledTimes(2);
    const keys = createTransaction.mock.calls.map(([request]) => request.idempotencyKey);
    expect(keys[0]).toBe(testUsdcKey(ORG, 2));
    expect(keys[1]).toBe(keys[0]);
  });

  it("records a transfer still processing, so the weekly limit counts it", async () => {
    const { factory } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    const result = await add({ circle: factory, settle: settled("pending") });
    expect(result).toMatchObject({ status: "pending", txHash: null, txUrl: null });
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "test_usdc_added", detail: expect.objectContaining({ txHash: null, status: "pending", transferId: "tx-1" }) }));
  });

  describe("refuses, before Circle moves anything", () => {
    const refused = async (code: string, setup: { config?: VestiarionConfig; float?: string; workspace?: Parameters<typeof workspace>[0] } = {}) => {
      const { factory, createTransaction } = circle(setup.float);
      fake = fakeSupabase(workspace({ bill: 500, ...setup.workspace }));
      const attempt = run(() => addTestUsdc({ actorId: MEMBER }, { circle: factory, now: NOW, settle: settled("confirmed", "0xabc") }), setup.config ?? config);
      await expect(attempt).rejects.toBeInstanceOf(TestUsdcError);
      await expect(attempt).rejects.toMatchObject({ code });
      expect(createTransaction).not.toHaveBeenCalled();
      expect(ledgerMock).not.toHaveBeenCalled();
      return attempt.then(
        () => new Error("added"),
        (error: Error) => error
      );
    };

    it("outside shadow mode", async () => {
      expect((await refused("not_in_shadow", { workspace: { shadow: false } })).message).toBe("Test USDC is for shadow mode. An owner turns it on in Settings.");
    });

    it("without the float, or without the hosted account it lives in", async () => {
      const noFloat = { ...config, shadowFloat: { weeklyLimit: 5000 } };
      expect((await refused("unavailable", { config: noFloat })).message).toBe("Vestiarion's test USDC float is not set up on this deployment.");
      await refused("unavailable", { config: { ...config, chain: { ...config.chain, hostedCircleApiKey: undefined } } });
    });

    it("before the workspace is live, or without an operating wallet", async () => {
      providerMock.mockReturnValue({ ...provider(0), mode: "simulate" });
      expect((await refused("not_live")).message).toBe("Go live on Arc testnet first: test USDC goes to the operating wallet.");
      providerMock.mockReturnValue(provider(0));
      await refused("not_live", { workspace: { operating: false } });
    });

    it("on Arc mainnet", async () => {
      expect((await refused("mainnet", { config: { ...config, network: "arc-mainnet" } })).message).toBe(
        "Test USDC is for Arc testnet. On Arc mainnet the agent pays your real bills."
      );
    });

    it("once the week's limit is used", async () => {
      const grants = [
        { ts: within(1), detail: { amount: 3000 } },
        { ts: within(30), detail: { amount: 2000 } },
      ];
      expect((await refused("limit_reached", { workspace: { grants } })).message).toBe("This workspace took its 5,000 test USDC for this week.");
    });

    it("when the float holds less than 1 USDC", async () => {
      expect((await refused("float_empty", { float: "0.5" })).message).toBe("Vestiarion's test USDC float is empty just now.");
    });
  });

  it("refuses while payments are off, before reading the float", async () => {
    paymentsMock.mockRejectedValue(new PaymentsDisabledError());
    const { factory, client, createTransaction } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    await expect(add({ circle: factory })).rejects.toBeInstanceOf(PaymentsDisabledError);
    expect(client.getWalletTokenBalance).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("readTestUsdcWeek", () => {
  it("adds up the last 7 days' grants and names the newest", async () => {
    fake = fakeSupabase(
      workspace({
        grants: [
          { ts: "2026-10-08T11:00:00Z", detail: { amount: 480.01, txHash: "0xabc" } },
          { ts: "2026-09-20T00:00:00Z", detail: { amount: 100 } },
        ],
      })
    );
    expect(await run(() => readTestUsdcWeek(NOW))).toEqual({
      takenThisWeek: 480.01,
      weeklyLimit: 5000,
      latest: { amount: 480.01, at: "2026-10-08T11:00:00Z", txHash: "0xabc" },
    });
    const read = fake.requests.find((r) => r.path === "/rest/v1/ledger_entries");
    expect(read?.params.get("action")).toBe("eq.test_usdc_added");
  });

  it("names nothing before the first grant", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => readTestUsdcWeek(NOW))).toEqual({ takenThisWeek: 0, weeklyLimit: 5000, latest: null });
  });
});
