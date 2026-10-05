import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import { BatchNotSentError } from "@/lib/circle/batch";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import type { ChainConfig } from "@/lib/config";
import { ARC_TESTNET } from "@/lib/network";

vi.mock("server-only", () => ({}));

const { accountSingle } = vi.hoisted(() => ({ accountSingle: vi.fn() }));
vi.mock("@/lib/dal", () => ({
  db: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: accountSingle }),
      }),
    }),
  }),
  unwrap: (result: { data: unknown; error?: { message: string } | null }) => {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));

const CHAIN: ChainConfig = {
  circleApiKey: "test-api-key",
  circleEntitySecret: "test-entity-secret",
  usdcTokenId: "usdc-token-id",
};

const TRANSFER = {
  fromAccountId: "account-1",
  toAddress: "0x1111111111111111111111111111111111111111",
  amount: 1,
  memo: "deadline test",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
};

const never = () => new Promise<never>(() => {});

function fakeClient(overrides: Partial<LiveProviderClient>): LiveProviderClient {
  const unexpectedCall = vi.fn(() => Promise.reject(new Error("unexpected Circle call")));
  return {
    createTransaction: unexpectedCall,
    getWalletTokenBalance: unexpectedCall,
    getTransaction: unexpectedCall,
    ...overrides,
  } as unknown as LiveProviderClient;
}

async function expectDeadline(
  promise: Promise<unknown>,
  ms: number,
  message: string
): Promise<void> {
  let settled = false;
  const observed = promise.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    }
  );

  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  const error = await observed;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  accountSingle.mockResolvedValue({
    data: {
      id: "account-1",
      chain: "ARC-TESTNET",
      token: "USDC",
      circle_wallet_id: "wallet-1",
    },
    error: null,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/**
 * A send that ends with no word from Circle on what became of it (payment safety R1): the error says the transfer may
 * or may not have been accepted, which Reject and Return read, so nothing closes over a transfer Circle may hold. The
 * SDK's errors carry an HTTP `status` when Circle answered, and a network `code` when it did not.
 */
describe("a send Circle never answered says so (payment safety R1)", () => {
  const failing = (error: unknown) =>
    fakeClient({ createTransaction: vi.fn(async () => { throw error; }) as unknown as LiveProviderClient["createTransaction"] });

  it.each([
    [
      "the connection dropped after the request left",
      Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }),
      "Circle did not answer createTransaction (ECONNRESET); the transfer may or may not have been accepted",
    ],
    [
      "Circle answered 5xx",
      Object.assign(new Error("Internal Server Error"), { status: 500, code: -1 }),
      "Circle answered createTransaction with HTTP 500, which does not say what became of it; the transfer may or may not have been accepted",
    ],
  ])("when %s", async (_label, error, message) => {
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: failing(error) });

    await expect(provider.transfer(TRANSFER)).rejects.toThrow(message);
  });

  it.each([
    ["Circle refused it", Object.assign(new Error("the asset amount owned by the wallet is insufficient"), { status: 400, code: 155201 })],
    ["the connection was never made", Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" })],
    ["the error is not an HTTP one", new Error("Circle rejected createTransaction")],
  ])("keeps the error's own words when %s", async (_label, error) => {
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: failing(error) });

    await expect(provider.transfer(TRANSFER)).rejects.toBe(error);
  });

  it("says so when Circle answers with no transaction id", async () => {
    const client = fakeClient({ createTransaction: vi.fn(async () => ({ data: {} })) as unknown as LiveProviderClient["createTransaction"] });

    await expect(new LiveProvider(CHAIN, { network: ARC_TESTNET, client }).transfer(TRANSFER)).rejects.toThrow(
      "Circle answered createTransaction with no transaction id; the transfer may or may not have been accepted"
    );
  });

  it("says so for a release from escrow too", async () => {
    const createContractExecutionTransaction = vi.fn(async () => {
      throw Object.assign(new Error("Request timeout"), { code: "ECONNABORTED" });
    });
    const client = fakeClient({ createContractExecutionTransaction } as unknown as Partial<LiveProviderClient>);
    const release = { ...TRANSFER, route: "escrow" as const, escrow: { contract: "0x2222222222222222222222222222222222222222", holdId: `0x${"ab".repeat(32)}` } };

    await expect(new LiveProvider(CHAIN, { network: ARC_TESTNET, client }).transfer(release)).rejects.toThrow(
      "Circle did not answer the escrow release (ECONNABORTED); it may or may not have been accepted"
    );
  });
});

