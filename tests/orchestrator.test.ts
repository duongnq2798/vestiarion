import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { CycleRunningError } from "@/lib/agent/cycle-running";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { agentCycleSuccessMessage, cycleCompleteSummary, runAgentCycle, triggerDetail } from "@/lib/agent/orchestrator";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * `runAgentCycle()` moves real money. These tests cover only its guarded
 * failure paths — an organization whose Circle credentials cannot be read
 * (R12), a `sim_clock` read that failed outright, and the ordering around
 * `begin_cycle_run` — and check that each rejects before anything it
 * shouldn't have written was written. A full happy-path run touches a couple
 * of dozen tables plus the LLM decision path and belongs to an end-to-end
 * check against a real database, not a unit test.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("runAgentCycle — refuses before touching the database (R12)", () => {
  it("rejects when the organization's Circle credentials are stored but unreadable, before any request", async () => {
    const reason = "could not decrypt circle_api_key_enc of organization x: wrong master key, or the ciphertext was altered or moved";
    const unreadable = { ...config, chain: { ...config.chain, credentialsUnreadable: reason } };
    const fake = fakeSupabase();

    await expect(
      runWith({ ...orgTestContext({ config, client: fake.client, orgId: ORG }), config: unreadable }, () => runAgentCycle())
    ).rejects.toThrow(/refusing to fall back to simulated payments/);
    expect(fake.requests).toEqual([]);
  });
});

describe("runAgentCycle — opens the run through begin_cycle_run before anything else", () => {
  const realClockConfig = configFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    CYCLE_CLOCK_MODE: "real",
  });

  it("rejects with the sim_clock read's own error, after begin_cycle_run already opened the run", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/begin_cycle_run") return { body: RUN_ID };
      if (request.path === "/rest/v1/sim_clock") {
        return { status: 500, body: { message: "sim_clock read failed: connection reset" } };
      }
      return { body: [] };
    });

    await expect(
      runWith(orgTestContext({ config: realClockConfig, client: fake.client, orgId: ORG }), () => runAgentCycle())
    ).rejects.toThrow("sim_clock read failed: connection reset");

    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/begin_cycle_run")).toBe(true);
    expect(fake.requests.some((request) => request.path === "/rest/v1/sim_clock")).toBe(true);
    // The row was opened through the RPC, not by a direct insert from here.
    expect(fake.requests.some((request) => request.path === "/rest/v1/cycle_runs" && request.method === "POST")).toBe(false);
  });

  // A missing sim_clock row (no organization has run a simulated cycle yet)
  // is the normal case realClockDay() defaults to day 0 for, but proving
  // that through a full runAgentCycle() would mean faking every table the
  // rest of the cycle touches — accounts, invoices, milestones, the ledger
  // RPC, a resolvable signing key, compliance, forecasts, the closing
  // snapshot — for a single `?? 0` default already covered by the identical
  // `.maybeSingle()` pattern in queries.ts's stats(), which
  // tenant-scope-lib.test.ts already exercises end to end. Kept to the error
  // case here, per the reviewed scope of this fix.

  it("in simulate mode, requests begin_cycle_run before advance_sim_day, then PATCHes sim_day onto the run", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/begin_cycle_run") return { body: RUN_ID };
      if (request.path === "/rest/v1/rpc/advance_sim_day") return { body: 3 };
      // Stops the cycle right after the day is recorded: the first
      // unguarded read once the cycle's own stages start, so the ordering
      // above is settled before anything else needs faking.
      if (request.path === "/rest/v1/accounts" && request.method === "GET") {
        return { status: 500, body: { message: "accounts read failed: stop here" } };
      }
      return { body: [] };
    });

    await expect(
      runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => runAgentCycle())
    ).rejects.toThrow("accounts read failed: stop here");

    const beginIndex = fake.requests.findIndex((request: RecordedRequest) => request.path === "/rest/v1/rpc/begin_cycle_run");
    const advanceIndex = fake.requests.findIndex((request: RecordedRequest) => request.path === "/rest/v1/rpc/advance_sim_day");
    const patchIndex = fake.requests.findIndex(
      (request: RecordedRequest) => request.path === "/rest/v1/cycle_runs" && request.method === "PATCH"
    );

    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(advanceIndex).toBeGreaterThan(beginIndex);
    expect(patchIndex).toBeGreaterThan(advanceIndex);
    expect(fake.requests[patchIndex].body).toEqual({ sim_day: 3 });
  });
});

