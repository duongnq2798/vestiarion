import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import {
  AgentPausedError,
  agentPaused,
  heldBecausePausedDetail,
  HELD_BECAUSE_PAUSED,
  pausedPaymentNote,
  pausedTreasuryNote,
  PAUSE_NOTE,
  PAUSE_TREASURY_NOTE,
} from "@/lib/agent/pause";
import {
  moveTreasuryIfNotPaused,
  payApInvoiceIfNotPaused,
  releaseMilestoneIfNotPaused,
} from "@/lib/agent/orchestrator";
import type { BalanceSnapshot, ChainProvider, EarnDepositParams, EarnResult, TransferParams, TransferResult } from "@/lib/circle";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `pausedPaymentNote()` is the one branch the AP and contractor stages both
 * check right before they would move money (src/lib/agent/orchestrator.ts).
 * Driving that check through a full `runAgentCycle()` would mean faking
 * every stage ahead of it in the cycle — reconcile, compliance, follow-up,
 * duplicate detection, and for the contractor loop the milestone-verification
 * read too — the same weight `tests/orchestrator.test.ts` already declines to
 * carry for its own happy path (see the comment above its `describe` block).
 * So this file proves the extracted helper directly: what it sends to
 * `agent_paused`, what it returns for each answer, and that `AgentPausedError`
 * carries the exact message a member sees. The orchestrator wiring itself —
 * that a stage sets `status: "held"` and appends this note instead of
 * calling `payInvoice`/`executePayment` — is a few lines guarded by this same
 * helper, reviewed alongside this report rather than re-proven end to end.
 */

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-000000000c0c";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("agentPaused", () => {
  it("sends p_org_id and returns the RPC's answer", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/agent_paused") return { body: true };
      return { body: [] };
    });

    const paused = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => agentPaused());

    expect(paused).toBe(true);
    const request = fake.requests.find((r) => r.path === "/rest/v1/rpc/agent_paused");
    expect(request?.body).toEqual({ p_org_id: ORG });
  });

  it("returns false when the RPC says the agent is not paused", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return { body: [] };
    });

    const paused = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => agentPaused());

    expect(paused).toBe(false);
  });

  it("throws with the database's own message when the read fails", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/agent_paused") {
        return { status: 500, body: { message: "agent_paused read failed: connection reset" } };
      }
      return { body: [] };
    });

    await expect(
      runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => agentPaused())
    ).rejects.toThrow("agent_paused read failed: connection reset");
  });
});

describe("pausedPaymentNote", () => {
  it("returns null — proceed — when the agent is not paused", async () => {
    const fake = fakeSupabase(() => ({ body: false }));

    const note = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => pausedPaymentNote());

    expect(note).toBeNull();
  });

  it("returns the pause note — hold instead of paying — when the agent is paused", async () => {
    const fake = fakeSupabase(() => ({ body: true }));

    const note = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => pausedPaymentNote());

    expect(note).toBe(PAUSE_NOTE);
    expect(note).toBe(" [not paid: the agent was paused]");
  });
});

describe("AgentPausedError", () => {
  it("carries the exact message a member sees", () => {
    expect(new AgentPausedError().message).toBe("The agent is paused. Resume it to run a cycle.");
  });
});

describe("pausedTreasuryNote", () => {
  it("returns null — proceed — when the agent is not paused", async () => {
    const fake = fakeSupabase(() => ({ body: false }));

    const note = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => pausedTreasuryNote());

    expect(note).toBeNull();
  });

  it("returns the treasury pause note when the agent is paused", async () => {
    const fake = fakeSupabase(() => ({ body: true }));

    const note = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => pausedTreasuryNote());

    expect(note).toBe(PAUSE_TREASURY_NOTE);
    expect(note).toBe(" [not moved: the agent was paused]");
  });
});

describe("heldBecausePausedDetail — the ledger marker (D6)", () => {
  it("carries the marker when the pause is why the entry holds", () => {
    expect(heldBecausePausedDetail(true)).toEqual({ heldBecause: HELD_BECAUSE_PAUSED });
    expect(heldBecausePausedDetail(true)).toEqual({ heldBecause: "agent_paused" });
  });

  it("is empty — adds no key at all — for any other hold", () => {
    expect(heldBecausePausedDetail(false)).toEqual({});
  });
});

