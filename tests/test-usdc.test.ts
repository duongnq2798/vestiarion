import { beforeEach, describe, expect, it, vi } from "vitest";
import { cashOutlook } from "@/lib/cash-outlook";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { txUrl } from "@/lib/payee-chains";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { addTestUsdc, floatAddress, readTestUsdcWeek, TestUsdcError, type FloatClientFactory } from "@/lib/test-usdc";
import { ceilCents, testUsdcKey } from "@/lib/test-usdc-rules";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Test USDC for shadow mode (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T2–T5 and its review fixes): a
 * shadow workspace on Arc testnet takes what its open bills need from Vestiarion's float, worked out again at the
 * moment of adding, within its weekly limit and the float's USDC. Circle's own list of what the float sent the operating
 * wallet decides the week's total and the transfer's key, and a transfer the ledger never recorded is recorded first.
 */

const { ledgerMock, signMock, providerMock, paymentsMock } = vi.hoisted(() => ({
  ledgerMock: vi.fn(),
  signMock: vi.fn(),
  providerMock: vi.fn(),
  paymentsMock: vi.fn(),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  appendLedgerEntry: ledgerMock,
  assertLedgerCanSign: signMock,
}));
vi.mock("@/lib/circle", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle")>()), getChainProvider: providerMock }));
vi.mock("@/lib/payments-switch", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/payments-switch")>()), assertPaymentsEnabled: paymentsMock }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a";
const MEMBER = "a1b2c3d4-0000-4000-8000-0000000002a1";
const FLOAT = "0xf10a7000000000000000000000000000000000f1";
const OPERATING = "0x0be2a7000000000000000000000000000000000a";
const NOW = Date.parse("2026-10-08T12:00:00Z");
const USDC_TOKEN = { id: "usdc-token", symbol: "USDC", tokenAddress: "0x3600000000000000000000000000000000000000", blockchain: "ARC-TESTNET", isNative: false };

/** The platform's configuration, which holds the hosted pair and the float. */
const PLATFORM = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  HOSTED_CIRCLE_API_KEY: "hosted-key",
  HOSTED_CIRCLE_ENTITY_SECRET: "hosted-secret",
  SHADOW_FLOAT_WALLET_ID: "float-wallet",
});
/** A workspace's configuration as `orgConfig` builds it from the platform's: the hosted pair stripped, only its boolean kept (R4). */
const workspaceOf = (platform: VestiarionConfig): VestiarionConfig => ({
  ...platform,
  chain: {
    ...platform.chain,
    hostedCircleApiKey: undefined,
    hostedCircleEntitySecret: undefined,
    hostedAvailable: Boolean(platform.chain.hostedCircleApiKey && platform.chain.hostedCircleEntitySecret),
  },
});

/** A transfer Circle lists from the float to the operating wallet. */
interface Sent {
  id: string;
  state: string;
  amounts: string[];
  createDate: string;
  txHash?: string;
  destinationAddress: string;
  sourceAddress: string;
  transactionType: string;
  blockchain: string;
}
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const sent = (id: string, amount: number, over: Partial<Sent> = {}): Sent => ({
  id,
  state: "COMPLETE",
  amounts: [String(amount)],
  createDate: hoursAgo(2),
  txHash: `0x${id}`,
  destinationAddress: OPERATING,
  sourceAddress: FLOAT,
  transactionType: "OUTBOUND",
  blockchain: "ARC-TESTNET",
  ...over,
});
/** The ledger's entry for a transfer Circle lists. */
const recorded = (transfer: Sent, amount = Number(transfer.amounts[0])) => ({
  ts: transfer.createDate,
  detail: { amount, transferId: transfer.id, txHash: transfer.txHash ?? null, status: "confirmed" },
});

