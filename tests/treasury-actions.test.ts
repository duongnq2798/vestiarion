import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { currentOrgId, runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `refreshOnChainBalanceAction`, the console balance tile's read. `authorize` and
 * the library are stand-ins; `inOrg` and the org lookup it makes are real, as
 * in `tests/notifications-actions.test.ts`.
 */

const { ORG } = vi.hoisted(() => ({ ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d" }));

vi.mock("server-only", () => ({}));
const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock("@/lib/agent/balances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/balances")>()),
  refreshOnChainBalances: refreshMock,
}));

import { refreshOnChainBalanceAction } from "@/app/actions/treasury";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const MEMBERSHIP = { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role: "viewer" as const };
const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshOnChainBalanceAction", () => {
  it("gates on workspace.read: any member may see the balance", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "refused" });
    await refreshOnChainBalanceAction("northstar");
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "workspace.read");
  });

  it("passes the permission as a string literal", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "app", "actions", "treasury.ts"), "utf8");
    expect(source).toContain('await authorize(orgSlug, "workspace.read")');
  });

  it("returns the refusal, and reads nothing, when authorize refuses", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });
    const result = await refreshOnChainBalanceAction("northstar");
    expect(result).toEqual({ ok: false, balance: null, syncedAt: null, message: "You are not a member of this workspace." });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("reads inside the organization's scope and answers with the balance and the time of the read", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: "u1" }, membership: MEMBERSHIP });
    let scoped: string | null = null;
    refreshMock.mockImplementationOnce(async () => {
      scoped = currentOrgId();
      return { refreshed: true, balance: 120, syncedAt: "2026-09-30T12:00:00.000Z" };
    });

    const result = await run(() => refreshOnChainBalanceAction("northstar"));

    expect(scoped).toBe(ORG);
    expect(result).toEqual({ ok: true, balance: 120, syncedAt: "2026-09-30T12:00:00.000Z" });
    // The client updates the tile itself; nothing re-renders the layout.
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it.each(["cooldown", "cycle_running", "not_live", "no_wallet"])("treats a skipped read (%s) as a success carrying the stored figures", async (reason) => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: "u1" }, membership: MEMBERSHIP });
    refreshMock.mockResolvedValueOnce({ refreshed: false, reason, balance: 100, syncedAt: "2026-09-30T11:59:50.000Z" });

    expect(await run(() => refreshOnChainBalanceAction("northstar"))).toEqual({ ok: true, balance: 100, syncedAt: "2026-09-30T11:59:50.000Z" });
  });

  it("does not share its name with the Go live step's refreshBalanceAction", async () => {
    const actions = await import("@/app/actions/treasury");
    expect(Object.keys(actions).sort()).toEqual(["fundGatewayAction", "refreshOnChainBalanceAction"]);
  });

  it("answers a Circle failure with the fixed sentence", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: "u1" }, membership: MEMBERSHIP });
    refreshMock.mockResolvedValueOnce({
      refreshed: false, reason: "unavailable", message: "Could not reach Circle; showing the last known balance", balance: 100, syncedAt: null,
    });

    expect(await run(() => refreshOnChainBalanceAction("northstar"))).toEqual({
      ok: false, balance: 100, syncedAt: null, message: "Could not reach Circle; showing the last known balance",
    });
  });

  it("logs only its own name when the read throws, and returns the fixed sentence", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: "u1" }, membership: MEMBERSHIP });
    refreshMock.mockRejectedValueOnce(new Error("relation accounts: column balance_synced_at does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(() => refreshOnChainBalanceAction("northstar"));

    expect(result).toEqual({ ok: false, balance: null, syncedAt: null, message: "Could not reach Circle; showing the last known balance" });
    expect(logged.mock.calls).toEqual([["refreshOnChainBalanceAction failed"]]);
    logged.mockRestore();
  });
});