/**
 * A `ChainProvider` whose money-moving methods record that they were called
 * and then throw, so a test proves the pause path never reaches them rather
 * than merely not asserting on their result. `reconcileTransfer` and
 * `getBalance` are never expected to be reached by these tests either, so
 * they throw immediately.
 */
class SpyProvider implements ChainProvider {
  readonly mode = "simulate" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  transferCalls: TransferParams[] = [];
  depositCalls: EarnDepositParams[] = [];
  withdrawCalls: EarnDepositParams[] = [];

  async transfer(params: TransferParams): Promise<TransferResult> {
    this.transferCalls.push(params);
    throw new Error("transfer must not be called while the agent is paused");
  }
  async reconcileTransfer(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async getBalance(): Promise<BalanceSnapshot> {
    throw new Error("not used");
  }
  async depositToEarn(params: EarnDepositParams): Promise<EarnResult> {
    this.depositCalls.push(params);
    throw new Error("depositToEarn must not be called while the agent is paused");
  }
  async withdrawFromEarn(params: EarnDepositParams): Promise<EarnResult> {
    this.withdrawCalls.push(params);
    throw new Error("withdrawFromEarn must not be called while the agent is paused");
  }
}

/**
 * `payApInvoiceIfNotPaused` is the AP stage's real `decision.action === "pay"`
 * call site (src/lib/agent/orchestrator.ts), extracted so it is directly
 * testable rather than only the `pausedPaymentNote()` helper it uses. Driving
 * it here instead of through a full `runAgentCycle()` — which would mean
 * faking reconcile, the compliance sweep, follow-up, and duplicate detection
 * first, none of which the pause check touches — is the "smallest seam that
 * still covers the real call site" the review asked for.
 */
describe("payApInvoiceIfNotPaused — the AP stage's real call site", () => {
  it("holds, notes the pause, and never claims a payment intent or calls transfer, when the agent is paused", async () => {
    const provider = new SpyProvider();
    const fake = fakeSupabase(() => ({ body: true })); // agent_paused -> true

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      payApInvoiceIfNotPaused(
        { invoiceId: "inv-1", counterpartyId: "cp-1", address: null, amount: 100 },
        { provider, operating: { id: "acct-1" } }
      )
    );

    expect(outcome).toEqual({
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: PAUSE_NOTE,
      heldBecausePaused: true,
      operatingBalance: null,
    });
    // No payment_intents claim, and no transfer: payInvoice was never reached.
    expect(provider.transferCalls).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/claim_payment_intent")).toBe(false);

    // What the AP loop does with this outcome — status "held", the pause
    // note appended to reasoning, and the ledger marker — is exactly:
    const reasoning = "PO matches, goods received." + outcome.reasoningSuffix;
    expect(outcome.status).toBe("held");
    expect(reasoning).toContain("[not paid: the agent was paused]");
    expect(heldBecausePausedDetail(outcome.heldBecausePaused)).toEqual({ heldBecause: "agent_paused" });
  });
});

/**
 * `releaseMilestoneIfNotPaused` mirrors the above for the contractor stage's
 * `decision.action === "release"` call site.
 */
describe("releaseMilestoneIfNotPaused — the contractor stage's real call site", () => {
  it("holds, notes the pause, and never claims a payment intent or calls transfer, when the agent is paused", async () => {
    const provider = new SpyProvider();
    const fake = fakeSupabase(() => ({ body: true }));

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      releaseMilestoneIfNotPaused(
        { milestoneId: "ms-1", destination: "sim:cp-1", amount: 250 },
        { provider, operatingAccountId: "acct-1" }
      )
    );

    expect(outcome).toEqual({
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: PAUSE_NOTE,
      heldBecausePaused: true,
      operatingBalance: null,
    });
    expect(provider.transferCalls).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/claim_payment_intent")).toBe(false);
    expect(heldBecausePausedDetail(outcome.heldBecausePaused)).toEqual({ heldBecause: "agent_paused" });
  });
});

function confirmedTransferResult(): TransferResult {
  return {
    providerTxId: "circle-tx-1",
    txHash: "0xhash",
    txRef: "0xhash",
    chain: "ARC-TESTNET",
    status: "confirmed",
    feeUsd: 0.01,
    feeSource: "chain_reported",
    providerMode: "live",
    settledInMs: 5,
    providerState: "COMPLETE",
    failureReason: null,
  };
}

