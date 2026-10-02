import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { enableUsycReserve, UsycReserveError } from "@/lib/platform/usyc-reserve";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Turning the real USYC reserve on (docs/superpowers/specs/2026-10-02-usyc-live-design.md R1): only a
 * live workspace with both wallets, an empty simulated reserve, and both wallets allowlisted on chain;
 * the change is made by 0054's function, told who is acting, and signed.
 */

const { ledgerMock, entitlementsMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), entitlementsMock: vi.fn() }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/circle/usyc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle/usyc")>()), usycEntitlements: entitlementsMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0d";
const ACTOR = "a1b2c3d4-0000-4000-8000-000000000002";
const OPERATING = "0x97f85033bbd83870a841cf7153f35b387746b6b6";
const RESERVE = "0xa8a4ced0cda82b24d11e0386f066eb8c27fd4887";

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ACTOR }), fn);

function workspace(over: { mode?: string; liveAt?: string | null; reserveBalance?: string; reserveAddress?: string | null; rpc?: FakeReply } = {}) {
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/orgs") return { body: { mode: over.mode ?? "live", usyc_live_at: over.liveAt ?? null } };
    if (r.path === "/rest/v1/accounts") {
      return {
        body: [
          { id: "op", kind: "operating", address: OPERATING, balance: "37.5" },
          { id: "res", kind: "reserve", address: over.reserveAddress === undefined ? RESERVE : over.reserveAddress, balance: over.reserveBalance ?? "0.000000" },
        ],
      };
    }
    if (r.path === "/rest/v1/rpc/enable_usyc_reserve") return over.rpc ?? { body: "2026-10-02T04:00:00+00:00" };
    return { body: [] };
  };
}

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  entitlementsMock.mockReset().mockResolvedValue({ operating: true, reserve: true });
});

describe("enableUsycReserve", () => {
  it("checks both wallets on chain, turns the reserve on as the person acting, and signs it", async () => {
    fake = fakeSupabase(workspace());
    expect(await run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).toEqual({ liveAt: "2026-10-02T04:00:00+00:00", operatingAddress: OPERATING, reserveAddress: RESERVE });
    expect(entitlementsMock).toHaveBeenCalledWith({ operating: OPERATING, reserve: RESERVE }, expect.anything());
    expect(fake.requests.find((r) => r.path === "/rest/v1/rpc/enable_usyc_reserve")?.body).toEqual({ p_org_id: ORG, p_actor: ACTOR });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, expect.objectContaining({ actor: "human", domain: "treasury", action: "usyc_reserve_enabled", detail: { by: ACTOR, operatingAddress: OPERATING, reserveAddress: RESERVE } }));
  });

  it("names the wallet Circle has not allowlisted, with its address, and turns nothing on", async () => {
    fake = fakeSupabase(workspace());
    entitlementsMock.mockResolvedValue({ operating: true, reserve: false });
    await expect(run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).rejects.toThrow(
      `Circle has not allowlisted the reserve wallet (${RESERVE}), to sell it. Ask Circle Support to allowlist it for USYC on Arc testnet, then try again.`
    );
    expect(fake.requests.some((r) => r.path === "/rest/v1/rpc/enable_usyc_reserve")).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses while the simulated reserve holds anything, so it is never counted as USYC", async () => {
    fake = fakeSupabase(workspace({ reserveBalance: "12.5" }));
    await expect(run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).rejects.toMatchObject({ code: "simulated_reserve" });
    expect(entitlementsMock).not.toHaveBeenCalled();
  });

  it("refuses a sandbox, a workspace without wallets, and one already on", async () => {
    fake = fakeSupabase(workspace({ mode: "sandbox" }));
    await expect(run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).rejects.toMatchObject({ code: "not_live" });
    fake = fakeSupabase(workspace({ reserveAddress: null }));
    await expect(run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).rejects.toMatchObject({ code: "no_wallets" });
    fake = fakeSupabase(workspace({ liveAt: "2026-10-01T00:00:00Z" }));
    await expect(run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).rejects.toMatchObject({ code: "already_live" });
  });

  it("says Arc did not answer, rather than that the wallets are not allowlisted", async () => {
    fake = fakeSupabase(workspace());
    entitlementsMock.mockRejectedValue(new Error("timeout"));
    await expect(run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR }))).rejects.toMatchObject({ code: "unreachable" });
  });

  it("maps the database's refusal of a role it does not allow", async () => {
    fake = fakeSupabase(workspace({ rpc: { status: 400, body: { message: "usyc_not_permitted: a approver cannot turn on the USYC reserve" } } }));
    const error = await run(() => enableUsycReserve({ orgId: ORG, actorId: ACTOR })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsycReserveError);
    expect(error).toMatchObject({ code: "not_permitted", message: "Only an owner or admin can turn the USYC reserve on." });
  });
});
