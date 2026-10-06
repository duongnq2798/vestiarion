import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { boundLimit, limitCandidates, niceCeil, proposeLimitChanges, referenceLimit } from "@/lib/agent/proposals";
import type { DecideParams } from "@/lib/agent/decide";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/** The agent learning from people's overrides (docs/superpowers/specs/2026-10-02-limit-proposals-design.md R1–R4). */

const { ledgerMock, decideMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), decideMock: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/agent/decide", () => ({ decide: decideMock }));

const NOW = new Date("2026-10-02T12:00:00Z");
const CENTRONEX = { id: "cp-c", name: "Centronex", role: "vendor", risk_level: "clear", baseline_payment_limit: "2.000000", payment_limit: "2.000000", performance_score: "0.75" };

const approval = (invoiceId: string, ts: string, action = "approval_paid", counterpartyId: string | undefined = "cp-c") => ({
  ts,
  action,
  detail: { invoiceId, by: "u-1", ...(counterpartyId && action === "approval_paid" ? { counterpartyId } : {}) },
});
const decision = (invoiceId: string, amount: number, limit = 2, action = "ap_hold", extra: Record<string, unknown> = {}) => ({
  seq: 1,
  ts: "2026-09-30T00:00:00Z",
  action,
  detail: { invoiceId, guardrailRule: null, observed: { amount, paymentLimit: limit, riskLevel: "clear" }, ...extra },
});

function base(over: Partial<Parameters<typeof limitCandidates>[0]> = {}): Parameters<typeof limitCandidates>[0] {
  return {
    now: NOW,
    approvals: [approval("i1", "2026-09-30T05:20:00Z"), approval("i2", "2026-09-30T05:21:00Z"), approval("i3", "2026-10-02T03:46:00Z")],
    decisions: new Map([
      ["i1", decision("i1", 3, 2, "ap_flag_fraud")],
      ["i2", decision("i2", 5)],
      ["i3", decision("i3", 5)],
    ]),
    invoiceCounterparty: new Map([["i1", "cp-c"], ["i2", "cp-c"], ["i3", "cp-c"]]),
    counterparties: [CENTRONEX],
    proposals: [],
    declines: [],
    ...over,
  };
}

describe("rounding and bounds (R3)", () => {
  it("rounds a limit up to a figure a person would set", () => {
    expect(niceCeil(5.5)).toBe(6);
    expect(niceCeil(0.33)).toBe(0.4);
    expect(niceCeil(123)).toBe(130);
    expect(niceCeil(6)).toBe(6);
    expect(referenceLimit(5)).toBe(6);
  });

  it("accepts a limit from the largest override to twice it, above today's", () => {
    expect(boundLimit(6, 5, 2)).toBe(6);
    expect(boundLimit(10, 5, 2)).toBe(10);
    expect(boundLimit(4.9, 5, 2)).toBeNull();
    expect(boundLimit(10.5, 5, 2)).toBeNull();
    expect(boundLimit(5, 5, 5)).toBeNull();
  });
});

