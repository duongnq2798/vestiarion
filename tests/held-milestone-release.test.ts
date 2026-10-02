import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { releaseHeldMilestone, releaseMilestoneIfNotPaused } from "@/lib/agent/orchestrator";
import { paymentIdempotencyKey } from "@/lib/payments";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * A person's Pay now on a held milestone (held milestone actions R2): the same release as the agent's, but the
 * one that sends again a transfer Circle ended in a terminal failure, a batch's included, as a transfer of its
 * own. The agent's release only records that failure.
 */

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-000000000e5d";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001ab";
const PAYEE = "0x67C8000000000000000000000000000000000504";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

class Chain implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  transfers: TransferParams[] = [];
  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transfers.push(params);
    return {
      providerTxId: "circle-retry-1", txHash: `0x${"5".repeat(64)}`, txRef: `0x${"5".repeat(64)}`, chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.006, feeSource: "chain_reported", providerMode: "live", settledInMs: 800, providerState: "COMPLETE", failureReason: null,
    };
  }
  async reconcileTransfer(providerTxId: string): Promise<TransferResult> {
    return {
      providerTxId, txHash: null, txRef: providerTxId, chain: "ARC-TESTNET", status: "failed",
      feeUsd: null, feeSource: null, providerMode: "live", settledInMs: null, providerState: "FAILED", failureReason: "ESTIMATION_ERROR",
    } as unknown as TransferResult;
  }
  async getBalance(): Promise<BalanceSnapshot> {
    return { accountId: "acct-1", balance: 8, chain: "ARC-TESTNET" } as unknown as BalanceSnapshot;
  }
  async depositToEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
  async withdrawFromEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
}

function world() {
  const intents = paymentIntentsBackend(ORG);
  Object.assign(
    intents.insert({ source_type: "milestone", source_id: MILESTONE, idempotency_key: paymentIdempotencyKey("milestone", MILESTONE), provider: "circle", provider_mode: "live", amount: 0.3, destination: PAYEE }),
    // The first attempt went out in a batch of three, which Circle failed before it was mined.
    { status: "failed", provider_tx_id: "circle-batch-1", provider_state: "FAILED", failure_reason: "ESTIMATION_ERROR", transfer_attempt: 1, batch_key: "batch-1", batch_size: 3 }
  );
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (sent.path === "/rest/v1/milestones" && sent.method === "GET") return { body: null };
    if (sent.path === "/rest/v1/accounts") return { body: [] };
    return intents.respond(sent);
  });
  const chain = new Chain();
  const within = <T>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  const input = { milestoneId: MILESTONE, destination: PAYEE, amount: 0.3 };
  return { chain, intents, within, input };
}

describe("a person's release of a held milestone", () => {
  it("sends again, on its own, a batch transfer Circle failed", async () => {
    const { chain, intents, within, input } = world();
    const outcome = await within(() => releaseHeldMilestone(input, { provider: chain, operatingAccountId: "acct-1" }));
    expect(outcome.status).toBe("paid");
    expect(chain.transfers).toHaveLength(1);
    expect(chain.transfers[0]).toMatchObject({ toAddress: PAYEE, amount: 0.3 });
    expect(intents.rows[0]).toMatchObject({ transfer_attempt: 2, provider_tx_id: "circle-retry-1" });
    expect(outcome.paymentExecution?.retriedAfter).toMatchObject({ providerTxId: "circle-batch-1", providerState: "FAILED" });
  });

  it("is not the agent's release, which records the failure and sends nothing", async () => {
    const { chain, within, input } = world();
    const outcome = await within(() => releaseMilestoneIfNotPaused(input, { provider: chain, operatingAccountId: "acct-1" }));
    expect(outcome.status).toBe("held");
    expect(chain.transfers).toEqual([]);
  });
});
