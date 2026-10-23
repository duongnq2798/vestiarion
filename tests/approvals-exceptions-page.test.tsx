import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COSIGN_BLOCKED } from "@/lib/cosign-state-rules";

/**
 * Approvals with each held payable as an exception someone owns (docs/superpowers/specs/2026-10-13-deal-cash-readiness-
 * design.md E1-E3): the members are read once to say who can act, and a read that fails never takes the page down,
 * where payments are decided, nor says nobody can approve. For a co-signing accountant, the page reads whether each
 * payment can be co-signed now and hands each card its state (2026-10-22-accountant-queue-design.md AQ5).
 */

const { listMembers, cards, waiting, viewer, cosignsNow, readCosignStates } = vi.hoisted(() => ({
  listMembers: vi.fn(),
  cards: [] as Array<{ id: string; exception: unknown; canCosign: boolean; cosign: unknown }>,
  waiting: { payables: [] as unknown[] },
  viewer: { role: "owner" },
  cosignsNow: vi.fn(async () => false),
  readCosignStates: vi.fn(),
}));

const HELD = { id: "inv-1", dueDate: "2026-10-12T00:00:00Z", status: "held", createdBy: "u-entered", discount: null, twoApprovals: null, verdictEntry: null };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/membership", () => ({
  requireMembership: vi.fn(async () => ({
    user: { id: "u-viewer", email: "viewer@northstar.example" },
    membership: { orgId: "org-1", slug: "northstar", role: viewer.role, mode: "live", network: "arc-testnet" },
  })),
}));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/dal", () => ({ db: vi.fn() }));
vi.mock("@/lib/agent/approvals", () => ({ listWaitingPayables: vi.fn(async () => waiting.payables) }));
vi.mock("@/lib/approval-policy", () => ({ cosignsNow }));
vi.mock("@/lib/cosign-state", () => ({ readCosignStates }));
vi.mock("@/lib/queries", () => ({ stats: vi.fn(async () => ({ day: 1, clockMode: "real", lastCycleAt: null })) }));
vi.mock("@/lib/policy-proposals", () => ({ listOpenProposals: vi.fn(async () => []) }));
vi.mock("@/lib/agent/sole-approver", () => ({ isSoleApprover: vi.fn(async () => false) }));
vi.mock("@/lib/platform/members", () => ({ listMembers }));
vi.mock("@/lib/shell-status", () => ({ shellStatus: vi.fn(async () => null) }));
vi.mock("@/lib/circle", () => ({ shellModes: () => ({}) }));
vi.mock("@/lib/verdicts", () => ({ verdictFacts: vi.fn(async () => null) }));
vi.mock("@/lib/capability-read", () => ({
  readCapability: vi.fn(async () => ({ situation: "live-testnet", network: "arc-testnet", afterVerdict: null, cause: null, why: null })),
}));
vi.mock("@/components/AutoRefresh", () => ({ AutoRefresh: () => null }));
vi.mock("@/components/ProposalCard", () => ({ ProposalCard: () => null }));
vi.mock("@/components/vx/Shell", () => ({
  ProductShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  PageHead: () => null,
}));
vi.mock("@/components/ApprovalCard", () => ({
  default: ({ payable, exception, canCosign, cosign }: { payable: { id: string }; exception?: unknown; canCosign?: boolean; cosign?: unknown }) => {
    cards.push({ id: payable.id, exception: exception ?? null, canCosign: canCosign === true, cosign: cosign ?? null });
    return <article>{payable.id}</article>;
  },
}));

import ApprovalsPage from "@/app/o/[slug]/approvals/page";

const render = async () => renderToStaticMarkup(await ApprovalsPage({ params: Promise.resolve({ slug: "northstar" }) }));