function circle(over: { float?: string; listed?: Sent[]; created?: string; address?: string } = {}) {
  const listed = over.listed ?? [];
  const createTransaction = vi.fn<(request: Record<string, unknown>) => Promise<{ data: { id: string } }>>(async () => ({ data: { id: over.created ?? "tx-new" } }));
  // Newest first, a page at a time after the id it is given, as Circle pages its lists.
  const listTransactions = vi.fn(async (params: { pageSize?: number; pageAfter?: string }) => {
    const start = params.pageAfter ? listed.findIndex((transfer) => transfer.id === params.pageAfter) + 1 : 0;
    return { data: { transactions: listed.slice(start, start + (params.pageSize ?? 50)) } };
  });
  const client = {
    getWallet: vi.fn(async () => ({ data: { wallet: { id: "float-wallet", address: over.address ?? FLOAT } } })),
    getWalletTokenBalance: vi.fn(async () => ({ data: { tokenBalances: [{ token: USDC_TOKEN, amount: over.float ?? "10000" }] } })),
    listTransactions,
    createTransaction,
    getTransaction: vi.fn(),
  };
  const factory = vi.fn(() => client);
  return { factory: factory as unknown as FloatClientFactory, calls: factory, client, createTransaction, listTransactions };
}
const settled = (status: "confirmed" | "pending", over: { id?: string; txHash?: string; amounts?: string[]; destinationAddress?: string } = {}) =>
  vi.fn(async () =>
    status === "confirmed"
      ? { status, transaction: { id: over.id ?? "tx-new", txHash: over.txHash ?? "0xabc", state: "CONFIRMED", amounts: over.amounts, destinationAddress: over.destinationAddress ?? OPERATING } }
      : { status }
  ) as never;

const PAYABLE = (bill: number) => ({ id: "inv-1", direction: "payable", counterparty_id: "cp-1", counterparties: { name: "Firm Studio" }, amount: String(bill), currency: "USDC", due_date: "2026-10-09", status: "pending", scheduled_for: null });

/** One open payable of `bill` USDC due tomorrow, the operating account, shadow mode on, and the ledger's grants. */
function workspace(
  over: {
    shadow?: boolean;
    bill?: number;
    grants?: Array<{ ts: string; detail: Record<string, unknown> }>;
    byTransfer?: Record<string, Array<{ ts: string; detail: Record<string, unknown> }>>;
    operating?: boolean;
  } = {}
) {
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
    if (r.path === "/rest/v1/ledger_entries") {
      const transferId = r.params.get("detail->>transferId");
      return { body: transferId ? (over.byTransfer?.[transferId.replace(/^eq\./, "")] ?? []) : (over.grants ?? []) };
    }
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
/** What a bill of 500 needs with 20 USDC in the wallet. */
const NEED = ceilCents(-safeToSpend(500, 20));

let fake: ReturnType<typeof fakeSupabase>;
/** The workspace's scope as the DAL builds it: its own configuration without the hosted pair, the platform's with it. */
const run = <T,>(fn: () => Promise<T>, platform: VestiarionConfig = PLATFORM) =>
  runWith({ ...orgTestContext({ config: workspaceOf(platform), client: fake.client, orgId: ORG, userId: MEMBER }), platformConfig: platform }, fn);
const provider = (operatingUsdc: number) => ({
  mode: "live",
  network: { id: "arc-testnet", circleBlockchain: "ARC-TESTNET" },
  getTokenBalance: vi.fn(async () => ({ accountId: "op", chain: "ARC-TESTNET", token: "USDC", balance: operatingUsdc })),
});
const add = (deps: Parameters<typeof addTestUsdc>[1], platform?: VestiarionConfig) =>
  run(() => addTestUsdc({ actorId: MEMBER }, { now: NOW, settle: settled("confirmed"), ...deps }), platform);

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  signMock.mockReset().mockReturnValue(undefined);
  providerMock.mockReset().mockReturnValue(provider(20));
  paymentsMock.mockReset().mockResolvedValue(undefined);
});

