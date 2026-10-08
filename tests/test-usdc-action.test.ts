import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `addTestUsdcAction` (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T2, T7, T8): someone who may add
 * records asks, the library adds the test USDC, and a cycle starts for what waited for cash. The library is a
 * stand-in; `inOrg` and its org lookup are real.
 */

const { ORG } = vi.hoisted(() => ({ ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a" }));
vi.mock("server-only", () => ({}));
const { authorizeMock, addMock, raiseMock, revalidateMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), addMock: vi.fn(), raiseMock: vi.fn(), revalidateMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: revalidateMock }));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock }));
vi.mock("@/lib/test-usdc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/test-usdc")>()), addTestUsdc: addMock }));

import { addTestUsdcAction } from "@/app/actions/test-usdc";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { TestUsdcError } from "@/lib/test-usdc";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const ACCESS = { ok: true, user: { id: "u1", email: null }, membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role: "owner" as const } };
const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
const TX = "https://explorer.testnet.arc.io/tx/0xabc";

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}
function form() {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  return data;
}
const INITIAL = { ok: false, message: "" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("addTestUsdcAction", () => {
  it("asks for records.write, and adds nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await addTestUsdcAction(INITIAL, form())).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(addMock).not.toHaveBeenCalled();
  });

  it("adds it, links its transaction, and starts a cycle for what waited for cash", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockResolvedValueOnce({ amount: 480.01, status: "confirmed", txHash: "0xabc", txUrl: TX });
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: true, message: "Added 480.01 test USDC to the operating wallet.", txUrl: TX });
    expect(addMock).toHaveBeenCalledWith({ actorId: "u1" });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "test_usdc_added");
    expect(revalidateMock).toHaveBeenCalled();
  });

  it("says Arc testnet is still confirming a transfer still processing", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockResolvedValueOnce({ amount: 480.01, status: "pending", txHash: null, txUrl: null });
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: true, message: "Added 480.01 test USDC to the operating wallet. Arc testnet is still confirming it." });
    expect(raiseMock).toHaveBeenCalledWith(ACCESS, "test_usdc_added");
    // Sent but not confirmed yet: the explorer may already show it.
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockResolvedValueOnce({ amount: 20, status: "pending", txHash: "0xabc", txUrl: TX });
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: true, message: "Added 20 test USDC to the operating wallet. Arc testnet is still confirming it.", txUrl: TX });
  });

  it("says a transfer Circle reported failed added nothing, and starts no cycle", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockResolvedValueOnce({ amount: 480.01, status: "failed", txHash: null, txUrl: null });
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: false, message: "Circle could not send the test USDC. Try again in a moment." });
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("says why nothing was added, and starts no cycle", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockRejectedValueOnce(new TestUsdcError("nothing_needed"));
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: false, message: "Nothing to add: the operating wallet covers your open bills." });
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("says payments are switched off in the switch's own words", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockRejectedValueOnce(new PaymentsDisabledError());
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: false, message: "Payments are switched off for every workspace right now." });
    expect(raiseMock).not.toHaveBeenCalled();
  });

  it("says nothing of an unexpected error but to try again", async () => {
    authorizeMock.mockResolvedValueOnce(ACCESS);
    addMock.mockRejectedValueOnce(new Error("Circle answered createTransaction with HTTP 503, which does not say what became of it"));
    expect(await run(() => addTestUsdcAction(INITIAL, form()))).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    expect(raiseMock).not.toHaveBeenCalled();
  });
});