/** A `ChainProvider` whose `transfer` always confirms, for the "a real
 * payment happened, then something else failed" tests below. */
class ConfirmingProvider implements ChainProvider {
  readonly mode = "live" as const;
  readonly earnMode = "simulate" as const;
  readonly estimatedFeeUsd = 0.01;
  async transfer(): Promise<TransferResult> {
    return confirmedTransferResult();
  }
  async reconcileTransfer(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async getBalance(): Promise<BalanceSnapshot> {
    throw new Error("not used");
  }
  async depositToEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
  async withdrawFromEarn(): Promise<EarnResult> {
    throw new Error("not used");
  }
}

/**
 * A minimal `payment_intents` table behind the fake REST wire, enough to
 * drive `executePayment`'s ensure → claim → transfer → recordResult path —
 * mirrors `tests/pay.test.ts`'s own `paymentIntentsBackend()` (not shared
 * across files since neither test file exports its helpers).
 */
function paymentIntentsBackend() {
  const rows = new Map<string, Record<string, unknown>>();

  const respond = (sent: RecordedRequest): FakeReply => {
    if (sent.path === "/rest/v1/payment_intents") {
      if (sent.method === "POST") {
        const body = (Array.isArray(sent.body) ? sent.body[0] : sent.body) as Record<string, unknown>;
        const key = body.idempotency_key as string;
        if (!rows.has(key)) {
          rows.set(key, {
            id: "intent-1",
            org_id: ORG,
            source_type: body.source_type,
            source_id: body.source_id,
            idempotency_key: key,
            provider: body.provider,
            provider_tx_id: null,
            tx_hash: null,
            amount: String(body.amount),
            destination: body.destination,
            status: "created",
            attempt_count: 0,
            last_error: null,
            confirmed_at: null,
            chain: null,
            provider_mode: body.provider_mode,
            fee_usd: null,
            fee_source: null,
            settled_in_ms: null,
            executed_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          });
        }
        return { body: [] };
      }
      if (sent.method === "GET") {
        const key = sent.params.get("idempotency_key")?.replace(/^eq\./, "");
        return { body: (key ? rows.get(key) : undefined) ?? null };
      }
      if (sent.method === "PATCH") {
        const key = sent.params.get("idempotency_key")?.replace(/^eq\./, "");
        const row = key ? rows.get(key) : undefined;
        if (row) Object.assign(row, sent.body as Record<string, unknown>);
        return { body: [] };
      }
    }
    if (sent.path === "/rest/v1/rpc/claim_payment_intent") {
      const key = (sent.body as Record<string, unknown> | undefined)?.p_idempotency_key as string | undefined;
      const row = key ? rows.get(key) : undefined;
      if (row && ["created", "failed"].includes(row.status as string)) {
        row.status = "submitting";
        row.attempt_count = (row.attempt_count as number) + 1;
        return { body: { ...row } };
      }
      return {
        body: Object.fromEntries(
          [
            "id", "org_id", "source_type", "source_id", "idempotency_key", "provider", "provider_tx_id", "tx_hash",
            "amount", "destination", "status", "attempt_count", "last_error", "confirmed_at", "chain",
            "provider_mode", "fee_usd", "fee_source", "settled_in_ms", "executed_at", "created_at", "updated_at",
          ].map((column) => [column, null])
        ),
      };
    }
    return { body: [] };
  };

  return { respond };
}

/**
 * `releaseMilestoneIfNotPaused`, not paused, once a transfer is genuinely
 * confirmed: what happens next must never understate that a real payment
 * moved (a review finding on the previous round of this fix — the sync
 * failure used to fall into the same catch as `executePayment` itself
 * throwing, demoting a confirmed release back to "held" with no `txRef`).
 */
describe("releaseMilestoneIfNotPaused — a confirmed transfer, not paused", () => {
  it("stays paid, with its txRef and paymentExecution, when the balance sync fails afterward", async () => {
    const provider = new ConfirmingProvider();
    const backend = paymentIntentsBackend();
    const fake = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/rpc/agent_paused") return { body: false };
      if (sent.path === "/rest/v1/accounts" && sent.method === "GET") {
        return { status: 500, body: { message: "accounts read failed: connection reset" } };
      }
      return backend.respond(sent);
    });

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      releaseMilestoneIfNotPaused(
        { milestoneId: "ms-1", destination: "sim:cp-1", amount: 250 },
        { provider, operatingAccountId: "acct-1" }
      )
    );

    // The transfer really happened and is confirmed — the failed sync must
    // only be noted, never demote status, txRef or paymentExecution.
    expect(outcome.status).toBe("paid");
    expect(outcome.txRef).toBe("0xhash");
    expect(outcome.paymentExecution?.status).toBe("confirmed");
    expect(outcome.reasoningSuffix).toBe(" [balance sync failed: accounts read failed: connection reset]");
    expect(outcome.operatingBalance).toBeNull();
    expect(outcome.heldBecausePaused).toBe(false);
  });

  it("still holds, with the execution failure's message, when executePayment itself throws", async () => {
    const provider = new ConfirmingProvider();
    const fake = fakeSupabase((sent) => {
      if (sent.path === "/rest/v1/rpc/agent_paused") return { body: false };
      if (sent.path === "/rest/v1/payment_intents" && sent.method === "POST") {
        return { status: 500, body: { message: "payment_intents insert failed: connection reset" } };
      }
      return { body: [] };
    });

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      releaseMilestoneIfNotPaused(
        { milestoneId: "ms-1", destination: "sim:cp-1", amount: 250 },
        { provider, operatingAccountId: "acct-1" }
      )
    );

    expect(outcome).toEqual({
      status: "held",
      txRef: null,
      paymentExecution: null,
      reasoningSuffix: " [execution failed: payment_intents insert failed: connection reset]",
      heldBecausePaused: false,
      operatingBalance: null,
    });
  });
});

