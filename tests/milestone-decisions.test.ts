import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { closeMilestone, heldReason, MilestoneDecisionError, payHeldMilestone, type HeldFacts } from "@/lib/agent/milestone-decisions";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A person decides a held milestone (docs/superpowers/specs/2026-10-02-held-milestone-actions-design.md): what
 * each held row waits for, Pay now with the agent's own checks, and Close without paying with a reason. The
 * release itself is `releaseHeldMilestone`'s (tests/held-milestone-release.test.ts), mocked here.
 */

const { releaseHeldMilestoneMock, syncOperatingBalanceMock } = vi.hoisted(() => ({
  releaseHeldMilestoneMock: vi.fn(),
  syncOperatingBalanceMock: vi.fn(),
}));
vi.mock("@/lib/agent/orchestrator", () => ({ releaseHeldMilestone: releaseHeldMilestoneMock }));
vi.mock("@/lib/agent/pay", () => ({
  payInvoice: vi.fn(),
  syncOperatingBalance: syncOperatingBalanceMock,
  payoutAddress: (address: string | null, id: string) => address ?? `sim:${id}`,
}));
const { getChainProviderMock } = vi.hoisted(() => ({ getChainProviderMock: vi.fn() }));
vi.mock("@/lib/circle", () => ({ getChainProvider: getChainProviderMock }));

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const CREATOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";
const MILESTONE = "018f8ce0-1557-7b54-a931-4d777f6bc001";
const CONTRACTOR = "018f8ce0-1557-7b54-a931-4d777f6bc002";
const ADDRESS = "0x840de234Bfc3F66fA380888A0a8204D9487D60d4";

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
  releaseHeldMilestoneMock.mockReset();
  syncOperatingBalanceMock.mockReset();
  getChainProviderMock.mockReset();
  getChainProviderMock.mockReturnValue({ mode: "simulate", earnMode: "simulate", estimatedFeeUsd: 0.01 });
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const CONTRACTOR_FACTS: HeldFacts["contractor"] = {
  name: "Puka Hotel",
  riskLevel: "clear",
  riskNotes: null,
  paymentLimit: 5,
  baselinePaymentLimit: 5,
  address: ADDRESS,
  addressChangedAt: null,
  addressConfirmedAt: null,
};

function facts(overrides: Partial<Omit<HeldFacts, "contractor">> & { contractor?: Partial<HeldFacts["contractor"]> } = {}): HeldFacts {
  return {
    amount: 0.3,
    agentReasoning: "Verified by hand; within the limit.",
    intent: null,
    lastEntry: { action: "milestone_hold", detail: { guardrailBlocked: false } },
    live: true,
    ...overrides,
    contractor: { ...CONTRACTOR_FACTS, ...overrides.contractor },
  };
}

const FAILED_INTENT = { status: "failed", provider_tx_id: "circle-batch-1", last_error: null, provider_state: "FAILED", failure_reason: "ESTIMATION_ERROR" };

