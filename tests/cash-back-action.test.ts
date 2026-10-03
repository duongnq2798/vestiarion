import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { CashBackError } from "@/lib/agent/liquidity";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `bringCashBackAction` (reserve cash back R2): an owner's or admin's, the amount asked or everything, then a cycle
 * for what waited for cash (R4). The library is a stand-in; `inOrg` and its org lookup are real.
 */

const { ORG } = vi.hoisted(() => ({ ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c6c" }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { authorizeMock, cashBackMock, raiseMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), cashBackMock: vi.fn(), raiseMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/agent/liquidity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/liquidity")>()),
  bringCashBackByPerson: cashBackMock,
}));
vi.mock("@/lib/circle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/circle")>()),
  getChainProvider: () => ({ mode: "live", earnMode: "live" }),
}));

import { bringCashBackAction } from "@/app/actions/treasury";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const ACCESS = { ok: true, user: { id: "u1", email: null }, membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role: "owner" as const } };
const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };

function run<T>(fn: () => Promise<T>, options: { paused?: boolean } = {}): Promise<T> {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs" ? { body: orgRow } : request.path === "/rest/v1/rpc/agent_paused" ? { body: options.paused === true } : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}
function form(amount: string) {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  data.set("amount", amount);
  return data;
}
const INITIAL = { ok: false, message: "" };

beforeEach(() => vi.clearAllMocks());

describe("bringCashBackAction", () => {
  it("asks for treasury.manage, and moves nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await bringCashBackAction(INITIAL, form(""))).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "treasury.manage");
    expect(cashBackMock).not.toHaveBeenCalled();
  });

  it("brings everything back when the amount is empty, then starts a cycle for what waited for cash", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    cashBackMock.mockResolvedValueOnce({ amount: 60.691351, execution: null });

    const result = await run(() => bringCashBackAction(INITIAL, form("")));

    expect(cashBackMock).toHaveBeenCalledWith(expect.objectContaining({ actorId: "u1", amount: null }));
    expect(result).toEqual({ ok: true, message: "Brought 60.691351 USDC back to the operating wallet. The agent pays what was waiting for cash within a minute." });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "cash_returned");
  });

  it("says a paused agent pays what waited for cash once it is resumed", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    cashBackMock.mockResolvedValueOnce({ amount: 5, execution: null });
    const result = await run(() => bringCashBackAction(INITIAL, form("5")), { paused: true });
    expect(result).toEqual({ ok: true, message: "Brought 5 USDC back to the operating wallet. The agent is paused; it pays what was waiting for cash once it is resumed." });
  });

  it("brings back the amount asked", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    cashBackMock.mockResolvedValueOnce({ amount: 5, execution: null });
    await run(() => bringCashBackAction(INITIAL, form(" 5 ")));
    expect(cashBackMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 5 }));
  });

  it("refuses an amount that is not one, moving nothing", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    const result = await run(() => bringCashBackAction(INITIAL, form("-3")));
    expect(result.ok).toBe(false);
    expect(result.message).not.toBe("");
    expect(cashBackMock).not.toHaveBeenCalled();
  });

  it("says why nothing came back, and starts no cycle", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    cashBackMock.mockRejectedValueOnce(new CashBackError("too_much", "The reserve holds 60.691351 USDC; bring back that much or less."));
    expect(await run(() => bringCashBackAction(INITIAL, form("100")))).toEqual({ ok: false, message: "The reserve holds 60.691351 USDC; bring back that much or less." });
    expect(raiseMock).not.toHaveBeenCalled();
  });
});
