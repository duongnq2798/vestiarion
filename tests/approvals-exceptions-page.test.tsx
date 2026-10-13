import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Approvals with each held payable as an exception someone owns (docs/superpowers/specs/2026-10-13-deal-cash-readiness-
 * design.md E1-E3): the members are read once to say who can act, and a read that fails never takes the page down,
 * where payments are decided, nor says nobody can approve.
 */

const { listMembers, cards } = vi.hoisted(() => ({
  listMembers: vi.fn(),
  cards: [] as Array<{ id: string; exception: unknown }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/membership", () => ({
  requireMembership: vi.fn(async () => ({
    user: { id: "u-viewer", email: "viewer@northstar.example" },
    membership: { orgId: "org-1", slug: "northstar", role: "owner", mode: "live", network: "arc-testnet" },
  })),
}));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/dal", () => ({ db: vi.fn() }));
vi.mock("@/lib/agent/approvals", () => ({
  listWaitingPayables: vi.fn(async () => [
    { id: "inv-1", dueDate: "2026-10-12T00:00:00Z", status: "held", createdBy: "u-entered", discount: null, twoApprovals: null, verdictEntry: null },
  ]),
}));
vi.mock("@/lib/queries", () => ({ stats: vi.fn(async () => ({ day: 1, clockMode: "real", lastCycleAt: null })) }));
vi.mock("@/lib/policy-proposals", () => ({ listOpenProposals: vi.fn(async () => []) }));
vi.mock("@/lib/agent/sole-approver", () => ({ isSoleApprover: vi.fn(async () => false) }));
vi.mock("@/lib/platform/members", () => ({ listMembers }));
vi.mock("@/lib/shell-status", () => ({ shellStatus: vi.fn(async () => null) }));
vi.mock("@/lib/circle", () => ({ shellModes: () => ({}) }));
vi.mock("@/lib/verdicts", () => ({ verdictFacts: vi.fn() }));
vi.mock("@/components/AutoRefresh", () => ({ AutoRefresh: () => null }));
vi.mock("@/components/ProposalCard", () => ({ ProposalCard: () => null }));
vi.mock("@/components/vx/Shell", () => ({
  ProductShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  PageHead: () => null,
}));
vi.mock("@/components/ApprovalCard", () => ({
  default: ({ payable, exception }: { payable: { id: string }; exception?: unknown }) => {
    cards.push({ id: payable.id, exception: exception ?? null });
    return <article>{payable.id}</article>;
  },
}));

import ApprovalsPage from "@/app/o/[slug]/approvals/page";

const render = async () => renderToStaticMarkup(await ApprovalsPage({ params: Promise.resolve({ slug: "northstar" }) }));

beforeEach(() => {
  cards.length = 0;
  listMembers.mockReset();
  vi.useFakeTimers({ now: Date.parse("2026-10-13T08:00:00Z"), toFake: ["Date"] });
});

describe("Approvals with who can act", () => {
  it("names who can act on each held payable, from the members read once", async () => {
    listMembers.mockResolvedValue([
      { userId: "u-owner", email: "ana@northstar.example", role: "owner" },
      { userId: "u-entered", email: "ben@northstar.example", role: "approver" },
    ]);
    expect(await render()).toContain("inv-1");
    expect(cards).toEqual([{ id: "inv-1", exception: { decideBy: { day: "2026-10-12", reason: "due" }, priority: "overdue", owners: ["ana@northstar.example"] } }]);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });

  it("still shows every card to decide when the members cannot be read, without saying nobody can approve", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    listMembers.mockRejectedValue(new Error("members down"));
    expect(await render()).toContain("inv-1");
    expect(cards).toEqual([{ id: "inv-1", exception: null }]);
  });
});