describe("limitCandidates (R1, R2)", () => {
  it("finds a counterparty people approved three times above its limit, as in testnet-2", () => {
    expect(limitCandidates(base())).toEqual([
      expect.objectContaining({ counterpartyId: "cp-c", name: "Centronex", currentLimit: 2, maxOverride: 5, rejections: 0, performanceScore: 0.75 }),
    ]);
    expect(limitCandidates(base())[0].overrides.map((o) => [o.amountUsdc, o.agentAction])).toEqual([[3, "ap_flag_fraud"], [5, "ap_hold"], [5, "ap_hold"]]);
  });

  it("weighs a EURC payable at its USDC value", () => {
    const decisions = new Map([
      ["i1", decision("i1", 1.9, 2, "ap_pay", { usdcValue: 2.2, guardrailRule: "counterparty.payment_limit" })],
      ["i2", decision("i2", 5)],
    ]);
    const found = limitCandidates(base({ approvals: [approval("i1", "2026-10-01T08:51:00Z"), approval("i2", "2026-09-30T05:21:00Z")], decisions }));
    expect(found[0].overrides.map((o) => o.amountUsdc)).toEqual([5, 2.2]);
  });

  it("needs two overrides, ignores approvals within the limit and older than 30 days", () => {
    expect(limitCandidates(base({ approvals: [approval("i2", "2026-09-30T05:21:00Z")] }))).toEqual([]);
    const withinLimit = new Map([["i1", decision("i1", 2)], ["i2", decision("i2", 5)]]);
    expect(limitCandidates(base({ approvals: [approval("i1", "2026-09-30T05:20:00Z"), approval("i2", "2026-09-30T05:21:00Z")], decisions: withinLimit }))).toEqual([]);
    expect(limitCandidates(base({ approvals: [approval("i1", "2026-08-01T00:00:00Z"), approval("i2", "2026-08-02T00:00:00Z")] }))).toEqual([]);
  });

  it("proposes nothing after a rejection above the limit, for a counterparty not screened clear, or a client", () => {
    const rejected = base();
    rejected.approvals.push(approval("i4", "2026-10-01T00:00:00Z", "approval_rejected"));
    rejected.decisions.set("i4", decision("i4", 9));
    rejected.invoiceCounterparty.set("i4", "cp-c");
    expect(limitCandidates(rejected)).toEqual([]);
    expect(limitCandidates(base({ counterparties: [{ ...CENTRONEX, risk_level: "medium" }] }))).toEqual([]);
    expect(limitCandidates(base({ counterparties: [{ ...CENTRONEX, role: "client" }] }))).toEqual([]);
  });

  it("counts only what is still above today's limit", () => {
    expect(limitCandidates(base({ counterparties: [{ ...CENTRONEX, baseline_payment_limit: "4" }] }))[0].overrides.map((o) => o.amountUsdc)).toEqual([5, 5]);
    expect(limitCandidates(base({ counterparties: [{ ...CENTRONEX, baseline_payment_limit: "5" }] }))).toEqual([]);
  });

  it("waits while a proposal is open, and after a dismissal or a decision not to propose, for a newer override", () => {
    expect(limitCandidates(base({ proposals: [{ counterparty_id: "cp-c", status: "open", decided_at: null, created_at: "2026-10-02T04:00:00Z" }] }))).toEqual([]);
    const dismissed = { counterparty_id: "cp-c", status: "dismissed", decided_at: "2026-10-02T04:00:00Z", created_at: "2026-10-02T03:50:00Z" };
    expect(limitCandidates(base({ proposals: [dismissed] }))).toEqual([]);
    expect(limitCandidates(base({ declines: [{ counterpartyId: "cp-c", ts: "2026-10-02T04:00:00Z" }] }))).toEqual([]);
    const later = base({ proposals: [dismissed] });
    later.approvals.push(approval("i5", "2026-10-02T06:00:00Z"));
    later.decisions.set("i5", decision("i5", 4));
    later.invoiceCounterparty.set("i5", "cp-c");
    expect(limitCandidates(later)).toHaveLength(1);
  });
});

