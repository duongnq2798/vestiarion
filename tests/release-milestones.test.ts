import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { releaseMilestones } from "@/lib/agent/orchestrator";
import type { PaymentExecution, PaymentRequest } from "@/lib/payments";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The contractor stage's releases, once every milestone is decided
 * (docs/superpowers/specs/2026-10-02-batch-payouts-design.md §2, R1, R2): those that can share one
 * transaction go out in one batch when the operating balance covers it; a release from escrow is its
 * own call; with too little money, or a provider that cannot batch, each goes alone; nothing moves while
 * the agent is paused.
 */

const { batchMock, payMock, syncMock } = vi.hoisted(() => ({ batchMock: vi.fn(), payMock: vi.fn(), syncMock: vi.fn() }));
vi.mock("@/lib/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments")>()),
  executePaymentBatch: batchMock,
  executePayment: payMock,
}));
vi.mock("@/lib/agent/pay", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/pay")>()), syncOperatingBalance: syncMock }));

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-0000000b47c4";
const ESCROWED = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e3";
const HASH = `0x${"d".repeat(64)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const RELEASES = [1, 2, 3].map((n) => ({ milestoneId: `0b6c1c9e-4a4f-4a7e-9b1e-00000000000${n}`, destination: `0x${String(n).repeat(40)}`, amount: n }));

function chain(canBatch = true): ChainProvider {
  const base = {
    mode: "live" as const,
    earnMode: "simulate" as const,
    estimatedFeeUsd: 0.003,
    transfer: async (): Promise<TransferResult> => {
      throw new Error("sent through executePayment");
    },
    reconcileTransfer: async (): Promise<TransferResult> => {
      throw new Error("unused");
    },
    getBalance: async (): Promise<BalanceSnapshot> => ({ accountId: "acct-1", balance: 50, chain: "ARC-TESTNET", token: "USDC" }),
    depositToEarn: async (): Promise<EarnResult> => {
      throw new Error("unused");
    },
    withdrawFromEarn: async (): Promise<EarnResult> => {
      throw new Error("unused");
    },
  };
  return canBatch ? { ...base, batchTransfer: async () => base.transfer() } : base;
}

function executed(over: Partial<PaymentExecution> = {}): PaymentExecution {
  return {
    idempotencyKey: "k", providerTxId: "tx-batch", txHash: HASH, txRef: HASH, status: "confirmed", attemptCount: 1, error: null, reconciled: false,
    chain: "ARC-TESTNET", providerMode: "live", feeUsd: 0.003, feeSource: "chain_reported", settledInMs: 2000, executedAt: "2026-10-02T10:00:00Z",
    attempt: 1, retriedAfter: null, route: null, batch: { key: "batch-1", size: 3 }, ...over,
  };
}

let paused = false;
function run(releases: typeof RELEASES, deps: { canBatch?: boolean; operatingBalance?: number | null } = {}) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/rpc/agent_paused") return { body: paused };
    if (sent.path === "/rest/v1/milestones" && sent.method === "GET") {
      return { body: sent.params.get("id") === `eq.${ESCROWED}` ? { escrow_state: "funded", escrow_amount: "2", escrow_payee: `0x${"2".repeat(40)}` } : null };
    }
    if (sent.path === "/rest/v1/escrow_contracts") return { body: { id: "esc-1", address: `0x${"e".repeat(40)}` } };
    return { body: [] };
  });
  return runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
    releaseMilestones(releases, { provider: chain(deps.canBatch ?? true), operatingAccountId: "acct-1", operatingBalance: deps.operatingBalance === undefined ? 10 : deps.operatingBalance })
  );
}

beforeEach(() => {
  paused = false;
  batchMock.mockReset().mockImplementation(async (requests: PaymentRequest[]) => requests.map(() => executed()));
  payMock.mockReset().mockImplementation(async (request: PaymentRequest) => executed({ providerTxId: `tx-${request.sourceId}`, batch: null }));
  syncMock.mockReset().mockResolvedValue(4);
});

describe("releaseMilestones", () => {
  it("sends releases that can share a transaction in one batch, and says so on each", async () => {
    const outcomes = await run(RELEASES);
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect(batchMock.mock.calls[0][0]).toEqual(
      RELEASES.map((release) => ({ sourceType: "milestone", sourceId: release.milestoneId, fromAccountId: "acct-1", destination: release.destination, amount: release.amount, memo: `Milestone ${release.milestoneId}` }))
    );
    expect(payMock).not.toHaveBeenCalled();
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["paid", "paid", "paid"]);
    expect(outcomes[0]).toMatchObject({ txRef: HASH, operatingBalance: 4, reasoningSuffix: " [paid in one Arc transaction with 2 other milestones]" });
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it("pays each alone when the operating balance does not cover the batch, so as many as it allows go out", async () => {
    const outcomes = await run(RELEASES, { operatingBalance: 5 });
    expect(batchMock).not.toHaveBeenCalled();
    expect(payMock).toHaveBeenCalledTimes(3);
    expect(outcomes.every((outcome) => outcome.status === "paid" && !outcome.reasoningSuffix.includes("one Arc transaction"))).toBe(true);
  });

  it("releases a milestone locked in escrow on its own, and batches the rest", async () => {
    const releases = [RELEASES[0], { ...RELEASES[1], milestoneId: ESCROWED }, RELEASES[2]];
    batchMock.mockImplementation(async (requests: PaymentRequest[]) => requests.map(() => executed({ batch: { key: "batch-1", size: 2 } })));
    await run(releases);
    expect(batchMock.mock.calls[0][0].map((request: PaymentRequest) => request.sourceId)).toEqual([RELEASES[0].milestoneId, RELEASES[2].milestoneId]);
    expect(payMock).toHaveBeenCalledTimes(1);
    expect(payMock.mock.calls[0][0]).toMatchObject({ sourceId: ESCROWED, route: "escrow" });
  });

  it("holds every release while the agent is paused, and sends nothing", async () => {
    paused = true;
    const outcomes = await run(RELEASES);
    expect(outcomes.every((outcome) => outcome.status === "held" && outcome.heldBecausePaused)).toBe(true);
    expect(batchMock).not.toHaveBeenCalled();
    expect(payMock).not.toHaveBeenCalled();
  });

  it("pays each alone with a provider that cannot batch, or with only one", async () => {
    await run(RELEASES, { canBatch: false });
    expect(payMock).toHaveBeenCalledTimes(3);
    payMock.mockClear();
    await run([RELEASES[0]]);
    expect(payMock).toHaveBeenCalledTimes(1);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("keeps a release whose batch's answer was lost verified, looked for on Circle", async () => {
    batchMock.mockImplementation(async (requests: PaymentRequest[]) => requests.map(() => executed({ status: "pending", providerTxId: null, txHash: null, txRef: null, error: "no answer" })));
    const outcomes = await run(RELEASES);
    expect(outcomes[0]).toMatchObject({ status: "verified", reasoningSuffix: " [sent in a batch whose answer was lost (no answer); it is looked for on Circle, never sent again]" });
    expect(syncMock).not.toHaveBeenCalled();
  });
});
