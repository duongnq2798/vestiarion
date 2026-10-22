import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORG_ROLES, type OrgRole } from "@/lib/auth/roles";

/**
 * Who sees when a live screening last worked on Compliance (docs/superpowers/specs/2026-10-22-screening-health-design.md
 * SH3): owners and admins of a workspace that screens live, and nobody else. For anyone else the workspace's checks are
 * not read at all. The line sits in the latest sweep's callout, or on its own when there is no sweep yet.
 */

const LINE = "Last successful live screening: Oct 22, 2026, 11:40 UTC";

const { state, lastLiveSuccessLine } = vi.hoisted(() => ({
  state: { role: "owner" as string, mode: "live" as "live" | "simulate", entries: [] as unknown[] },
  lastLiveSuccessLine: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/membership", () => ({
  requireMembership: vi.fn(async () => ({
    user: { id: "u-member", email: "member@northstar.example" },
    membership: { orgId: "org-1", slug: "northstar", role: state.role, mode: "live", network: "arc-testnet" },
  })),
}));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/dal", () => ({ db: vi.fn(() => ({})) }));
vi.mock("@/lib/compliance", () => ({ screeningMode: () => state.mode }));
vi.mock("@/lib/screening/health", () => ({ lastLiveSuccessLine }));
vi.mock("@/lib/queries", () => ({
  listCounterparties: vi.fn(async () => []),
  stats: vi.fn(async () => ({ day: 1, clockMode: "real", lastCycleAt: null })),
}));
vi.mock("@/lib/ledger", () => ({
  listLedgerEntriesByDomain: vi.fn(async () => state.entries),
  listLedgerEntries: vi.fn(async () => []),
}));
vi.mock("@/lib/shell-status", () => ({ shellStatus: vi.fn(async () => null) }));
vi.mock("@/lib/circle", () => ({ shellModes: () => ({}) }));
vi.mock("@/components/AgentControls", () => ({ default: () => null }));
vi.mock("@/components/vx/Shell", () => ({
  ProductShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  PageHead: () => null,
}));

import CompliancePage from "@/app/o/[slug]/compliance/page";

const render = async () => renderToStaticMarkup(await CompliancePage({ params: Promise.resolve({ slug: "northstar" }) }));
const occurrences = (markup: string, text: string) => markup.split(text).length - 1;

const SWEEP = {
  id: "entry-7",
  seq: 7,
  ts: "2026-10-22T11:41:00Z",
  actor: "agent",
  domain: "compliance",
  action: "compliance_sweep",
  summary: "Screened 3 counterparties: no tier changed",
  detail: { complete: true },
};

beforeEach(() => {
  lastLiveSuccessLine.mockReset();
  lastLiveSuccessLine.mockResolvedValue(LINE);
  state.role = "owner";
  state.mode = "live";
  state.entries = [];
});

describe("the Compliance page's last successful live screening (SH3)", () => {
  const cases = ORG_ROLES.flatMap((role) => (["live", "simulate"] as const).map((mode) => [role, mode] as [OrgRole, "live" | "simulate"]));

  it.each(cases)("for a %s where screening is %s", async (role, mode) => {
    state.role = role;
    state.mode = mode;
    const markup = await render();
    const shown = (role === "owner" || role === "admin") && mode === "live";
    expect(markup.includes("Last successful live screening:")).toBe(shown);
    // Nobody else's page reads the workspace's checks at all.
    expect(lastLiveSuccessLine).toHaveBeenCalledTimes(shown ? 1 : 0);
  });

  it("sits in the latest sweep's callout when there is one, and on its own when there is none", async () => {
    state.entries = [SWEEP];
    const withSweep = await render();
    expect(withSweep).toContain("Latest continuous screening sweep");
    expect(occurrences(withSweep, LINE)).toBe(1);
    expect(withSweep.indexOf(LINE)).toBeGreaterThan(withSweep.indexOf(SWEEP.summary));
    expect(withSweep.indexOf(SWEEP.summary)).toBeGreaterThan(-1);

    state.entries = [];
    const alone = await render();
    expect(alone).not.toContain("Latest continuous screening sweep");
    expect(occurrences(alone, LINE)).toBe(1);
  });
});
