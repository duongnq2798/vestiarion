import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { runComplianceSweep, screenCounterparty } from "@/lib/compliance";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";
import { applyMigrations, createDatabase, createOrg } from "./support/pglite";

/**
 * A verdict remembers which source produced it (migration 0041), so turning on
 * live screening re-checks every counterparty at the next sweep instead of
 * trusting bundled-list verdicts for up to a day. Seen in production on
 * 2026-09-30: the first live-mode sweep re-screened 0 of 3 counterparties.
 */

vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: vi.fn(async () => ({})) }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const bundled = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const live = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  OPENSANCTIONS_API_URL: "https://yente.invalid",
  OPENSANCTIONS_API_KEY: "test-key",
});

const fresh = new Date(Date.now() - 60 * 60_000).toISOString();
const counterparty = (overrides: Record<string, unknown> = {}) => ({
  id: "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de",
  name: "Acme Supplies",
  risk_level: "clear",
  payment_limit: 100,
  baseline_payment_limit: 100,
  last_screened_at: fresh,
  last_screening_mode: "simulate",
  jurisdiction: null,
  performance_score: null,
  performance_inputs: null,
  ...overrides,
});

function workspace(rows: unknown[]) {
  return fakeSupabase((request: RecordedRequest) => {
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: wantsObject ? rows[0] : rows };
    return { body: [] };
  });
}

const patches = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.path === "/rest/v1/counterparties" && request.method === "PATCH").map((request) => request.body as Record<string, unknown>);
const checks = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.path === "/rest/v1/compliance_checks" && request.method === "POST").map((request) => request.body as Record<string, unknown>);

beforeEach(() => vi.unstubAllGlobals());

describe("a screen", () => {
  it("records the source that produced the verdict on the counterparty", async () => {
    const fake = workspace([counterparty()]);
    await runWith(orgTestContext({ config: bundled, client: fake.client, orgId: ORG }), () => screenCounterparty("0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de"));
    expect(patches(fake.requests)[0]).toMatchObject({ last_screening_mode: "simulate" });
  });
});

describe("the sweep, once live screening is on", () => {
  it("re-screens a counterparty a bundled-list verdict covered, however fresh, with the live source", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ responses: { counterparty: { status: 200, results: [] } } }), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetch);
    const fake = workspace([counterparty()]);
    const result = await runWith(orgTestContext({ config: live, client: fake.client, orgId: ORG }), () => runComplianceSweep());

    expect(result.screened).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(checks(fake.requests)[0]).toMatchObject({ source: "opensanctions:yente", screening_mode: "live" });
    expect(patches(fake.requests)[0]).toMatchObject({ last_screening_mode: "live" });
  });

  it("leaves a fresh live verdict alone", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fake = workspace([counterparty({ last_screening_mode: "live" })]);
    const result = await runWith(orgTestContext({ config: live, client: fake.client, orgId: ORG }), () => runComplianceSweep());
    expect(result.screened).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("counterparties.last_screening_mode (0041)", () => {
  let db: PGlite;
  const MIGRATION = path.join(process.cwd(), "supabase", "migrations", "0041_screening_mode.sql");

  beforeAll(async () => {
    db = await createDatabase();
    await applyMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it("is live, simulate or unknown", async () => {
    const orgId = await createOrg(db, "mode-co");
    await db.query("insert into public.counterparties (org_id, name, role, last_screening_mode) values ($1, 'A', 'vendor', 'live'), ($1, 'B', 'vendor', null)", [orgId]);
    await expect(
      db.query("insert into public.counterparties (org_id, name, role, last_screening_mode) values ($1, 'C', 'vendor', 'guess')", [orgId])
    ).rejects.toThrow(/counterparties_last_screening_mode_check/);
  });

  it("is filled from each counterparty's latest complete check, and a failed check never counts", async () => {
    const orgId = await createOrg(db, "backfill-co");
    const id = (await db.query<{ id: string }>("insert into public.counterparties (org_id, name, role, last_screened_at) values ($1, 'Old', 'vendor', now()) returning id", [orgId]))
      .rows[0].id;
    await db.query(
      `insert into public.compliance_checks (org_id, counterparty_id, risk_level, source, screening_mode, status, created_at)
       values ($1, $2, 'clear', 'simulated-sanctions-list', 'simulate', 'complete', now() - interval '2 days'),
              ($1, $2, 'clear', 'simulated-sanctions-list', 'simulate', 'complete', now() - interval '1 day'),
              ($1, $2, 'clear', 'opensanctions:yente', 'live', 'failed', now())`,
      [orgId, id]
    );
    await db.exec(readFileSync(MIGRATION, "utf8"));
    const row = await db.query<{ last_screening_mode: string | null }>("select last_screening_mode from public.counterparties where id = $1", [id]);
    expect(row.rows[0].last_screening_mode).toBe("simulate");
  });
});
