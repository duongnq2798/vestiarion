import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { endShadowMode, readShadowMode, ShadowModeError, startShadowMode } from "@/lib/shadow-mode";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The shadow mode switch (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S1): one row per workspace on Arc
 * testnet, in the business's own currency, an owner's to turn on and off, refused while a cycle runs, each change signed.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const OWNER = "a1b2c3d4-0000-4000-8000-0000000000e1";
const ON = { currency: "VND", started_at: "2026-10-07T12:00:00Z", started_by: OWNER };

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>, network: "arc-testnet" | "arc-mainnet" = "arc-testnet") =>
  runWith(orgTestContext({ config: { ...config, network }, client: fake.client, orgId: ORG, userId: OWNER }), fn);

function workspace(over: { row?: unknown[]; read?: FakeReply; running?: unknown[]; insert?: FakeReply } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/shadow_modes" && r.method === "GET") return over.read ?? { body: over.row ?? [] };
    if (r.path === "/rest/v1/shadow_modes" && r.method === "POST") return over.insert ?? { status: 201, body: null };
    if (r.path === "/rest/v1/shadow_modes" && r.method === "DELETE") return { body: [] };
    if (r.path === "/rest/v1/cycle_runs") return { body: over.running ?? [] };
    return { body: [] };
  };
}

const writes = (method: "POST" | "DELETE") => fake.requests.filter((r) => r.path === "/rest/v1/shadow_modes" && r.method === method);

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("readShadowMode", () => {
  it("reads the workspace's row, or null when it is off", async () => {
    fake = fakeSupabase(workspace({ row: [ON] }));
    expect(await run(() => readShadowMode(db()))).toEqual({ currency: "VND", startedAt: "2026-10-07T12:00:00Z", startedBy: OWNER });
    fake = fakeSupabase(workspace());
    expect(await run(() => readShadowMode(db()))).toBeNull();
  });

  it("throws when it cannot be read, so nothing is paid on a guess", async () => {
    fake = fakeSupabase(workspace({ read: { status: 500, body: { message: "boom" } } }));
    await expect(run(() => readShadowMode(db()))).rejects.toThrow(/shadow_modes/);
  });
});

describe("startShadowMode", () => {
  it("turns it on in the business's currency, and records it", async () => {
    fake = fakeSupabase(workspace());
    const started = await run(() => startShadowMode({ actorId: OWNER, currency: " vnd " }));
    expect(started).toMatchObject({ currency: "VND", startedBy: OWNER });
    expect(writes("POST")[0].body).toMatchObject({ currency: "VND", started_by: OWNER });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, expect.objectContaining({ actor: "human", domain: "system", action: "shadow_mode_started", detail: { by: OWNER, currency: "VND" } }));
  });

  it.each(["", "VN", "VNDX", "USDC", "EURC", "V1D"])("refuses %j as the business's currency", async (currency) => {
    fake = fakeSupabase(workspace());
    await expect(run(() => startShadowMode({ actorId: OWNER, currency }))).rejects.toMatchObject({ code: "invalid_currency" });
    expect(writes("POST")).toHaveLength(0);
  });

  it("refuses a workspace on Arc mainnet, where the agent pays the real bills", async () => {
    fake = fakeSupabase(workspace());
    await expect(run(() => startShadowMode({ actorId: OWNER, currency: "VND" }), "arc-mainnet")).rejects.toMatchObject({
      code: "mainnet",
      message: "Shadow mode runs on Arc testnet. On Arc mainnet the agent pays your real bills.",
    });
  });

  it("refuses when it is on already, or turned on a moment before", async () => {
    fake = fakeSupabase(workspace({ row: [ON] }));
    await expect(run(() => startShadowMode({ actorId: OWNER, currency: "VND" }))).rejects.toMatchObject({ code: "already_on" });
    fake = fakeSupabase(workspace({ insert: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint" } } }));
    await expect(run(() => startShadowMode({ actorId: OWNER, currency: "VND" }))).rejects.toMatchObject({ code: "already_on" });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses while a cycle runs: the cycle read it when it began", async () => {
    fake = fakeSupabase(workspace({ running: [{ id: "run-1" }] }));
    await expect(run(() => startShadowMode({ actorId: OWNER, currency: "VND" }))).rejects.toMatchObject({ code: "cycle_running" });
    expect(writes("POST")).toHaveLength(0);
  });
});

describe("endShadowMode", () => {
  it("turns it off and records it", async () => {
    fake = fakeSupabase(workspace({ row: [ON] }));
    await run(() => endShadowMode({ actorId: OWNER }));
    expect(writes("DELETE")).toHaveLength(1);
    expect(ledgerMock).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "shadow_mode_ended", detail: { by: OWNER, currency: "VND" } }));
  });

  it("refuses when it is off already, and while a cycle runs", async () => {
    fake = fakeSupabase(workspace());
    await expect(run(() => endShadowMode({ actorId: OWNER }))).rejects.toMatchObject({ code: "already_off" });
    fake = fakeSupabase(workspace({ row: [ON], running: [{ id: "run-1" }] }));
    await expect(run(() => endShadowMode({ actorId: OWNER }))).rejects.toMatchObject({ code: "cycle_running" });
    expect(writes("DELETE")).toHaveLength(0);
  });

  it("says each refusal in words a person reads", () => {
    expect(new ShadowModeError("already_off").message).toBe("Shadow mode is already off.");
  });
});
