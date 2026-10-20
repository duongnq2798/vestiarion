import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { CycleRunningError } from "@/lib/agent/cycle-running";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";

/**
 * The due-work watch (docs/superpowers/specs/2026-10-21-due-work-watch-design.md): every 5 minutes it runs a cycle in a
 * live workspace whose work became due only because time passed, a scheduled cycle the tick missed (DW4) or the end of
 * the payee lock's wait on a confirmed address that holds something back (DW5), never twice for the same due time
 * (DW3), and never more than one cycle per workspace per run (DW6). What the cycle then does is the follow-up's and
 * the stages' to test.
 */

const { runAgentCycleMock, runScheduledCycleMock } = vi.hoisted(() => ({ runAgentCycleMock: vi.fn(), runScheduledCycleMock: vi.fn() }));
vi.mock("@/lib/agent/orchestrator", () => ({ runAgentCycle: runAgentCycleMock }));
vi.mock("@/lib/agent/cron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/cron")>()),
  runScheduledCycle: runScheduledCycleMock,
}));

const { watchDueWork, lastScheduledTick, missedSchedule, waitsEnded, TICK_GRACE_MS } = await import("@/lib/agent/due-watch");

const A = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a000";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const at = (iso: string) => Date.parse(iso);
/** 15:16 UTC on Oct 20: after the 12:17 tick and its 15 minutes, before the 18:17 one. */
const NOW = at("2026-10-20T15:16:00.000Z");
const LOCK = { on: true, coolingHours: 4 };

/** Northwind Referrals on Oct 20: changed at 11:14:02, confirmed by a second member at 12:10:52, so payable from 15:14:02. */
const northwind = { id: "cp-northwind", address_changed_at: "2026-10-20T11:14:02.000Z", address_confirmed_at: "2026-10-20T12:10:52.000Z" };

interface Workspace {
  paused?: boolean;
  lastStart?: string | null;
  lock?: { on: boolean; coolingHours: number };
  changes?: Array<typeof northwind>;
  open?: Array<{ counterparty_id: string }>;
  milestones?: Array<{ contractor_id: string }>;
  /** The lock's read refused, as a permission error would be. */
  lockRefused?: boolean;
}

function workspace(options: Workspace) {
  return fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs" && request.params.get("mode") === "eq.live") {
      return { body: [{ id: A, slug: "pinecrest-studio", agent_paused_at: options.paused ? "2026-10-20T10:00:00Z" : null }] };
    }
    if (request.path === "/rest/v1/orgs") {
      return { body: { id: A, slug: "pinecrest-studio", name: "Pinecrest", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    }
    if (request.path === "/rest/v1/cycle_runs") {
      // The 12:17 tick's cycle, unless a test says otherwise.
      const start = options.lastStart === undefined ? "2026-10-20T12:17:20.000Z" : options.lastStart;
      return { body: start ? [{ started_at: start }] : [] };
    }
    if (request.path === "/rest/v1/approval_policies") {
      if (options.lockRefused) return { status: 403, body: { code: "42501", message: "permission denied" } };
      const lock = options.lock ?? LOCK;
      return { body: [{ payee_lock: lock.on, payee_lock_cooling_hours: lock.coolingHours }] };
    }
    if (request.path === "/rest/v1/counterparties") return { body: options.changes ?? [northwind] };
    if (request.path === "/rest/v1/invoices") return { body: options.open ?? [{ counterparty_id: "cp-northwind" }] };
    if (request.path === "/rest/v1/milestones") return { body: options.milestones ?? [] };
    return { body: [] };
  });
}

function watch(fake: ReturnType<typeof fakeSupabase>, now = NOW, overrides: Partial<typeof config> = {}) {
  return runWith({ config: { ...config, ...overrides }, db: fake.client, fetch: fake.fetch }, () => watchDueWork({ now: () => now }));
}

beforeEach(() => {
  runAgentCycleMock.mockReset();
  runAgentCycleMock.mockResolvedValue({ ok: true });
  runScheduledCycleMock.mockReset();
  runScheduledCycleMock.mockResolvedValue({ ok: true });
});
afterEach(() => vi.restoreAllMocks());

describe("lastScheduledTick and missedSchedule (DW4)", () => {
  it("finds the tick at 17 minutes past hour 0, 6, 12 or 18 UTC at or before now", () => {
    expect(lastScheduledTick(at("2026-10-20T15:16:00Z"))).toBe(at("2026-10-20T12:17:00Z"));
    expect(lastScheduledTick(at("2026-10-20T12:17:00Z"))).toBe(at("2026-10-20T12:17:00Z"));
    expect(lastScheduledTick(at("2026-10-20T12:16:59Z"))).toBe(at("2026-10-20T06:17:00Z"));
    expect(lastScheduledTick(at("2026-10-21T00:05:00Z"))).toBe(at("2026-10-20T18:17:00Z"));
    expect(lastScheduledTick(at("2026-11-01T00:17:00Z"))).toBe(at("2026-11-01T00:17:00Z"));
  });

  it("leaves the tick its own 15 minutes, then calls a workspace with no cycle since the tick missed", () => {
    const tick = at("2026-10-17T18:17:00Z");
    // vangbac-daquy on Oct 17: its last cycle was the 12:17 tick's, and the 18:17 tick ran out of time before it.
    const before = at("2026-10-17T12:21:43Z");
    expect(missedSchedule(before, tick + TICK_GRACE_MS - 1)).toBe(false);
    expect(missedSchedule(before, tick + TICK_GRACE_MS)).toBe(true);
    expect(missedSchedule(tick + 60_000, tick + TICK_GRACE_MS)).toBe(false);
    expect(missedSchedule(tick, tick + TICK_GRACE_MS)).toBe(false);
    // A workspace that never ran a cycle, once the tick's 15 minutes have passed.
    expect(missedSchedule(null, tick + TICK_GRACE_MS)).toBe(true);
  });
});