beforeEach(() => {
  cards.length = 0;
  waiting.payables = [HELD];
  viewer.role = "owner";
  listMembers.mockReset();
  cosignsNow.mockReset();
  cosignsNow.mockResolvedValue(false);
  readCosignStates.mockReset();
  vi.useFakeTimers({ now: Date.parse("2026-10-13T08:00:00Z"), toFake: ["Date"] });
});

describe("Approvals with who can act", () => {
  it("names who can act on each held payable, from the members read once", async () => {
    listMembers.mockResolvedValue([
      { userId: "u-owner", email: "ana@northstar.example", role: "owner" },
      { userId: "u-entered", email: "ben@northstar.example", role: "approver" },
    ]);
    expect(await render()).toContain("inv-1");
    expect(cards).toEqual([
      { id: "inv-1", exception: { decideBy: { day: "2026-10-12", reason: "due" }, priority: "overdue", owners: ["ana@northstar.example"] }, canCosign: false, cosign: null },
    ]);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("still shows every card to decide when the members cannot be read, without saying nobody can approve", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    listMembers.mockRejectedValue(new Error("members down"));
    expect(await render()).toContain("inv-1");
    expect(cards).toEqual([{ id: "inv-1", exception: null, canCosign: false, cosign: null }]);
  });
});

describe("Approvals for a co-signing accountant (accountant queue AQ5)", () => {
  /** A payment above the figure, held in shadow mode for a person's verdict. */
  const WAITING_FOR_VERDICT = {
    id: "inv-2",
    dueDate: "2026-10-20T00:00:00Z",
    status: "held",
    createdBy: "u-entered",
    discount: null,
    amount: 1200,
    currency: "USDC",
    reviewedAt: null,
    counterpartyId: "cp-2",
    counterpartyName: "Cobalt Cloud",
    address: "0xabc0000000000000000000000000000000000002",
    riskLevel: "low",
    twoApprovals: { above: 500, approvals: [], excluded: ["u-entered"], excludedSlots: 1, approvers: 2 },
    heldForVerdict: true,
    verdictEntry: { seq: 41, ts: "2026-10-12T10:00:00Z" },
  };

  beforeEach(() => {
    viewer.role = "accountant";
    waiting.payables = [WAITING_FOR_VERDICT];
    listMembers.mockResolvedValue([{ userId: "u-owner", email: "ana@northstar.example", role: "owner" }]);
  });

  it("reads whether each payment can be co-signed now, and hands each card its state, so a bill held for a verdict shows no Co-sign", async () => {
    cosignsNow.mockResolvedValue(true);
    readCosignStates.mockResolvedValue(new Map([["inv-2", { state: "blocked", reason: COSIGN_BLOCKED.verdict }]]));
    expect(await render()).toContain("inv-2");
    expect(readCosignStates).toHaveBeenCalledTimes(1);
    expect(readCosignStates).toHaveBeenCalledWith("u-viewer", [
      { id: "inv-2", amount: 1200, currency: "USDC", status: "held", reviewedAt: null, counterpartyId: "cp-2", riskLevel: "low", address: "0xabc0000000000000000000000000000000000002" },
    ]);
    expect(cards).toEqual([expect.objectContaining({ id: "inv-2", canCosign: true, cosign: { state: "blocked", reason: "Waiting for a verdict in shadow mode" } })]);
  });

  it("still shows each card, offering Co-sign as before, when the states cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    cosignsNow.mockResolvedValue(true);
    readCosignStates.mockRejectedValue(new Error("approval_policies not read: down"));
    expect(await render()).toContain("inv-2");
    expect(cards).toEqual([expect.objectContaining({ id: "inv-2", canCosign: true, cosign: null })]);
  });

  it("reads no co-sign state for anyone who does not co-sign", async () => {
    viewer.role = "owner";
    expect(await render()).toContain("inv-2");
    expect(readCosignStates).not.toHaveBeenCalled();
    expect(cards).toEqual([expect.objectContaining({ id: "inv-2", canCosign: false, cosign: null })]);
  });
});
