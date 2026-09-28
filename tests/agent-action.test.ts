import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { runAgentCycleAction } from "@/app/actions/agent";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `runAgentCycleAction` against a real supabase-js client whose network is a
 * recorder, the same shape as `tests/intake-action.test.ts`: `server-only`
 * and `authorize` are stand-ins, everything after authorization — the
 * sandbox cap check, and `inOrg` — is real.
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

describe("runAgentCycleAction — the sandbox cap", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  it("stops a sandbox at its daily cap, quoting SANDBOX_DAILY_CYCLES, before running a cycle", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("sandbox") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("sandbox") };
      if (request.path === "/rest/v1/cycle_runs") return { body: [], headers: { "content-range": "*/20" } };
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(result).toEqual({
      ok: false,
      message: "This sandbox has run its 20 cycles for today (UTC). It resets at midnight UTC.",
    });
    expect(fake.requests.some((request: RecordedRequest) => request.path === "/rest/v1/cycle_runs" && request.method === "POST")).toBe(false);
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

  it("never counts cycle_runs before the cycle starts — a cheap proxy is failing the cycle's first request and seeing the count query never sent", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/sim_clock") return { status: 500, body: { message: "sim_clock read failed: connection reset" } };
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(result.ok).toBe(false);
    expect(fake.requests.some((request: RecordedRequest) => request.path === "/rest/v1/cycle_runs")).toBe(false);
  });
});
