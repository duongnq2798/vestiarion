import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveProvider, type LiveProviderClient } from "@/lib/circle/liveProvider";
import type { ChainConfig } from "@/lib/config";

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

async function flushProviderSetup(): Promise<void> {
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
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

  await flushProviderSetup();
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

describe("LiveProvider Circle request deadlines", () => {
  it("rejects a hung createTransaction after 20 seconds with an unknown-outcome message", async () => {
    const createTransaction = vi.fn(never);
    const client = fakeClient({
      createTransaction: createTransaction as unknown as LiveProviderClient["createTransaction"],
    });
    const provider = new LiveProvider(CHAIN, { client });

    await expectDeadline(
      provider.transfer(TRANSFER),
      20_000,
      "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted"
    );
    expect(createTransaction).toHaveBeenCalledOnce();
  });

  it("rejects a hung balance read while resolving the USDC token after 15 seconds", async () => {
    const getWalletTokenBalance = vi.fn(never);
    const client = fakeClient({
      getWalletTokenBalance: getWalletTokenBalance as unknown as LiveProviderClient["getWalletTokenBalance"],
    });
    const provider = new LiveProvider({ ...CHAIN, usdcTokenId: undefined }, { client });

    await expectDeadline(
      provider.transfer(TRANSFER),
      15_000,
      "no answer from Circle within 15000 ms"
    );
    expect(getWalletTokenBalance).toHaveBeenCalledOnce();
    expect(client.createTransaction).not.toHaveBeenCalled();
  });

  it("rejects a hung getBalance read after 15 seconds", async () => {
    const getWalletTokenBalance = vi.fn(never);
    const client = fakeClient({
      getWalletTokenBalance: getWalletTokenBalance as unknown as LiveProviderClient["getWalletTokenBalance"],
    });
    const provider = new LiveProvider(CHAIN, { client });

    await expectDeadline(
      provider.getBalance("account-1"),
      15_000,
      "no answer from Circle within 15000 ms"
    );
    expect(getWalletTokenBalance).toHaveBeenCalledOnce();
  });

  it("rejects a hung reconciliation read after 15 seconds", async () => {
    const getTransaction = vi.fn(never);
    const client = fakeClient({
      getTransaction: getTransaction as unknown as LiveProviderClient["getTransaction"],
    });
    const provider = new LiveProvider(CHAIN, { client });

    await expectDeadline(
      provider.reconcileTransfer("tx-1"),
      15_000,
      "no answer from Circle within 15000 ms"
    );
    expect(getTransaction).toHaveBeenCalledOnce();
  });
});
