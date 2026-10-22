import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { mondayOf, RETENTION_WEEKS, retentionCohorts } from "@/lib/growth/retention";
import { DECISION_ACTIONS, readRetentionActivity } from "@/lib/growth/retention-read";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * Retention by week on the founder dashboard (docs/superpowers/specs/2026-10-22-growth-retention-design.md R1, R2): the
 * cohorts by opening week, each workspace's own week k, a week not reached and one still running; and the reader, two
 * queries in each workspace's own scope, leaving out one that could not be read.
 */

vi.mock("server-only", () => ({}));

const DAY = 24 * 60 * 60 * 1000;
const at = (base: string, days: number) => new Date(Date.parse(base) + days * DAY).toISOString();

describe("the week a workspace opened in", () => {
  it("is the Monday, in UTC, of the instant's week", () => {
    expect(mondayOf("2026-10-22T02:00:00Z")).toBe("2026-10-19");
    expect(mondayOf("2026-10-19T00:00:00Z")).toBe("2026-10-19");
    expect(mondayOf("2026-10-18T23:59:59Z")).toBe("2026-10-12");
  });
});

describe("the cohorts (R2)", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const a = { orgId: "a", createdAt: "2026-09-29T10:00:00Z" };
  const b = { orgId: "b", createdAt: "2026-10-01T10:00:00Z" };
  const c = { orgId: "c", createdAt: "2026-10-20T10:00:00Z" };

  it("groups workspaces by opening week, oldest first, with a cell per week", () => {
    const cohorts = retentionCohorts([c, a, b], new Map(), now);
    expect(cohorts.map((cohort) => [cohort.weekOf, cohort.size])).toEqual([
      ["2026-09-28", 2],
      ["2026-10-19", 1],
    ]);
    expect(cohorts[0].cells).toHaveLength(RETENTION_WEEKS);
  });

  it("counts a workspace active in its own week k, over those whose week k has begun", () => {
    const activity = new Map([
      ["a", [at(a.createdAt, 1), at(a.createdAt, 8), at(a.createdAt, 15)]],
      ["b", [at(b.createdAt, 0.5)]],
    ]);
    const [cohort] = retentionCohorts([a, b], activity, now);
    expect(cohort.cells[0]).toEqual({ active: 2, eligible: 2, value: 1, partial: false });
    expect(cohort.cells[1]).toMatchObject({ active: 1, eligible: 2, value: 0.5 });
    expect(cohort.cells[2]).toMatchObject({ active: 1, eligible: 2 });
    // a opened Sep 29: its week 3 (Oct 20-27) is still running; b's week 3 (Oct 22-29) began this morning.
    expect(cohort.cells[3]).toMatchObject({ active: 0, eligible: 2, partial: true });
    // Week 4 has begun for neither.
    expect(cohort.cells[4]).toEqual({ active: 0, eligible: 0, value: null, partial: false });
  });

  it("counts nothing before a workspace opened, or after its week ended, in that week", () => {
    const activity = new Map([["a", [at(a.createdAt, -1), at(a.createdAt, 7)]]]);
    const [cohort] = retentionCohorts([a], activity, now);
    expect(cohort.cells[0].active).toBe(0);
    expect(cohort.cells[1].active).toBe(1);
  });
});

describe("reading each workspace's activity (R1)", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });
  const ORG_A = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
  const ORG_B = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";

  it("reads real bills and a person's decisions in each workspace's scope, and leaves out one that could not be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") {
        const id = request.params.get("id")?.replace("eq.", "");
        if (id === ORG_B) return { status: 500, body: { code: "XX000", message: "down" } };
        return { body: { id, slug: "a", name: "A", mode: "live", circle_api_key_enc: null, circle_entity_secret_enc: null, ledger_signing_key_enc: null } };
      }
      if (request.path === "/rest/v1/invoices") return { body: [{ created_at: "2026-10-02T00:00:00Z" }] };
      if (request.path === "/rest/v1/ledger_entries") return { body: [{ ts: "2026-10-09T00:00:00Z" }] };
      return { body: [] };
    });
    const read = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      readRetentionActivity([
        { orgId: ORG_A, createdAt: "2026-10-01T00:00:00Z" },
        { orgId: ORG_B, createdAt: "2026-10-01T00:00:00Z" },
      ])
    );
    expect(read.activity.get(ORG_A)).toEqual(["2026-10-02T00:00:00Z", "2026-10-09T00:00:00Z"]);
    expect(read.unread).toEqual([ORG_B]);
    const bills = fake.requests.find((request) => request.path === "/rest/v1/invoices");
    expect(bills?.params.get("counterparties.sample")).toBe("eq.false");
    expect(bills?.params.get("direction")).toBe("eq.payable");
    expect(bills?.params.get("created_at")).toBe("gte.2026-10-01T00:00:00Z");
    const decisions = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries");
    expect(decisions?.params.get("actor")).toBe("eq.human");
    expect(decisions?.params.get("action")).toBe(`in.(${DECISION_ACTIONS.join(",")})`);
  });
});
