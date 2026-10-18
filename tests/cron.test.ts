import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { runLiveOrganizations, runScheduledCycle } from "@/lib/agent/cron";
import { CycleRunningError } from "@/lib/agent/cycle-running";
import { AgentPausedError } from "@/lib/agent/pause";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

// What a cycle does is the orchestrator's tests' job, and what a digest does
// is tests/notifications.test.ts's: here only the order and isolation of the two.
const { runAgentCycleMock, notifyMock, escalateMock, briefMock } = vi.hoisted(() => ({ runAgentCycleMock: vi.fn(), notifyMock: vi.fn(), escalateMock: vi.fn(), briefMock: vi.fn() }));
vi.mock("@/lib/agent/orchestrator", () => ({ runAgentCycle: runAgentCycleMock }));
vi.mock("@/lib/notifications/waiting", () => ({ notifyWaitingDecisions: notifyMock }));
vi.mock("@/lib/notifications/escalations", () => ({ escalateOverdueDecisions: escalateMock }));
vi.mock("@/lib/notifications/weekly-brief", () => ({ sendWeeklyBrief: briefMock }));

const A = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a000";
const B = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b000";
const C = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c000";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function orgRow(id: string, slug: string) {
  return { id, slug, name: `Org ${slug}`, mode: "live" as const, ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
}

/** Two live organizations, plus the scope-entry read for either one by id. */
function liveOrgsDatabase(request: RecordedRequest): FakeReply {
  if (request.path !== "/rest/v1/orgs") return { body: [] };
  if (request.params.get("mode") === "eq.live") {
    return { body: [{ id: A, slug: "a-corp" }, { id: B, slug: "b-corp" }] };
  }
  const id = request.params.get("id")?.replace(/^eq\./, "");
  if (id === A) return { body: orgRow(A, "a-corp") };
  if (id === B) return { body: orgRow(B, "b-corp") };
  return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
}

