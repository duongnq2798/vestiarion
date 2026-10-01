import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { releaseMilestoneIfNotPaused } from "@/lib/agent/orchestrator";
import { holdId } from "@/lib/circle/escrow-holds";
import type { BalanceSnapshot, ChainProvider, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";
import { paymentIntentsBackend } from "./support/payment-intents";

/**
 * The agent paying a milestone locked in escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md
 * E4): it releases the hold, on the escrow route, rather than transferring; a milestone whose amount no longer
 * matches the hold is held for a person, and nothing is sent; once released, the milestone records it.
 */

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-000000000e5c";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001aa";
const ESCROW = "0xE5c0000000000000000000000000000000000E5c";
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
      providerTxId: "circle-release-1", txHash: `0x${"3".repeat(64)}`, txRef: `0x${"3".repeat(64)}`, chain: "ARC-TESTNET", status: "confirmed",
      feeUsd: 0.007, feeSource: "chain_reported", providerMode: "live", settledInMs: 900, providerState: "COMPLETE", failureReason: null, route: params.route,
    };
  }
  async reconcileTransfer(): Promise<TransferResult> {
    throw new Error("not used");
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

function world(milestone: Record<string, unknown> | null) {
  const intents = paymentIntentsBackend(ORG);
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/rpc/agent_paused") return { body: false };
    if (sent.path === "/rest/v1/milestones" && sent.method === "GET") return { body: milestone };
    if (sent.path === "/rest/v1/milestones" && sent.method === "PATCH") return { body: [] };
    if (sent.path === "/rest/v1/escrow_contracts") return { body: { id: "esc-1", address: ESCROW } };
    if (sent.path === "/rest/v1/accounts") return { body: [] };
    return intents.respond(sent);
  });
  const chain = new Chain();
  const release = () =>
    runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      releaseMilestoneIfNotPaused({ milestoneId: MILESTONE, destination: PAYEE, amount: 2 }, { provider: chain, operatingAccountId: "acct-1" })
    );
  return { fake, chain, intents, release };
}

describe("releasing a milestone locked in escrow", () => {
  it("releases the hold on the escrow route, keeps that route on the intent, and records the release on the milestone", async () => {
    const { fake, chain, intents, release } = world({ escrow_state: "funded", escrow_amount: "2" });
    const outcome = await release();
    expect(outcome.status).toBe("paid");
    expect(chain.transfers[0]).toMatchObject({ route: "escrow", escrow: { contract: ESCROW, holdId: holdId(MILESTONE) }, amount: 2, toAddress: PAYEE });
    expect(intents.rows[0]).toMatchObject({ payout_route: "escrow" });
    const patch = fake.requests.find((r) => r.path === "/rest/v1/milestones" && r.method === "PATCH");
    expect(patch?.body).toEqual({ escrow_state: "released", escrow_release_tx_hash: `0x${"3".repeat(64)}` });
  });

  it("holds a milestone whose amount no longer matches its hold, and sends nothing", async () => {
    const { chain, release } = world({ escrow_state: "funded", escrow_amount: "1.5" });
    const outcome = await release();
    expect(outcome.status).toBe("held");
    expect(outcome.reasoningSuffix).toBe(" [not paid: 1.5 USDC is locked in escrow for this milestone, which now asks 2 USDC; held for a person]");
    expect(chain.transfers).toEqual([]);
  });

  it("transfers as before for a milestone with no hold, or one refunded to the workspace", async () => {
    for (const milestone of [null, { escrow_state: null, escrow_amount: null }, { escrow_state: "refunded", escrow_amount: "2" }]) {
      const { chain, release } = world(milestone);
      await release();
      expect(chain.transfers[0].route, JSON.stringify(milestone)).toBeUndefined();
      expect(chain.transfers[0]).not.toHaveProperty("escrow");
    }
  });
});

void vi;
