import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { AgentPausedError } from "@/lib/agent/pause";
import { PauseError } from "@/lib/platform/pause";
import type { Actor } from "@/lib/commands/actor";
import { pauseWorkspaceAgent, resumeWorkspaceAgent, runWorkspaceCycle } from "@/lib/commands/agent";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Stopping, starting and running the agent, as commands (integrations design §9): anyone who may approve money
 * leaving may pause; resuming and running a cycle are an owner's or admin's. A resume has the agent look again. The
 * pause library is tests/pause.test.ts's and the cycle tests/agent-action.test.ts's; here they are stand-ins.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: { pauseAgent: vi.fn(), resumeAgent: vi.fn(), runAgentCycle: vi.fn(), runCycleSoon: vi.fn() },
}));
vi.mock("@/lib/platform/pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/pause")>()),
  pauseAgent: mocks.pauseAgent,
  resumeAgent: mocks.resumeAgent,
}));
vi.mock("@/lib/agent/orchestrator", () => ({
  runAgentCycle: mocks.runAgentCycle,
  agentCycleSuccessMessage: (result: { day: number }) => `Cycle complete, day ${result.day}.`,
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c31";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c6";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const owner = (fields: Partial<Actor> = {}): Actor => ({
  orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields,
});
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("pauseWorkspaceAgent and resumeWorkspaceAgent", () => {
  it("pauses with the reason, as the actor", async () => {
    mocks.pauseAgent.mockResolvedValueOnce(undefined);
    expect(await run(() => pauseWorkspaceAgent(owner(), { reason: "investigating" }))).toEqual({ ok: true, message: "Agent paused." });
    expect(mocks.pauseAgent).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, reason: "investigating" });
  });

  it("lets an approver pause, and not resume", async () => {
    mocks.pauseAgent.mockResolvedValueOnce(undefined);
    expect(await run(() => pauseWorkspaceAgent(owner({ role: "approver" }), { reason: "" }))).toMatchObject({ ok: true });
    expect(await run(() => resumeWorkspaceAgent(owner({ role: "approver" })))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("resumes, and has the agent look again", async () => {
    mocks.resumeAgent.mockResolvedValueOnce(undefined);
    expect(await run(() => resumeWorkspaceAgent(owner()))).toEqual({ ok: true, message: "Agent resumed." });
    expect(mocks.resumeAgent).toHaveBeenCalledWith({ orgId: ORG, actorId: USER });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "agent_resumed" });
  });

  it("passes a PauseError's code and words, and logs anything else", async () => {
    mocks.pauseAgent.mockRejectedValueOnce(new PauseError("already_paused"));
    expect(await run(() => pauseWorkspaceAgent(owner(), { reason: "" }))).toEqual({
      ok: false, code: "already_paused", message: "The agent is already paused.",
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.resumeAgent.mockRejectedValueOnce(new Error("connection refused"));
    expect(await run(() => resumeWorkspaceAgent(owner()))).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
    expect(log).toHaveBeenCalled();
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a pause from a surface that may not pause", async () => {
    const telegram = owner({ surface: { kind: "telegram", linkId: "l-1" } });
    expect(await run(() => pauseWorkspaceAgent(telegram, { reason: "" }))).toMatchObject({ ok: false, code: "surface" });
    expect(mocks.pauseAgent).not.toHaveBeenCalled();
  });
});

describe("runWorkspaceCycle", () => {
  it("runs a manual cycle, capped in a sandbox only", async () => {
    mocks.runAgentCycle.mockResolvedValue({ day: 4, lines: [{}, {}] });
    expect(await run(() => runWorkspaceCycle(owner({ mode: "sandbox" })))).toEqual({ ok: true, message: "Cycle complete, day 4.", day: 4, lines: 2 });
    expect(mocks.runAgentCycle).toHaveBeenLastCalledWith({ triggeredBy: USER, dailyCap: 20, trigger: { kind: "manual" } });
    await run(() => runWorkspaceCycle(owner()));
    expect(mocks.runAgentCycle).toHaveBeenLastCalledWith({ triggeredBy: USER, dailyCap: undefined, trigger: { kind: "manual" } });
  });

  it("says a pause in its own words", async () => {
    mocks.runAgentCycle.mockRejectedValueOnce(new AgentPausedError());
    expect(await run(() => runWorkspaceCycle(owner()))).toEqual({
      ok: false, code: "agent_paused", message: "The agent is paused. Resume it to run a cycle.",
    });
  });

  it("refuses an approver, who may not run cycles", async () => {
    expect(await run(() => runWorkspaceCycle(owner({ role: "approver" })))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.runAgentCycle).not.toHaveBeenCalled();
  });
});
