import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { raiseCycleEvent, resetCycleSoonForTests, runCycleSoon } from "@/lib/agent/cycle-soon";
import { CycleRunningError } from "@/lib/agent/cycle-running";
import { AgentPausedError } from "@/lib/agent/pause";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "@/lib/agent/sandbox-cap";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Event-driven cycles (docs/superpowers/specs/2026-09-30-event-driven-cycles-design.md):
 * a workspace event schedules one agent cycle after the response, a burst
 * shares one cycle, and a cycle already running is waited for, never overlapped.
 * `after`, the organization scope and the cycle itself are faked; the running
 * check goes through the real DAL to a recorded supabase-js client.
 */

const { afterMock, runAgentCycleMock, withOrgMock } = vi.hoisted(() => ({
  afterMock: vi.fn(),
  runAgentCycleMock: vi.fn(),
  withOrgMock: vi.fn(),
}));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/agent/orchestrator", () => ({ runAgentCycle: runAgentCycleMock }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: withOrgMock }));

const A = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const B = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000aa";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

/** Whether each workspace has a cycle running, as its cycle_runs query answers. */
let running: Record<string, boolean>;
let callbacks: Array<() => Promise<void>>;

beforeEach(() => {
  vi.useFakeTimers();
  resetCycleSoonForTests();
  running = {};
  callbacks = [];
  afterMock.mockReset().mockImplementation((callback: () => Promise<void>) => {
    callbacks.push(callback);
  });
  runAgentCycleMock.mockReset().mockResolvedValue({ lines: [] });
  withOrgMock.mockReset().mockImplementation(async (orgId: string, fn: () => Promise<unknown>) => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/cycle_runs" ? { body: running[orgId] ? [{ id: "run-1" }] : [] } : { body: [] }
    );
    return runWith(orgTestContext({ config, client: fake.client, orgId }), fn);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Runs the scheduled callbacks to completion, moving the clock as they wait. */
async function drain(ms = 200_000): Promise<void> {
  const pending = callbacks.splice(0).map((callback) => callback());
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.all(pending);
}

const live = (orgId = A) => ({ orgId, userId: USER, sandbox: false });

describe("runCycleSoon", () => {
  it("starts one cycle after the response, a short moment later, recording the event and the person", async () => {
    runCycleSoon({ ...live(), kind: "invoice_added" });
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(runAgentCycleMock).not.toHaveBeenCalled();

    const pending = callbacks[0]();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    // One scope to wait for a running cycle, a fresh one for the cycle: the cycle's
    // signing key is read when it starts, never held through the wait.
    expect(withOrgMock.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      [A, { userId: USER }],
      [A, { userId: USER }],
    ]);
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
    expect(runAgentCycleMock).toHaveBeenCalledWith({
      triggeredBy: USER,
      dailyCap: undefined,
      trigger: { kind: "event", events: ["invoice_added"] },
    });
  });

  it("gives a burst of events one cycle, naming each kind once, in order", async () => {
    runCycleSoon({ ...live(), kind: "sample_loaded" });
    runCycleSoon({ ...live(), kind: "invoice_added" });
    runCycleSoon({ ...live(), kind: "invoice_added" });
    expect(afterMock).toHaveBeenCalledTimes(1);
    await drain();
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
    expect(runAgentCycleMock.mock.calls[0][0].trigger).toEqual({ kind: "event", events: ["invoice_added", "sample_loaded"] });
  });

  it("gives each workspace its own cycle", async () => {
    runCycleSoon({ ...live(A), kind: "invoice_added" });
    runCycleSoon({ ...live(B), kind: "payable_returned" });
    await drain();
    expect(new Set(withOrgMock.mock.calls.map((call) => call[0]))).toEqual(new Set([A, B]));
    expect(runAgentCycleMock).toHaveBeenCalledTimes(2);
  });

  it("schedules a new cycle for an event that arrives once the last one has started", async () => {
    runCycleSoon({ ...live(), kind: "invoice_added" });
    await drain();
    runCycleSoon({ ...live(), kind: "invoice_added" });
    expect(afterMock).toHaveBeenCalledTimes(2);
    await drain();
    expect(runAgentCycleMock).toHaveBeenCalledTimes(2);
  });

  it("caps a sandbox's cycles as Run cycle does", async () => {
    runCycleSoon({ ...live(), sandbox: true, kind: "sample_loaded" });
    await drain();
    expect(runAgentCycleMock.mock.calls[0][0].dailyCap).toBe(SANDBOX_DAILY_CYCLES);
  });

  it("waits for a cycle already running, then runs", async () => {
    running[A] = true;
    runCycleSoon({ ...live(), kind: "invoice_added" });
    const pending = callbacks.splice(0)[0]();
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 * 3);
    expect(runAgentCycleMock).not.toHaveBeenCalled();
    running[A] = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
  });

  it("gives up 90 seconds into the wait if that cycle is still running, and says so", async () => {
    running[A] = true;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    runCycleSoon({ ...live(), kind: "invoice_added" });
    const pending = callbacks.splice(0)[0]();
    await vi.advanceTimersByTimeAsync(2_000 + 85_000);
    expect(info).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(runAgentCycleMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("event cycle skipped: a cycle is still running", A);
  });

  it("decides an invoice added while the last event cycle is still running, in a second cycle after it", async () => {
    let finish!: () => void;
    runAgentCycleMock.mockImplementationOnce(() => {
      running[A] = true;
      return new Promise((resolve) => {
        finish = () => {
          running[A] = false;
          resolve({ lines: [] });
        };
      });
    });
    runCycleSoon({ ...live(), kind: "invoice_added" });
    const first = callbacks.splice(0)[0]();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);

    runCycleSoon({ ...live(), kind: "payable_returned" });
    expect(afterMock).toHaveBeenCalledTimes(2);
    const second = callbacks.splice(0)[0]();
    await vi.advanceTimersByTimeAsync(2_000 + 10_000);
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);

    finish();
    await first;
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(runAgentCycleMock).toHaveBeenCalledTimes(2);
    expect(runAgentCycleMock.mock.calls[1][0].trigger).toEqual({ kind: "event", events: ["payable_returned"] });
  });

  it("drops the event quietly when another cycle starts between its wait and its own start", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runAgentCycleMock.mockRejectedValueOnce(new CycleRunningError());
    runCycleSoon({ ...live(), kind: "invoice_added" });
    await drain();
    expect(info).toHaveBeenCalledWith("event cycle skipped: a cycle is still running", A);
    expect(error).not.toHaveBeenCalled();
  });

  it("drops the event quietly when the agent is paused or the sandbox has used its cycles", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runAgentCycleMock.mockRejectedValueOnce(new AgentPausedError()).mockRejectedValueOnce(new SandboxCapReachedError());
    runCycleSoon({ ...live(A), kind: "agent_resumed" });
    runCycleSoon({ ...live(B), sandbox: true, kind: "invoice_added" });
    await drain();
    expect(runAgentCycleMock).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("drops the event quietly while payments are switched off (payment safety S3)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runAgentCycleMock.mockRejectedValueOnce(new PaymentsDisabledError());
    runCycleSoon({ ...live(), kind: "invoice_added" });
    await drain();
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs any other failure with the workspace, and nothing more", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    runAgentCycleMock.mockRejectedValueOnce(new Error("Circle is down"));
    runCycleSoon({ ...live(), kind: "invoice_added" });
    await expect(drain()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("event cycle failed", A, "Circle is down");
  });

  it("does nothing outside a request, and still schedules the next event inside one", async () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    expect(() => runCycleSoon({ ...live(), kind: "invoice_added" })).not.toThrow();
    runCycleSoon({ ...live(), kind: "invoice_added" });
    expect(afterMock).toHaveBeenCalledTimes(2);
    await drain();
    expect(runAgentCycleMock).toHaveBeenCalledTimes(1);
  });
});

describe("raiseCycleEvent", () => {
  it("reads the workspace, the person and the sandbox from an authorized access", async () => {
    raiseCycleEvent({ user: { id: USER }, membership: { orgId: B, mode: "sandbox" } }, "address_confirmed");
    await drain();
    expect(withOrgMock).toHaveBeenCalledWith(B, expect.any(Function), { userId: USER });
    expect(runAgentCycleMock).toHaveBeenCalledWith({
      triggeredBy: USER,
      dailyCap: SANDBOX_DAILY_CYCLES,
      trigger: { kind: "event", events: ["address_confirmed"] },
    });
  });
});
