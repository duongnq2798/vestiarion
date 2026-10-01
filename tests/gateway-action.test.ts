import { beforeEach, describe, expect, it, vi } from "vitest";
import { can } from "@/lib/auth/roles";

/**
 * The Treasury page's "Fund Gateway" (Gateway payouts G1): an owner's or admin's deliberate move of
 * treasury cash, in a live workspace only. Authorization, the scope and the funding itself are
 * stand-ins; the action's own checks and messages are real.
 */

const { authorizeMock, fundGateway } = vi.hoisted(() => ({ authorizeMock: vi.fn(), fundGateway: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/circle/gateway-funding", () => ({
  fundGateway,
  GatewayStepFailed: class GatewayStepFailed extends Error {},
}));

import { fundGatewayAction } from "@/app/actions/treasury";
import { GatewayStepFailed } from "@/lib/circle/gateway-funding";

const REQUEST = "0b6c1c9e-4a4f-4a7e-9b1e-00000000f00d";
const access = (mode: "live" | "sandbox") => ({
  ok: true,
  user: { id: "user-1", email: null },
  membership: { orgId: "org-1", slug: "testnet-2", name: "Testnet 2", mode, role: "owner" },
});

function form(amount: string, requestId = REQUEST): FormData {
  const data = new FormData();
  data.set("orgSlug", "testnet-2");
  data.set("amount", amount);
  data.set("requestId", requestId);
  return data;
}

beforeEach(() => {
  authorizeMock.mockReset();
  fundGateway.mockReset();
});

describe("who may fund a Gateway balance", () => {
  it("is an owner or an admin", () => {
    expect(["owner", "admin", "approver", "viewer"].filter((role) => can(role as never, "treasury.manage"))).toEqual(["owner", "admin"]);
  });
});

describe("fundGatewayAction", () => {
  it("funds a live workspace's Gateway balance under the request's id, and says what it holds now", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    fundGateway.mockResolvedValue({ signerAddress: "0xsigner", depositTxHash: "0xdeposit", balanceUsdc: 3 });
    const result = await fundGatewayAction({ ok: false, message: "" }, form("3"));
    expect(authorizeMock).toHaveBeenCalledWith("testnet-2", "treasury.manage");
    expect(fundGateway).toHaveBeenCalledWith({ actorId: "user-1", amount: 3, requestId: REQUEST });
    expect(result).toEqual({ ok: true, message: "Deposited 3 USDC into Gateway. The Gateway balance is 3 USDC." });
  });

  it("refuses a sandbox: its payments are simulated, and Gateway is on Arc testnet", async () => {
    authorizeMock.mockResolvedValue(access("sandbox"));
    expect(await fundGatewayAction({ ok: false, message: "" }, form("3"))).toEqual({ ok: false, message: "Gateway is for a live workspace on Arc testnet. Take this workspace live first." });
    expect(fundGateway).not.toHaveBeenCalled();
  });

  it("refuses someone who may not move treasury cash", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(await fundGatewayAction({ ok: false, message: "" }, form("3"))).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(fundGateway).not.toHaveBeenCalled();
  });

  it("refuses an amount that is not a positive USDC amount, and a request without its id", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    expect((await fundGatewayAction({ ok: false, message: "" }, form("-1"))).ok).toBe(false);
    expect((await fundGatewayAction({ ok: false, message: "" }, form("1.1234567"))).ok).toBe(false);
    expect(await fundGatewayAction({ ok: false, message: "" }, form("1", "not-a-uuid"))).toEqual({ ok: false, message: "Reload the page and try again." });
    expect(fundGateway).not.toHaveBeenCalled();
  });

  it("asks the form for a new request id after Circle failed a step, and keeps the id otherwise (review I5)", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    fundGateway.mockRejectedValueOnce(new GatewayStepFailed("Circle did not complete the deposit into Gateway (FAILED). Nothing was moved into Gateway; try again.", "tx-9"));
    expect(await fundGatewayAction({ ok: false, message: "" }, form("1"))).toEqual({
      ok: false,
      message: "Circle did not complete the deposit into Gateway (FAILED). Nothing was moved into Gateway; try again.",
      renew: true,
    });
    fundGateway.mockRejectedValueOnce(new Error("Circle did not complete the deposit into Gateway (no answer yet). Try again: the same request sends nothing twice."));
    expect((await fundGatewayAction({ ok: false, message: "" }, form("1"))).renew).toBeUndefined();
  });

  it("says what failed in the funding's own words, and nothing else", async () => {
    authorizeMock.mockResolvedValue(access("live"));
    fundGateway.mockRejectedValueOnce(new Error("Circle did not complete the deposit into Gateway (FAILED). Try again: the same request sends nothing twice."));
    expect((await fundGatewayAction({ ok: false, message: "" }, form("1"))).message).toBe(
      "Circle did not complete the deposit into Gateway (FAILED). Try again: the same request sends nothing twice."
    );
  });
});
