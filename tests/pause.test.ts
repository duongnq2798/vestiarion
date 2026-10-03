import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { pauseAgent, PauseError, pauseStateOf, resumeAgent } from "@/lib/platform/pause";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `src/lib/platform/pause.ts` against a real supabase-js client whose
 * network is a recorder, the same shape as `tests/members.test.ts`: the
 * `pause_agent` and `resume_agent` RPCs from migration 0025 are answered as
 * PostgREST would, over the tenant scope the ledger append needs.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-0000000000ee";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a5";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  vi.useRealTimers();
});

function orgRow() {
  return {
    id: ORG,
    slug: "northstar",
    name: "Northstar",
    mode: "live",
    ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
  };
}

/** PostgREST as `pause.ts` meets it: the 0025 pause/resume RPCs and `append_ledger_entry`. */
function pauseFake(options: {
  pauseAgent?: (request: RecordedRequest) => FakeReply | undefined;
  resumeAgent?: (request: RecordedRequest) => FakeReply | undefined;
  ledgerFails?: boolean;
  resumedSince?: string;
} = {}) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: orgRow() };
    if (request.path === "/rest/v1/rpc/pause_agent") {
      const failure = options.pauseAgent?.(request);
      if (failure) return failure;
      const body = request.body as Record<string, unknown>;
      return {
        body: {
          id: body.p_org_id, slug: "northstar", name: "Northstar", mode: "live",
          agent_paused_at: "2026-09-29T00:00:00Z", agent_paused_by: body.p_actor, agent_pause_reason: body.p_reason,
        },
      };
    }
    if (request.path === "/rest/v1/rpc/resume_agent") {
      const failure = options.resumeAgent?.(request);
      if (failure) return failure;
      return { body: options.resumedSince ?? "2026-09-29T00:00:00Z" };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      if (options.ledgerFails) return { status: 500, body: { message: "ledger unavailable" } };
      return {
        body: {
          seq: 1, id: "e1", ts: "2026-09-29T00:00:00Z", actor: "human", domain: "system", action: "x",
          summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null,
        },
      };
    }
    return { body: [] };
  });
  return { fake, run: <T>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

function rpcBodies(requests: RecordedRequest[], name: string) {
  return requests.filter((request) => request.path === `/rest/v1/rpc/${name}`).map((request) => request.body as Record<string, unknown>);
}

describe("pauseAgent", () => {
  it("sends the trimmed reason to pause_agent, and appends agent_paused with by and the same reason", async () => {
    const { fake, run } = pauseFake();

    await run(() => pauseAgent({ orgId: ORG, actorId: ACTOR, reason: "  investigating a mismatch  " }));

    const [pause] = rpcBodies(fake.requests, "pause_agent");
    expect(pause).toEqual({ p_org_id: ORG, p_actor: ACTOR, p_reason: "investigating a mismatch" });

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      p_org_id: ORG,
      p_action: "agent_paused",
      p_detail: { by: ACTOR, reason: "investigating a mismatch" },
    });
  });

  it("names the surface and its link when the pause did not come from the console", async () => {
    const { fake, run } = pauseFake();

    await run(() => pauseAgent({ orgId: ORG, actorId: ACTOR, reason: "stop", provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, reason: "stop", via: "slack", linkId: "link-1" });
  });

  it("caps the reason at 280 characters, and sends null when it is empty", async () => {
    const long = "x".repeat(300);
    const { fake, run } = pauseFake();

    await run(() => pauseAgent({ orgId: ORG, actorId: ACTOR, reason: long }));
    let [pause] = rpcBodies(fake.requests, "pause_agent");
    expect(pause.p_reason).toBe("x".repeat(280));
    let [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ reason: "x".repeat(280) });

    fake.requests.length = 0;
    await run(() => pauseAgent({ orgId: ORG, actorId: ACTOR, reason: "   " }));
    [pause] = rpcBodies(fake.requests, "pause_agent");
    expect(pause.p_reason).toBeNull();
    [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toMatchObject({ reason: null });
  });

  it("also sends null when no reason is given at all", async () => {
    const { fake, run } = pauseFake();
    await run(() => pauseAgent({ orgId: ORG, actorId: ACTOR }));
    const [pause] = rpcBodies(fake.requests, "pause_agent");
    expect(pause.p_reason).toBeNull();
  });

  it.each([
    ["not_a_member: the acting person is not a member of this organization", "not_a_member", "You are not a member of this workspace."],
    ["pause_not_permitted: a viewer cannot pause the agent", "pause_not_permitted", "Your role cannot pause the agent."],
    ["already_paused: the agent has been paused since 2026-09-29T00:00:00Z", "already_paused", "The agent is already paused."],
  ])("maps %s to a PauseError", async (message, code, text) => {
    const { run } = pauseFake({ pauseAgent: () => ({ status: 400, body: { code: "P0001", message } }) });

    const attempt = run(() => pauseAgent({ orgId: ORG, actorId: ACTOR }));
    await expect(attempt).rejects.toBeInstanceOf(PauseError);
    await expect(attempt).rejects.toMatchObject({ code, message: text });
  });

  it("appends nothing when the RPC itself refuses", async () => {
    const { fake, run } = pauseFake({ pauseAgent: () => ({ status: 400, body: { code: "P0001", message: "already_paused: x" } }) });
    await expect(run(() => pauseAgent({ orgId: ORG, actorId: ACTOR }))).rejects.toThrow();
    expect(rpcBodies(fake.requests, "append_ledger_entry")).toHaveLength(0);
  });

  it("still resolves, and logs by action and org id, when the ledger append fails after the pause commits", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = pauseFake({ ledgerFails: true });

    await expect(run(() => pauseAgent({ orgId: ORG, actorId: ACTOR, reason: "x" }))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "agent_paused", ORG);
    error.mockRestore();
  });
});