describe("runLiveOrganizations", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the work in every live organization, isolating each one's failure (spec §4.4)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(liveOrgsDatabase);
    const seen: string[] = [];
    const run = async () => {
      const orgId = currentOrgId();
      seen.push(orgId);
      if (orgId === B) throw new Error("boom");
      return "ok";
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: "ok" },
      { slug: "b-corp", ok: false, error: "boom" },
    ]);
    // Both ran, each entered its own scope: `run` saw each organization's own id (in either order, as they overlap).
    expect([...seen].sort()).toEqual([A, B]);
    const orgsQuery = fake.requests.find((request) => request.path === "/rest/v1/orgs" && request.params.has("mode"));
    expect(orgsQuery?.params.get("mode")).toBe("eq.live");
    expect(console.error).toHaveBeenCalledWith("cycle failed for", "b-corp", expect.any(Error));
  });

  it("returns an empty result for no live organizations, without running anything", async () => {
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: [] } : { body: [] }));
    let ran = false;
    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      runLiveOrganizations(async () => { ran = true; })
    );
    expect(results).toEqual([]);
    expect(ran).toBe(false);
  });

  it("skips a paused organization and runs the others, without entering its scope", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path !== "/rest/v1/orgs") return { body: [] };
      if (request.params.get("mode") === "eq.live") {
        return {
          body: [
            { id: A, slug: "a-corp", agent_paused_at: null },
            { id: C, slug: "c-corp", agent_paused_at: "2026-09-29T00:00:00.000Z" },
          ],
        };
      }
      const id = request.params.get("id")?.replace(/^eq\./, "");
      if (id === A) return { body: orgRow(A, "a-corp") };
      return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
    });
    const seen: string[] = [];
    const run = async () => {
      seen.push(currentOrgId());
      return "ok";
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: "ok" },
      { slug: "c-corp", ok: true, skipped: "paused" },
    ]);
    // c-corp's scope was never entered: run only ever saw A.
    expect(seen).toEqual([A]);
  });

  it("skips every workspace, without entering it, while payments are switched off (payment safety S3)", async () => {
    const fake = fakeSupabase(liveOrgsDatabase);
    const seen: string[] = [];
    const run = async () => {
      seen.push(currentOrgId());
      return "ok";
    };

    const results = await runWith({ config: { ...config, paymentsDisabled: true }, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, skipped: "payments_off" },
      { slug: "b-corp", ok: true, skipped: "payments_off" },
    ]);
    expect(seen).toEqual([]);
  });

  it("reports a cycle refused because payments are switched off as skipped, not failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(liveOrgsDatabase);
    const run = async () => {
      if (currentOrgId() === B) throw new PaymentsDisabledError();
      return "ok";
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run));

    expect(results[1]).toEqual({ slug: "b-corp", ok: true, skipped: "payments_off" });
    expect(error).not.toHaveBeenCalled();
  });

  it("reports an organization paused between the listing and begin_cycle_run as skipped, not failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(liveOrgsDatabase);
    const run = async () => {
      // begin_cycle_run refuses once the pause has landed; runAgentCycle raises this.
      if (currentOrgId() === B) throw new AgentPausedError();
      return "ok";
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: "ok" },
      { slug: "b-corp", ok: true, skipped: "paused" },
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  /** Three live organizations, plus the scope-entry read for each by id. */
  function threeOrgsDatabase(request: RecordedRequest): FakeReply {
    if (request.path !== "/rest/v1/orgs") return { body: [] };
    if (request.params.get("mode") === "eq.live") {
      return { body: [{ id: A, slug: "a-corp" }, { id: B, slug: "b-corp" }, { id: C, slug: "c-corp" }] };
    }
    const id = request.params.get("id")?.replace(/^eq\./, "");
    if (id === A) return { body: orgRow(A, "a-corp") };
    if (id === B) return { body: orgRow(B, "b-corp") };
    if (id === C) return { body: orgRow(C, "c-corp") };
    return { status: 406, body: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
  }

  it("runs workspaces at once, no more than the concurrency, each in its own scope, and keeps the results in slug order", async () => {
    // Twelve live workspaces one after another outran the tick's 300 seconds on Oct 17; now they overlap.
    const fake = fakeSupabase(threeOrgsDatabase);
    let running = 0;
    let most = 0;
    const seen: string[] = [];
    const run = async () => {
      running += 1;
      most = Math.max(most, running);
      const before = currentOrgId();
      await new Promise((resolve) => setTimeout(resolve, before === A ? 30 : 5));
      // Still its own scope after the other workspaces ran meanwhile.
      expect(currentOrgId()).toBe(before);
      seen.push(before);
      running -= 1;
      return before;
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(run, { concurrency: 2 }));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: A },
      { slug: "b-corp", ok: true, result: B },
      { slug: "c-corp", ok: true, result: C },
    ]);
    expect(most).toBe(2);
    // a-corp is the slow one: b-corp and c-corp finished while it ran.
    expect(seen).toEqual([B, C, A]);
  });

  it("starts no workspace after startBy: one not yet started is skipped as out of time and logged, not failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeSupabase(threeOrgsDatabase);
    let clock = 1_000;
    const seen: string[] = [];
    const run = async () => {
      seen.push(currentOrgId());
      clock += 100; // each cycle takes 100 ms of the budget
      return "ok";
    };

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
      runLiveOrganizations(run, { concurrency: 1, startBy: 1_150, now: () => clock })
    );

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: "ok" },
      { slug: "b-corp", ok: true, result: "ok" },
      { slug: "c-corp", ok: true, skipped: "out_of_time" },
    ]);
    expect(seen).toEqual([A, B]);
    expect(warn).toHaveBeenCalledWith("scheduled cycle left to the next tick: out of time", "c-corp");
  });
});

