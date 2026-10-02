import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { CounterpartyLimitError } from "@/lib/counterparty-limit";
import { acceptProposal, dismissProposal, listOpenProposals } from "@/lib/policy-proposals";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * People deciding the agent's proposals (docs/superpowers/specs/2026-10-02-limit-proposals-design.md R4):
 * accepting is the ordinary limit change, then the proposal closes compare-and-set and is signed; a
 * proposal whose limit changed meanwhile is superseded; dismissing is signed and changes nothing.
 */

const { ledgerMock, changeMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), changeMock: vi.fn() }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/counterparty-limit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/counterparty-limit")>()), changeCounterpartyLimit: changeMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-00000000a8a8";
const ACTOR = "a1b2c3d4-0000-4000-8000-000000000005";
const PROPOSAL = {
  id: "prop-1",
  counterparty_id: "cp-c",
  from_limit: "2.000000",
  to_limit: "6.000000",
  reasoning: "People approved three payments above the limit.",
  evidence: [{ invoiceId: "i2", amountUsdc: 5, approvedAt: "2026-09-30T05:21:00Z", agentAction: "ap_hold" }],
  created_at: "2026-10-02T05:00:00Z",
  status: "open",
  counterparties: { name: "Centronex", baseline_payment_limit: "2.000000" },
};

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ACTOR }), fn);

function workspace(over: { proposal?: unknown; closed?: unknown[] } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/policy_proposals" && r.method === "GET") return r.params.has("id") ? { body: over.proposal === undefined ? PROPOSAL : over.proposal } : { body: [PROPOSAL] };
    if (r.path === "/rest/v1/policy_proposals" && r.method === "PATCH") return { body: over.closed ?? [{ id: "prop-1" }] };
    return { body: [] };
  };
}
const patches = () => fake.requests.filter((r) => r.path === "/rest/v1/policy_proposals" && r.method === "PATCH");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  changeMock.mockReset().mockResolvedValue({ name: "Centronex", from: 2, to: 6, current: 6 });
});

describe("acceptProposal", () => {
  it("changes the limit as a person's edit would, closes the proposal compare-and-set, and signs it", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => acceptProposal({ actorId: ACTOR, id: "prop-1" }))).toEqual({ counterpartyName: "Centronex", to: 6, current: 6 });
    expect(changeMock).toHaveBeenCalledWith({ actorId: ACTOR, counterpartyId: "cp-c", raw: "6" });
    expect(patches()[0].body).toMatchObject({ status: "accepted", decided_by: ACTOR });
    expect(patches()[0].params.get("status")).toBe("eq.open");
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ actor: "human", action: "policy_proposal_accepted", detail: expect.objectContaining({ proposalId: "prop-1", fromLimit: 2, toLimit: 6 }) }));
  });

  it("supersedes a proposal whose limit changed since, and changes nothing", async () => {
    fake = fakeSupabase(workspace({ proposal: { ...PROPOSAL, counterparties: { name: "Centronex", baseline_payment_limit: "4.000000" } } }));
    await expect(run(() => acceptProposal({ actorId: ACTOR, id: "prop-1" }))).rejects.toMatchObject({ code: "superseded" });
    expect(changeMock).not.toHaveBeenCalled();
    expect(patches()[0].body).toMatchObject({ status: "superseded" });
  });

  it("passes on the limit change's own refusal, such as a cycle running, and leaves the proposal open", async () => {
    fake = fakeSupabase(workspace());
    changeMock.mockRejectedValue(new CounterpartyLimitError("cycle_running"));
    await expect(run(() => acceptProposal({ actorId: ACTOR, id: "prop-1" }))).rejects.toBeInstanceOf(CounterpartyLimitError);
    expect(patches()).toEqual([]);
  });

  it("refuses one already decided", async () => {
    fake = fakeSupabase(workspace({ proposal: { ...PROPOSAL, status: "dismissed" } }));
    await expect(run(() => acceptProposal({ actorId: ACTOR, id: "prop-1" }))).rejects.toMatchObject({ code: "not_open" });
  });
});

describe("dismissProposal", () => {
  it("closes it and signs it, changing nothing", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => dismissProposal({ actorId: ACTOR, id: "prop-1" }))).toEqual({ counterpartyName: "Centronex" });
    expect(patches()[0].body).toMatchObject({ status: "dismissed", decided_by: ACTOR });
    expect(changeMock).not.toHaveBeenCalled();
    expect(ledgerMock).toHaveBeenCalledWith(expect.objectContaining({ action: "policy_proposal_dismissed" }));
  });

  it("says when someone decided it first", async () => {
    fake = fakeSupabase(workspace({ closed: [] }));
    await expect(run(() => dismissProposal({ actorId: ACTOR, id: "prop-1" }))).rejects.toMatchObject({ code: "not_open" });
  });
});

describe("listOpenProposals", () => {
  it("shows each open one with its counterparty and evidence", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => listOpenProposals())).toEqual([
      {
        id: "prop-1",
        counterpartyId: "cp-c",
        counterpartyName: "Centronex",
        fromLimit: 2,
        toLimit: 6,
        reasoning: "People approved three payments above the limit.",
        evidence: [{ invoiceId: "i2", amountUsdc: 5, approvedAt: "2026-09-30T05:21:00Z", agentAction: "ap_hold" }],
        createdAt: "2026-10-02T05:00:00Z",
      },
    ]);
  });
});