describe("resumeAgent", () => {
  it("sends p_org_id and p_actor to resume_agent", async () => {
    const { fake, run } = pauseFake();
    await run(() => resumeAgent({ orgId: ORG, actorId: ACTOR }));
    const [resume] = rpcBodies(fake.requests, "resume_agent");
    expect(resume).toEqual({ p_org_id: ORG, p_actor: ACTOR });
  });

  it("appends agent_resumed with by and pausedFor computed from the returned timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-29T00:05:30Z"));
    const { fake, run } = pauseFake({ resumedSince: "2026-09-29T00:00:00Z" });

    await run(() => resumeAgent({ orgId: ORG, actorId: ACTOR }));

    const appends = rpcBodies(fake.requests, "append_ledger_entry");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({
      p_org_id: ORG,
      p_action: "agent_resumed",
      p_detail: { by: ACTOR, pausedFor: 330 },
    });
  });

  it.each([
    ["not_a_member: the acting person is not a member of this organization", "not_a_member", "You are not a member of this workspace."],
    ["resume_not_permitted: a approver cannot resume the agent", "resume_not_permitted", "Only an owner or admin can resume the agent."],
    ["not_paused: the agent is running", "not_paused", "The agent is already running."],
  ])("maps %s to a PauseError", async (message, code, text) => {
    const { run } = pauseFake({ resumeAgent: () => ({ status: 400, body: { code: "P0001", message } }) });

    const attempt = run(() => resumeAgent({ orgId: ORG, actorId: ACTOR }));
    await expect(attempt).rejects.toBeInstanceOf(PauseError);
    await expect(attempt).rejects.toMatchObject({ code, message: text });
  });

  it("still resolves, and logs by action and org id, when the ledger append fails after the resume commits", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = pauseFake({ ledgerFails: true });

    await expect(run(() => resumeAgent({ orgId: ORG, actorId: ACTOR }))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("ledger entry not recorded", "agent_resumed", ORG);
    error.mockRestore();
  });
});

describe("pauseStateOf", () => {
  it("is null when the workspace is not paused", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/orgs" ? { body: { agent_paused_at: null, agent_paused_by: null, agent_pause_reason: null } } : { body: [] }
    );
    await expect(
      runWith({ config, db: fake.client, fetch: fake.fetch }, () => pauseStateOf(ORG))
    ).resolves.toBeNull();
  });

  it("reads pausedAt, pausedBy and reason from the orgs row", async () => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/orgs"
        ? { body: { agent_paused_at: "2026-09-29T00:00:00Z", agent_paused_by: ACTOR, agent_pause_reason: "investigating" } }
        : { body: [] }
    );
    await expect(
      runWith({ config, db: fake.client, fetch: fake.fetch }, () => pauseStateOf(ORG))
    ).resolves.toEqual({ pausedAt: "2026-09-29T00:00:00Z", pausedBy: ACTOR, reason: "investigating" });
  });
});
