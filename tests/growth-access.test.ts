import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who reaches the founder dashboard (/admin/growth): a signed-in person on platform_team. An anonymous visitor and a
 * signed-in person off the team get notFound from the page and a 404 from the export, and every action refuses them
 * before reading or writing anything, since each asks the gate itself.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string | null } | null,
  teamMember: false,
  gateFails: false,
  calls: [] as Array<{ kind: "rpc" | "from"; name: string; args?: unknown }>,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  }),
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: vi.fn(async () => state.user) }));
vi.mock("@/lib/dal", () => ({
  platformDb: () => ({
    rpc: async (name: string, args: unknown) => {
      state.calls.push({ kind: "rpc", name, args });
      if (name === "growth_team_member") return state.gateFails ? { data: null, error: { message: "function does not exist" } } : { data: state.teamMember, error: null };
      if (name === "growth_update_lead") return { data: true, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      state.calls.push({ kind: "from", name: table });
      throw new Error(`${table} is not read in this test`);
    },
  }),
}));

const EMPTY_SIDE = { opened: 0, withRealBill: 0, withDecision: 0, withPayment: 0, paidOnTwoDays: 0, withVerdict: 0, withTwoPeople: 0 };
vi.mock("@/lib/growth/read", () => ({
  readGrowth: vi.fn(async () => ({
    ready: true,
    campaigns: [],
    leads: [
      {
        id: "3f1c2a4e-1111-4222-8333-444455556666",
        business_name: "Northwind Studio",
        company_url: "https://northwind.example",
        stage: "verified",
        review_status: "needs_review",
        source: "signal_outbound",
        segment: "software_agency",
        campaign_id: null,
        org_id: null,
        created_at: "2026-10-01T00:00:00Z",
        signal: "Hiring a finance ops lead",
        evidence_url: "https://northwind.example/jobs",
        evidence_date: "2026-10-01",
        evidence_confidence: "medium",
        draft_message: "Hello from the draft",
        dedupe_key: "northwind.example",
      },
    ],
    events: [],
    spend: [],
    revenue: [],
    workspaces: [],
    funnels: { "arc-testnet": { customers: EMPTY_SIDE, ours: EMPTY_SIDE, total: EMPTY_SIDE }, "arc-mainnet": null },
    workspaceSlugs: {},
  })),
}));

import * as actions from "@/app/admin/growth/actions";
import { GET as exportLeads } from "@/app/admin/growth/leads.csv/route";
import GrowthPage, { metadata } from "@/app/admin/growth/page";
import sitemap from "@/app/sitemap";
import { requiresSession } from "@/lib/auth/routes";

const INITIAL = { ok: false, message: "" };
const TEAM = { id: "11111111-1111-4111-8111-111111111111", email: "team@vestiarion.test" };
const CUSTOMER = { id: "22222222-2222-4222-8222-222222222222", email: "owner@customer.test" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const render = async () => renderToStaticMarkup(await GrowthPage({ searchParams: Promise.resolve({}) }));

/** Every action, called the way its form or the import calls it. */
const EVERY_ACTION: Array<[string, () => Promise<{ ok: boolean; message: string }>]> = [
  ["saveCampaignAction", () => actions.saveCampaignAction(INITIAL, form({ id: "agency-oct", name: "Agencies", status: "planned" }))],
  ["logSpendAction", () => actions.logSpendAction(INITIAL, form({ spent_on: "2026-10-01", usd: "10" }))],
  ["recordRevenueAction", () => actions.recordRevenueAction(INITIAL, form({ kind: "payment_received", amount: "10", currency: "USD", occurred_on: "2026-10-01" }))],
  ["changeLeadStageAction", () => actions.changeLeadStageAction(INITIAL, form({ lead_id: "3f1c2a4e-1111-4222-8333-444455556666", stage: "contacted" }))],
  ["linkLeadAction", () => actions.linkLeadAction(INITIAL, form({ lead_id: "3f1c2a4e-1111-4222-8333-444455556666", workspace: "" }))],
  ["decideLeadAction", () => actions.decideLeadAction(INITIAL, form({ lead_id: "3f1c2a4e-1111-4222-8333-444455556666", decision: "approve" }))],
  ["previewLeadsCsvAction", () => actions.previewLeadsCsvAction("business_name\nX")],
  ["importLeadsCsvAction", () => actions.importLeadsCsvAction("business_name\nX")],
];

beforeEach(() => {
  state.user = null;
  state.teamMember = false;
  state.gateFails = false;
  state.calls = [];
});

describe("the founder dashboard's gate", () => {
  it("covers every action the module exports", () => {
    const exported = Object.entries(actions).filter(([, value]) => typeof value === "function").map(([name]) => name);
    expect(exported.sort()).toEqual(EVERY_ACTION.map(([name]) => name).sort());
  });

  it("is notFound for an anonymous visitor, without asking the database", async () => {
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(state.calls).toEqual([]);
  });

  it("is notFound for a signed-in person off the team", async () => {
    state.user = CUSTOMER;
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(state.calls).toEqual([{ kind: "rpc", name: "growth_team_member", args: { p_user: CUSTOMER.id } }]);
  });

  it("fails closed when the gate cannot be read", async () => {
    state.user = TEAM;
    state.gateFails = true;
    await expect(render()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it.each([
    ["an anonymous visitor", null],
    ["a signed-in person off the team", CUSTOMER],
  ])("refuses every action to %s, reading and writing nothing", async (_who, user) => {
    for (const [name, call] of EVERY_ACTION) {
      state.user = user;
      state.calls = [];
      expect(await call(), name).toEqual({ ok: false, message: "This is not available." });
      expect(state.calls.filter((entry) => entry.name !== "growth_team_member"), name).toEqual([]);
    }
  });

  it("answers the export with a 404 to anyone off the team", async () => {
    for (const user of [null, CUSTOMER]) {
      state.user = user;
      const response = await exportLeads();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("shows the page to a team member: noindex, out of the sitemap, needing no login redirect that would reveal it", async () => {
    state.user = TEAM;
    state.teamMember = true;
    const markup = await render();
    expect(markup).toContain("Growth");
    expect(markup).toContain("Approving records a decision only. Vestiarion never sends outreach.");
    expect(markup).toContain("Not enough data yet");
    expect(markup).toContain("Northwind Studio");
    expect(markup).toContain("Hello from the draft");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some((entry) => entry.url.includes("/admin"))).toBe(false);
    expect(requiresSession("/admin/growth")).toBe(false);
  });

  it("lets a team member change a stage, logged with who did it", async () => {
    state.user = TEAM;
    state.teamMember = true;
    const result = await actions.changeLeadStageAction(INITIAL, form({ lead_id: "3f1c2a4e-1111-4222-8333-444455556666", stage: "contacted", note: "sent by hand" }));
    expect(result).toEqual({ ok: true, message: "Stage changed and logged." });
    expect(state.calls.at(-1)).toEqual({
      kind: "rpc",
      name: "growth_update_lead",
      args: { p_lead: "3f1c2a4e-1111-4222-8333-444455556666", p_changes: { stage: "contacted" }, p_note: "sent by hand", p_by: TEAM.id },
    });
  });

  it("checks a team member's input before writing", async () => {
    state.user = TEAM;
    state.teamMember = true;
    expect(await actions.changeLeadStageAction(INITIAL, form({ lead_id: "nope", stage: "contacted" }))).toEqual({ ok: false, message: "That lead could not be read." });
    expect(await actions.decideLeadAction(INITIAL, form({ lead_id: "3f1c2a4e-1111-4222-8333-444455556666", decision: "reject" }))).toEqual({ ok: false, message: "Say why it is rejected." });
    expect(state.calls.filter((entry) => entry.name !== "growth_team_member")).toEqual([]);
  });
});
