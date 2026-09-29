import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { AgentPausedError, agentPaused, pausedPaymentNote, PAUSE_NOTE } from "@/lib/agent/pause";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * `pausedPaymentNote()` is the one branch the AP and contractor stages both
 * check right before they would move money (src/lib/agent/orchestrator.ts).
 * Driving that check through a full `runAgentCycle()` would mean faking
 * every stage ahead of it in the cycle — reconcile, compliance, follow-up,
 * duplicate detection, and for the contractor loop the milestone-verification
 * read too — the same weight `tests/orchestrator.test.ts` already declines to
 * carry for its own happy path (see the comment above its `describe` block).
 * So this file proves the extracted helper directly: what it sends to
 * `agent_paused`, what it returns for each answer, and that `AgentPausedError`
 * carries the exact message a member sees. The orchestrator wiring itself —
 * that a stage sets `status: "held"` and appends this note instead of
 * calling `payInvoice`/`executePayment` — is a few lines guarded by this same
 * helper, reviewed alongside this report rather than re-proven end to end.
 */

const ORG = "1c8e7a3d-9b2f-4e5c-8a1d-000000000c0c";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

describe("agentPaused", () => {
  it("sends p_org_id and returns the RPC's answer", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/agent_paused") return { body: true };
      return { body: [] };
    });

    const paused = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => agentPaused());

    expect(paused).toBe(true);
    const request = fake.requests.find((r) => r.path === "/rest/v1/rpc/agent_paused");
    expect(request?.body).toEqual({ p_org_id: ORG });
  });

  it("returns false when the RPC says the agent is not paused", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/agent_paused") return { body: false };
      return { body: [] };
    });

    const paused = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => agentPaused());

    expect(paused).toBe(false);
  });

  it("throws with the database's own message when the read fails", async () => {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/rpc/agent_paused") {
        return { status: 500, body: { message: "agent_paused read failed: connection reset" } };
      }
      return { body: [] };
    });

    await expect(
      runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => agentPaused())
    ).rejects.toThrow("agent_paused read failed: connection reset");
  });
});

describe("pausedPaymentNote", () => {
  it("returns null — proceed — when the agent is not paused", async () => {
    const fake = fakeSupabase(() => ({ body: false }));

    const note = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => pausedPaymentNote());

    expect(note).toBeNull();
  });

  it("returns the pause note — hold instead of paying — when the agent is paused", async () => {
    const fake = fakeSupabase(() => ({ body: true }));

    const note = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => pausedPaymentNote());

    expect(note).toBe(PAUSE_NOTE);
    expect(note).toBe(" [not paid: the agent was paused]");
  });
});

describe("AgentPausedError", () => {
  it("carries the exact message a member sees", () => {
    expect(new AgentPausedError().message).toBe("The agent is paused. Resume it to run a cycle.");
  });
});