describe("runScheduledCycle", () => {
  afterEach(() => {
    runAgentCycleMock.mockReset();
    notifyMock.mockReset();
    escalateMock.mockReset();
    briefMock.mockReset();
    vi.restoreAllMocks();
  });

  it("notifies after a successful cycle, in the same organization's scope, and returns the cycle's result", async () => {
    const fake = fakeSupabase(liveOrgsDatabase);
    const order: string[] = [];
    runAgentCycleMock.mockImplementation(async () => {
      order.push(`cycle ${currentOrgId()}`);
      return { lines: [] };
    });
    notifyMock.mockImplementation(async () => {
      order.push(`notify ${currentOrgId()}`);
      return { sent: 1, failed: 0, invoices: 1 };
    });
    escalateMock.mockImplementation(async () => {
      order.push(`escalate ${currentOrgId()}`);
      return { sent: 0, failed: 0, invoices: 0 };
    });
    // The weekly brief follows, in the same scope (weekly brief W1).
    briefMock.mockImplementation(async () => {
      order.push(`brief ${currentOrgId()}`);
      return { sent: 0, failed: 0, skipped: "not_monday" };
    });

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(runScheduledCycle));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: { lines: [] } },
      { slug: "b-corp", ok: true, result: { lines: [] } },
    ]);
    // Each workspace's steps in order, in its own scope; the two workspaces overlap, so only their own order is fixed.
    expect(order.filter((step) => step.endsWith(A))).toEqual([`cycle ${A}`, `notify ${A}`, `escalate ${A}`, `brief ${A}`]);
    expect(order.filter((step) => step.endsWith(B))).toEqual([`cycle ${B}`, `notify ${B}`, `escalate ${B}`, `brief ${B}`]);
    expect(order).toHaveLength(8);
    // Only the scheduled path starts a cycle this way: no person, no cap (N1), and the schedule as its trigger.
    expect(runAgentCycleMock).toHaveBeenCalledWith({ trigger: { kind: "schedule" } });
  });

  it("does not notify for a failed cycle or one refused by a pause", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(liveOrgsDatabase);
    runAgentCycleMock.mockImplementation(async () => {
      if (currentOrgId() === A) throw new Error("boom");
      throw new AgentPausedError();
    });

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(runScheduledCycle));

    expect(results).toEqual([
      { slug: "a-corp", ok: false, error: "boom" },
      { slug: "b-corp", ok: true, skipped: "paused" },
    ]);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(escalateMock).not.toHaveBeenCalled();
  });

  it("skips a workspace whose cycle is already running, as a skip and not a failure", async () => {
    const fake = fakeSupabase(liveOrgsDatabase);
    runAgentCycleMock.mockImplementation(async () => {
      if (currentOrgId() === A) throw new CycleRunningError();
      return { lines: [] };
    });

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(runScheduledCycle));

    expect(results[0]).toEqual({ slug: "a-corp", ok: true, skipped: "running" });
    expect(results[1]).toMatchObject({ slug: "b-corp", ok: true });
  });

  it("does not notify an organization skipped as paused", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs" && request.params.get("mode") === "eq.live") {
        return { body: [{ id: C, slug: "c-corp", agent_paused_at: "2026-09-29T00:00:00.000Z" }] };
      }
      return { body: [] };
    });

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(runScheduledCycle));

    expect(results).toEqual([{ slug: "c-corp", ok: true, skipped: "paused" }]);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("keeps the workspace ok when notifying throws, and logs it by organization id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(liveOrgsDatabase);
    runAgentCycleMock.mockResolvedValue({ lines: [{}] });
    notifyMock.mockRejectedValue(new Error("smtp down"));

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(runScheduledCycle));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: { lines: [{}] } },
      { slug: "b-corp", ok: true, result: { lines: [{}] } },
    ]);
    expect(error).toHaveBeenCalledWith("notifications failed after the cycle", A, "smtp down");
    expect(error).toHaveBeenCalledWith("notifications failed after the cycle", B, "smtp down");
    // The escalations still run: a digest that failed never holds them back.
    expect(escalateMock).toHaveBeenCalledTimes(2);
  });
});