describe("what a held milestone waits for", () => {
  it("says Circle did not send it, in plain words, and offers to send it again or close it", () => {
    const reason = heldReason(facts({ intent: FAILED_INTENT, lastEntry: { action: "milestone_release", detail: {} } }));
    expect(reason).toMatchObject({ kind: "transfer_failed", hint: "Circle did not send it", canPay: true, canClose: true, override: false });
    expect(reason.text).toBe("Circle did not send it: Circle could not prepare the transaction (Circle: ESTIMATION_ERROR). Nothing moved. Pay now sends it again.");
  });

  it("records a transfer that went out, or may still, and never closes over it", () => {
    for (const intent of [
      { ...FAILED_INTENT, status: "pending", provider_state: "SENT", failure_reason: null },
      { ...FAILED_INTENT, status: "confirmed", provider_state: "COMPLETE", failure_reason: null },
    ]) {
      expect(heldReason(facts({ intent })), intent.status).toMatchObject({ kind: "in_flight", canPay: true, canClose: false });
    }
  });

  it("names a screening match that lowered the limit, with where to review it, and offers no Pay now", () => {
    const reason = heldReason(facts({ amount: 1, contractor: { name: "Quoc Duong", riskLevel: "medium", riskNotes: "Matched a politically exposed person", paymentLimit: 0.25, baselinePaymentLimit: 1 } }));
    expect(reason).toMatchObject({ kind: "screening_limit", canPay: false, canClose: true, link: { label: "Counterparties", path: "/counterparties" } });
    expect(reason.text).toBe(
      "A screening match lowered Quoc Duong's limit to 0.25 USDC, below this milestone's 1 USDC. Review the match on Counterparties: once the limit changes, the agent decides it again."
    );
  });

  it("holds a contractor screened high risk, above its limit, or without a confirmed address, before a failed transfer", () => {
    expect(heldReason(facts({ intent: FAILED_INTENT, contractor: { riskLevel: "high" } })).kind).toBe("high_risk");
    expect(heldReason(facts({ amount: 6 })).kind).toBe("above_limit");
    expect(heldReason(facts({ contractor: { addressChangedAt: "2026-10-02T09:00:00Z" } })).kind).toBe("address_unconfirmed");
    expect(heldReason(facts({ contractor: { address: null } })).kind).toBe("no_address");
    // A sandbox pays a simulated address.
    expect(heldReason(facts({ live: false, contractor: { address: null } })).kind).toBe("agent_held");
  });

  it("tells the pause, the spending limit and the agent's own hold apart; overriding a hold needs someone else", () => {
    expect(heldReason(facts({ lastEntry: { action: "milestone_release", detail: { execution: { heldBecause: "agent_paused" } } } }))).toMatchObject({ kind: "paused", override: false });
    expect(heldReason(facts({ lastEntry: { action: "milestone_release", detail: { guardrailBlocked: true, guardrailRule: "workspace.outflow_budget" } } }))).toMatchObject({
      kind: "outflow_budget",
      override: true,
      link: { path: "/console" },
    });
    expect(heldReason(facts())).toMatchObject({ kind: "agent_held", override: true, canPay: true });
  });

  it("repeats an escrow hold's note", () => {
    const reason = heldReason(facts({ agentReasoning: "Release. [not paid: it is being locked in escrow; verify it again once the lock has finished]" }));
    expect(reason).toMatchObject({ kind: "escrow", text: "Not paid: it is being locked in escrow; verify it again once the lock has finished." });
  });
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "sandbox",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

function milestoneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MILESTONE,
    title: "Clean service",
    amount: "0.3",
    status: "held",
    verified: true,
    created_by: CREATOR,
    agent_reasoning: "Within the limit. [transfer failed: provider reported failure]",
    escrow_state: null,
    escrow_refund_after: null,
    counterparties: {
      id: CONTRACTOR,
      name: "Puka Hotel",
      risk_level: "clear",
      risk_notes: null,
      payment_limit: "5",
      baseline_payment_limit: "5",
      address: ADDRESS,
      address_changed_at: null,
      address_confirmed_at: null,
    },
    ...overrides,
  };
}

function entryRow(action: string, detail: Record<string, unknown>) {
  return {
    seq: 763, id: "e763", ts: "2026-10-02T07:00:00Z", actor: "agent", domain: "contractor", action, summary: "",
    detail: { milestoneId: MILESTONE, ...detail }, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
  };
}

function world(options: {
  milestone?: Record<string, unknown>;
  intent?: Record<string, unknown> | null;
  last?: ReturnType<typeof entryRow>;
  balance?: string;
  claim?: () => FakeReply;
} = {}) {
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/milestones" && request.method === "GET") return { body: milestoneRow(options.milestone) };
    if (request.path === "/rest/v1/milestones" && request.method === "PATCH") return { body: [{ id: MILESTONE }] };
    if (request.path === "/rest/v1/payment_intents") return { body: options.intent === undefined ? FAILED_INTENT : options.intent };
    if (request.path === "/rest/v1/rpc/ledger_entries_for_targets") return { body: [options.last ?? entryRow("milestone_release", {})] };
    if (request.path === "/rest/v1/accounts") return { body: { id: "acct-1", balance: options.balance ?? "8" } };
    if (request.path === "/rest/v1/rpc/claim_milestone_decision") return options.claim ? options.claim() : { body: milestoneRow() };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return { body: { ...entryRow("x", {}), seq: 800, actor: "human" } };
    }
    return { body: [] };
  });
  const run = <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn));
  const patch = () => fake.requests.find((request) => request.path === "/rest/v1/milestones" && request.method === "PATCH");
  const claimed = () => fake.requests.some((request) => request.path === "/rest/v1/rpc/claim_milestone_decision");
  const ledger = () => fake.requests.filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry").map((request) => request.body as Record<string, unknown>);
  return { fake, run, patch, claimed, ledger };
}

const PAID = { status: "paid", txRef: `0x${"4".repeat(64)}`, paymentExecution: { attempt: 2, retriedAfter: { providerTxId: "circle-batch-1", providerState: "FAILED", failureReason: "ESTIMATION_ERROR" } }, reasoningSuffix: "", heldBecausePaused: false, operatingBalance: 7.7 };

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(MilestoneDecisionError);
  return (error as MilestoneDecisionError).code;
}

