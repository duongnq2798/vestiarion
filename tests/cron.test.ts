import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { runLiveOrganizations, runScheduledCycle } from "@/lib/agent/cron";
import { AgentPausedError } from "@/lib/agent/pause";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

// What a cycle does is the orchestrator's tests' job, and what a digest does
// is tests/notifications.test.ts's: here only the order and isolation of the two.
const { runAgentCycleMock, notifyMock } = vi.hoisted(() => ({ runAgentCycleMock: vi.fn(), notifyMock: vi.fn() }));
vi.mock("@/lib/agent/orchestrator", () => ({ runAgentCycle: runAgentCycleMock }));
vi.mock("@/lib/notifications/waiting", () => ({ notifyWaitingDecisions: notifyMock }));

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
    // Both ran, each entered its own scope: `run` saw each organization's own id.
    expect(seen).toEqual([A, B]);
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
});

describe("runScheduledCycle", () => {
  afterEach(() => {
    runAgentCycleMock.mockReset();
    notifyMock.mockReset();
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

    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => runLiveOrganizations(runScheduledCycle));

    expect(results).toEqual([
      { slug: "a-corp", ok: true, result: { lines: [] } },
      { slug: "b-corp", ok: true, result: { lines: [] } },
    ]);
    expect(order).toEqual([`cycle ${A}`, `notify ${A}`, `cycle ${B}`, `notify ${B}`]);
    // Only the scheduled path starts a cycle this way, with no options (N1).
    expect(runAgentCycleMock).toHaveBeenCalledWith();
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
  });
});
