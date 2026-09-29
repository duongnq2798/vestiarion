import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { withOrg } from "@/lib/dal/scope";
import { existingMilestoneIntents, reconcileMilestone } from "@/lib/agent/orchestrator";
import type { ChainProvider } from "@/lib/circle";
import type { PaymentExecution } from "@/lib/payments";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The contractor stage's twin of the AP stage's in-flight reconcile (see
 * `reconcileApInvoice` in `tests/control-cycle.test.ts`). A `verified`
 * milestone with a payment intent already has a release in flight — a
 * pending transfer maps back to `verified` — so the stage reconciles it
 * through `executePayment`'s idempotency key rather than asking the model
 * again, which could record a real payment as `held`.
 *
 * `executePayment` is mocked at the module boundary, so every test controls
 * exactly what the reconcile reported; the pause and the risk re-read go
 * through the recorded PostgREST fake, as in the AP tests.
 */

const { executePaymentMock, syncMock, decideMock } = vi.hoisted(() => ({
  executePaymentMock: vi.fn(),
  syncMock: vi.fn(),
  decideMock: vi.fn(),
}));
vi.mock("@/lib/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments")>()),
  executePayment: executePaymentMock,
}));
vi.mock("@/lib/agent/pay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/pay")>()),
  syncOperatingBalance: syncMock,
}));
vi.mock("@/lib/agent/decide", () => ({ decide: decideMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c2c2";
const MILESTONE_ID = "018f8ce0-1557-7b54-a931-4d777f6bd001";
const CONTRACTOR_ID = "018f8ce0-1557-7b54-a931-4d777f6bd002";
const ACCOUNT_ID = "018f8ce0-1557-7b54-a931-4d777f6bd003";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  executePaymentMock.mockReset();
  syncMock.mockReset();
  decideMock.mockReset();
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

const LEDGER_ROW = {
  seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "agent", domain: "contractor", action: "x",
  summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
};

function cycleFake(respond: (request: RecordedRequest) => FakeReply | undefined = () => undefined) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: LEDGER_ROW };
    return respond(request) ?? { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((r) => r.path === `/rest/v1/rpc/${name}`).map((r) => r.body as Record<string, unknown>);
}
function milestonePatches(requests: RecordedRequest[]) {
  return requests.filter((r) => r.path === "/rest/v1/milestones" && r.method === "PATCH");
}

function execution(overrides: Partial<PaymentExecution>): PaymentExecution {
  return {
    idempotencyKey: "key",
    providerTxId: "circle-tx-1",
    txHash: null,
    txRef: "circle-tx-1",
    status: "pending",
    attemptCount: 1,
    error: null,
    reconciled: true,
    chain: "ARC-TESTNET",
    providerMode: "live",
    feeUsd: null,
    feeSource: null,
    settledInMs: null,
    executedAt: null,
    ...overrides,
  };
}

const provider = { mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 } as unknown as ChainProvider;
const milestone = {
  id: MILESTONE_ID,
  title: "Checkout redesign",
  amount: 250,
  contractorId: CONTRACTOR_ID,
  contractorName: "Lena Ortiz",
  address: "0xbeef",
  reasoning: 'Milestone "Checkout redesign" is verified via github. [transfer submitted; awaiting provider confirmation]',
  txRef: "circle-tx-1",
};
const inFlight = { providerTxId: "circle-tx-1", status: "pending" };
const neverSubmitted = { providerTxId: null, status: "submitting" };

describe("existingMilestoneIntents — which milestones the contractor stage reconciles instead of deciding", () => {
  it("looks up milestone intents for verified milestones only, keyed by milestone id", async () => {
    const { fake, run } = cycleFake((r) =>
      r.path === "/rest/v1/payment_intents" ? { body: [{ source_id: "verified-1", provider_tx_id: "circle-tx-1", status: "pending" }] } : undefined
    );

    const intents = await run(() =>
      existingMilestoneIntents(db(), [
        { id: "pending-1", status: "pending" },
        { id: "verified-1", status: "verified" },
        { id: "verified-2", status: "verified" },
      ])
    );

    // verified-2 has no intent: it is not in the map, so the stage decides it exactly as before.
    expect([...intents.entries()]).toEqual([["verified-1", { providerTxId: "circle-tx-1", status: "pending" }]]);
    expect(intents.has("verified-2")).toBe(false);
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/payment_intents");
    expect(lookup.params.get("source_type")).toBe("eq.milestone");
    expect(lookup.params.get("source_id")).toBe("in.(verified-1,verified-2)");
  });

  it("leaves out a release that failed before Circle returned an id, so the milestone is decided again", async () => {
    // payments.ts records a submission that threw as `failed` with no provider id,
    // the milestone is held, and the GitHub refresh puts it back to `verified`.
    const { run } = cycleFake((r) =>
      r.path === "/rest/v1/payment_intents"
        ? {
            body: [
              { source_id: "failed-no-id", provider_tx_id: null, status: "failed" },
              { source_id: "failed-by-circle", provider_tx_id: "circle-tx-2", status: "failed" },
              { source_id: "submitting", provider_tx_id: null, status: "submitting" },
            ],
          }
        : undefined
    );

    const intents = await run(() =>
      existingMilestoneIntents(db(), [
        { id: "failed-no-id", status: "verified" },
        { id: "failed-by-circle", status: "verified" },
        { id: "submitting", status: "verified" },
      ])
    );

    // Nothing moved: it goes back through the model and the limit and risk guardrails.
    expect(intents.has("failed-no-id")).toBe(false);
    // A transfer Circle reported failed is a real transfer, still reconciled by its id.
    expect(intents.get("failed-by-circle")).toEqual({ providerTxId: "circle-tx-2", status: "failed" });
    expect(intents.get("submitting")).toEqual({ providerTxId: null, status: "submitting" });
  });

  it("asks nothing when no milestone is verified", async () => {
    const { fake, run } = cycleFake();

    const intents = await run(() => existingMilestoneIntents(db(), [{ id: "pending-1", status: "pending" }]));

    expect(intents.size).toBe(0);
    expect(fake.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);
  });
});

describe("reconcileMilestone — a verified milestone with a release in flight", () => {
  it("reconciles a confirmed intent to paid with its txRef, without the model, the guardrails or the pause", async () => {
    executePaymentMock.mockResolvedValue(
      execution({ status: "confirmed", txHash: "0xhash", txRef: "0xhash", reconciled: false, feeUsd: 0.003, feeSource: "chain_reported", settledInMs: 4000, executedAt: "2026-09-29T00:00:00Z" })
    );
    syncMock.mockResolvedValue(350);
    const { fake, run } = cycleFake();

    const outcome = await run(() =>
      reconcileMilestone(milestone, { providerTxId: "circle-tx-1", status: "confirmed" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(decideMock).not.toHaveBeenCalled();
    // The guardrails read the contractor's risk; a transfer that exists never re-reads it, nor the pause.
    expect(fake.requests.some((r) => r.path === "/rest/v1/counterparties")).toBe(false);
    expect(rpcBodies(fake.requests, "agent_paused")).toHaveLength(0);
    expect(executePaymentMock).toHaveBeenCalledTimes(1);
    expect(executePaymentMock).toHaveBeenCalledWith(
      { sourceType: "milestone", sourceId: MILESTONE_ID, fromAccountId: ACCOUNT_ID, destination: "0xbeef", amount: 250, memo: `Milestone ${MILESTONE_ID}` },
      { provider }
    );
    expect(syncMock).toHaveBeenCalledWith(ACCOUNT_ID);

    const [patch] = milestonePatches(fake.requests);
    expect(patch.params.get("id")).toBe(`eq.${MILESTONE_ID}`);
    const body = patch.body as Record<string, unknown>;
    expect(body.status).toBe("paid");
    expect(body.tx_ref).toBe("0xhash");
    expect(typeof body.settled_at).toBe("string");
    expect(body.agent_reasoning).toBe(milestone.reasoning);
    // The decision time is the original decision's, not the reconcile's.
    expect(body).not.toHaveProperty("decided_at");

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_domain).toBe("contractor");
    expect(append.p_action).toBe("milestone_reconcile");
    expect(append.p_summary).toBe('RECONCILE milestone "Checkout redesign" for Lena Ortiz (250 USDC): paid');
    expect(append.p_detail).toMatchObject({
      milestoneId: MILESTONE_ID,
      counterpartyId: CONTRACTOR_ID,
      reconciled: true,
      previousStatus: "verified",
      execution: { txRef: "0xhash", chainMode: "live", resultingStatus: "paid", settlementRequired: true, feeUsd: 0.003, settledInMs: 4000 },
    });
    expect(append.p_detail).not.toHaveProperty("observed");

    expect(outcome).toEqual({
      status: "paid",
      operatingBalance: 350,
      line: { domain: "contractor", message: "Lena Ortiz: reconciled an in-flight release, now paid (250 USDC)" },
    });
  });

  it("keeps a confirmed release paid, and only notes it, when the balance sync fails afterwards", async () => {
    executePaymentMock.mockResolvedValue(execution({ status: "confirmed", txHash: "0xhash", txRef: "0xhash" }));
    syncMock.mockRejectedValue(new Error("accounts read failed: connection reset"));
    const { fake, run } = cycleFake();

    const outcome = await run(() => reconcileMilestone(milestone, inFlight, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(outcome.status).toBe("paid");
    expect(outcome.operatingBalance).toBeNull();
    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("paid");
    expect(body.tx_ref).toBe("0xhash");
    expect(body.agent_reasoning).toBe(`${milestone.reasoning} [balance sync failed: accounts read failed: connection reset]`);
  });

  it("leaves a still-pending release verified, keeps its txRef, and does not repeat the note", async () => {
    executePaymentMock.mockResolvedValue(execution({ status: "pending", txRef: null }));
    const { fake, run } = cycleFake();

    const outcome = await run(() => reconcileMilestone(milestone, inFlight, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(syncMock).not.toHaveBeenCalled();
    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("verified");
    expect(body.tx_ref).toBe("circle-tx-1");
    expect(body.settled_at).toBeNull();
    expect(body.agent_reasoning).toBe(milestone.reasoning);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ reconciled: true, execution: { txRef: "circle-tx-1", resultingStatus: "verified" } });
    expect(outcome).toEqual({
      status: "verified",
      operatingBalance: null,
      line: { domain: "contractor", message: "Lena Ortiz: reconciled an in-flight release, still pending (250 USDC)" },
    });
  });

  it("records a provider-reported failure as held, keeping the txRef and noting why", async () => {
    executePaymentMock.mockResolvedValue(execution({ status: "failed", error: null }));
    const { fake, run } = cycleFake();

    const outcome = await run(() => reconcileMilestone(milestone, inFlight, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(outcome.status).toBe("held");
    expect(outcome.line.message).toBe("Lena Ortiz: reconciled an in-flight release, now held (250 USDC)");
    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.tx_ref).toBe("circle-tx-1");
    expect(body.agent_reasoning).toBe(`${milestone.reasoning} [transfer failed: provider reported failure]`);
  });

  it("does not append a note the reasoning already ends with, when a failed release churns back through verified", async () => {
    // Circle reported the transfer failed; the GitHub refresh puts the held milestone back
    // to `verified` every cycle, and each reconcile holds it again with the same note.
    executePaymentMock.mockResolvedValue(execution({ status: "failed", error: null }));
    const { fake, run } = cycleFake();
    const reasoning = `${milestone.reasoning} [transfer failed: provider reported failure]`;

    await run(() =>
      reconcileMilestone({ ...milestone, reasoning }, { providerTxId: "circle-tx-1", status: "failed" }, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.agent_reasoning).toBe(reasoning);
  });

  it("leaves the release verified, and says so, when the reconcile could not read the provider", async () => {
    // executePayment's reconcile catch: the intent keeps its provider id and records our own error.
    executePaymentMock.mockResolvedValue(execution({ status: "failed", error: "provider unreachable" }));
    const { fake, run } = cycleFake();

    const outcome = await run(() => reconcileMilestone(milestone, inFlight, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(outcome).toEqual({
      status: "verified",
      operatingBalance: null,
      line: { domain: "contractor", message: "Lena Ortiz: could not reconcile the in-flight release, left pending for the next cycle (250 USDC)" },
    });
    expect(milestonePatches(fake.requests)).toHaveLength(0);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_domain).toBe("contractor");
    expect(append.p_action).toBe("milestone_reconcile");
    expect(append.p_summary).toBe('RECONCILE milestone "Checkout redesign" for Lena Ortiz (250 USDC): not completed, left pending');
    expect(append.p_detail).toMatchObject({
      milestoneId: MILESTONE_ID,
      counterpartyId: CONTRACTOR_ID,
      reconciled: false,
      reconcileError: "provider unreachable",
      previousStatus: "verified",
      execution: { txRef: "circle-tx-1", resultingStatus: "verified" },
    });
  });

  it("leaves the release verified when executePayment threw before any result", async () => {
    executePaymentMock.mockRejectedValue(new Error("store unavailable"));
    const { fake, run } = cycleFake();

    const outcome = await run(() => reconcileMilestone(milestone, inFlight, { db: db(), provider, operating: { id: ACCOUNT_ID } }));

    expect(outcome.status).toBe("verified");
    expect(milestonePatches(fake.requests)).toHaveLength(0);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ reconciled: false, reconcileError: "execution failed: store unavailable" });
  });

  it("leaves the release verified, without calling executePayment, when there is no operating account", async () => {
    const { fake, run } = cycleFake();

    const outcome = await run(() => reconcileMilestone(milestone, inFlight, { db: db(), provider, operating: null }));

    expect(executePaymentMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "verified",
      operatingBalance: null,
      line: { domain: "contractor", message: "Lena Ortiz: in-flight release left pending, no operating account to reconcile it against (250 USDC)" },
    });
    expect(milestonePatches(fake.requests)).toHaveLength(0);
  });

  it("does not resubmit to a contractor now screened high risk, and holds with a note", async () => {
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "high" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });

    const outcome = await run(() =>
      reconcileMilestone({ ...milestone, txRef: null }, neverSubmitted, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(executePaymentMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    const [lookup] = fake.requests.filter((r) => r.path === "/rest/v1/counterparties");
    expect(lookup.params.get("id")).toBe(`eq.${CONTRACTOR_ID}`);
    expect(outcome.status).toBe("held");
    expect(outcome.line.message).toBe("Lena Ortiz: not resubmitted, the contractor is now screened high risk (250 USDC)");
    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.tx_ref).toBeNull();
    expect(body.agent_reasoning).toBe(`${milestone.reasoning} [not resubmitted: counterparty now screened high risk]`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ notResubmittedBecause: "counterparty.high_risk", execution: { resultingStatus: "held" } });
  });

  it("holds without calling executePayment when no transfer exists yet and the agent is paused", async () => {
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: true };
      return undefined;
    });

    const outcome = await run(() =>
      reconcileMilestone({ ...milestone, txRef: null }, neverSubmitted, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(executePaymentMock).not.toHaveBeenCalled();
    expect(decideMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("held");
    expect(outcome.line.message).toBe("Lena Ortiz: not paid, the agent was paused (250 USDC)");
    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.status).toBe("held");
    expect(body.agent_reasoning).toBe(`${milestone.reasoning} [not paid: the agent was paused]`);
    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect((append.p_detail as { execution: Record<string, unknown> }).execution.heldBecause).toBe("agent_paused");
  });

  it("resubmits through executePayment when the contractor is not high risk and the agent is not paused", async () => {
    executePaymentMock.mockResolvedValue(execution({ status: "confirmed", txHash: "0xhash", txRef: "0xhash", reconciled: false }));
    syncMock.mockResolvedValue(200);
    const { run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });

    const outcome = await run(() =>
      reconcileMilestone({ ...milestone, txRef: null }, neverSubmitted, { db: db(), provider, operating: { id: ACCOUNT_ID } })
    );

    expect(executePaymentMock).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("paid");
    expect(outcome.operatingBalance).toBe(200);
  });

  it("holds, noting it, when no transfer exists yet and there is no operating account", async () => {
    const { fake, run } = cycleFake((r) => {
      if (r.path === "/rest/v1/counterparties" && r.method === "GET") return { body: { risk_level: "low" } };
      if (r.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return undefined;
    });

    const outcome = await run(() => reconcileMilestone({ ...milestone, txRef: null }, neverSubmitted, { db: db(), provider, operating: null }));

    expect(executePaymentMock).not.toHaveBeenCalled();
    expect(outcome.status).toBe("held");
    const body = milestonePatches(fake.requests)[0].body as Record<string, unknown>;
    expect(body.agent_reasoning).toBe(`${milestone.reasoning} [no operating account configured]`);
  });

  it("fails closed when the contractor's risk level cannot be read", async () => {
    const { run } = cycleFake((r) =>
      r.path === "/rest/v1/counterparties" ? { status: 500, body: { message: "counterparties read failed: connection reset" } } : undefined
    );

    await expect(
      run(() => reconcileMilestone({ ...milestone, txRef: null }, neverSubmitted, { db: db(), provider, operating: { id: ACCOUNT_ID } }))
    ).rejects.toThrow("counterparties read failed: connection reset");
    expect(executePaymentMock).not.toHaveBeenCalled();
  });
});
