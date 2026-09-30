import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { pauseAgentAction, resumeAgentAction, runAgentCycleAction } from "@/app/actions/agent";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * `runAgentCycleAction` against a real supabase-js client whose network is a
 * recorder, the same shape as `tests/intake-action.test.ts`: `server-only`
 * and `authorize` are stand-ins, everything after authorization — the cap
 * request it hands `begin_cycle_run`, and `inOrg` — is real. The cap itself
 * is enforced inside `begin_cycle_run` (migration 0022); these tests only
 * cover the boundary between it and the action.
 *
 * `pauseAgentAction` and `resumeAgentAction` below follow the same shape,
 * against the 0025 pause/resume RPCs.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2",
}));

vi.mock("server-only", () => ({}));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
// The same stand-in `tests/members-actions.test.ts` uses: `revalidatePath`
// needs a request's static-generation store that does not exist here, so a
// success path (which the pause/resume tests below reach, unlike the cap and
// pause-refusal tests above) would otherwise throw rather than assert on.
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

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

describe("runAgentCycleAction — a cycle already running", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  it("says one is running instead of starting a second beside it", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/cycle_runs" && request.method === "GET") return { body: [{ id: "run-0" }] };
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(result).toEqual({ ok: false, message: "A cycle is already running. Its decisions appear here in a moment." });
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/begin_cycle_run")).toBe(false);
  });
});

describe("runAgentCycleAction — a paused workspace", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  it("returns the pause message when begin_cycle_run refuses it, and never sends advance_sim_day", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/begin_cycle_run") {
        return {
          status: 400,
          body: { code: "P0001", message: "agent_paused: the agent is paused" },
        };
      }
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runAgentCycleAction("northstar"));

    expect(result).toEqual({
      ok: false,
      message: "The agent is paused. Resume it to run a cycle.",
    });
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/advance_sim_day")).toBe(false);
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

function pauseForm(reason?: string): FormData {
  const formData = new FormData();
  formData.set("orgSlug", "northstar");
  if (reason !== undefined) formData.set("reason", reason);
  return formData;
}

const INITIAL = { ok: false, message: "" };

describe("pauseAgentAction", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  it("returns the refusal when authorize refuses, and never calls pause_agent", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });

    const result = await pauseAgentAction(INITIAL, pauseForm());

    expect(result).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
  });

  it("sends the org, the actor and the reason to pause_agent, and returns 'Agent paused.'", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/pause_agent") {
        const body = request.body as Record<string, unknown>;
        return { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "live", agent_paused_at: "2026-09-29T00:00:00Z", agent_paused_by: body.p_actor, agent_pause_reason: body.p_reason } };
      }
      if (request.path === "/rest/v1/rpc/append_ledger_entry") {
        return { body: { seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "system", action: "agent_paused", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null } };
      }
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => pauseAgentAction(INITIAL, pauseForm("investigating")));

    const pauseCall = fake.requests.find((r) => r.path === "/rest/v1/rpc/pause_agent");
    expect(pauseCall?.body).toEqual({ p_org_id: ORG, p_actor: USER, p_reason: "investigating" });
    expect(result).toEqual({ ok: true, message: "Agent paused." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("maps a PauseError to its message, without revalidating", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/pause_agent") {
        return { status: 400, body: { code: "P0001", message: "already_paused: the agent has been paused since 2026-09-29T00:00:00Z" } };
      }
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => pauseAgentAction(INITIAL, pauseForm()));

    expect(result).toEqual({ ok: false, message: "The agent is already paused." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("logs and returns the generic message for anything else", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/pause_agent") return { status: 500, body: { message: "connection refused" } };
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => pauseAgentAction(INITIAL, pauseForm()));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("resumeAgentAction", () => {
  const config = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
  });

  it("returns the refusal when authorize refuses, and never calls resume_agent", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });

    const result = await resumeAgentAction(INITIAL, pauseForm());

    expect(result).toEqual({ ok: false, message: "You are not a member of this workspace." });
  });

  it("sends the org and the actor to resume_agent, and returns 'Agent resumed.'", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/resume_agent") return { body: "2026-09-29T00:00:00Z" };
      if (request.path === "/rest/v1/rpc/append_ledger_entry") {
        return { body: { seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "system", action: "agent_resumed", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null } };
      }
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => resumeAgentAction(INITIAL, pauseForm()));

    const resumeCall = fake.requests.find((r) => r.path === "/rest/v1/rpc/resume_agent");
    expect(resumeCall?.body).toEqual({ p_org_id: ORG, p_actor: USER });
    expect(result).toEqual({ ok: true, message: "Agent resumed." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("maps a PauseError to its message ('Only an owner or admin can resume the agent.')", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: membership("live") });
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: orgRow("live") };
      if (request.path === "/rest/v1/rpc/resume_agent") {
        return { status: 400, body: { code: "P0001", message: "resume_not_permitted: a approver cannot resume the agent" } };
      }
      return { body: [] };
    });

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => resumeAgentAction(INITIAL, pauseForm()));

    expect(result).toEqual({ ok: false, message: "Only an owner or admin can resume the agent." });
  });
});