describe("runAgentCycle — one cycle at a time in a workspace", () => {
  it("refuses to open a second cycle while one started in the last 15 minutes is still running", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/cycle_runs" && request.method === "GET" ? { body: [{ id: "run-0" }] } : { body: [] }
    );

    await expect(runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => runAgentCycle())).rejects.toBeInstanceOf(
      CycleRunningError
    );

    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/begin_cycle_run")).toBe(false);
    const check = fake.requests.find((request) => request.path === "/rest/v1/cycle_runs");
    expect(check?.params.get("status")).toBe("eq.running");
    expect(check?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(check?.params.get("started_at")).toMatch(/^gt\./);
  });

  it("refuses while payments are switched off, before reading or writing anything (payment safety S3)", async () => {
    const fake = fakeSupabase(() => ({ body: [] }));

    await expect(
      runWith(orgTestContext({ config: { ...config, paymentsDisabled: true }, client: fake.client, orgId: ORG }), () => runAgentCycle())
    ).rejects.toBeInstanceOf(PaymentsDisabledError);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses as well when begin_cycle_run finds a run another instance opened after the check (0043)", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/rpc/begin_cycle_run"
        ? { status: 400, body: { code: "P0001", message: "cycle_running: a cycle is already running in this workspace" } }
        : { body: [] }
    );

    await expect(runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => runAgentCycle())).rejects.toBeInstanceOf(
      CycleRunningError
    );
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/advance_sim_day")).toBe(false);
  });
});

describe("triggerDetail — what started a cycle, as cycle_complete records it", () => {
  it("names an event cycle's events", () => {
    expect(triggerDetail({ kind: "event", events: ["invoice_added", "sample_loaded"] })).toEqual({
      trigger: "event",
      events: ["invoice_added", "sample_loaded"],
    });
  });

  it("names a person's run and the schedule's", () => {
    expect(triggerDetail({ kind: "manual" })).toEqual({ trigger: "manual" });
    expect(triggerDetail({ kind: "schedule" })).toEqual({ trigger: "schedule" });
  });

  it("adds nothing when nothing says what started it (a script)", () => {
    expect(triggerDetail(undefined)).toEqual({});
  });
});

describe("cycleCompleteSummary", () => {
  it("uses the singular at exactly one decision, in simulate mode", () => {
    expect(cycleCompleteSummary("simulate", 3, "2026-09-28T00:00:00.000Z", 1)).toBe(
      "Agent cycle 3 complete: 1 agent decision recorded"
    );
  });

  it("uses the plural at any other count, in simulate mode", () => {
    expect(cycleCompleteSummary("simulate", 3, "2026-09-28T00:00:00.000Z", 0)).toBe(
      "Agent cycle 3 complete: 0 agent decisions recorded"
    );
    expect(cycleCompleteSummary("simulate", 3, "2026-09-28T00:00:00.000Z", 2)).toBe(
      "Agent cycle 3 complete: 2 agent decisions recorded"
    );
  });

  it("names the finish time instead of the day number in real-clock mode", () => {
    expect(cycleCompleteSummary("real", 3, "2026-09-28T00:00:00.000Z", 1)).toBe(
      "Agent cycle complete at 2026-09-28T00:00:00.000Z: 1 agent decision recorded"
    );
  });
});

describe("agentCycleSuccessMessage", () => {
  it("uses the singular at exactly one line, in simulate mode", () => {
    expect(
      agentCycleSuccessMessage({ clockMode: "simulate", day: 4, finishedAt: "2026-09-28T00:00:00.000Z", lines: [{ domain: "ap", message: "x" }] })
    ).toBe("Day 4 complete · 1 decision logged.");
  });

  it("uses the plural at any other count, in simulate mode", () => {
    expect(
      agentCycleSuccessMessage({ clockMode: "simulate", day: 4, finishedAt: "2026-09-28T00:00:00.000Z", lines: [] })
    ).toBe("Day 4 complete · 0 decisions logged.");
    expect(
      agentCycleSuccessMessage({
        clockMode: "simulate",
        day: 4,
        finishedAt: "2026-09-28T00:00:00.000Z",
        lines: [{ domain: "ap", message: "x" }, { domain: "treasury", message: "y" }],
      })
    ).toBe("Day 4 complete · 2 decisions logged.");
  });

  it("names the finish time instead of the day number in real-clock mode", () => {
    expect(
      agentCycleSuccessMessage({ clockMode: "real", day: 4, finishedAt: "2026-09-28T00:00:00.000Z", lines: [{ domain: "ap", message: "x" }] })
    ).toBe(`Cycle complete at ${new Date("2026-09-28T00:00:00.000Z").toLocaleString()} · 1 decision logged.`);
  });
});