describe("waitsEnded (DW5)", () => {
  const since = at("2026-10-20T12:17:20Z");

  it("names a confirmed change whose wait ended after the latest cycle and by now", () => {
    expect(waitsEnded([northwind], LOCK, since, NOW)).toEqual(["cp-northwind"]);
  });

  it("leaves out a wait still running, one a later cycle covered, and an unconfirmed change", () => {
    expect(waitsEnded([northwind], LOCK, since, at("2026-10-20T15:14:01Z"))).toEqual([]);
    expect(waitsEnded([northwind], LOCK, at("2026-10-20T15:15:00Z"), NOW)).toEqual([]);
    expect(waitsEnded([{ ...northwind, address_confirmed_at: null }], LOCK, since, NOW)).toEqual([]);
    // Confirmed before a later change: that change is unconfirmed.
    expect(waitsEnded([{ ...northwind, address_confirmed_at: "2026-10-20T11:00:00Z" }], LOCK, since, NOW)).toEqual([]);
  });

  it("names nothing with the lock off or with no wait", () => {
    expect(waitsEnded([northwind], { on: false, coolingHours: 4 }, since, NOW)).toEqual([]);
    expect(waitsEnded([northwind], { on: true, coolingHours: 0 }, since, NOW)).toEqual([]);
  });

  it("names any ended wait for a workspace that never ran a cycle", () => {
    expect(waitsEnded([northwind], LOCK, null, NOW)).toEqual(["cp-northwind"]);
  });
});