/**
 * `moveTreasuryIfNotPaused` is the treasury stage's real call site for both
 * a sweep and a redemption (ruling R5) — the smallest seam that still covers
 * `provider.depositToEarn`/`withdrawFromEarn` and the reserve-balance PATCH.
 */
describe("moveTreasuryIfNotPaused — the treasury stage's real call site", () => {
  const ctxBase = {
    operatingAccountId: "operating-1",
    reserveAccountId: "reserve-1",
    operatingBalance: 1000,
    reserveBalance: 500,
  };

  it("does not move, and never calls depositToEarn, when paused and sweeping", async () => {
    const provider = new SpyProvider();
    const fake = fakeSupabase(() => ({ body: true }));

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveTreasuryIfNotPaused(
        { action: "sweep_to_usyc", amount: 300, reasoning: "idle cash" },
        { db: db(), provider, ...ctxBase }
      )
    );

    expect(outcome).toEqual({ executed: false, executionNote: PAUSE_TREASURY_NOTE, heldBecausePaused: true });
    expect(provider.depositCalls).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/accounts" && r.method === "PATCH")).toBe(false);
    expect(heldBecausePausedDetail(outcome.heldBecausePaused)).toEqual({ heldBecause: "agent_paused" });
  });

  it("does not move, and never calls withdrawFromEarn, when paused and redeeming", async () => {
    const provider = new SpyProvider();
    const fake = fakeSupabase(() => ({ body: true }));

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveTreasuryIfNotPaused(
        { action: "redeem_from_usyc", amount: 200, reasoning: "cover a payable" },
        { db: db(), provider, ...ctxBase }
      )
    );

    expect(outcome).toEqual({ executed: false, executionNote: PAUSE_TREASURY_NOTE, heldBecausePaused: true });
    expect(provider.withdrawCalls).toEqual([]);
    expect(fake.requests.some((r) => r.path === "/rest/v1/accounts" && r.method === "PATCH")).toBe(false);
  });

  it("checks nothing and never calls the provider for a hold decision — there is nothing to pause", async () => {
    const provider = new SpyProvider();
    // agent_paused would answer true here too, but a "hold" decision (or a
    // non-positive amount) never reaches the pause check at all.
    const fake = fakeSupabase(() => ({ body: true }));

    const outcome = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () =>
      moveTreasuryIfNotPaused(
        { action: "hold", amount: 0, reasoning: "nothing idle" },
        { db: db(), provider, ...ctxBase }
      )
    );

    expect(outcome).toEqual({ executed: false, executionNote: null, heldBecausePaused: false });
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/agent_paused")).toBe(false);
  });
});
