import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { deleteAbandonedSandboxes, SANDBOX_IDLE_DAYS } from "@/lib/platform/cleanup";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * `deleteAbandonedSandboxes` against a real supabase-js client whose network
 * is a recorder, the same shape as `tests/cron.test.ts`: the listing and the
 * per-organization `delete_sandbox_org` calls it makes are real, against a
 * fake network that answers as PostgREST would.
 */

const DELETED = "5d0f3a2e-8c1b-4f7a-9e6d-000000000d01";
const SURVIVED = "5d0f3a2e-8c1b-4f7a-9e6d-000000000d02";
const BROKEN = "5d0f3a2e-8c1b-4f7a-9e6d-000000000d03";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const NOW = new Date("2026-09-28T00:00:00.000Z");
const CUTOFF_ISO = new Date(NOW.getTime() - SANDBOX_IDLE_DAYS * 24 * 60 * 60 * 1000).toISOString();

function sandboxesDatabase(request: RecordedRequest): FakeReply {
  if (request.path === "/rest/v1/orgs") {
    return { body: [
      { id: DELETED, slug: "deleted-co" },
      { id: SURVIVED, slug: "survived-co" },
      { id: BROKEN, slug: "broken-co" },
    ] };
  }
  if (request.path === "/rest/v1/rpc/delete_sandbox_org") {
    const orgId = (request.body as { p_org_id: string }).p_org_id;
    if (orgId === DELETED) return { body: true };
    if (orgId === SURVIVED) return { body: false };
    return { status: 500, body: { message: "boom" } };
  }
  return { body: [] };
}

describe("deleteAbandonedSandboxes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists sandboxes idle since the cutoff and sorts each reply into deleted, skipped or failed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = fakeSupabase(sandboxesDatabase);

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteAbandonedSandboxes(NOW));

    expect(result).toEqual({ deleted: ["deleted-co"], failed: [{ slug: "broken-co", error: "boom" }] });

    const listing = fake.requests.find((request) => request.path === "/rest/v1/orgs");
    expect(listing?.params.get("mode")).toBe("eq.sandbox");
    expect(listing?.params.get("last_active_at")).toBe(`lt.${CUTOFF_ISO}`);

    const rpcCalls = fake.requests.filter((request) => request.path === "/rest/v1/rpc/delete_sandbox_org");
    expect(rpcCalls).toHaveLength(3);
    for (const call of rpcCalls) {
      expect((call.body as { p_inactive_before: string }).p_inactive_before).toBe(CUTOFF_ISO);
    }
  });

  it("returns empty results and calls nothing when no sandbox is listed", async () => {
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: [] } : { body: [] }));

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteAbandonedSandboxes(NOW));

    expect(result).toEqual({ deleted: [], failed: [] });
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/delete_sandbox_org")).toBe(false);
  });
});