describe("watchDueWork", () => {
  it("runs one cycle, with the event payee_lock_wait_ended, once a wait holding back an open payable has ended", async () => {
    let scope: string | null = null;
    runAgentCycleMock.mockImplementation(async () => {
      scope = currentOrgId();
      return { ok: true };
    });
    const fake = workspace({});
    expect(await watch(fake)).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "payee_lock_wait_ended", counterparties: 1 } }]);
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
    expect(runAgentCycleMock).toHaveBeenCalledWith({ trigger: { kind: "event", events: ["payee_lock_wait_ended"] } });
    expect(runScheduledCycleMock).not.toHaveBeenCalled();
    expect(scope).toBe(A);

    // It reads only the changes whose wait could have ended since the latest cycle, and writes nothing.
    const changes = fake.requests.find((request) => request.path === "/rest/v1/counterparties");
    expect(changes?.params.getAll("address_changed_at")).toEqual(["lte.2026-10-20T11:16:00.000Z", "gt.2026-10-20T08:17:20.000Z"]);
    const invoices = fake.requests.find((request) => request.path === "/rest/v1/invoices");
    expect(invoices?.params.get("direction")).toBe("eq.payable");
    expect(invoices?.params.get("status")).toBe("in.(held,flagged,awaiting_info)");
    expect(invoices?.params.get("counterparty_id")).toBe("in.(cp-northwind)");
    expect(fake.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("runs the cycle for a verified milestone the wait held back too", async () => {
    const fake = workspace({ open: [], milestones: [{ contractor_id: "cp-northwind" }] });
    expect(await watch(fake)).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "payee_lock_wait_ended", counterparties: 1 } }]);
    const milestones = fake.requests.find((request) => request.path === "/rest/v1/milestones");
    expect(milestones?.params.get("status")).toBe("eq.verified");
    expect(milestones?.params.get("tx_ref")).toBe("is.null");
  });

  it("runs no cycle when the ended wait holds nothing back", async () => {
    expect(await watch(workspace({ open: [], milestones: [] }))).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "none" } }]);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });

  it("runs no cycle again once a cycle has started after the wait ended (DW3)", async () => {
    const fake = workspace({ lastStart: "2026-10-20T15:15:40.000Z", changes: [] });
    expect(await watch(fake)).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "none" } }]);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });

  it("reads no address change with the lock off", async () => {
    const fake = workspace({ lock: { on: false, coolingHours: 4 } });
    expect(await watch(fake)).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "none" } }]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/counterparties")).toBe(false);
  });

  it("runs the scheduled cycle for a workspace the tick missed, and only that one cycle (DW4, DW6)", async () => {
    // The 12:17 tick did not reach it: its latest cycle was the 06:17 tick's, and a lock wait has ended as well.
    const fake = workspace({ lastStart: "2026-10-20T06:21:17.000Z" });
    expect(await watch(fake)).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "missed_schedule" } }]);
    expect(runScheduledCycleMock).toHaveBeenCalledTimes(1);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });

  it("runs the scheduled cycle for a live workspace that never ran one", async () => {
    expect(await watch(workspace({ lastStart: null }))).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "missed_schedule" } }]);
  });

  it("leaves the tick its own 15 minutes", async () => {
    const fake = workspace({ lastStart: "2026-10-20T06:21:17.000Z", changes: [] });
    expect(await watch(fake, at("2026-10-20T12:30:00.000Z"))).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "none" } }]);
    expect(runScheduledCycleMock).not.toHaveBeenCalled();
  });

  it("starts no event cycle while the tick's own 15 minutes run, so none takes the scheduled cycle's place (DW4, DW6)", async () => {
    // The latest cycle was the 12:17 tick's; a wait ended at 18:18, and the 18:17 tick has not reached the workspace by 18:20.
    const fake = workspace({ changes: [{ ...northwind, address_changed_at: "2026-10-20T14:18:00.000Z" }] });
    expect(await watch(fake, at("2026-10-20T18:20:00.000Z"))).toEqual([{ slug: "pinecrest-studio", ok: true, result: { due: "none" } }]);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
    expect(runScheduledCycleMock).not.toHaveBeenCalled();
    expect(fake.requests.some((request) => request.path === "/rest/v1/counterparties")).toBe(false);
  });

  it("reports a cycle already running as running, so the next run finds the work still due", async () => {
    runAgentCycleMock.mockRejectedValue(new CycleRunningError());
    expect(await watch(workspace({}))).toEqual([{ slug: "pinecrest-studio", ok: true, skipped: "running" }]);
  });

  it("skips a paused workspace without entering it", async () => {
    const fake = workspace({ paused: true });
    expect(await watch(fake)).toEqual([{ slug: "pinecrest-studio", ok: true, skipped: "paused" }]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/cycle_runs")).toBe(false);
  });

  it("skips every workspace without entering it while payments are switched off", async () => {
    const fake = workspace({});
    expect(await watch(fake, NOW, { paymentsDisabled: true })).toEqual([{ slug: "pinecrest-studio", ok: true, skipped: "payments_off" }]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/cycle_runs")).toBe(false);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });

  it("reports a workspace whose lock cannot be read as failed, and runs nothing there", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await watch(workspace({ lockRefused: true }));
    expect(results).toEqual([{ slug: "pinecrest-studio", ok: false, error: "approval_policies not read: permission denied" }]);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });
});

describe("watchDueWork across workspaces (DW6, DW7)", () => {
  const B = "5d0f3a2e-8c1b-4f7a-9e6d-00000000b000";
  const orgs = [
    { id: A, slug: "pinecrest-studio" },
    { id: B, slug: "testnet-2" },
  ];
  const orgRow = (id: string) => {
    const org = orgs.find((candidate) => candidate.id === id) ?? orgs[0];
    return { ...org, name: org.slug, mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
  };

  function two() {
    return fakeSupabase((request: RecordedRequest) => {
      if (request.path === "/rest/v1/orgs" && request.params.get("mode") === "eq.live") return { body: orgs.map((org) => ({ ...org, agent_paused_at: null })) };
      if (request.path === "/rest/v1/orgs") return { body: orgRow(String(request.params.get("id") ?? "").replace("eq.", "")) };
      const orgId = String(request.params.get("org_id") ?? "").replace("eq.", "");
      if (request.path === "/rest/v1/cycle_runs") return { body: [{ started_at: "2026-10-20T12:17:20.000Z" }] };
      if (request.path === "/rest/v1/approval_policies") return { body: [{ payee_lock: orgId === A, payee_lock_cooling_hours: 4 }] };
      if (request.path === "/rest/v1/counterparties") return { body: [northwind] };
      if (request.path === "/rest/v1/invoices") return { body: [{ counterparty_id: "cp-northwind" }] };
      return { body: [] };
    });
  }

  it("runs a cycle only in the workspace with work due, in its own scope, and reports each", async () => {
    const scopes: string[] = [];
    runAgentCycleMock.mockImplementation(async () => {
      scopes.push(currentOrgId());
      return { ok: true };
    });
    expect(await watch(two())).toEqual([
      { slug: "pinecrest-studio", ok: true, result: { due: "payee_lock_wait_ended", counterparties: 1 } },
      { slug: "testnet-2", ok: true, result: { due: "none" } },
    ]);
    expect(scopes).toEqual([A]);
  });

  it("leaves every workspace to the next run once 180 seconds have passed, starting nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = two();
    let calls = 0;
    // The run starts at NOW; every later reading of the clock is past its start budget.
    const clock = () => (calls++ === 0 ? NOW : NOW + 181_000);
    const results = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => watchDueWork({ now: clock }));
    expect(results).toEqual([
      { slug: "pinecrest-studio", ok: true, skipped: "out_of_time" },
      { slug: "testnet-2", ok: true, skipped: "out_of_time" },
    ]);
    expect(fake.requests.some((request) => request.path === "/rest/v1/cycle_runs")).toBe(false);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
  });
});
