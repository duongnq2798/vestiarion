import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  deleteAbandonedSandboxes, deleteExpiredWebhookDeliveries, SANDBOX_IDLE_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS,
} from "@/lib/platform/cleanup";
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
    if (request.params.get("id")) throw new Error("a sandbox that is not hosted is never checked for wallets");
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

  it("lists sandboxes idle since the cutoff and counts each reply as deleted, skipped or failed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(sandboxesDatabase);

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteAbandonedSandboxes(NOW));

    expect(result).toEqual({ deleted: 1, failed: 1 });
    // Per-organization detail goes to the server log by id only; no slug
    // (derived from a workspace name) appears in the result or the logs.
    expect(log).toHaveBeenCalledWith("deleted abandoned sandbox", DELETED);
    expect(error).toHaveBeenCalledWith("could not delete abandoned sandbox", BROKEN, "boom");
    expect(JSON.stringify([result, log.mock.calls, error.mock.calls])).not.toMatch(/-co/);

    const listing = fake.requests.find((request) => request.path === "/rest/v1/orgs");
    expect(listing?.params.get("mode")).toBe("eq.sandbox");
    expect(listing?.params.get("last_active_at")).toBe(`lt.${CUTOFF_ISO}`);
    // Migration 0029: a sandbox holding Circle credentials is never listed for deletion.
    expect(listing?.params.get("circle_api_key_enc")).toBe("is.null");
    // R6: hosted sandboxes are listed too, with their host, so an abandoned
    // one with no wallet frees its hosted slot.
    expect(listing?.params.get("or")).toBeNull();
    expect(listing?.params.get("select")?.split(",").map((column) => column.trim())).toEqual(["id", "wallet_host"]);

    const rpcCalls = fake.requests.filter((request) => request.path === "/rest/v1/rpc/delete_sandbox_org");
    expect(rpcCalls).toHaveLength(3);
    for (const call of rpcCalls) {
      expect((call.body as { p_inactive_before: string }).p_inactive_before).toBe(CUTOFF_ISO);
    }
  });

  it("returns empty results and calls nothing when no sandbox is listed", async () => {
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: [] } : { body: [] }));

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteAbandonedSandboxes(NOW));

    expect(result).toEqual({ deleted: 0, failed: 0 });
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/delete_sandbox_org")).toBe(false);
  });
});

describe("deleteAbandonedSandboxes — hosted sandboxes (R6, hosted wallets H6)", () => {
  afterEach(() => vi.restoreAllMocks());

  const HOSTED_EMPTY = "5d0f3a2e-8c1b-4f7a-9e6d-000000000e01";
  const HOSTED_WALLETED = "5d0f3a2e-8c1b-4f7a-9e6d-000000000e02";
  const HOSTED_UNCHECKABLE = "5d0f3a2e-8c1b-4f7a-9e6d-000000000e03";
  const OWN = "5d0f3a2e-8c1b-4f7a-9e6d-000000000e04";
  const UNCHOSEN = "5d0f3a2e-8c1b-4f7a-9e6d-000000000e05";

  const idOf = (request: RecordedRequest) => request.params.get("id")?.replace(/^eq\./, "");

  function hostedDatabase(request: RecordedRequest): FakeReply {
    if (request.path === "/rest/v1/orgs" && !request.params.get("id")) {
      return { body: [
        { id: HOSTED_EMPTY, wallet_host: "hosted" },
        { id: HOSTED_WALLETED, wallet_host: "hosted" },
        { id: HOSTED_UNCHECKABLE, wallet_host: "hosted" },
        { id: OWN, wallet_host: "own" },
        { id: UNCHOSEN, wallet_host: null },
      ] };
    }
    if (request.path === "/rest/v1/orgs") {
      // The wallet check: the org, only if one of its accounts has a wallet.
      if (idOf(request) === HOSTED_UNCHECKABLE) return { status: 500, body: { message: "check failed" } };
      return { body: idOf(request) === HOSTED_WALLETED ? [{ id: HOSTED_WALLETED }] : [] };
    }
    if (request.path === "/rest/v1/rpc/delete_sandbox_org") return { body: true };
    return { body: [] };
  }

  async function run() {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(hostedDatabase);
    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteAbandonedSandboxes(NOW));
    const checks = fake.requests.filter((request) => request.path === "/rest/v1/orgs" && request.params.get("id"));
    const deletes = fake.requests
      .filter((request) => request.path === "/rest/v1/rpc/delete_sandbox_org")
      .map((request) => (request.body as { p_org_id: string }).p_org_id);
    return { result, log, error, checks, deletes };
  }

  it("deletes a hosted sandbox with no wallet, freeing its slot, and skips one with a wallet without calling delete", async () => {
    const { result, log, deletes } = await run();
    expect(deletes).toContain(HOSTED_EMPTY);
    expect(deletes).not.toContain(HOSTED_WALLETED);
    expect(log).toHaveBeenCalledWith("deleted abandoned sandbox", HOSTED_EMPTY);
    expect(log).toHaveBeenCalledWith("kept abandoned hosted sandbox with wallets", HOSTED_WALLETED);
    expect(result).toEqual({ deleted: 3, failed: 1 });
  });

  it("checks each hosted candidate's accounts for a wallet through the orgs table, by id", async () => {
    const { checks } = await run();
    expect(checks.map(idOf)).toEqual([HOSTED_EMPTY, HOSTED_WALLETED, HOSTED_UNCHECKABLE]);
    for (const check of checks) {
      expect(check.method).toBe("GET");
      expect(check.params.get("select")).toBe("id,accounts!inner(id)");
      expect(check.params.get("accounts.circle_wallet_id")).toBe("not.is.null");
      expect(check.params.get("limit")).toBe("1");
    }
  });

  it("counts a hosted sandbox whose check fails as failed, and does not delete it", async () => {
    const { result, error, deletes } = await run();
    expect(deletes).not.toContain(HOSTED_UNCHECKABLE);
    expect(error).toHaveBeenCalledWith("could not check abandoned hosted sandbox for wallets", HOSTED_UNCHECKABLE, "check failed");
    expect(result.failed).toBe(1);
  });

  it("leaves own and unchosen sandboxes as before: no check, straight to delete_sandbox_org", async () => {
    const { checks, deletes } = await run();
    expect(checks.map(idOf)).not.toContain(OWN);
    expect(checks.map(idOf)).not.toContain(UNCHOSEN);
    expect(deletes).toEqual([HOSTED_EMPTY, OWN, UNCHOSEN]);
  });
});