describe("addTestUsdc", () => {
  it("sends what the open bills need from the float to the operating wallet, with the platform's hosted pair, and signs it", async () => {
    const { factory, calls, createTransaction, listTransactions } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    expect(NEED).toBeGreaterThan(480);

    expect(await add({ circle: factory, settle: settled("confirmed", { amounts: [NEED.toFixed(6)] }) })).toEqual({
      amount: NEED,
      status: "confirmed",
      txHash: "0xabc",
      txUrl: txUrl("arc-testnet", "0xabc"),
    });
    // The workspace's own configuration has no hosted pair: the float's credentials come from the platform's.
    expect(workspaceOf(PLATFORM).chain.hostedCircleApiKey).toBeUndefined();
    expect(calls).toHaveBeenCalledWith({ apiKey: "hosted-key", entitySecret: "hosted-secret" });
    expect(listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ walletIds: ["float-wallet"], destinationAddress: OPERATING, txType: "OUTBOUND", blockchain: "ARC-TESTNET" })
    );
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: "float-wallet",
        tokenId: "usdc-token",
        destinationAddress: OPERATING,
        amount: [NEED.toFixed(6)],
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
        summary: `Added ${NEED} test USDC on Arc testnet to the operating wallet, from Vestiarion's test USDC float, for shadow mode`,
        detail: { by: MEMBER, amount: NEED, from: FLOAT, to: OPERATING, transferId: "tx-new", txHash: "0xabc", status: "confirmed", shortfall: NEED, weeklyLimit: 5000 },
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

  it("takes the week's total and the key's ordinal from what Circle lists the float sent, not from the ledger", async () => {
    const listed = [sent("tx-a", 2000, { createDate: hoursAgo(2) }), sent("tx-b", 2900, { createDate: hoursAgo(48) }), sent("tx-c", 4000, { createDate: hoursAgo(24 * 10) })];
    const { factory, createTransaction } = circle({ listed });
    // The ledger's figures are not what decides: Circle's are.
    fake = fakeSupabase(workspace({ bill: 500, grants: listed.map((transfer) => recorded(transfer, 1)) }));
    expect((await add({ circle: factory, settle: settled("confirmed", { amounts: ["100"] }) })).amount).toBe(100);
    // Every transfer Circle lists counts towards the ordinal; only the last 7 days' towards the limit.
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: ["100.000000"], idempotencyKey: testUsdcKey(ORG, 4) }));
    expect(ledgerMock).toHaveBeenCalledTimes(1);
  });

  it("counts a failed transfer towards the key's ordinal, not towards the week", async () => {
    const listed = [sent("tx-f", 4900, { state: "FAILED", txHash: undefined })];
    const { factory, createTransaction } = circle({ listed });
    fake = fakeSupabase(workspace({ bill: 500 }));
    expect((await add({ circle: factory })).amount).toBe(NEED);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: testUsdcKey(ORG, 2) }));
    // Money that never moved is not recorded.
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    expect(ledgerMock.mock.calls[0][0].detail.transferId).toBe("tx-new");
  });

  it("reads the whole of Circle's list, a page at a time", async () => {
    const listed = Array.from({ length: 51 }, (_, i) => sent(`tx-${i}`, 1, { createDate: hoursAgo(24 * 30) }));
    const { factory, createTransaction, listTransactions } = circle({ listed });
    fake = fakeSupabase(workspace({ bill: 500, grants: listed.map((transfer) => recorded(transfer)) }));
    await add({ circle: factory });
    expect(listTransactions).toHaveBeenCalledTimes(2);
    expect(listTransactions.mock.calls[1][0]).toMatchObject({ pageAfter: "tx-49" });
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: testUsdcKey(ORG, 52) }));
  });

  it("two calls that listed the same transfers send under one key", async () => {
    const listed = [sent("tx-a", 20)];
    const { factory, createTransaction } = circle({ listed });
    fake = fakeSupabase(workspace({ bill: 500, grants: [recorded(listed[0])] }));
    await Promise.all([add({ circle: factory }), add({ circle: factory })]);
    expect(createTransaction).toHaveBeenCalledTimes(2);
    const keys = createTransaction.mock.calls.map(([request]) => request.idempotencyKey);
    expect(keys[0]).toBe(testUsdcKey(ORG, 2));
    expect(keys[1]).toBe(keys[0]);
  });

  it("refuses while Arc testnet still confirms an earlier transfer from the float", async () => {
    const { factory, createTransaction } = circle({ listed: [sent("tx-a", 20, { state: "SENT", txHash: undefined })] });
    fake = fakeSupabase(workspace({ bill: 500 }));
    await expect(add({ circle: factory })).rejects.toMatchObject({ code: "in_flight", message: "Arc testnet is still confirming the last test USDC. Try again in a minute." });
    expect(createTransaction).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("records first a confirmed transfer the ledger never recorded, from Circle's own figures", async () => {
    const lost = sent("tx-lost", 50, { state: "CONFIRMED", txHash: "0xlost" });
    const { factory, createTransaction } = circle({ listed: [lost, sent("tx-failed", 30, { state: "FAILED", txHash: undefined })] });
    fake = fakeSupabase(workspace({ bill: 500 }));
    await add({ circle: factory });

    expect(ledgerMock).toHaveBeenCalledTimes(2);
    expect(ledgerMock.mock.calls[0][0]).toEqual({
      actor: "human",
      domain: "treasury",
      action: "test_usdc_added",
      summary: "Recorded 50 test USDC that Vestiarion's float sent earlier to the operating wallet, on Arc testnet",
      detail: { by: null, amount: 50, from: FLOAT, to: OPERATING, transferId: "tx-lost", txHash: "0xlost", status: "confirmed", shortfall: null, weeklyLimit: 5000, recovered: true },
    });
    expect(ledgerMock.mock.calls[1][0].detail).toMatchObject({ by: MEMBER, transferId: "tx-new" });
    // Two transfers listed, in any state: this one is the third.
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: testUsdcKey(ORG, 3) }));
  });

  it("writes no second entry when Circle answers with a transfer it already listed", async () => {
    const earlier = sent("tx-a", 480.01, { txHash: "0xa" });
    const { factory } = circle({ listed: [earlier], created: "tx-a" });
    fake = fakeSupabase(workspace({ bill: 500, grants: [recorded(earlier)] }));
    expect(await add({ circle: factory })).toEqual({ amount: 480.01, status: "confirmed", txHash: "0xa", txUrl: txUrl("arc-testnet", "0xa") });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("writes no second entry when another press recorded the same transfer meanwhile", async () => {
    const { factory } = circle({ created: "tx-new" });
    fake = fakeSupabase(
      workspace({ bill: 500, byTransfer: { "tx-new": [{ ts: hoursAgo(0), detail: { amount: 555, transferId: "tx-new", txHash: "0xabc", status: "confirmed" } }] } })
    );
    expect(await add({ circle: factory })).toEqual({ amount: 555, status: "confirmed", txHash: "0xabc", txUrl: txUrl("arc-testnet", "0xabc") });
    expect(ledgerMock).toHaveBeenCalledTimes(0);
  });

  it("records the amount Circle's transaction reports", async () => {
    const { factory } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    const result = await add({ circle: factory, settle: settled("confirmed", { amounts: ["554.5"] }) });
    expect(result.amount).toBe(554.5);
    expect(ledgerMock.mock.calls[0][0].detail).toMatchObject({ amount: 554.5, shortfall: NEED });
  });

  it("records nothing when Circle's transaction names another destination than the operating wallet", async () => {
    const { factory } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    await expect(add({ circle: factory, settle: settled("confirmed", { destinationAddress: "0x0000000000000000000000000000000000000bad" }) })).rejects.toThrow(
      /another destination/
    );
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("records a transfer still processing, so the weekly limit counts it", async () => {
    const { factory } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    const result = await add({ circle: factory, settle: settled("pending") });
    expect(result).toEqual({ amount: NEED, status: "pending", txHash: null, txUrl: null });
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "test_usdc_added", detail: expect.objectContaining({ amount: NEED, txHash: null, status: "pending", transferId: "tx-new" }) }));
  });

  describe("refuses, before Circle moves anything", () => {
    const refused = async (code: string, setup: { platform?: VestiarionConfig; float?: string; workspace?: Parameters<typeof workspace>[0]; listed?: Sent[] } = {}) => {
      const { factory, createTransaction } = circle({ float: setup.float, listed: setup.listed });
      fake = fakeSupabase(workspace({ bill: 500, ...setup.workspace }));
      const attempt = add({ circle: factory }, setup.platform);
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
      const noFloat = { ...PLATFORM, shadowFloat: { weeklyLimit: 5000 } };
      expect((await refused("unavailable", { platform: noFloat })).message).toBe("Vestiarion's test USDC float is not set up on this deployment.");
      await refused("unavailable", { platform: { ...PLATFORM, chain: { ...PLATFORM.chain, hostedCircleApiKey: undefined } } });
    });

    it("before the workspace is live, or without an operating wallet", async () => {
      providerMock.mockReturnValue({ ...provider(0), mode: "simulate" });
      expect((await refused("not_live")).message).toBe("Go live on Arc testnet first: test USDC goes to the operating wallet.");
      providerMock.mockReturnValue(provider(0));
      await refused("not_live", { workspace: { operating: false } });
    });

    it("on Arc mainnet", async () => {
      expect((await refused("mainnet", { platform: { ...PLATFORM, network: "arc-mainnet" } })).message).toBe(
        "Test USDC is for Arc testnet. On Arc mainnet the agent pays your real bills."
      );
    });

    it("once the week's limit is used, by what Circle lists", async () => {
      const listed = [sent("tx-a", 3000, { createDate: hoursAgo(1) }), sent("tx-b", 2000, { createDate: hoursAgo(30) })];
      const error = await refused("limit_reached", { listed, workspace: { grants: listed.map((transfer) => recorded(transfer)) } });
      expect(error.message).toBe("This workspace took its 5,000 test USDC for this week.");
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
    expect(client.listTransactions).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses when nothing it does could be signed, before any money moves", async () => {
    signMock.mockImplementation(() => {
      throw new Error("This organization has no readable ledger signing key stored on it");
    });
    const { factory, calls, createTransaction } = circle();
    fake = fakeSupabase(workspace({ bill: 500 }));
    await expect(add({ circle: factory })).rejects.toThrow(/ledger signing key/);
    expect(calls).not.toHaveBeenCalled();
    expect(createTransaction).not.toHaveBeenCalled();
  });
});