describe("Pay now", () => {
  it("sends again a release Circle failed, records it on the milestone and in the ledger, even for whoever added it", async () => {
    releaseHeldMilestoneMock.mockResolvedValue(PAID);
    const { run, patch, ledger } = world({ milestone: { created_by: ACTOR } });
    const result = await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));

    expect(result.status).toBe("paid");
    expect(releaseHeldMilestoneMock).toHaveBeenCalledWith({ milestoneId: MILESTONE, destination: ADDRESS, amount: 0.3 }, { provider: expect.anything(), operatingAccountId: "acct-1" });
    const update = patch();
    expect(update?.params.get("status")).toBe("eq.held");
    expect(update?.body).toMatchObject({ status: "paid", tx_ref: PAID.txRef, decision_claimed_by: null, decision_claimed_at: null });
    expect((update?.body as Record<string, unknown>).agent_reasoning).toContain("[paid now by a person]");
    const [entry] = ledger();
    expect(entry.p_actor).toBe("human");
    expect(entry.p_action).toBe("milestone_approval_paid");
    expect(entry.p_detail).toMatchObject({ by: ACTOR, milestoneId: MILESTONE, amount: 0.3, overrode: "held", heldFor: "transfer_failed", status: "paid", attempt: 2, retriedAfter: { providerState: "FAILED" } });
  });

  it("puts a submitted transfer back to verified, for the agent's cycle to reconcile", async () => {
    releaseHeldMilestoneMock.mockResolvedValue({ ...PAID, status: "verified", txRef: null, reasoningSuffix: " [transfer submitted; awaiting provider confirmation]" });
    const { run, patch } = world();
    await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));
    expect(patch()?.body).toMatchObject({ status: "verified", settled_at: null });
  });

  it("refuses, before any claim, what the agent's release refuses", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ risk_level: "high" }, "high_risk"],
      [{ payment_limit: "0.25", risk_notes: "Matched a politically exposed person" }, "above_limit"],
      [{ address_changed_at: "2026-10-02T09:00:00Z" }, "address_unconfirmed"],
    ];
    for (const [contractor, code] of cases) {
      const { run, claimed } = world({ milestone: { counterparties: { ...milestoneRow().counterparties, ...contractor } } });
      expect(await refusal(run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))), code).toBe(code);
      expect(claimed()).toBe(false);
    }
    expect(releaseHeldMilestoneMock).not.toHaveBeenCalled();
  });

  it("needs someone other than whoever added it to override the agent's own hold", async () => {
    const { run, claimed } = world({ milestone: { created_by: ACTOR }, intent: null, last: entryRow("milestone_hold", { guardrailBlocked: false }) });
    expect(await refusal(run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("self_approval");
    expect(claimed()).toBe(false);
  });

  it("checks the balance for a new transfer, and not for one already sent", async () => {
    const short = world({ balance: "0.1" });
    expect(await refusal(short.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("insufficient_funds");

    releaseHeldMilestoneMock.mockResolvedValue(PAID);
    const sent = world({ balance: "0", intent: { ...FAILED_INTENT, status: "pending", provider_state: "SENT", failure_reason: null } });
    await sent.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));
    expect(releaseHeldMilestoneMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a milestone someone else is deciding, or one no longer held", async () => {
    const busy = world({ claim: () => ({ status: 400, body: { code: "P0001", message: "already_claimed: someone is deciding this milestone" } }) });
    expect(await refusal(busy.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("already_claimed");
    const paid = world({ milestone: { status: "paid" } });
    expect(await refusal(paid.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("not_held");
    expect(releaseHeldMilestoneMock).not.toHaveBeenCalled();
  });
});

describe("Close without paying", () => {
  it("closes a held milestone with the reason given, and signs it in the ledger", async () => {
    const { run, patch, ledger } = world();
    await run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "  Paid in cash on site  " }));
    const update = patch();
    expect(update?.params.get("status")).toBe("eq.held");
    expect(update?.body).toMatchObject({ status: "closed", closed_by: ACTOR, close_reason: "Paid in cash on site", decision_claimed_at: null });
    expect((update?.body as Record<string, unknown>).agent_reasoning).toContain("[closed without paying by a person: Paid in cash on site]");
    const [entry] = ledger();
    expect(entry.p_action).toBe("milestone_closed");
    expect(entry.p_detail).toMatchObject({ by: ACTOR, milestoneId: MILESTONE, amount: 0.3, heldFor: "transfer_failed", reason: "Paid in cash on site" });
    expect(releaseHeldMilestoneMock).not.toHaveBeenCalled();
  });

  it("needs a reason, and refuses while a transfer may still settle or the USDC is locked in escrow", async () => {
    expect(await refusal(world().run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "   " })))).toBe("reason_required");
    const sending = world({ intent: { ...FAILED_INTENT, status: "pending", provider_state: "SENT", failure_reason: null } });
    expect(await refusal(sending.run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Not needed" })))).toBe("payment_in_flight");
    expect(sending.claimed()).toBe(false);
    const locked = world({ milestone: { escrow_state: "funded" }, intent: null });
    expect(await refusal(locked.run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Not needed" })))).toBe("escrow_locked");
  });
});
