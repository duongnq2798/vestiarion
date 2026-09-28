import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { runAgentCycleAction } from "@/app/actions/agent";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `runAgentCycleAction` against a real supabase-js client whose network is a
 * recorder, the same shape as `tests/intake-action.test.ts`: `server-only`
 * and `authorize` are stand-ins, everything after authorization — the cap
 * request it hands `begin_cycle_run`, and `inOrg` — is real. The cap itself
 * is enforced inside `begin_cycle_run` (migration 0022); these tests only
 * cover the boundary between it and the action.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2",
}));

vi.mock("server-only", () => ({}));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

function membership(mode: "sandbox" | "live") {
  return { orgId: ORG, slug: "northstar", name: "Northstar", mode, role: "owner" as const };
}

function orgRow(mode: "sandbox" | "live") {
  return { id: ORG, slug: "northstar", name: "Northstar", mode, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

function beginCycleRunArgs(requests: RecordedRequest[]): Record<string, unknown> {
  const request = requests.find((r) => r.path === "/rest/v1/rpc/begin_cycle_run");
  expect(request).toBeDefined();
  return request!.body as Record<string, unknown>;
}

describe("runAgentCycleAction — the sandbox cap", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  it("stops a sandbox at its daily cap, quoting SANDBOX_DAILY_CYCLES, once begin_cycle_run refuses it", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("sandbox") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("sandbox") };
      if (request.path === "/rest/v1/rpc/begin_cycle_run") {
        return {
          status: 400,
          body: { code: "P0001", message: "sandbox_cap_reached: 20 cycles already started today (UTC)" },
        };
      }
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(result).toEqual({
      ok: false,
      message: "This sandbox has run its 20 cycles for today (UTC). It resets at midnight UTC.",
    });
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/advance_sim_day")).toBe(false);
    expect(fake.requests.some((request) => request.path === "/rest/v1/cycle_runs" && request.method === "POST")).toBe(false);
  });

  it("sends p_daily_cap: 20 for a sandbox run", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("sandbox") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("sandbox") };
      // Fails the run right after begin_cycle_run is reached — this test
      // only needs to see what it was asked, not complete a whole cycle.
      if (request.path === "/rest/v1/rpc/begin_cycle_run") return { status: 500, body: { message: "stop here" } };
      return { body: [] };
    });

    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(beginCycleRunArgs(fake.requests).p_daily_cap).toBe(20);
  });
});

describe("runAgentCycleAction — a live workspace", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
    CYCLE_CLOCK_MODE: "real",
  });

  it("sends p_daily_cap: null for a live run", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/begin_cycle_run") return { status: 500, body: { message: "stop here" } };
      return { body: [] };
    });

    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(beginCycleRunArgs(fake.requests).p_daily_cap).toBeNull();
  });
});