describe("floatAddress", () => {
  const withWallet = (walletId: string) => configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    HOSTED_CIRCLE_API_KEY: "hosted-key",
    HOSTED_CIRCLE_ENTITY_SECRET: "hosted-secret",
    SHADOW_FLOAT_WALLET_ID: walletId,
  });

  it("reads the float's address with the hosted pair, once per wallet", async () => {
    const { factory, client } = circle();
    fake = fakeSupabase();
    const platform = withWallet("float-read-once");
    expect(await run(() => floatAddress({ circle: factory }), platform)).toBe(FLOAT);
    expect(await run(() => floatAddress({ circle: factory }), platform)).toBe(FLOAT);
    expect(client.getWallet).toHaveBeenCalledTimes(1);
    expect(client.getWallet).toHaveBeenCalledWith({ id: "float-read-once" });
  });

  it("gives null for a read that failed, and keeps no answer from it", async () => {
    const { factory, client } = circle();
    client.getWallet.mockRejectedValueOnce(new Error("socket hang up"));
    fake = fakeSupabase();
    const platform = withWallet("float-read-fails");
    expect(await run(() => floatAddress({ circle: factory }), platform)).toBeNull();
    expect(await run(() => floatAddress({ circle: factory }), platform)).toBe(FLOAT);
  });

  it("gives null without asking Circle when the float is not set up", async () => {
    const { factory, calls } = circle();
    fake = fakeSupabase();
    expect(await run(() => floatAddress({ circle: factory }), { ...PLATFORM, shadowFloat: { weeklyLimit: 5000 } })).toBeNull();
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("readTestUsdcWeek", () => {
  it("adds up the last 7 days' grants and names the newest", async () => {
    fake = fakeSupabase(
      workspace({
        grants: [
          { ts: "2026-10-08T11:00:00Z", detail: { amount: 480.01, txHash: "0xabc", transferId: "tx-b" } },
          { ts: "2026-09-20T00:00:00Z", detail: { amount: 100, transferId: "tx-a" } },
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

  it("names the newest grant that did not fail, and counts a transfer once", async () => {
    fake = fakeSupabase(
      workspace({
        grants: [
          { ts: "2026-10-08T11:30:00Z", detail: { amount: 300, status: "failed", transferId: "tx-c" } },
          { ts: "2026-10-08T11:00:00Z", detail: { amount: 200, txHash: "0xb", status: "confirmed", transferId: "tx-b" } },
          { ts: "2026-10-08T10:59:00Z", detail: { amount: 200, txHash: "0xb", status: "confirmed", transferId: "tx-b" } },
        ],
      })
    );
    expect(await run(() => readTestUsdcWeek(NOW))).toEqual({ takenThisWeek: 200, weeklyLimit: 5000, latest: { amount: 200, at: "2026-10-08T11:00:00Z", txHash: "0xb" } });
  });

  it("names nothing before the first grant", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => readTestUsdcWeek(NOW))).toEqual({ takenThisWeek: 0, weeklyLimit: 5000, latest: null });
  });
});
