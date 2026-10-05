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

  it("says Circle never answered its transfer's send, and that Pay now and Close look for it on Circle first (payment safety R6)", () => {
    const intent = { status: "failed", provider_tx_id: null, last_error: "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted", provider_state: null, failure_reason: null };
    const reason = heldReason(facts({ intent, lastEntry: { action: "milestone_release", detail: {} } }));
    expect(reason).toMatchObject({ kind: "unknown", hint: "Transfer to look for", canPay: true, canClose: true });
    expect(reason.text).toBe(
      "Circle did not answer when its transfer was sent, so it may have taken it. Pay now and Close look for it on Circle first: Pay now records it if Circle has it, and sends it only once Circle shows none."
    );
  });

  it("carries what would hold it with no transfer: no Pay now for a contractor screened high risk, and the agent's own hold to override", () => {
    const intent = { status: "failed", provider_tx_id: null, last_error: "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted", provider_state: null, failure_reason: null };
    const risky = heldReason(facts({ intent, contractor: { riskLevel: "high" } }));
    expect(risky).toMatchObject({ kind: "unknown", canPay: false, canClose: true });
    expect(risky.text).toContain("is screened high risk, so it is not paid.");
    expect(heldReason(facts({ intent })).override).toBe(heldReason(facts({ intent: null })).override);
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

  it("names the hold of a first payment to an address one person alone stands behind, which someone else may pay (new payee check)", () => {
    const reason = heldReason(facts({ lastEntry: { action: "milestone_release", detail: { guardrailBlocked: true, guardrailRule: "counterparty.new_payee" } } }));
    expect(reason).toMatchObject({ kind: "new_payee", hint: "First payment to a new address", canPay: true, canClose: true, override: true });
    expect(reason.text).toBe(
      "This would be the first payment to Puka Hotel's address, and only one person stands behind it. Someone other than whoever gave the address pays it now; after that, the agent pays this address on its own."
    );
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
  /** `sole_approver`'s reply (migration 0061); unset falls through to the default `[]`, which is not `true`. */
  soleApprover?: FakeReply;
  /** The contractor's entries that set or confirmed its address, newest first (new payee check N2); none by default. */
  addressEntries?: Array<Record<string, unknown>>;
  /** The workspace's figure above which a payment needs two approvals (two approvals T1); none by default. */
  twoApprovals?: number;
  /** The milestone's open approvals (two approvals T4); none by default. */
  approvals?: Array<Record<string, unknown>>;
  /** How many members may approve payments besides those named (`approvers_besides`); 2 by default. */
  approversBesides?: number;
} = {}) {
  let intentRow: Record<string, unknown> | null = options.intent === undefined ? FAILED_INTENT : options.intent;
  const fake = fakeSupabase((request: RecordedRequest) => {
    // What the new payee check reads (N1, N2): the confirmed payments' addresses, and the address's entries.
    if (request.path === "/rest/v1/payment_intents" && request.params.get("status") === "eq.confirmed") return { body: [] };
    if (request.path === "/rest/v1/ledger_entries" && request.params.has("detail->>counterpartyId")) return { body: options.addressEntries ?? [] };
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/milestones" && request.method === "GET") return { body: milestoneRow(options.milestone) };
    if (request.path === "/rest/v1/milestones" && request.method === "PATCH") return { body: [{ id: MILESTONE }] };
    if (request.path === "/rest/v1/payment_intents" && request.method === "PATCH") {
      intentRow = { ...(intentRow as Record<string, unknown>), ...(request.body as Record<string, unknown>) };
      return { body: [] };
    }
    if (request.path === "/rest/v1/payment_intents") return { body: intentRow };
    if (request.path === "/rest/v1/rpc/ledger_entries_for_targets") return { body: [options.last ?? entryRow("milestone_release", {})] };
    if (request.path === "/rest/v1/accounts") return { body: { id: "acct-1", balance: options.balance ?? "8" } };
    if (request.path === "/rest/v1/rpc/claim_milestone_decision") return options.claim ? options.claim() : { body: milestoneRow() };
    if (request.path === "/rest/v1/rpc/sole_approver" && options.soleApprover) return options.soleApprover;
    if (request.path === "/rest/v1/approval_policies") return { body: options.twoApprovals ? [{ two_approvals_above: String(options.twoApprovals) }] : [] };
    if (request.path === "/rest/v1/payment_approvals" && request.method === "GET") return { body: options.approvals ?? [] };
    if (request.path === "/rest/v1/payment_approvals" && request.method === "POST") {
      const body = request.body as Record<string, unknown>;
      return { status: 201, body: { id: "appr-new", approved_by: body.approved_by, approved_at: "2026-10-05T09:00:00.000Z", amount: String(body.amount), currency: body.currency, address: body.address } };
    }
    if (request.path === "/rest/v1/rpc/approvers_among") return { body: (request.body as { p_users: string[] }).p_users };
    if (request.path === "/rest/v1/rpc/approvers_besides") return { body: options.approversBesides ?? 2 };
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

describe("Close over a transfer Circle never answered (payment safety R6)", () => {
  const unknownIntent = (minutesAgo: number) => ({
    ...FAILED_INTENT,
    idempotency_key: "key-1",
    previous_attempts: [],
    provider_tx_id: null,
    provider_state: null,
    failure_reason: null,
    last_error: "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted",
    updated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  const looking = () =>
    getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003, findTransferByRef: vi.fn(async () => null) });

  it("looks for it first, and refuses, saying when to try again, while Circle has not listed it", async () => {
    looking();
    const w = world({ intent: unknownIntent(5) });
    const attempt = w.run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Not needed" }));
    expect(await refusal(attempt)).toBe("payment_unknown");
    await expect(attempt).rejects.toThrow(/Circle did not answer when this milestone's payment was sent, and has not listed it yet\. Try again from \d\d:\d\d UTC/);
    expect(w.claimed()).toBe(false);
  });

  it("closes it once Circle has listed nothing 15 minutes after the send", async () => {
    looking();
    const w = world({ intent: unknownIntent(20) });
    await w.run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Not needed" }));
    expect(w.claimed()).toBe(true);
  });
});

describe("Pay now while payments are switched off (payment safety S4)", () => {
  it("refuses a new payment before any claim", async () => {
    const { fake, claimed } = world();

    const attempt = runWith({ config: { ...config, paymentsDisabled: true }, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))
    );
    expect(await refusal(attempt)).toBe("payments_off");
    await expect(attempt).rejects.toThrow("Payments are switched off for every workspace right now.");
    expect(claimed()).toBe(false);
  });

  it("still records a transfer already sent, which only reads Circle (payment safety S8)", async () => {
    releaseHeldMilestoneMock.mockResolvedValue(PAID);
    const { fake, claimed } = world({ intent: { ...FAILED_INTENT, status: "pending", provider_state: "SENT", failure_reason: null } });

    await runWith({ config: { ...config, paymentsDisabled: true }, db: fake.client, fetch: fake.fetch }, () =>
      withOrg(ORG, () => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))
    );

    expect(claimed()).toBe(true);
    expect(releaseHeldMilestoneMock).toHaveBeenCalledTimes(1);
  });
});

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

  describe("over a transfer Circle never answered (payment safety R1)", () => {
    const UNKNOWN = { status: "failed", provider_tx_id: null, last_error: "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted", provider_state: null, failure_reason: null };

    it("refuses what the agent's release refuses, since sending it again may be a new payment", async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ risk_level: "high" }, "high_risk"],
        [{ payment_limit: "0.25", risk_notes: "Matched a politically exposed person" }, "above_limit"],
        [{ address_changed_at: "2026-10-02T09:00:00Z" }, "address_unconfirmed"],
      ];
      for (const [contractor, code] of cases) {
        const { run, claimed } = world({ intent: UNKNOWN, milestone: { counterparties: { ...milestoneRow().counterparties, ...contractor } } });
        expect(await refusal(run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))), code).toBe(code);
        expect(claimed()).toBe(false);
      }
      expect(releaseHeldMilestoneMock).not.toHaveBeenCalled();
    });

    it("sends it again under its key without the balance check, which the transfer may already have lowered", async () => {
      releaseHeldMilestoneMock.mockResolvedValue(PAID);
      const { run } = world({ intent: UNKNOWN, balance: "0" });

      await expect(run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))).resolves.toMatchObject({ status: "paid" });
      expect(releaseHeldMilestoneMock).toHaveBeenCalledTimes(1);
    });
  });

  it("needs someone other than whoever added it to override the agent's own hold", async () => {
    const { run, claimed } = world({ milestone: { created_by: ACTOR }, intent: null, last: entryRow("milestone_hold", { guardrailBlocked: false }) });
    expect(await refusal(run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("self_approval");
    expect(claimed()).toBe(false);
  });

  it("lets the workspace's sole approver override the agent's hold on a milestone they added, and the ledger says so", async () => {
    releaseHeldMilestoneMock.mockResolvedValue({ ...PAID, paymentExecution: { attempt: 1, retriedAfter: null } });
    const { fake, run, claimed, ledger } = world({
      milestone: { created_by: ACTOR },
      intent: null,
      last: entryRow("milestone_hold", { guardrailBlocked: false }),
      soleApprover: { body: true },
    });
    await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));

    expect(fake.requests.filter((request) => request.path === "/rest/v1/rpc/sole_approver").map((request) => request.body)).toEqual([
      { p_org_id: ORG, p_user_id: ACTOR },
    ]);
    expect(claimed()).toBe(true);
    const [entry] = ledger();
    expect(entry.p_summary).toBe(`Paid milestone "Clean service" to Puka Hotel now: 0.3 USDC (entered and approved by the workspace's only approver)`);
    expect(entry.p_detail).toMatchObject({ by: ACTOR, soleApprover: true, status: "paid" });
  });

  it("does not ask about a sole approver when someone other than whoever added it pays it now", async () => {
    releaseHeldMilestoneMock.mockResolvedValue(PAID);
    const { fake, run, ledger } = world({ intent: null, last: entryRow("milestone_hold", { guardrailBlocked: false }), soleApprover: { body: true } });
    await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));

    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/sole_approver")).toBe(false);
    expect(ledger()[0].p_detail).not.toHaveProperty("soleApprover");
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

  it("names the surface and its link when the close did not come from the console", async () => {
    const { run, ledger } = world();
    await run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Paid in cash", provenance: { via: "slack", linkId: "link-1" } }));
    const [entry] = ledger();
    expect(entry.p_detail).toMatchObject({ by: ACTOR, reason: "Paid in cash", via: "slack", linkId: "link-1" });
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

describe("Pay now and the first payment to an address (new payee check N4)", () => {
  const heldAsNewPayee = entryRow("milestone_release", { guardrailBlocked: true, guardrailRule: "counterparty.new_payee" });
  const gaveAddress = (by: string) => [{ action: "create_counterparty", detail: { by, counterpartyId: CONTRACTOR, address: ADDRESS } }];
  const live = () => getChainProviderMock.mockReturnValue({ mode: "live", earnMode: "simulate", estimatedFeeUsd: 0.003 });

  it("refuses the person who gave the contractor's address, before any claim", async () => {
    live();
    const { run, claimed } = world({ intent: null, last: heldAsNewPayee, addressEntries: gaveAddress(ACTOR) });
    expect(await refusal(run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("new_payee_self");
    expect(claimed()).toBe(false);
    expect(releaseHeldMilestoneMock).not.toHaveBeenCalled();
  });

  it("lets the workspace's only approver, or anyone else, pay it, and records that it was the address's first payment", async () => {
    live();
    releaseHeldMilestoneMock.mockResolvedValue(PAID);
    const alone = world({ intent: null, last: heldAsNewPayee, addressEntries: gaveAddress(ACTOR), soleApprover: { body: true } });
    expect((await alone.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))).status).toBe("paid");
    expect(alone.ledger()[0].p_detail).toMatchObject({ firstPayment: true, heldFor: "new_payee" });

    const other = world({ intent: null, last: heldAsNewPayee, addressEntries: gaveAddress(CREATOR) });
    expect((await other.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))).status).toBe("paid");
  });
});


