import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/** `GET /api/agent/activity`: members only, a `since` read as a sequence number or not at all, never cached. */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000e2e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e2",
}));

const { sessionMock, membershipMock, readMock } = vi.hoisted(() => ({ sessionMock: vi.fn(), membershipMock: vi.fn(), readMock: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock }));
vi.mock("@/lib/agent-activity-read", () => ({ readAgentActivity: readMock }));

import { GET } from "@/app/api/agent/activity/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MEMBERSHIP = { orgId: ORG, slug: "northstar", name: "Northstar Studio", mode: "live" as const, role: "viewer" as const };
const ACTIVITY = { running: null, head: 974, lastCycleAt: "2026-10-03T02:20:59Z", items: [] };

function call(query: string) {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "northstar", name: "Northstar Studio", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, () => GET(new Request(`https://www.vestiarion.xyz/api/agent/activity${query}`)));
}

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockResolvedValue(ACTIVITY);
});

describe("GET /api/agent/activity", () => {
  it("asks a visitor to sign in, and reads nothing", async () => {
    sessionMock.mockResolvedValue(null);
    const response = await call("?org=northstar");
    expect(response.status).toBe(401);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("answers 404 to someone who is not a member of the workspace", async () => {
    sessionMock.mockResolvedValue({ id: USER, email: null });
    membershipMock.mockResolvedValue(null);
    const response = await call("?org=northstar");
    expect(response.status).toBe(404);
    expect(readMock).not.toHaveBeenCalled();
  });

  it("answers a member with the workspace's activity after `since`, uncached", async () => {
    sessionMock.mockResolvedValue({ id: USER, email: null });
    membershipMock.mockResolvedValue(MEMBERSHIP);
    const response = await call("?org=northstar&since=967");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(ACTIVITY);
    expect(membershipMock).toHaveBeenCalledWith(USER, "northstar");
    expect(readMock).toHaveBeenCalledWith(967);
  });

  it.each(["", "&since=abc", "&since=-3", "&since=1e3"])("reads a `since` that is not a sequence number (%j) as none", async (query) => {
    sessionMock.mockResolvedValue({ id: USER, email: null });
    membershipMock.mockResolvedValue(MEMBERSHIP);
    await call(`?org=northstar${query}`);
    expect(readMock).toHaveBeenCalledWith(null);
  });

  it("answers a fixed message when the read fails", async () => {
    sessionMock.mockResolvedValue({ id: USER, email: null });
    membershipMock.mockResolvedValue(MEMBERSHIP);
    readMock.mockRejectedValue(new Error("connection reset"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("?org=northstar");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "The agent's activity could not be read." });
  });
});