/** The backstop of the platform's stop switch (payment safety S2): no way of moving money gets past the provider. */
describe("a live provider with payments switched off (payment safety S2)", () => {
  it("refuses every way of moving money, before reading an account or calling Circle", async () => {
    const client = fakeClient({});
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client, paymentsDisabled: true });
    const earn = { accountId: "account-1", amount: 1, reserveAccountId: "account-2", key: "move-1" };

    await expect(provider.transfer(TRANSFER)).rejects.toBeInstanceOf(PaymentsDisabledError);
    await expect(provider.depositToEarn(earn)).rejects.toBeInstanceOf(PaymentsDisabledError);
    await expect(provider.withdrawFromEarn(earn)).rejects.toBeInstanceOf(PaymentsDisabledError);
    await expect(
      provider.swapForEurc({ fromAccountId: "account-1", adapter: "0x3333333333333333333333333333333333333333", usdcIn: 1, callData: "0x", approveKey: "a", executeKey: "e" })
    ).rejects.toBeInstanceOf(PaymentsDisabledError);
    // A batch that never left is undone and each payment sent alone, which the transfer refuses in turn (batch payouts R4).
    const batch = provider.batchTransfer({ fromAccountId: "account-1", transfers: [{ toAddress: TRANSFER.toAddress, amount: 1 }], idempotencyKey: "batch-1" });
    await expect(batch).rejects.toBeInstanceOf(BatchNotSentError);
    await expect(batch).rejects.toThrow("Payments are switched off for every workspace right now; nothing was sent.");
    expect(accountSingle).not.toHaveBeenCalled();
  });

  it("still reads a balance", async () => {
    const getWalletTokenBalance = vi.fn(async () => ({ data: { tokenBalances: [{ token: { id: "usdc-token-id", symbol: "USDC" }, amount: "12.5" }] } }));
    const client = fakeClient({ getWalletTokenBalance } as unknown as Partial<LiveProviderClient>);
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client, paymentsDisabled: true });

    await expect(provider.getBalance("account-1")).resolves.toMatchObject({ balance: 12.5 });
  });
});

describe("LiveProvider Circle request deadlines", () => {
  it("rejects a hung createTransaction after 20 seconds with an unknown-outcome message", async () => {
    const createTransaction = vi.fn(never);
    const client = fakeClient({
      createTransaction: createTransaction as unknown as LiveProviderClient["createTransaction"],
    });
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client });

    await expectDeadline(
      provider.transfer(TRANSFER),
      20_000,
      "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted"
    );
    expect(createTransaction).toHaveBeenCalledOnce();
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: TRANSFER.idempotencyKey })
    );
  });

  it("clears the createTransaction deadline when Circle rejects before it", async () => {
    const createTransaction = vi.fn(async () => {
      throw new Error("Circle rejected createTransaction");
    });
    const client = fakeClient({
      createTransaction: createTransaction as unknown as LiveProviderClient["createTransaction"],
    });
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client });

    await expect(provider.transfer(TRANSFER)).rejects.toThrow("Circle rejected createTransaction");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a hung balance read while resolving the USDC token after 15 seconds", async () => {
    const getWalletTokenBalance = vi.fn(never);
    const client = fakeClient({
      getWalletTokenBalance: getWalletTokenBalance as unknown as LiveProviderClient["getWalletTokenBalance"],
    });
    const provider = new LiveProvider({ ...CHAIN, usdcTokenId: undefined }, { network: ARC_TESTNET, client });

    await expectDeadline(
      provider.transfer(TRANSFER),
      15_000,
      "no answer from Circle getWalletTokenBalance within 15000 ms"
    );
    expect(getWalletTokenBalance).toHaveBeenCalledOnce();
    expect(client.createTransaction).not.toHaveBeenCalled();
  });

  it("clears the getWalletTokenBalance deadline when Circle resolves before it", async () => {
    const getWalletTokenBalance = vi.fn(async () => ({
      data: {
        tokenBalances: [{ amount: "12.5", token: { symbol: "USDC" } }],
      },
    }));
    const client = fakeClient({
      getWalletTokenBalance: getWalletTokenBalance as unknown as LiveProviderClient["getWalletTokenBalance"],
    });
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client });

    await expect(provider.getBalance("account-1")).resolves.toMatchObject({ balance: 12.5 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a hung getBalance read after 15 seconds", async () => {
    const getWalletTokenBalance = vi.fn(never);
    const client = fakeClient({
      getWalletTokenBalance: getWalletTokenBalance as unknown as LiveProviderClient["getWalletTokenBalance"],
    });
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client });

    await expectDeadline(
      provider.getBalance("account-1"),
      15_000,
      "no answer from Circle getWalletTokenBalance within 15000 ms"
    );
    expect(getWalletTokenBalance).toHaveBeenCalledOnce();
  });

  it("rejects a hung reconciliation read after 15 seconds", async () => {
    const getTransaction = vi.fn(never);
    const client = fakeClient({
      getTransaction: getTransaction as unknown as LiveProviderClient["getTransaction"],
    });
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client });

    await expectDeadline(
      provider.reconcileTransfer("tx-1"),
      15_000,
      "no answer from Circle getTransaction during reconciliation within 15000 ms"
    );
    expect(getTransaction).toHaveBeenCalledOnce();
  });
});