describe("a held milestone above the workspace's figure for two approvals (two approvals T3–T7)", () => {
  const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
  const HELD = entryRow("milestone_release", {
    guardrailBlocked: true,
    guardrailRule: "workspace.two_approvals",
    observed: { amount: 0.3, twoApprovalsAbove: 0.2 },
  });
  const approval = (by: string, over: Record<string, unknown> = {}) => ({
    id: `appr-${by.slice(-2)}`, approved_by: by, approved_at: "2026-10-05T08:00:00.000Z", amount: "0.300000", currency: "USDC", address: ADDRESS, ...over,
  });
  const approvalRequests = (requests: RecordedRequest[], method: string) => requests.filter((r) => r.path === "/rest/v1/payment_approvals" && r.method === method);

  it("says it waits for two approvals, and that Pay now gives one", () => {
    const reason = heldReason(facts({ intent: null, lastEntry: { action: HELD.action, detail: HELD.detail } }));
    expect(reason).toMatchObject({ kind: "two_approvals", hint: "Needs two approvals", canPay: true, canClose: true, override: true, link: null });
    expect(reason.text).toBe(
      "Payments above 0.2 USDC need two approvals in this workspace. The first Pay now records an approval and sends nothing; another person's Pay now pays it."
    );
  });

  it("records the first Pay now as an approval, and sends nothing", async () => {
    const { fake, run, claimed, ledger } = world({ intent: null, last: HELD, twoApprovals: 0.2 });

    const result = await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));

    expect(result).toEqual({ status: "approved", txRef: null, note: "" });
    expect(claimed()).toBe(false);
    expect(releaseHeldMilestoneMock).not.toHaveBeenCalled();
    expect(approvalRequests(fake.requests, "POST")[0].body).toMatchObject({
      source_type: "milestone", source_id: MILESTONE, approved_by: ACTOR, amount: 0.3, currency: "USDC", address: ADDRESS,
    });
    const [entry] = ledger();
    expect(entry).toMatchObject({
      p_actor: "human",
      p_domain: "contractor",
      p_action: "milestone_approval_given",
      p_summary: 'Approved milestone "Clean service" for Puka Hotel: 0.3 USDC; one more approval pays it (payments above 0.2 USDC need two)',
      p_detail: { by: ACTOR, milestoneId: MILESTONE, counterpartyId: CONTRACTOR, amount: 0.3, currency: "USDC", address: ADDRESS, twoApprovalsAbove: 0.2 },
    });
  });

  it("pays on another person's Pay now, using both approvals, and names them", async () => {
    releaseHeldMilestoneMock.mockResolvedValue({ ...PAID, paymentExecution: null });
    const { fake, run, claimed, ledger } = world({ intent: null, last: HELD, twoApprovals: 0.2, approvals: [approval(OTHER)] });

    const result = await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }));

    expect(result.status).toBe("paid");
    expect(claimed()).toBe(true);
    expect(approvalRequests(fake.requests, "PATCH")).toHaveLength(1);
    const [entry] = ledger();
    expect(entry.p_action).toBe("milestone_approval_paid");
    expect(entry.p_summary).toBe('Paid milestone "Clean service" to Puka Hotel now: 0.3 USDC (the second of two approvals)');
    expect(entry.p_detail).toMatchObject({
      twoApprovalsAbove: 0.2,
      approvals: [
        { by: OTHER, at: "2026-10-05T08:00:00.000Z" },
        { by: ACTOR, at: "2026-10-05T09:00:00.000Z" },
      ],
    });
  });

  it("refuses the same person twice, and whoever added it while two others can approve", async () => {
    const twice = world({ intent: null, last: HELD, twoApprovals: 0.2, approvals: [approval(ACTOR)] });
    expect(await refusal(twice.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("already_approved");

    const own = world({ intent: null, last: HELD, twoApprovals: 0.2, milestone: { created_by: ACTOR } });
    expect(await refusal(own.run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE })))).toBe("self_approval");
    expect(approvalRequests(own.fake.requests, "POST")).toHaveLength(0);
  });

  it("lets whoever added it give one when fewer than two others can, and says so", async () => {
    const { run, ledger } = world({ intent: null, last: HELD, twoApprovals: 0.2, milestone: { created_by: ACTOR }, approversBesides: 1 });
    expect((await run(() => payHeldMilestone({ actorId: ACTOR, milestoneId: MILESTONE }))).status).toBe("approved");
    expect(ledger()[0].p_detail).toMatchObject({ fewApprovers: true });
  });

  it("clears the approvals given when it is closed without paying", async () => {
    const { fake, run } = world({ intent: null, last: HELD, twoApprovals: 0.2 });
    await run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Not delivered" }));
    const cleared = approvalRequests(fake.requests, "DELETE");
    expect(cleared).toHaveLength(1);
    expect(cleared[0].params.get("source_type")).toBe("eq.milestone");
    expect(cleared[0].params.get("source_id")).toBe(`eq.${MILESTONE}`);
  });
});
