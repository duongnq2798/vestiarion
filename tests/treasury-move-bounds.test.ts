import { describe, expect, it } from "vitest";
import type { BalanceSnapshot, ChainProvider, EarnDepositParams, EarnResult, TransferResult } from "@/lib/circle";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { planTreasury } from "@/lib/agent/treasury";
import { moveAgentTreasury } from "@/lib/agent/treasury-moves";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The treasury stage's move (treasury move bounds R1–R3): the model's decision is bounded by the buffer before anything
 * moves, so what reaches the chain is the bounded amount, and the caller learns what code changed. Driven through the
 * extracted call site, as tests/pause-cycle.test.ts drives the pause, rather than through a full cycle.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

class RecordingProvider implements ChainProvider {
  readonly mode = "simulate" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.003;
  depositCalls: EarnDepositParams[] = [];
  withdrawCalls: EarnDepositParams[] = [];

  async transfer(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async reconcileTransfer(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async getBalance(): Promise<BalanceSnapshot> {
    throw new Error("not used");
  }
  async depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    this.depositCalls.push(params);
    return { txRef: "sim-deposit", positionValue: params.amount, apy: 0.0345 };
  }
  async withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    this.withdrawCalls.push(params);
    return { txRef: "sim-redeem", positionValue: 0, apy: 0.0345 };
  }
}

/** The workspace's database: the agent is not paused, and balance writes succeed. */
function workspace() {
  return fakeSupabase((sent: RecordedRequest) => (sent.path === "/rest/v1/rpc/agent_paused" ? { body: false } : { body: [] }));
}

// testnet-2 at 07:43 UTC on 2026-10-03: the operating wallet empty, 58.210738 USDC in the reserve, 0.10 USDC due.
const plan = planTreasury({ operatingBalance: 0, reserveBalance: 58.210738, apy: 0.0345, obligationsDue7d: 0.1, daysUntilNextObligation: 1.68, roundTripCostUsd: 0.006 });
const ctx = { operatingAccountId: "operating-1", reserveAccountId: "reserve-1", operatingBalance: 0, reserveBalance: 58.210738, moveKey: "cycle-1" };

describe("moveAgentTreasury", () => {
  it("redeems only the shortfall below the buffer when the model asks for the whole reserve, and says code limited it", async () => {
    const provider = new RecordingProvider();
    const fake = workspace();

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveAgentTreasury({ action: "redeem_from_usyc", amount: 58.1, reasoning: "restore liquid cash" }, plan, { db: db(), provider, ...ctx })
    );

    expect(provider.withdrawCalls.map((call) => call.amount)).toEqual([0.114999]);
    expect(outcome).toMatchObject({
      executed: true,
      decision: { action: "redeem_from_usyc", amount: 0.114999 },
      guardrail: { rule: "treasury.redeem_above_need", modelAmount: 58.1, limit: 0.114999 },
    });
    expect(outcome.decision.reasoning).toContain("Code limited it to 0.114999 USDC");
  });

  it("moves nothing, and asks nothing, when the bound turns the move into a hold", async () => {
    const provider = new RecordingProvider();
    const fake = workspace();

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveAgentTreasury({ action: "sweep_to_usyc", amount: 1, reasoning: "earn on it" }, plan, { db: db(), provider, ...ctx })
    );

    expect(provider.depositCalls).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(outcome).toMatchObject({ executed: false, decision: { action: "hold", amount: 0 }, guardrail: { rule: "treasury.sweep_below_buffer" } });
  });

  it("moves a decision within the bound exactly as the model sized it", async () => {
    const provider = new RecordingProvider();
    const fake = workspace();

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveAgentTreasury({ action: "redeem_from_usyc", amount: 0.1, reasoning: "cover the bill" }, plan, { db: db(), provider, ...ctx })
    );

    expect(provider.withdrawCalls.map((call) => call.amount)).toEqual([0.1]);
    expect(outcome).toMatchObject({ executed: true, decision: { action: "redeem_from_usyc", amount: 0.1, reasoning: "cover the bill" }, guardrail: null });
  });
});