describe("LiveProvider reports Circle's state and failure reason", () => {
  function transactionResponse(overrides: Record<string, unknown>) {
    return {
      data: {
        transaction: {
          id: "tx-1",
          blockchain: "ARC-TESTNET",
          createDate: "2026-09-29T00:00:00Z",
          ...overrides,
        },
      },
    };
  }

  function provider(getTransaction: LiveProviderClient["getTransaction"], createTransaction?: LiveProviderClient["createTransaction"]): LiveProvider {
    return new LiveProvider(CHAIN, { network: ARC_TESTNET,
      client: fakeClient({
        createTransaction: createTransaction ?? (vi.fn(async () => ({ data: { id: "tx-1" } })) as unknown as LiveProviderClient["createTransaction"]),
        getTransaction,
      }),
    });
  }

  it("transfer() carries COMPLETE and no failure reason on a confirmed transfer", async () => {
    const getTransaction = vi.fn(async () => transactionResponse({ state: "COMPLETE" })) as unknown as LiveProviderClient["getTransaction"];

    const result = await provider(getTransaction).transfer(TRANSFER);

    expect(result.status).toBe("confirmed");
    expect(result.providerState).toBe("COMPLETE");
    expect(result.failureReason).toBeNull();
  });

  it("transfer() carries FAILED and Circle's errorReason", async () => {
    const getTransaction = vi.fn(async () =>
      transactionResponse({ state: "FAILED", errorReason: "INSUFFICIENT_NATIVE_TOKEN" })
    ) as unknown as LiveProviderClient["getTransaction"];

    const result = await provider(getTransaction).transfer(TRANSFER);

    expect(result.status).toBe("failed");
    expect(result.providerState).toBe("FAILED");
    expect(result.failureReason).toBe("INSUFFICIENT_NATIVE_TOKEN");
  });

  it("transfer() treats STUCK as pending, not failed, while still reporting the state", async () => {
    const getTransaction = vi.fn(async () => transactionResponse({ state: "STUCK" })) as unknown as LiveProviderClient["getTransaction"];

    const result = await provider(getTransaction).transfer(TRANSFER);

    expect(result.status).toBe("pending");
    expect(result.providerState).toBe("STUCK");
    expect(result.failureReason).toBeNull();
  });

  it("transfer() carries both null when no transaction could be read at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getTransaction = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as LiveProviderClient["getTransaction"];

    const result = await provider(getTransaction).transfer(TRANSFER);

    expect(result.status).toBe("pending");
    expect(result.providerState).toBeNull();
    expect(result.failureReason).toBeNull();
    warn.mockRestore();
  });

  it.each(["CANCELLED", "DENIED"])("reconcileTransfer() carries %s as failed, with its state", async (state) => {
    const getTransaction = vi.fn(async () => transactionResponse({ state })) as unknown as LiveProviderClient["getTransaction"];

    const result = await provider(getTransaction).reconcileTransfer("tx-1");

    expect(result.status).toBe("failed");
    expect(result.providerState).toBe(state);
  });

  it("reconcileTransfer() treats STUCK as pending, with its state and no failure reason", async () => {
    const getTransaction = vi.fn(async () => transactionResponse({ state: "STUCK" })) as unknown as LiveProviderClient["getTransaction"];

    const result = await provider(getTransaction).reconcileTransfer("tx-1");

    expect(result.status).toBe("pending");
    expect(result.providerState).toBe("STUCK");
    expect(result.failureReason).toBeNull();
  });
});

describe("LiveProvider refusals name the fix in the product, not a script", () => {
  it("a counterparty without an address points to the Counterparties page", async () => {
    const createTransaction = vi.fn();
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: fakeClient({ createTransaction: createTransaction as unknown as LiveProviderClient["createTransaction"] }) });

    const error = (await provider.transfer({ ...TRANSFER, toAddress: "sim:acme-supplies" }).then(() => undefined, (e: unknown) => e)) as Error;

    expect(error.message).toBe("Counterparty has no on-chain address (sim:acme-supplies). Add this counterparty's Arc address on the Counterparties page.");
    expect(error.message).not.toContain("bootstrap");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("an account without a wallet points to Settings → Go live", async () => {
    accountSingle.mockResolvedValueOnce({
      data: { id: "account-1", chain: "ARC-TESTNET", token: "USDC", circle_wallet_id: null },
      error: null,
    });
    const createTransaction = vi.fn();
    const provider = new LiveProvider(CHAIN, { network: ARC_TESTNET, client: fakeClient({ createTransaction: createTransaction as unknown as LiveProviderClient["createTransaction"] }) });

    const error = (await provider.transfer(TRANSFER).then(() => undefined, (e: unknown) => e)) as Error;

    expect(error.message).toBe("Account account-1 has no Circle wallet. Create the treasury wallets in Settings → Go live.");
    expect(error.message).not.toContain("bootstrap");
    expect(createTransaction).not.toHaveBeenCalled();
  });
});