describe("deleteExpiredWebhookDeliveries", () => {
  afterEach(() => vi.restoreAllMocks());

  const RETENTION_CUTOFF_ISO = new Date(NOW.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  /** Answers each DELETE with a count: 7 delivered rows, 4 failed ones. */
  const deletes = (request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/webhook_deliveries" || request.method !== "DELETE") {
      return { status: 404, body: { message: "unexpected" } };
    }
    const count = request.params.get("status") === "eq.delivered" ? 7 : 4;
    return { status: 200, body: [], headers: { "content-range": `*/${count}` } };
  };

  it("deletes delivered rows delivered more than 30 days ago and failed rows created more than 30 days ago, and counts both", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = fakeSupabase(deletes);

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteExpiredWebhookDeliveries(NOW));

    expect(WEBHOOK_DELIVERY_RETENTION_DAYS).toBe(30);
    expect(result).toEqual({ deleted: 11, failed: 0 });
    expect(fake.requests).toHaveLength(2);
    for (const request of fake.requests) {
      expect(request.method).toBe("DELETE");
      expect(request.headers.get("prefer")).toMatch(/count=exact/);
    }
    const [delivered, failed] = fake.requests;
    expect(delivered.params.get("status")).toBe("eq.delivered");
    expect(delivered.params.get("delivered_at")).toBe(`lt.${RETENTION_CUTOFF_ISO}`);
    expect(delivered.params.has("created_at")).toBe(false);
    expect(failed.params.get("status")).toBe("eq.failed");
    expect(failed.params.get("created_at")).toBe(`lt.${RETENTION_CUTOFF_ISO}`);
    expect(failed.params.has("delivered_at")).toBe(false);
  });

  it("never touches pending or sending rows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = fakeSupabase(deletes);

    await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteExpiredWebhookDeliveries(NOW));

    expect(fake.requests.map((request) => request.params.get("status"))).toEqual(["eq.delivered", "eq.failed"]);
  });

  it("never throws: a failed delete is logged and counted as failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase(() => ({ status: 500, body: { message: "boom" } }));

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteExpiredWebhookDeliveries(NOW));

    expect(result).toEqual({ deleted: 0, failed: 2 });
    expect(error).toHaveBeenCalledWith("could not delete expired webhook deliveries", "boom");
  });

  it("still deletes the failed rows when deleting the delivered ones fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeSupabase((request) =>
      request.params.get("status") === "eq.delivered" ? { status: 500, body: { message: "boom" } } : deletes(request));

    const result = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => deleteExpiredWebhookDeliveries(NOW));

    expect(result).toEqual({ deleted: 4, failed: 1 });
  });
});