describe("proposeLimitChanges", () => {
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-00000000a7a7";
  let fake: ReturnType<typeof fakeSupabase>;
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);

  function workspace(insert: FakeReply = { status: 201, body: { id: "prop-1" } }) {
    const b = base();
    return (r: RecordedRequest): FakeReply => {
      if (r.path === "/rest/v1/ledger_entries" && r.params.get("action")?.startsWith("in.(approval_paid")) return { body: b.approvals };
      if (r.path === "/rest/v1/ledger_entries" && r.params.get("actor") === "eq.agent") return { body: [...b.decisions.values()] };
      if (r.path === "/rest/v1/ledger_entries" && r.params.get("action") === "eq.policy_proposal_declined") return { body: [] };
      if (r.path === "/rest/v1/invoices") return { body: [...b.invoiceCounterparty].map(([id, counterparty_id]) => ({ id, counterparty_id })) };
      if (r.path === "/rest/v1/counterparties") return { body: [CENTRONEX] };
      if (r.path === "/rest/v1/policy_proposals" && r.method === "GET") return { body: [] };
      if (r.path === "/rest/v1/policy_proposals" && r.method === "POST") return insert;
      return { body: [] };
    };
  }
  const model = (answer: Record<string, unknown>) =>
    decideMock.mockImplementation(async (params: DecideParams<{ action: string }>) => {
      const reference = params.fallback();
      return { value: params.schema.parse(answer), mode: "deepseek", reference, agreedWithReference: answer.action === reference.action };
    });
  const posted = () => fake.requests.filter((r) => r.path === "/rest/v1/policy_proposals" && r.method === "POST").map((r) => r.body as Record<string, unknown>);

  beforeEach(() => {
    ledgerMock.mockReset().mockResolvedValue(undefined);
    decideMock.mockReset();
  });

  it("tells the model the workspace's network: Arc mainnet for a workspace there (mainnet copy C1)", async () => {
    fake = fakeSupabase(workspace());
    model({ action: "propose", newLimit: 6, reasoning: "Three approvals above the 2 USDC limit, up to 5 USDC." });
    await runWith(orgTestContext({ config: { ...config, network: "arc-mainnet" }, client: fake.client, orgId: ORG }), () => proposeLimitChanges(db(), NOW));
    const system = (decideMock.mock.calls[0][0] as DecideParams<unknown>).systemPrompt;
    expect(system).toContain("in USDC and EURC on Arc mainnet");
    expect(system).not.toContain("Arc testnet");
  });

  it("opens the proposal the model makes within bounds, and signs it", async () => {
    fake = fakeSupabase(workspace());
    model({ action: "propose", newLimit: 6, reasoning: "Three approvals above the 2 USDC limit, up to 5 USDC." });
    const lines = await run(() => proposeLimitChanges(db(), NOW));

    expect(posted()).toEqual([expect.objectContaining({ kind: "raise_limit", counterparty_id: "cp-c", from_limit: 2, to_limit: 6, decision_mode: "deepseek" })]);
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "agent", action: "policy_proposal_made", detail: expect.objectContaining({ proposalId: "prop-1", fromLimit: 2, toLimit: 6, referenceLimit: 6 }) })
    );
    expect(lines).toEqual([{ domain: "compliance", message: "Proposed raising Centronex's limit from 2 to 6 USDC, for a person to accept" }]);
    const prompt = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt);
    expect(prompt.approvedAboveLimit.map((a: { amountUsdc: number }) => a.amountUsdc)).toEqual([3, 5, 5]);
    expect(prompt.bounds).toEqual({ minimum: 5, maximum: 10 });
  });

  it("keeps the reference limit when the model's is out of bounds, and says so", async () => {
    fake = fakeSupabase(workspace());
    model({ action: "propose", newLimit: 50, reasoning: "Raise it a lot." });
    await run(() => proposeLimitChanges(db(), NOW));
    expect(posted()[0]).toMatchObject({ to_limit: 6 });
    expect(posted()[0].reasoning).toContain("[the model proposed 50 USDC, outside 5–10 USDC; the reference limit stands]");
  });

  it("records a decision not to propose, and opens nothing", async () => {
    fake = fakeSupabase(workspace());
    model({ action: "no_change", reasoning: "Each was a one-off." });
    expect(await run(() => proposeLimitChanges(db(), NOW))).toEqual([]);
    expect(posted()).toEqual([]);
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "policy_proposal_declined", detail: expect.objectContaining({ counterpartyId: "cp-c", reasoning: "Each was a one-off." }) }));
  });

  it("asks nothing when no one approved anything in the window", async () => {
    fake = fakeSupabase(() => ({ body: [] }));
    expect(await run(() => proposeLimitChanges(db(), NOW))).toEqual([]);
    expect(decideMock).not.toHaveBeenCalled();
  });
});
